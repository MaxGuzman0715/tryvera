import { timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth, canAccessApplication, canAccessProfile } from "./auth/middleware.js";
import { listApplications } from "./logStore.js";
import { listProfiles, readProfile } from "./profileStore.js";
import { getInterview, listInterviews, upsertInterview } from "./interviewStore.js";
import { matchInterview, sameCompany } from "./interviewMatch.js";
import { autoStage } from "./pipelineStage.js";
import type { ApplicationLogEntry, InterviewEvent, User } from "./types.js";

/**
 * Interview emails pushed in by the Slack triage bot (slack-email-triage), and
 * the page that ties each one back to the application it came from.
 *
 * The bot is a machine, not a user, so ingest is gated by a shared secret
 * (INTERVIEW_INGEST_TOKEN) instead of a session. Everything else is the normal
 * session auth: admins see every email; other users see emails sent to the
 * profiles assigned to them — the same rule profiles already follow.
 */

const MAX_EVENTS_PER_REQUEST = 500;

function requireIngestToken(req: Request, res: Response, next: NextFunction): void {
  const expected = (process.env.INTERVIEW_INGEST_TOKEN ?? "").trim();
  if (!expected) {
    res.status(503).json({ error: "Interview ingest is off: INTERVIEW_INGEST_TOKEN is not set on the server." });
    return;
  }
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? "").trim());
  const got = Buffer.from(m ? m[1].trim() : "");
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    res.status(401).json({ error: "Bad ingest token." });
    return;
  }
  next();
}

/**
 * Coerce and truncate rather than reject. These fields come straight from an
 * LLM, and a refused card is never resent, so an odd value (a list where a
 * string belongs, an over-long kind) must still land as readable text.
 */
const text = (max: number) =>
  z.unknown().transform((v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)).slice(0, max));

const ingestEvent = z.object({
  id: z.string().min(1).max(64),
  received_at: z.string().min(1),
  verdict: z.enum(["ACTION", "MAYBE", "REJECTION"]),
  kind: text(40).transform((v) => v || null),
  company: text(300),
  role: text(300),
  reason: text(2000),
  asked: text(2000),
  deadline: text(300),
  subject: text(500),
  sender: text(500),
  sender_addr: text(320),
  to: text(1000),
  permalink: text(1000),
  handled: z.boolean().default(false),
  handled_at: z.string().nullish(),
  // Anything malformed is dropped rather than refused: a bad time must not cost the email.
  meeting_date: z.unknown().transform((v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)),
  meeting_time: z.unknown().transform((v) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : undefined)),
});

const ingestBody = z.object({ events: z.array(ingestEvent).min(1).max(MAX_EVENTS_PER_REQUEST) });

const patchBody = z.object({
  // auto_matched is the matcher's word; a person confirms instead. It is
  // accepted only with its application, to put a Remove back exactly (Undo).
  match_status: z.enum(["needs_check", "auto_matched", "confirmed", "not_from_tryvera", "ignored"]).optional(),
  application_id: z.string().min(1).nullable().optional(),
  note: z.string().max(5000).optional(),
  handled: z.boolean().optional(),
});

const handledAckBody = z.object({
  items: z.array(z.object({ id: z.string().min(1), handled: z.boolean() })).max(MAX_EVENTS_PER_REQUEST),
});

/** First email address in a To header, lowercased. */
function firstAddress(to: string): string {
  const m = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(to);
  return m ? m[0].toLowerCase() : "";
}

/** Recipient address → every profile using it (a person's base and _ai profiles share one inbox). */
async function profilesByEmail(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const { id } of await listProfiles()) {
    const p = await readProfile(id);
    const email = p?.basic.email?.trim().toLowerCase();
    if (!email) continue;
    out.set(email, [...(out.get(email) ?? []), id]);
  }
  return out;
}

function isIgnorableApp(a: ApplicationLogEntry): boolean {
  return a.status === "failed" && Boolean(a.duplicate_of);
}

function canSeeEvent(user: User, ev: InterviewEvent, appsById: Map<string, ApplicationLogEntry>): boolean {
  if (user.role === "admin") return true;
  if (ev.profile_ids.some((p) => canAccessProfile(user, p))) return true;
  const app = ev.application_id ? appsById.get(ev.application_id) : undefined;
  return Boolean(app && canAccessApplication(user, app));
}

/**
 * The linked application is shown only to someone who could open it on
 * Application Logs. Seeing an email (by profile) must not widen that: two
 * users sharing a profile still don't see each other's applications.
 */
function appSummary(app: ApplicationLogEntry | undefined, user: User) {
  if (!app || !canAccessApplication(user, app)) return null;
  return {
    id: app.id,
    company_name: app.company_name,
    role_name: app.role_name,
    resume_profile: app.resume_profile,
    created_at: app.created_at,
    job_link: app.job_link,
  };
}

/** Statuses whose link counts as "this application has interview activity". */
const LINKED = new Set(["auto_matched", "confirmed"]);

export function registerInterviewRoutes(app: Express): void {
  app.post("/api/interviews/ingest", requireIngestToken, async (req, res) => {
    try {
      const body = ingestBody.parse(req.body);
      const [apps, emailMap] = await Promise.all([listApplications(), profilesByEmail()]);
      const now = new Date().toISOString();
      let created = 0;
      let updated = 0;
      for (const e of body.events) {
        const receivedMs = Date.parse(e.received_at);
        const to_addr = firstAddress(e.to);
        const fields = {
          ...e,
          source: "slack_triage" as const,
          received_at: Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : now,
          handled_at: e.handled ? e.handled_at || undefined : undefined,
          to_addr,
          profile_ids: emailMap.get(to_addr) ?? [],
        };
        upsertInterview(e.id, (cur) => {
          if (!cur) {
            created++;
            return { ...fields, ...matchInterview(fields, apps), created_at: now, updated_at: now };
          }
          updated++;
          const next: InterviewEvent = { ...cur, ...fields, updated_at: now };
          // A Done/Reopen clicked here hasn't reached the Slack card yet, so the
          // card's state is stale: keep ours until the bot acknowledges it.
          // Rejections have no card at all, so Tryvera alone owns their Done.
          if (cur.handled_pending || cur.verdict === "REJECTION") {
            next.handled = cur.handled;
            next.handled_at = cur.handled_at;
          } else if (!next.handled) {
            next.handled_by = undefined;
          }
          // Re-match only what nobody has decided yet: an application created
          // since the last send may now resolve it. Never overrule a person,
          // and never move an automatic link out from under someone reading it.
          if (cur.match_status === "needs_check" && !cur.status_by) {
            Object.assign(next, matchInterview(next, apps));
          }
          return next;
        });
      }
      res.json({ ok: true, created, updated });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/interviews", requireAuth, async (req, res) => {
    try {
      const apps = await listApplications();
      const appsById = new Map(apps.map((a) => [a.id, a]));
      const interviews = listInterviews()
        .filter((ev) => canSeeEvent(req.user!, ev, appsById))
        .map((ev) => ({
          ...ev,
          application: ev.application_id ? appSummary(appsById.get(ev.application_id), req.user!) : null,
        }));
      res.json({ interviews });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Per-application roll-up for the Application Logs column. */
  app.get("/api/interviews/summary", requireAuth, async (req, res) => {
    try {
      const apps = await listApplications();
      const appsById = new Map(apps.map((a) => [a.id, a]));
      type Summary = {
        count: number;
        open: number;
        unconfirmed: number;
        latest_at: string;
        latest_kind: string | null;
        latest_verdict: string;
        stage_auto: string;
      };
      const by_application: Record<string, Summary> = {};
      const linkedEvents = new Map<string, InterviewEvent[]>();
      // listInterviews is newest first, so the first event seen per app is its latest.
      for (const ev of listInterviews()) {
        if (!ev.application_id || !LINKED.has(ev.match_status)) continue;
        const linked = appsById.get(ev.application_id);
        if (!linked || !canAccessApplication(req.user!, linked)) continue;
        const s = (by_application[ev.application_id] ??= {
          count: 0,
          open: 0,
          unconfirmed: 0,
          latest_at: ev.received_at,
          latest_kind: ev.kind,
          latest_verdict: ev.verdict,
          stage_auto: "applied",
        });
        s.count++;
        // A rejection asks nothing of anyone, so it is never "open".
        if (!ev.handled && ev.verdict !== "REJECTION") s.open++;
        if (ev.match_status === "auto_matched") s.unconfirmed++;
        linkedEvents.set(ev.application_id, [...(linkedEvents.get(ev.application_id) ?? []), ev]);
      }
      for (const [id, evs] of linkedEvents) by_application[id].stage_auto = autoStage(evs);
      res.json({ by_application });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Applications this email could belong to, for the link picker. */
  app.get<{ id: string }>("/api/interviews/:id/candidates", requireAuth, async (req, res) => {
    try {
      const ev = getInterview(req.params.id);
      const apps = await listApplications();
      const appsById = new Map(apps.map((a) => [a.id, a]));
      if (!ev || !canSeeEvent(req.user!, ev, appsById)) {
        return res.status(404).json({ error: "Interview not found" });
      }
      const q = String(req.query.q ?? "").trim().toLowerCase();
      const suggested = new Set(ev.candidate_ids);
      const pool = apps.filter(
        (a) =>
          !isIgnorableApp(a) &&
          (ev.profile_ids.length === 0 || ev.profile_ids.includes(a.resume_profile)) &&
          canAccessApplication(req.user!, a) &&
          (!q || a.company_name.toLowerCase().includes(q) || a.role_name.toLowerCase().includes(q))
      );
      // Without a search, show only plausible rows: the matcher's picks, then
      // anything at the same company. A search widens to the whole profile.
      const ranked = (q ? pool : pool.filter((a) => suggested.has(a.id) || sameCompany(a.company_name, ev.company)))
        .map((a) => ({ a, rank: suggested.has(a.id) ? 0 : sameCompany(a.company_name, ev.company) ? 1 : 2 }))
        .sort((x, y) => x.rank - y.rank || y.a.created_at.localeCompare(x.a.created_at))
        .slice(0, 50)
        .map((x) => ({ ...appSummary(x.a, req.user!)!, suggested: suggested.has(x.a.id) }));
      res.json({ candidates: ranked });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.put<{ id: string }>("/api/interviews/:id", requireAuth, async (req, res) => {
    try {
      const body = patchBody.parse(req.body);
      const apps = await listApplications();
      const appsById = new Map(apps.map((a) => [a.id, a]));
      const existing = getInterview(req.params.id);
      if (!existing || !canSeeEvent(req.user!, existing, appsById)) {
        return res.status(404).json({ error: "Interview not found" });
      }
      if (body.application_id) {
        const target = appsById.get(body.application_id);
        if (!target || !canAccessApplication(req.user!, target)) {
          return res.status(400).json({ error: "That application doesn't exist or isn't yours." });
        }
        // Same pool the picker offers: the profiles this email was sent to.
        if (existing.profile_ids.length && !existing.profile_ids.includes(target.resume_profile)) {
          return res.status(400).json({ error: "That application is for a different profile than this email." });
        }
      }

      // Picking an application is itself the confirmation.
      let status = body.match_status ?? (body.application_id ? "confirmed" : undefined);
      let application_id = body.application_id !== undefined ? body.application_id : existing.application_id;
      // These say "no application", so they never keep one.
      if (status === "not_from_tryvera" || status === "ignored") application_id = null;
      // Undo clears the link unless a new one comes with it.
      if (status === "needs_check" && body.application_id === undefined) application_id = null;
      // Removing the link from a linked row reopens it, rather than leaving
      // a "confirmed" row that points at nothing.
      if (!status && !application_id && LINKED.has(existing.match_status)) status = "needs_check";
      if (status === "confirmed" && !application_id) {
        return res.status(400).json({ error: "Pick an application to confirm." });
      }
      if (status === "auto_matched" && !body.application_id) {
        return res.status(400).json({ error: "Auto-matched needs its application." });
      }

      const now = new Date().toISOString();
      const next = upsertInterview(existing.id, (cur) =>
        cur
          ? {
              ...cur,
              application_id,
              ...(status ? { match_status: status, status_by: req.user!.email, status_at: now } : {}),
              ...(body.note !== undefined ? { note: body.note } : {}),
              ...(body.handled !== undefined && body.handled !== cur.handled
                ? {
                    handled: body.handled,
                    handled_at: body.handled ? now : undefined,
                    handled_by: body.handled ? req.user!.email : undefined,
                    // Rejections have no Slack card to update.
                    handled_pending: cur.verdict !== "REJECTION",
                  }
                : {}),
              updated_at: now,
            }
          : null
      );
      if (!next) return res.status(404).json({ error: "Interview not found" });
      res.json({
        ok: true,
        interview: { ...next, application: appSummary(appsById.get(next.application_id ?? ""), req.user!) },
      });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * Done/Reopen clicked in Tryvera that the bot still has to apply to the
   * Slack cards. The bot polls this with the ingest token, updates each card,
   * then acknowledges below.
   */
  app.get("/api/interviews/handled-pending", requireIngestToken, (_req, res) => {
    try {
      const items = listInterviews()
        .filter((ev) => ev.handled_pending)
        .map((ev) => ({ id: ev.id, handled: ev.handled }));
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/interviews/handled-ack", requireIngestToken, (req, res) => {
    try {
      const body = handledAckBody.parse(req.body);
      let cleared = 0;
      for (const item of body.items) {
        upsertInterview(item.id, (cur) => {
          // Clicked again since the bot read it: still pending, the bot will see the new state.
          if (!cur || !cur.handled_pending || cur.handled !== item.handled) return null;
          cleared++;
          return { ...cur, handled_pending: false };
        });
      }
      res.json({ ok: true, cleared });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * Re-run the matcher on every row nobody has decided yet. For after profile
   * emails change or older applications are imported; new emails match on arrival.
   */
  app.post("/api/interviews/rematch", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const [apps, emailMap] = await Promise.all([listApplications(), profilesByEmail()]);
      const now = new Date().toISOString();
      let rematched = 0;
      let matched = 0;
      for (const ev of listInterviews()) {
        if (ev.match_status !== "needs_check" || ev.status_by) continue;
        upsertInterview(ev.id, (cur) => {
          if (!cur) return null;
          const base = { ...cur, profile_ids: emailMap.get(cur.to_addr) ?? [] };
          const m = matchInterview(base, apps);
          rematched++;
          if (m.match_status === "auto_matched") matched++;
          return { ...base, ...m, updated_at: now };
        });
      }
      res.json({ ok: true, rematched, matched });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
