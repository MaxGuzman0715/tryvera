import type { ApplicationLogEntry, InterviewEvent } from "./types.js";
import { normCompany, roleOverlap, rolesConflict, sameCompany } from "./interviewMatch.js";

/**
 * The interview schedule: one row per person + company + role, with a
 * date/time and state for each round (Intro, HR, Tech, Final), built from the
 * hiring emails the triage bot flagged. No model calls: the classifier already
 * named the company, role and request type; this places each email on a row
 * and a round, and reads the time out of calendar invites and the
 * classifier's own date field.
 *
 * Pure: everything it needs is passed in, so it can be re-run at any time and
 * tested against real data.
 */

export const ROUNDS = ["Intro", "HR", "Tech", "Final"] as const;

export type RoundState = "none" | "pending" | "sched" | "wait" | "done" | "failed" | "skipped";
/** Where a round's value came from. "manual" is never overwritten by email. */
export type RoundSource = "" | "email" | "sheet" | "inferred" | "manual";
/**
 * `at`: when this value was set (the email's arrival, or the moment of a hand
 * edit). A hand edit is protected from emails older than it — replaying old
 * mail never undoes a correction — while newer emails still update it.
 */
export type Round = { state: RoundState; date: string; time: string; source: RoundSource; at?: string };

export type ScheduleRow = {
  id: string;
  person: string;
  company: string;
  role: string;
  contact: string;
  /** Tryvera application created_at (YYYY-MM-DD), the sheet's applied date, or "" */
  applied: string;
  application_id: string | null;
  rounds: Round[];
  offer: boolean;
  /** Close reason ("Not remote", "Job ended", …), or null while active. */
  closed: string | null;
  note: string;
  last_activity: string;
  email_ids: string[];
  from_sheet: boolean;
  /** The latest date the sheet itself mentions; emails older than this were already reflected in it. */
  sheet_until: string;
  /** Closed automatically for going quiet (see NO_RESPONSE_DAYS), not by a person. */
  auto_closed?: boolean;
};

/**
 * What a person changed by hand on one row. Rounds listed here win over every
 * email that arrived before the change; newer emails still update them.
 * `closed`: a reason closes the row, null keeps it open (a reopened row is
 * never auto-closed again), absent leaves it to the automatic rules.
 */
export type ScheduleOverride = {
  rounds?: Record<string, Round>;
  closed?: string | null;
  offer?: boolean;
  note?: string;
  updated_at: string;
  updated_by?: string;
};

/** No email and no hand edit for longer than this closes an open row as "No response". */
export const NO_RESPONSE_DAYS = 20;

/** Emails that start or advance a row. Everything else only attaches to an existing one. */
const ROW_KINDS = new Set(["SCHEDULING", "RESCHEDULE", "NEXT_ROUND", "ASSESSMENT", "OFFER"]);
const ACTIVE: RoundState[] = ["pending", "sched", "wait"];

const ROUND_WORDS: [number, RegExp][] = [
  [3, /\bfinal\b|on-?site|\bpanel\b|\bloop\b|last round|super ?day/i],
  [2, /technical|coding|tech(nical)? (screen|interview|round|assessment)|system design|pair(ing)? (programming|session)|live code|take[- ]home|hackerrank|codesignal|codility|coderpad/i],
  [1, /hiring manager|\bhm\b|\bhr\b|people (team|partner)|culture|behaviou?ral|leadership/i],
  [0, /\bintro|recruiter|phone screen|screening call|initial|talent acquisition|first call|quick (call|chat)|exploratory/i],
];

/** Which round an email is about, from its subject and the ask; -1 if it doesn't say. */
export function detectRound(text: string, kind: string | null): number {
  for (const [i, re] of ROUND_WORDS) if (re.test(text)) return i;
  return kind === "ASSESSMENT" ? 2 : -1;
}

/* ---------- dates & times (everything ends up as ET wall time) ---------- */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const TZ_OFFSET: Record<string, number> = {
  edt: -4, est: -5, cdt: -5, cst: -6, mdt: -6, mst: -7, pdt: -7, pst: -8, utc: 0, gmt: 0,
};
// "ET" alone says nothing about daylight time: resolved per date by etOffset.

const pad = (n: number) => String(n).padStart(2, "0");

/** A UTC instant → { date, time } on the ET clock. */
function toET(ms: number): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** UTC offset (hours) of ET on that calendar day. */
function etOffset(y: number, m: number, d: number): number {
  const probe = Date.UTC(y, m - 1, d, 12);
  const et = toET(probe);
  return Number(et.time.slice(0, 2)) - 12;
}

/** An ET wall-clock date and time → the UTC instant (daylight time handled per date). */
export function etMs(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = (time || "23:59").split(":").map(Number);
  return Date.UTC(y, m - 1, d, h - etOffset(y, m, d), mi);
}

/** The ET calendar date an email arrived on (its timestamp is UTC). */
export const etDate = (iso: string): string => toET(Date.parse(iso)).date;

function hour24(h: number, ap?: string): number {
  if (!ap) return h;
  const pm = ap.toLowerCase() === "pm";
  return (h % 12) + (pm ? 12 : 0);
}

/**
 * The year the model wrote is often wrong (2020, 2023 for an interview next
 * week), so the month/day/time are trusted and the year is the one that puts
 * the date nearest after the email arrived.
 */
function fixYear(m: number, d: number, receivedMs: number): number {
  const r = new Date(receivedMs);
  const y = r.getUTCFullYear();
  const candidate = Date.UTC(y, m - 1, d);
  return candidate < receivedMs - 45 * 86400000 ? y + 1 : y;
}

type When = { date: string; time: string };

function build(y: number, m: number, d: number, h: number, min: number, offset: number | null): When {
  const off = offset ?? etOffset(y, m, d);
  return toET(Date.UTC(y, m - 1, d, h - off, min));
}

/** Google/Outlook invite subjects: "… @ Mon Oct 5, 2026 12pm - 12:30pm (EDT)". */
const INVITE_RE = /@\s*(?:mon|tue|wed|thu|fri|sat|sun)\w*\s+([a-z]{3,9})\s+(\d{1,2}),?\s*(\d{4})?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:[^(]*\((\w{2,4})\))?/i;
/** The classifier's ISO-ish date: "2026-10-05T14:30:00-04:00", "2026-10-02 02:30 pm EDT", "2026-10-05 1:30pm (GMT-04:00)". */
const ISO_RE = /(\d{4})-(\d{2})-(\d{2})[T ]\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\s*(?:(Z|[+-]\d{2}:?\d{2})|\(?GMT([+-]\d{2}):?\d{2}\)?|\(?\b(EDT|EST|ET|CDT|CST|MDT|MST|PDT|PST|UTC)\b\)?)?/i;

/** "Canceled event: … @ Mon Oct 5 …" names the slot that is now gone. */
export const CANCELLED_RE = /^\s*(?:(?:re|fwd?):\s*)*(cancel+ed|declined)\b/i;

export function parseInvite(subject: string, receivedMs: number): When | null {
  if (CANCELLED_RE.test(subject)) return null;
  const m = INVITE_RE.exec(subject);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  const day = Number(m[2]);
  const year = m[3] ? Number(m[3]) : fixYear(mon, day, receivedMs);
  const tz = m[7]?.toLowerCase();
  return build(year, mon, day, hour24(Number(m[4]), m[6]), Number(m[5] ?? 0), tz ? TZ_OFFSET[tz] ?? null : null);
}

export function parseIsoish(s: string, receivedMs: number): When | null {
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const mon = Number(m[2]);
  const day = Number(m[3]);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  let offset: number | null = null;
  if (m[7]) offset = m[7].toUpperCase() === "Z" ? 0 : Number(m[7].slice(0, 3));
  else if (m[8]) offset = Number(m[8]);
  else if (m[9]) offset = TZ_OFFSET[m[9].toLowerCase()] ?? null;
  return build(fixYear(mon, day, receivedMs), mon, day, hour24(Number(m[4]), m[6]), Number(m[5]), offset);
}

/** Wording that means a time is fixed, not just proposed. */
const BOOKED_RE = /invitation|invite|confirm(ed|ation)\b|is scheduled|has been scheduled|scheduled for|details for connecting|reminder|video interview|interview -|join (the|your)|attend/i;
const PROPOSED_RE = /availability|choose a time|pick a (slot|time)|propose|select a time|book a time|schedule a (call|meeting|time)|calendly|let me know/i;

/**
 * The interview time an email fixes, if any. An invite in the subject is
 * always a booked time. The classifier's date field counts only when the email
 * reads as a confirmation — otherwise it is often a reply-by date.
 */
export function extractWhen(ev: Pick<InterviewEvent, "subject" | "deadline" | "asked" | "received_at">): When | null {
  const receivedMs = Date.parse(ev.received_at);
  const inv = parseInvite(ev.subject, receivedMs);
  if (inv) return inv;
  const text = `${ev.subject} ${ev.asked}`;
  if (!ev.deadline || !BOOKED_RE.test(text) || (PROPOSED_RE.test(ev.asked) && !/attend|join/i.test(ev.asked))) return null;
  const w = parseIsoish(ev.deadline, receivedMs);
  if (!w) return null;
  // A meeting "booked" for before the email arrived, or months out, is a misread.
  const at = etMs(w.date, w.time);
  if (at < receivedMs - 86400000 || at > receivedMs + 90 * 86400000) return null;
  return w;
}

/* ---------- the sheet you kept by hand ---------- */

/** One row of the Google Sheet tab, columns as exported. */
export type SheetRow = [
  company: string, role: string, contact: string, status: string, applied: string,
  introD: string, introT: string, hrD: string, hrT: string, techD: string, techT: string,
  finalD: string, finalT: string, note: string,
];

/** "9/22" → "2026-09-22". With no year, the year that keeps the date from being far in the future. */
function sheetDate(s: string, todayIso: string): string {
  const m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/.exec(s || "");
  if (!m) return "";
  const mon = Number(m[1]);
  const day = Number(m[2]);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return "";
  const md = `${pad(mon)}-${pad(day)}`;
  if (m[3]) return `${m[3]}-${md}`;
  // The year that puts the date nearest today, but not more than 60 days ahead
  // ("1/5" pasted on Dec 20 is next January; "9/22" pasted in October is this year).
  const y = Number(todayIso.slice(0, 4));
  const today = Date.parse(todayIso);
  const best = [y - 1, y, y + 1]
    .map((yy) => ({ yy, t: Date.parse(`${yy}-${md}`) }))
    .filter((c) => Number.isFinite(c.t) && c.t <= today + 60 * 86400000)
    .sort((a, b) => Math.abs(a.t - today) - Math.abs(b.t - today))[0];
  return best ? `${best.yy}-${md}` : "";
}
function sheetTime(s: string): string {
  const m = /(\d{1,2})\s*:\s*(\d{2})/.exec(s || "");
  return m ? `${pad(Number(m[1]))}:${m[2]}` : "";
}

/**
 * A range pasted from Google Sheets: tab-separated, a cell holding a line
 * break or tab is quoted. Header rows are dropped. Some pastes lose the quotes
 * around a cell that ends in a line break ("Riya<riya@clio.com>⏎⇥Intro
 * Pending"): a record that stops after a few cells and is followed by one
 * starting with an empty cell is the same row continued.
 */
export function parseSheetTsv(tsv: string): SheetRow[] {
  const records: string[][] = [];
  let rec: string[] = [];
  let cell = "";
  let quoted = false;
  const text = tsv.replace(/\r\n?/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === "\t") { rec.push(cell); cell = ""; }
    else if (c === "\n") { rec.push(cell); records.push(rec); rec = []; cell = ""; }
    else cell += c;
  }
  if (cell || rec.length) { rec.push(cell); records.push(rec); }

  const merged: string[][] = [];
  for (let i = 0; i < records.length; i++) {
    let r = records[i];
    while (r.filter((x) => x.trim()).length > 0 && r.length <= 3 && records[i + 1] && records[i + 1][0] === "") {
      r = r.concat(records[i + 1].slice(1));
      i++;
    }
    merged.push(r);
  }
  return merged
    .filter((r) => r[0]?.trim() && !/^company$/i.test(r[0].trim()))
    .map((r) => {
      const cells = r.map((x) => x.trim());
      const note = cells.slice(13).filter(Boolean).join(" · ");
      const row = Array.from({ length: 13 }, (_, k) => cells[k] ?? "");
      return [...row, note] as SheetRow;
    });
}

const CLOSE_NOTE = /\((not remote|low budget|job ended|[^)]*low budget[^)]*)\)/i;

export function rowsFromSheet(person: string, sheet: SheetRow[], todayIso: string): ScheduleRow[] {
  const seen = new Set<string>();
  const out: ScheduleRow[] = [];
  for (const r of sheet) {
    const [company, role, contact, statusRaw, appliedRaw] = r;
    if (!company.trim()) continue;
    const dupKey = `${normCompany(company)}|${role.trim().toLowerCase()}`;
    if (seen.has(dupKey)) continue; // the sheet lists some rows twice
    seen.add(dupKey);

    const pairs: [string, string][] = [[r[5], r[6]], [r[7], r[8]], [r[9], r[10]], [r[11], r[12]]];
    const rounds: Round[] = pairs.map(([d, t]) => {
      const date = sheetDate(d, todayIso);
      return { state: date ? "done" : "none", date, time: date ? sheetTime(t) : "", source: date ? "sheet" : "" };
    });
    const notes: string[] = [];
    let closed: string | null = null;
    // Free text that landed in a date column ("(Not Remote)", "Hybrid(Negotiable)").
    for (const [d] of pairs) if (d && !sheetDate(d, todayIso)) notes.push(d.trim());
    if (r[13]) notes.push(r[13].trim());
    for (const n of notes) {
      const c = CLOSE_NOTE.exec(n);
      if (c) closed = c[1].toLowerCase().includes("budget") ? "Low budget" : c[1][0].toUpperCase() + c[1].slice(1).toLowerCase();
    }

    // "HR Pending" in the sheet means: HR happened, waiting to hear back.
    const st = /(intro|hr|technical|tech|final)\s+(pending|scheduled|passed)/i.exec(statusRaw);
    if (st) {
      const k = { intro: 0, hr: 1, technical: 2, tech: 2, final: 3 }[st[1].toLowerCase() as "intro"]!;
      const what = st[2].toLowerCase();
      for (let j = 0; j < k; j++) if (rounds[j].state === "none") rounds[j] = { state: "skipped", date: "", time: "", source: "sheet" };
      const cur = rounds[k];
      if (what === "passed") {
        cur.state = "done";
        cur.source = "sheet";
        if (k < 3 && rounds[k + 1].state === "none") rounds[k + 1] = { state: "pending", date: "", time: "", source: "inferred" };
      } else if (cur.date) {
        cur.state = what === "scheduled" && cur.date >= todayIso ? "sched" : "wait";
      } else {
        cur.state = "pending";
        cur.source = "sheet";
      }
      // Rounds after the current one can't have happened yet.
      for (let j = k + 1; j < 4; j++) if (rounds[j].state === "done" && what !== "passed") rounds[j].state = "sched";
    }
    const allDates = [sheetDate(appliedRaw, todayIso), ...rounds.map((x) => x.date)].filter(Boolean).sort();
    out.push({
      id: `sheet:${person}:${dupKey}`,
      person,
      company: company.trim(),
      role: role.trim(),
      contact: contact.trim(),
      applied: sheetDate(appliedRaw, todayIso),
      application_id: null,
      rounds,
      offer: false,
      closed,
      note: notes.filter((n) => !CLOSE_NOTE.test(n)).join(" · "),
      last_activity: allDates[allDates.length - 1] ?? "",
      email_ids: [],
      from_sheet: true,
      // Emails after the import day are always news, even before a future date the sheet lists.
      sheet_until: [allDates[allDates.length - 1] ?? "", todayIso].sort()[0],
    });
  }
  return out;
}

/* ---------- emails → rows ---------- */

export type BuildInput = {
  events: InterviewEvent[];
  apps: ApplicationLogEntry[];
  /** Rows imported from the sheet, possibly already fixed by hand. */
  base: ScheduleRow[];
  /** Person label for an email (from its recipient profiles). */
  personOf: (ev: InterviewEvent) => string;
  overrides: Map<string, ScheduleOverride>;
  nowMs: number;
  /** Today on the ET calendar, YYYY-MM-DD. */
  todayIso: string;
};

export type BuildResult = { rows: ScheduleRow[]; unplaced: InterviewEvent[] };

function findRow(rows: ScheduleRow[], person: string, ev: InterviewEvent): ScheduleRow | undefined {
  const cands = rows.filter(
    (r) => r.person === person && sameCompany(r.company, ev.company) && !(ev.role && r.role && rolesConflict(ev.role, r.role))
  );
  if (cands.length <= 1) return cands[0];
  return cands
    .map((r) => ({ r, s: roleOverlap(ev.role, r.role) }))
    .sort((a, b) => b.s - a.s || b.r.last_activity.localeCompare(a.r.last_activity))[0].r;
}

/** A hand edit wins over emails that arrived before it, not over newer ones. */
const lockedFor = (x: Round, evAt: string) => x.source === "manual" && evAt <= (x.at ?? "");

function setRound(row: ScheduleRow, k: number, next: Partial<Round>, evAt: string): void {
  const cur = row.rounds[k];
  if (lockedFor(cur, evAt)) return;
  row.rounds[k] = { ...cur, ...next, source: "email", at: evAt };
}

/** Everything before round k is behind you: passed if it happened, skipped if it never did. */
function settleBefore(row: ScheduleRow, k: number, evAt: string): void {
  for (let j = 0; j < k; j++) {
    const x = row.rounds[j];
    if (lockedFor(x, evAt)) continue;
    if (ACTIVE.includes(x.state)) row.rounds[j] = { ...x, state: x.date ? "done" : "skipped", source: x.source === "manual" ? "email" : x.source || "inferred", at: evAt };
    else if (x.state === "none") row.rounds[j] = { state: "skipped", date: "", time: "", source: "inferred", at: evAt };
  }
}

const highest = (row: ScheduleRow, states: RoundState[]) => {
  for (let k = 3; k >= 0; k--) if (states.includes(row.rounds[k].state)) return k;
  return -1;
};

function applyEvent(row: ScheduleRow, ev: InterviewEvent, nowMs: number, ov: ScheduleOverride | undefined): void {
  const evAt = ev.received_at;
  const day = etDate(evAt);
  row.email_ids.push(ev.id);
  if (day > row.last_activity) row.last_activity = day;
  // The sheet already reflects what happened up to the day it was imported.
  if (row.from_sheet && day <= row.sheet_until) return;

  if (ev.verdict === "REJECTION") {
    // After an offer, "rejection" mail is onboarding text tripping the
    // rejection filter ("Preparing for your first day…"), not a rejection.
    if (row.offer) return;
    const k = Math.max(0, highest(row, ["pending", "sched", "wait", "done"]));
    setRound(row, k, { state: "failed" }, evAt);
    return;
  }
  if (ev.verdict !== "ACTION") return;

  if (ev.kind === "OFFER") {
    // An offer a person took back by hand stays taken back for older mail.
    if (ov?.offer === false && evAt <= ov.updated_at) return;
    row.offer = true;
    // Rounds up to the latest one that happened are behind you; later ones simply never happened.
    settleBefore(row, highest(row, ["pending", "sched", "wait", "done"]) + 1, evAt);
    return;
  }
  if (ev.kind === "NEXT_ROUND") {
    const k = highest(row, ["pending", "sched", "wait", "done"]);
    if (k < 3) {
      settleBefore(row, k + 1, evAt);
      if (row.rounds[k + 1].state === "none") setRound(row, k + 1, { state: "pending", date: "", time: "" }, evAt);
    }
    return;
  }
  if (!ROW_KINDS.has(ev.kind ?? "")) return;

  const active = highest(row, ["pending", "sched", "wait"]);
  // A cancelled invite: the slot is gone, the round needs a new time.
  if (CANCELLED_RE.test(ev.subject)) {
    if (active >= 0 && row.rounds[active].state === "sched") setRound(row, active, { state: "pending", date: "", time: "" }, evAt);
    return;
  }

  const when = extractWhen(ev);
  const reached = highest(row, ["pending", "sched", "wait", "done"]);
  // Only the subject and the ask: the classifier's free-text "reason" mentions
  // "recruiter" or "on-site" in passing and would drag emails to the wrong round.
  let k = detectRound(`${ev.subject} ${ev.asked}`, ev.kind);
  if (ev.kind === "RESCHEDULE" && active >= 0) k = active; // a new time for the same round
  else if (k >= 0 && k < reached) k = -1; // keywords may move forward, never back over rounds already reached
  if (k < 0) {
    const done = highest(row, ["done", "skipped"]);
    if (active >= 0) {
      const a = row.rounds[active];
      // A new time after the last one already happened is the next round; otherwise it's this round (re)booked.
      const happened = a.date && etMs(a.date, a.time) < Date.parse(evAt);
      k = happened && a.state !== "pending" && active < 3 ? active + 1 : active;
    } else {
      k = Math.min(3, done + 1);
    }
  }
  settleBefore(row, k, evAt);
  if (when) {
    setRound(row, k, { state: etMs(when.date, when.time) < nowMs ? "wait" : "sched", date: when.date, time: when.time }, evAt);
  } else if (row.rounds[k].state === "none" || row.rounds[k].state === "skipped") {
    setRound(row, k, { state: "pending", date: "", time: "" }, evAt);
  }
}

/** Hand changes go in before any email, so applyEvent knows what each one protects. */
function lockRounds(row: ScheduleRow, ov: ScheduleOverride | undefined): ScheduleRow {
  if (!ov) return row;
  for (const [k, r] of Object.entries(ov.rounds ?? {})) {
    const i = Number(k);
    if (i >= 0 && i < 4) row.rounds[i] = { ...r, source: "manual", at: r.at ?? ov.updated_at };
  }
  // Before the emails, so a hand-set offer also mutes the rejection filter.
  if (ov.offer !== undefined) row.offer = ov.offer;
  return row;
}

export function buildSchedule(input: BuildInput): BuildResult {
  const rows: ScheduleRow[] = input.base.map((r) =>
    lockRounds({ ...r, rounds: r.rounds.map((x) => ({ ...x })), email_ids: [...r.email_ids] }, input.overrides.get(r.id))
  );
  const appsById = new Map(input.apps.map((a) => [a.id, a]));
  const unplaced: InterviewEvent[] = [];
  const ordered = [...input.events]
    .filter((e) => e.match_status !== "ignored")
    .sort((a, b) => a.received_at.localeCompare(b.received_at));

  for (const ev of ordered) {
    const person = input.personOf(ev);
    const startsRow = ev.verdict === "ACTION" && ROW_KINDS.has(ev.kind ?? "");
    if (!normCompany(ev.company)) {
      if (startsRow) unplaced.push(ev);
      continue;
    }
    let row = findRow(rows, person, ev);
    if (!row) {
      if (!startsRow) continue;
      const app = ev.application_id && ["auto_matched", "confirmed"].includes(ev.match_status) ? appsById.get(ev.application_id) : undefined;
      row = {
        id: `mail:${ev.id}`,
        person,
        company: ev.company,
        role: ev.role,
        contact: ev.sender,
        applied: app ? app.created_at.slice(0, 10) : "",
        application_id: app?.id ?? null,
        rounds: ROUNDS.map(() => ({ state: "none" as RoundState, date: "", time: "", source: "" as RoundSource })),
        offer: false,
        closed: null,
        note: "",
        last_activity: etDate(ev.received_at),
        email_ids: [],
        from_sheet: false,
        sheet_until: "",
      };
      lockRounds(row, input.overrides.get(row.id));
      rows.push(row);
    }
    if (!row.application_id && ev.application_id && ["auto_matched", "confirmed"].includes(ev.match_status)) {
      const app = appsById.get(ev.application_id);
      if (app) {
        row.application_id = app.id;
        if (!row.applied) row.applied = app.created_at.slice(0, 10);
      }
    }
    if (!row.role && ev.role) row.role = ev.role;
    applyEvent(row, ev, input.nowMs, input.overrides.get(row.id));
  }

  const quietSince = new Date(Date.parse(input.todayIso) - NO_RESPONSE_DAYS * 86400000).toISOString().slice(0, 10);
  for (const row of rows) {
    const ov = input.overrides.get(row.id);
    if (ov?.note !== undefined) row.note = ov.note;
    if (ov && ov.closed !== undefined) row.closed = ov.closed;
    if (ov && etDate(ov.updated_at) > row.last_activity) row.last_activity = etDate(ov.updated_at);

    // Time passes: a booked interview whose time has gone by now needs a result.
    for (const x of row.rounds) {
      if (x.state === "sched" && x.date && etMs(x.date, x.time) < input.nowMs) x.state = "wait";
    }

    // Gone quiet: no email and no hand edit for more than NO_RESPONSE_DAYS, and
    // nothing booked ahead. Not when a person has set the row open or closed.
    const upcoming = row.rounds.some((x) => x.state === "sched");
    const failed = row.rounds.some((x) => x.state === "failed");
    if (ov?.closed === undefined && !row.closed && !row.offer && !failed && !upcoming && row.last_activity && row.last_activity < quietSince) {
      row.closed = "No response";
      row.auto_closed = true;
    }
  }
  return { rows, unplaced };
}
