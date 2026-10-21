import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { canAccessProfile, requireAdmin, requireAuth } from "./auth/middleware.js";
import { listApplications } from "./logStore.js";
import { listProfiles, readProfile } from "./profileStore.js";
import { listInterviews } from "./interviewStore.js";
import {
  buildSchedule,
  parseSheetTsv,
  ROUNDS,
  rowsFromSheet,
  type Round,
  type ScheduleRow,
} from "./scheduleBuild.js";
import { addBaseRow, getOverride, getSeen, listBase, listOverrides, mergeOverride, replaceSheetRows, setOverride, setSeen } from "./scheduleStore.js";
import type { ScheduleOverride } from "./scheduleBuild.js";
import type { User } from "./types.js";

/**
 * The Schedule tab: one row per person + company + role with a date and state
 * per round, rebuilt on every request from the interview emails, the sheets
 * people imported, and their hand edits (scheduleBuild.ts).
 *
 * A "person" is an inbox: the recipient address the triage bot saw, shared by
 * every profile that uses it (hansal_maniar and hansal_maniar_ai). Who can see
 * a row follows profile access, as on the Interviews page.
 */

type Person = { key: string; label: string; profile_ids: string[] };

const todayEt = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

let peopleCache: { at: number; map: Map<string, Person> } | null = null;

/** Inbox address → person, cached for a minute: it reads every profile file. */
async function people(): Promise<Map<string, Person>> {
  if (peopleCache && Date.now() - peopleCache.at < 60_000) return peopleCache.map;
  const map = await loadPeople();
  peopleCache = { at: Date.now(), map };
  return map;
}

/** Labelled by first name; the full name only when two people share one. */
async function loadPeople(): Promise<Map<string, Person>> {
  const byEmail = new Map<string, { names: string[]; ids: string[] }>();
  for (const { id } of await listProfiles()) {
    const p = await readProfile(id);
    const email = p?.basic.email?.trim().toLowerCase();
    if (!p || !email) continue;
    const cur = byEmail.get(email) ?? { names: [], ids: [] };
    cur.names.push(p.basic.fullName.trim());
    cur.ids.push(id);
    byEmail.set(email, cur);
  }
  const firsts = [...byEmail.values()].map((v) => v.names[0].split(/\s+/)[0]);
  const out = new Map<string, Person>();
  for (const [email, v] of byEmail) {
    const first = v.names[0].split(/\s+/)[0];
    out.set(email, { key: email, label: firsts.filter((f) => f === first).length > 1 ? v.names[0] : first, profile_ids: v.ids });
  }
  return out;
}

const canSeePerson = (user: User, p: Person | undefined) =>
  user.role === "admin" || Boolean(p && p.profile_ids.some((id) => canAccessProfile(user, id)));

const KIND_LABEL: Record<string, string> = {
  SCHEDULING: "Scheduling",
  RESCHEDULE: "Rescheduling",
  NEXT_ROUND: "Next round",
  ASSESSMENT: "Assessment",
  OFFER: "Offer",
  SCREENING_QUESTION: "Question to answer",
  DOCUMENT_REQUEST: "Send something",
  OTHER: "Needs a look",
};

async function build() {
  const [apps, persons] = await Promise.all([listApplications(), people()]);
  const events = listInterviews();
  const today = todayEt();
  const { rows, unplaced } = buildSchedule({
    events,
    apps,
    base: listBase(),
    overrides: listOverrides(),
    personOf: (ev) => ev.to_addr,
    nowMs: Date.now(),
    todayIso: today,
  });
  return { rows, unplaced, events: new Map(events.map((e) => [e.id, e])), persons, today };
}

type Built = Awaited<ReturnType<typeof build>>;

/**
 * The Inbox's "Needs your attention": open hiring emails the schedule can't
 * show for you. A scheduling email it couldn't place (no company, or sent to
 * an inbox no profile uses), at any age, since nothing else will surface it;
 * or one from the last week that asks for something (documents, answers, a
 * test, an offer to answer). Marking one Done or Ignored takes it off.
 */
const ATTENTION_DAYS = 7;
const ASK_KINDS = new Set(["DOCUMENT_REQUEST", "SCREENING_QUESTION", "ASSESSMENT", "OFFER", "OTHER"]);
export type Attention = "not_placed" | "asks";

function attentionOf(b: Built): Map<string, Attention> {
  const unplaced = new Set(b.unplaced.map((e) => e.id));
  for (const r of b.rows) if (!b.persons.has(r.person)) for (const id of r.email_ids) unplaced.add(id);
  const since = Date.now() - ATTENTION_DAYS * 86400_000;
  const out = new Map<string, Attention>();
  for (const e of b.events.values()) {
    if (e.handled || e.verdict !== "ACTION" || e.match_status === "ignored") continue;
    if (unplaced.has(e.id)) out.set(e.id, "not_placed");
    else if (ASK_KINDS.has(e.kind ?? "") && Date.parse(e.received_at) >= since) out.set(e.id, "asks");
  }
  return out;
}

const visibleEvent = (user: User, b: Built, id: string) => {
  const e = b.events.get(id);
  return Boolean(e && canSeePerson(user, b.persons.get(e.to_addr)));
};

function present(row: ScheduleRow, b: Built) {
  const emails = row.email_ids
    .map((id) => b.events.get(id))
    .filter((e) => e !== undefined)
    .sort((x, y) => y.received_at.localeCompare(x.received_at))
    .slice(0, 12)
    .map((e) => ({
      id: e.id,
      received_at: e.received_at,
      kind: e.verdict === "REJECTION" ? "Rejection" : e.verdict === "MAYBE" ? "Maybe" : KIND_LABEL[e.kind ?? ""] ?? "Needs a look",
      subject: e.subject,
      permalink: e.permalink,
    }));
  return { ...row, person_label: b.persons.get(row.person)?.label ?? row.person, emails };
}

const roundBody = z.object({
  state: z.enum(["none", "ask", "pending", "sched", "wait", "done", "failed", "skipped"]),
  date: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  time: z.string().regex(/^(\d{2}:\d{2})?$/),
});

/**
 * Undo, kept on the server: a change hands back a one-time token, and undoing
 * puts back exactly what was there before. The page never sends override
 * content of its own, so it can't forge who changed what or when.
 */
const undoTokens = new Map<string, { rowId: string; userId: string; previous: ScheduleOverride | null; expires: number }>();
const UNDO_MS = 10 * 60_000;

function issueUndo(rowId: string, userId: string, previous: ScheduleOverride | null): string {
  const now = Date.now();
  for (const [k, v] of undoTokens) if (v.expires < now) undoTokens.delete(k);
  const token = randomUUID();
  undoTokens.set(token, { rowId, userId, previous, expires: now + UNDO_MS });
  return token;
}

/** Undo for a bulk change: every row's hand changes as they were before it. */
const bulkUndoTokens = new Map<string, { userId: string; items: { rowId: string; previous: ScheduleOverride | null }[]; expires: number }>();

/**
 * A row that only exists because of an email gets a fixed home on its first
 * hand edit, so the edit stays attached even if that first email is later
 * ignored or an older one turns up.
 */
function materialize(row: ScheduleRow): void {
  if (!row.id.startsWith("mail:") || listBase().some((r) => r.id === row.id)) return;
  addBaseRow({
    ...row,
    rounds: ROUNDS.map(() => ({ state: "none", date: "", time: "", source: "" })),
    email_ids: [],
    offer: false,
    closed: null,
    note: "",
    auto_closed: undefined,
    changes: undefined,
    removed: undefined,
    task: undefined,
    since: undefined,
  });
}

const patchBody = z.object({
  rounds: z.record(z.enum(["0", "1", "2", "3"]), roundBody).optional(),
  closed: z.string().trim().min(1).max(80).nullable().optional(),
  offer: z.boolean().optional(),
  note: z.string().max(2000).optional(),
  removed: z.boolean().optional(),
});

export function registerScheduleRoutes(app: Express): void {
  app.get("/api/schedule", requireAuth, async (req, res) => {
    try {
      const b = await build();
      const visible = b.rows.filter((r) => b.persons.has(r.person) && canSeePerson(req.user!, b.persons.get(r.person)));
      const counts = new Map<string, number>();
      for (const r of visible) if (!r.removed) counts.set(r.person, (counts.get(r.person) ?? 0) + 1);
      res.json({
        today: b.today,
        seen_at: getSeen(req.user!.id),
        rounds: ROUNDS,
        rows: visible.map((r) => present(r, b)),
        people: [...counts.keys()].map((k) => ({ key: k, label: b.persons.get(k)!.label, count: counts.get(k) })),
        // People the user may add rows for or import a sheet for, with rows or not.
        all_people: [...b.persons.values()]
          .filter((p) => canSeePerson(req.user!, p))
          .map((p) => ({ key: p.key, label: p.label })),
        // The same emails the Inbox lists as "Not on the schedule", so the link and the list agree.
        unplaced: [...attentionOf(b)].filter(([id, why]) => why === "not_placed" && visibleEvent(req.user!, b, id)).length,
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** "Mark all seen": nothing before now counts as New for this person any more. */
  app.post("/api/schedule/seen", requireAuth, (req, res) => {
    const at = new Date().toISOString();
    setSeen(req.user!.id, at);
    res.json({ ok: true, seen_at: at });
  });

  /** How many rows have news since this person last looked: the sidebar badge. */
  app.get("/api/schedule/new-count", requireAuth, async (req, res) => {
    try {
      const b = await build();
      const seen = getSeen(req.user!.id);
      const count = b.rows.filter(
        (r) => !r.removed && b.persons.has(r.person) && canSeePerson(req.user!, b.persons.get(r.person)) && (r.changes ?? []).some((c) => c.at > seen)
      ).length;
      const attention = [...attentionOf(b).keys()].filter((id) => visibleEvent(req.user!, b, id)).length;
      res.json({ count, seen_at: seen, attention });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * For the Inbox: which schedule row each email landed on (to link to it),
   * and which emails need attention and why.
   */
  app.get("/api/schedule/email-map", requireAuth, async (req, res) => {
    try {
      const b = await build();
      const placed: Record<string, { row: string; company: string }> = {};
      for (const r of b.rows) {
        if (!b.persons.has(r.person) || !canSeePerson(req.user!, b.persons.get(r.person))) continue;
        for (const id of r.email_ids) placed[id] = { row: r.id, company: r.company };
      }
      const attention: Record<string, Attention> = {};
      for (const [id, why] of attentionOf(b)) if (visibleEvent(req.user!, b, id)) attention[id] = why;
      res.json({ placed, attention, attention_days: ATTENTION_DAYS });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** A hand change. Only the rounds sent are locked; the rest keep following email. */
  app.put<{ id: string }>("/api/schedule/:id", requireAuth, async (req, res) => {
    try {
      const body = patchBody.parse(req.body);
      const before = await build();
      const row = before.rows.find((r) => r.id === req.params.id);
      if (!row || !canSeePerson(req.user!, before.persons.get(row.person))) {
        return res.status(404).json({ error: "Row not found" });
      }
      const previous = getOverride(row.id) ?? null;
      materialize(row);
      const now = new Date().toISOString();
      mergeOverride(row.id, (cur) => ({
        ...cur,
        rounds: {
          ...(cur?.rounds ?? {}),
          ...Object.fromEntries(Object.entries(body.rounds ?? {}).map(([k, v]) => [k, { ...v, source: "manual", at: now } as Round])),
        },
        ...(body.closed !== undefined ? { closed: body.closed } : {}),
        ...(body.offer !== undefined ? { offer: body.offer } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.removed !== undefined ? { removed: body.removed ? now : null } : {}),
        updated_at: now,
        updated_by: req.user!.email,
      }));
      const after = await build();
      const next = after.rows.find((r) => r.id === row.id);
      res.json({ ok: true, row: next ? present(next, after) : null, undo: issueUndo(row.id, req.user!.id, previous) });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ id: string }>("/api/schedule/:id/restore", requireAuth, async (req, res) => {
    try {
      const { token } = z.object({ token: z.string().min(1) }).parse(req.body);
      const u = undoTokens.get(token);
      if (!u || u.rowId !== req.params.id || u.userId !== req.user!.id || u.expires < Date.now()) {
        return res.status(410).json({ error: "This change can no longer be undone." });
      }
      undoTokens.delete(token);
      setOverride(u.rowId, u.previous);
      const after = await build();
      const next = after.rows.find((r) => r.id === u.rowId);
      res.json({ ok: true, row: next ? present(next, after) : null });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Remove (or put back) several rows at once, from the checkboxes. One Undo puts them all back. */
  app.post("/api/schedule/bulk-remove", requireAuth, async (req, res) => {
    try {
      const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(500), removed: z.boolean() }).parse(req.body);
      const b = await build();
      const want = new Set(body.ids);
      const rows = b.rows.filter((r) => want.has(r.id) && canSeePerson(req.user!, b.persons.get(r.person)));
      const now = new Date().toISOString();
      const items = rows.map((row) => {
        const previous = getOverride(row.id) ?? null;
        materialize(row);
        mergeOverride(row.id, (cur) => ({ ...cur, removed: body.removed ? now : null, updated_at: now, updated_by: req.user!.email }));
        return { rowId: row.id, previous };
      });
      for (const [k, v] of bulkUndoTokens) if (v.expires < Date.now()) bulkUndoTokens.delete(k);
      const undo = randomUUID();
      bulkUndoTokens.set(undo, { userId: req.user!.id, items, expires: Date.now() + UNDO_MS });
      res.json({ ok: true, count: items.length, undo });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/schedule/bulk-restore", requireAuth, (req, res) => {
    try {
      const { token } = z.object({ token: z.string().min(1) }).parse(req.body);
      const u = bulkUndoTokens.get(token);
      if (!u || u.userId !== req.user!.id || u.expires < Date.now()) {
        return res.status(410).json({ error: "This change can no longer be undone." });
      }
      bulkUndoTokens.delete(token);
      for (const it of u.items) setOverride(it.rowId, it.previous);
      res.json({ ok: true, count: u.items.length });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Add a row by hand (an interview that never came through the inbox). */
  app.post("/api/schedule/rows", requireAuth, async (req, res) => {
    try {
      const body = z
        .object({
          person: z.string().min(3),
          company: z.string().trim().min(1).max(200),
          role: z.string().trim().max(300).default(""),
          contact: z.string().trim().max(300).default(""),
        })
        .parse(req.body);
      const persons = await people();
      const person = persons.get(body.person.toLowerCase());
      if (!person || !canSeePerson(req.user!, person)) return res.status(400).json({ error: "Unknown person" });
      const today = todayEt();
      addBaseRow({
        id: `manual:${randomUUID()}`,
        person: person.key,
        company: body.company,
        role: body.role,
        contact: body.contact,
        applied: "",
        application_id: null,
        rounds: ROUNDS.map(() => ({ state: "none", date: "", time: "", source: "" })),
        offer: false,
        closed: null,
        note: "",
        last_activity: today,
        email_ids: [],
        from_sheet: false,
        sheet_until: "",
      });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Paste a person's Google Sheet tab. Replaces that person's earlier import; hand edits stay. */
  app.post("/api/schedule/import", requireAuth, requireAdmin, async (req, res) => {
    try {
      // Under express.json's 2mb limit, so an oversized paste gets this message, not a bare 413.
      const body = z.object({ person: z.string().min(3), tsv: z.string().min(1).max(1_000_000) }).parse(req.body);
      const persons = await people();
      const person = persons.get(body.person.toLowerCase());
      if (!person) return res.status(400).json({ error: "Unknown person" });
      const rows = rowsFromSheet(person.key, parseSheetTsv(body.tsv), todayEt());
      replaceSheetRows(person.key, rows);
      res.json({ ok: true, imported: rows.length });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
