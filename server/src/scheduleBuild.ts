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

/**
 * ask: they asked you to book a time (your move). pending: the round is
 * expected but nothing is asked of you (waiting on them). sched: booked.
 * wait: the time has passed, no result yet.
 */
export type RoundState = "none" | "ask" | "pending" | "sched" | "wait" | "done" | "failed" | "skipped";
/** Where a round's value came from. "manual" is never overwritten by email. */
export type RoundSource = "" | "email" | "sheet" | "inferred" | "manual";
/**
 * `at`: when this value was set (the email's arrival, or the moment of a hand
 * edit). A hand edit is protected from emails older than it — replaying old
 * mail never undoes a correction — while newer emails still update it.
 */
export type Round = {
  state: RoundState; date: string; time: string; source: RoundSource; at?: string;
  /**
   * With "ask": reschedule = a booked time fell through (cancelled, or they
   * asked to move it); confirm = they offered a time, you say yes or no.
   */
  why?: "reschedule" | "confirm";
};

/** An assessment or take-home waiting on you. Not an interview round. */
export type RowTask = { kind: "assessment"; asked: string; at: string; email_id: string };

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
  /** Taken off the schedule by a person (a misread email, a duplicate). Kept, just hidden. */
  removed?: boolean;
  /** What each email did to this row, oldest first: what "New" on the page is made of. */
  changes?: RowChange[];
  /** An open assessment / take-home from email, until it's marked done or the process moves on. */
  task?: RowTask | null;
  /**
   * A row an email started that was later stored (on its first hand edit)
   * takes only emails from that first email on: older mail from the same
   * company belongs to an earlier application (Twilio's October rejection
   * must not reject the new Oct 21 invite once it's edited).
   */
  since?: string;
};

/**
 * One email's effect on a row. new: the email started the row; booked: a
 * round got its first time; time: a booked time moved; cancelled: a booked
 * slot was cancelled; rejected / offer / advanced: as named; email: it
 * arrived but changed nothing on the row.
 */
export type RowChange = { at: string; what: "new" | "booked" | "time" | "cancelled" | "ask" | "assessment" | "rejected" | "offer" | "advanced" | "email"; round?: number };

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
  /** When a person removed the row from the schedule; null = put back. */
  removed?: string | null;
  updated_at: string;
  updated_by?: string;
};

/** No email and no hand edit for longer than this closes an open row as "No response". */
export const NO_RESPONSE_DAYS = 20;

/** Emails that start or advance a row. Everything else only attaches to an existing one. */
const ROW_KINDS = new Set(["SCHEDULING", "RESCHEDULE", "NEXT_ROUND", "ASSESSMENT", "OFFER"]);
const ACTIVE: RoundState[] = ["ask", "pending", "sched", "wait"];
/** Rounds that have started (active) or been passed. */
const REACHED: RoundState[] = [...ACTIVE, "done"];

/**
 * The email asks you to book or propose a time: "Select a time…", "Share
 * availability…", "Confirm if Friday works…". Checked against every real
 * ask; "Wait for the email asking for availability" is waiting, not asking.
 */
const ASK_RE = /availab|calendly|find (a|another) time|another time|time ?slots?|booking link|proposed times?|provided times|\b(book|select|choose|pick|grab|share|provide|suggest|propose|submit|send|give|offer|let us know|reply with)\b[^.;]{0,40}\b(times?|slots?|dates?|days?)\b|\b(book|schedule|arrange|set up|set-up)\b[^.;]{0,30}\b(call|interview|chat|meeting|time|screen|conversation)\b|respond to schedule|\bconfirm if\b[^.;]{0,50}\bworks?\b|confirm (the )?(new|updated|rescheduled) (meeting |interview )?time|(^|and )reschedul\w* (the |this |our )?(call|meeting|interview|conversation)/i;
export const asksToBook = (asked: string) => !/^\s*wait\b/i.test(asked) && ASK_RE.test(asked);

/** The ask is "confirm the time we offered" rather than "pick a time". */
const CONFIRM_RE = /\bconfirm (if|whether)\b|\bconfirm (the )?(new|updated|rescheduled|proposed)\b|\bconfirm (the )?interview time|\bconfirm availability for\b[^.;]*\d/i;

/**
 * A confirmation with no time we could read ("Join the Microsoft Teams
 * meeting", "Reschedule or cancel the meeting", "your interview is coming
 * up!"): it's booked, the time is just not in the text. Checked against
 * every such email; Purpose's and Cision's bookings were showing as
 * "needs scheduling" for want of this.
 */
const BOOKED_ASK_RE = /^(attend|join)\b|manage (the |your )?(meeting|booking|interview)|reschedule or cancel|cancel or reschedule|coming up|is (now )?(scheduled|confirmed)|confirm(ed)? (your )?attendance|confirm (if|whether) (you('| a)re )?joining/i;
const BOOKED_SUBJ_RE = /\b(confirmation|confirmed|is scheduled|invitation|accepted|booked|coming up)\b/i;
const saysBooked = (ev: InterviewEvent) => BOOKED_ASK_RE.test(ev.asked) || BOOKED_SUBJ_RE.test(ev.subject);

/** A booking whose time we never read counts as ahead for this long (people book up to two weeks out), then as over. */
const UNTIMED_BOOKING_DAYS = 14;

const ROUND_WORDS: [number, RegExp][] = [
  [3, /\bfinal\b|on-?site|\bpanel\b|\bloop\b|last round|super ?day/i],
  [2, /technical|coding|tech(nical)? (screen|interview|round|assessment)|system design|pair(ing)? (programming|session)|live code|take[- ]home|hackerrank|codesignal|codility|coderpad/i],
  [1, /hiring manager|\bhm\b|\bhr\b|people (team|partner)|culture|behaviou?ral|leadership/i],
  [0, /\bintro|recruiter|phone screen|screening call|initial|talent acquisition|first call|quick (call|chat)|exploratory/i],
];

/** Which round an email is about, from its subject and the ask; -1 if it doesn't say. */
export function detectRound(text: string, kind: string | null): number {
  for (const [i, re] of ROUND_WORDS) if (re.test(text)) return i;
  return -1;
}

/* ---------- dates & times (everything ends up as ET wall time) ---------- */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const TZ_OFFSET: Record<string, number> = { utc: 0, gmt: 0 };
/**
 * Hours a US zone sits from Eastern. Senders write "EST" all year to mean
 * "Eastern" (Practice Better's "12:30pm EST" is 12:30 in Outlook in October),
 * so every Eastern abbreviation means the Eastern clock on that date, and the
 * other zones are that clock shifted.
 */
const ZONE_FROM_ET: Record<string, number> = {
  et: 0, est: 0, edt: 0, ct: -1, cst: -1, cdt: -1, mt: -2, mst: -2, mdt: -2, pt: -3, pst: -3, pdt: -3,
};

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

/** `zone`: a key of TZ_OFFSET/ZONE_FROM_ET, or a fixed UTC offset in hours; absent = Eastern. */
function build(y: number, m: number, d: number, h: number, min: number, zone: string | number | null): When {
  let off: number;
  if (typeof zone === "number") off = zone;
  else if (zone && zone in TZ_OFFSET) off = TZ_OFFSET[zone];
  else off = etOffset(y, m, d) + (zone && zone in ZONE_FROM_ET ? ZONE_FROM_ET[zone] : 0);
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
  return build(year, mon, day, hour24(Number(m[4]), m[6]), Number(m[5] ?? 0), m[7]?.toLowerCase() ?? null);
}

export function parseIsoish(s: string, receivedMs: number): When | null {
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const mon = Number(m[2]);
  const day = Number(m[3]);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  let zone: string | number | null = null;
  if (m[7]) zone = m[7].toUpperCase() === "Z" ? 0 : Number(m[7].slice(0, 3));
  else if (m[8]) zone = Number(m[8]);
  else if (m[9]) zone = m[9].toLowerCase();
  return build(fixYear(mon, day, receivedMs), mon, day, hour24(Number(m[4]), m[6]), Number(m[5]), zone);
}

/** Wording that means a time is fixed, not just proposed. */
const BOOKED_RE = /invitation|invite|confirm(ed|ation)\b|is scheduled|has been scheduled|scheduled for|details for connecting|reminder|video interview|interview -|join (the|your)|attend/i;
const PROPOSED_RE = /availability|choose a time|pick a (slot|time)|propose|select a time|book a time|schedule a (call|meeting|time)|calendly|let me know/i;

/**
 * The interview time an email fixes, if any. An invite in the subject is
 * always a booked time. The classifier's date field counts only when the email
 * reads as a confirmation — otherwise it is often a reply-by date.
 */
export function extractWhen(
  ev: Pick<InterviewEvent, "subject" | "deadline" | "asked" | "received_at" | "meeting_date" | "meeting_time">
): When | null {
  // The bot read it from the email body, where most confirmations put it, and
  // only when the email states it as booked (meeting_time.py).
  if (ev.meeting_date) return { date: ev.meeting_date, time: ev.meeting_time ?? "" };
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
    (r) => r.person === person && !(r.since && ev.received_at < r.since) && sameCompany(r.company, ev.company) && !(ev.role && r.role && rolesConflict(ev.role, r.role))
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

/**
 * Rounds before k, once round k is reached. Rounds that never started are
 * skipped. A round that did start is marked Passed only with `pass`: when
 * the next round actually got a booked time, or an email said so outright
 * (next round, offer). Otherwise it stays as it is — "awaiting result" once
 * its time is over — until a person clicks Pass or Fail.
 */
function settleBefore(row: ScheduleRow, k: number, evAt: string, pass: boolean): void {
  for (let j = 0; j < k; j++) {
    const x = row.rounds[j];
    if (lockedFor(x, evAt)) continue;
    // A meeting still ahead hasn't been passed, whatever got booked after it.
    if (x.state === "sched" && x.date && etMs(x.date, x.time) > Date.parse(evAt)) continue;
    if (ACTIVE.includes(x.state) && !x.date) {
      // Never booked, and a later round is underway: it simply didn't happen.
      row.rounds[j] = { ...x, state: "skipped", source: x.source === "manual" ? "email" : x.source || "inferred", at: evAt };
    } else if (ACTIVE.includes(x.state)) {
      // It took place: passed only on proof (see above), else it awaits a result.
      if (pass) row.rounds[j] = { ...x, state: "done", source: x.source === "manual" ? "email" : x.source || "inferred", at: evAt };
    } else if (x.state === "none") row.rounds[j] = { state: "skipped", date: "", time: "", source: "inferred", at: evAt };
  }
}

/**
 * Subject wording that moves a meeting rather than booking a new one. The
 * subject only: the classifier's "asked" says "attend or reschedule if
 * needed" on brand-new bookings too.
 */
const RESCHEDULE_RE = /re-?schedul|\bmoved\b|new time|missed|sorry|apolog|updated invitation|push(ed)? (back|out)|postpone/i;

const highest = (row: ScheduleRow, states: RoundState[]) => {
  for (let k = 3; k >= 0; k--) if (states.includes(row.rounds[k].state)) return k;
  return -1;
};

/** Apply one email and record what it changed (for "New" on the page). */
function applyAndRecord(row: ScheduleRow, ev: InterviewEvent, nowMs: number, ov: ScheduleOverride | undefined, created: boolean): void {
  const before = row.rounds.map((x) => ({ ...x }));
  const offerBefore = row.offer;
  const taskBefore = row.task;
  applyEvent(row, ev, nowMs, ov);
  const changes = (row.changes ??= []);
  const at = ev.received_at;
  if (created) return void changes.push({ at, what: "new" });
  if (!offerBefore && row.offer) return void changes.push({ at, what: "offer" });
  if (ev.verdict === "REJECTION" && row.rounds.some((x, k) => x.state === "failed" && before[k].state !== "failed")) {
    return void changes.push({ at, what: "rejected" });
  }
  for (let k = 0; k < 4; k++) {
    const a = before[k];
    const b = row.rounds[k];
    if (a.state === b.state && a.date === b.date && a.time === b.time) continue;
    if (b.date && a.date && (a.date !== b.date || a.time !== b.time)) return void changes.push({ at, what: "time", round: k });
    if ((b.date && !a.date) || (b.state === "sched" && a.state !== "sched")) return void changes.push({ at, what: "booked", round: k });
    if (a.state === "sched" && (b.state === "pending" || b.state === "ask")) return void changes.push({ at, what: "cancelled", round: k });
    if (b.state === "ask") return void changes.push({ at, what: "ask", round: k });
    if (b.state === "pending" && a.state === "none") return void changes.push({ at, what: "advanced", round: k });
  }
  if (row.task && row.task !== taskBefore) return void changes.push({ at, what: "assessment" });
  changes.push({ at, what: "email" });
}

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
    const k = Math.max(0, highest(row, REACHED));
    setRound(row, k, { state: "failed" }, evAt);
    row.task = null;
    return;
  }
  if (ev.verdict !== "ACTION") return;

  if (ev.kind === "OFFER") {
    // An offer a person took back by hand stays taken back for older mail.
    if (ov?.offer === false && evAt <= ov.updated_at) return;
    row.offer = true;
    row.task = null;
    // An offer says outright that the rounds before it were passed.
    settleBefore(row, highest(row, REACHED) + 1, evAt, true);
    return;
  }
  if (ev.kind === "NEXT_ROUND" && !extractWhen(ev)) {
    const k = highest(row, REACHED);
    row.task = null;
    if (k < 3) {
      // "You're through to the next round" says outright the last one was passed.
      settleBefore(row, k + 1, evAt, true);
      const ask = !ev.handled && asksToBook(ev.asked);
      if (row.rounds[k + 1].state === "none") setRound(row, k + 1, { state: ask ? "ask" : "pending", date: "", time: "" }, evAt);
    }
    return;
  }
  // An assessment or take-home is a to-do on the row, not an interview round
  // (micro1's "AI interview" used to land as the Final round). Marking its
  // email Done closes it; so does the process moving on.
  if (ev.kind === "ASSESSMENT" && !extractWhen(ev)) {
    // Reminders repeat the same test: marking any of them done closes it, a newer open one reopens it.
    row.task = ev.handled ? null : { kind: "assessment", asked: ev.asked, at: evAt, email_id: ev.id };
    return;
  }
  if (!ROW_KINDS.has(ev.kind ?? "")) return;

  const active = highest(row, ACTIVE);
  // A cancelled invite: the slot is gone, the round needs a new time.
  if (CANCELLED_RE.test(ev.subject)) {
    if (active >= 0 && row.rounds[active].state === "sched") setRound(row, active, { state: "ask", date: "", time: "", why: "reschedule" }, evAt);
    return;
  }

  const when = extractWhen(ev);
  // Asked to book (or rebook) a time, and not yet marked done in the inbox.
  const asks = !when && !ev.handled && asksToBook(ev.asked);
  const confirm = asks && CONFIRM_RE.test(ev.asked);
  const bookedNoTime = !when && !asksToBook(ev.asked) && saysBooked(ev);
  const reached = highest(row, REACHED);
  // Only the subject and the ask: the classifier's free-text "reason" mentions
  // "recruiter" or "on-site" in passing and would drag emails to the wrong round.
  let k = detectRound(`${ev.subject} ${ev.asked}`, ev.kind);
  const moving = ev.kind === "RESCHEDULE" || RESCHEDULE_RE.test(ev.subject);
  if (moving && active >= 0) k = active; // a new time for the same round
  else if (k >= 0 && k < reached) k = -1; // keywords may move forward, never back over rounds already reached
  if (k < 0) {
    const done = highest(row, ["done", "skipped"]);
    const a = active >= 0 ? row.rounds[active] : null;
    if (active >= 0 && a) {
      // A newer booking while one is still ahead is a reschedule: it replaces
      // that round's time (Lutra Oct 26 -> Oct 23, Altus Wed -> Fri). Only a
      // NEW booked time arriving after the meeting already happened is the
      // next round. A follow-up with no new time ("thanks, we'll be in
      // touch") leaves everything as it is.
      const happened = a.date && a.state !== "pending" && a.state !== "ask" && etMs(a.date, a.time) < Date.parse(evAt);
      const differs = when && (when.date !== a.date || when.time !== a.time);
      k = happened && differs && !moving && active < 3 ? active + 1 : active;
    } else {
      k = Math.min(3, done + 1);
    }
  }
  // A round someone marked skipped by hand isn't where a booking goes: it
  // belongs to the round after it (Practice Better: HR skipped, so Tech).
  while (k < 3 && lockedFor(row.rounds[k], evAt) && row.rounds[k].state === "skipped") k++;
  // Earlier rounds count as passed only once this round has a booked time.
  settleBefore(row, k, evAt, Boolean(when));
  const cur = row.rounds[k];
  if (when) {
    setRound(row, k, { state: etMs(when.date, when.time) < nowMs ? "wait" : "sched", date: when.date, time: when.time, why: undefined }, evAt);
    row.task = null; // a booked interview means the process moved past any test
  } else if (bookedNoTime) {
    // Booked, time not in the text. A booking already holding a time keeps it.
    if (cur.state === "none" || cur.state === "skipped" || cur.state === "pending" || cur.state === "ask") {
      setRound(row, k, { state: "sched", date: "", time: "", why: undefined }, evAt);
      row.task = null;
    }
  } else if (confirm && (cur.state === "sched" || cur.state === "wait")) {
    // "Confirm the new time works": a booked round stays booked.
  } else if (asks && moving && (cur.state === "sched" || cur.state === "wait")) {
    // They asked to move a booked meeting: the old time is gone until a new one is picked.
    setRound(row, k, { state: "ask", date: "", time: "", why: "reschedule" }, evAt);
  } else if (asks && (cur.state === "none" || cur.state === "skipped" || cur.state === "pending" || cur.state === "ask")) {
    // A newer ask replaces an older one; a rescheduling stays one until booked.
    setRound(row, k, { state: "ask", date: "", time: "", why: confirm ? "confirm" : cur.state === "ask" && cur.why === "reschedule" ? "reschedule" : undefined }, evAt);
  } else if (cur.state === "none" || cur.state === "skipped") {
    setRound(row, k, { state: "pending", date: "", time: "" }, evAt);
  } else if (cur.state === "ask" && ev.handled && asksToBook(ev.asked)) {
    // The ask was marked done in the inbox: booked outside, waiting on their confirmation.
    setRound(row, k, { state: "pending", date: "", time: "", why: undefined }, evAt);
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

/** Mail hosts and ATS senders say nothing about which company an email is from. */
const SHARED_DOMAINS = /(^|\.)(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|proton|lever|greenhouse|ashbyhq|workday|myworkday|smartrecruiters|applytojob|icims|jobvite|breezy|bamboohr|recruitee|teamtailor|workable|calendly|goodtime|modernloop|zoom|google|microsoft|linkedin|indeed|paradox|gem|guide)\.[a-z.]+$/i;

/**
 * An email the classifier named no company for ("Appointment booked: 15 min
 * with Jessie (Rajeev Kumar) @ …") borrows one from earlier mail: the same
 * sender, then the same company domain, then a company already on that
 * person's schedule whose name appears in the subject.
 */
function inferCompanies(events: InterviewEvent[], personOf: (ev: InterviewEvent) => string, base: ScheduleRow[]): InterviewEvent[] {
  const bySender = new Map<string, string>();
  const byDomain = new Map<string, string>();
  for (const e of events) {
    if (!normCompany(e.company) || e.verdict === "REJECTION") continue;
    const addr = (e.sender_addr || "").toLowerCase();
    if (addr) bySender.set(addr, e.company);
    const dom = addr.split("@")[1] ?? "";
    if (dom && !SHARED_DOMAINS.test(dom)) byDomain.set(dom, e.company);
  }
  const companiesOf = new Map<string, Set<string>>();
  for (const e of events) if (normCompany(e.company)) {
    const p = personOf(e);
    companiesOf.set(p, (companiesOf.get(p) ?? new Set()).add(e.company));
  }
  for (const r of base) companiesOf.set(r.person, (companiesOf.get(r.person) ?? new Set()).add(r.company));
  return events.map((e) => {
    if (normCompany(e.company)) return e;
    const addr = (e.sender_addr || "").toLowerCase();
    const dom = addr.split("@")[1] ?? "";
    let company = bySender.get(addr) ?? (dom && !SHARED_DOMAINS.test(dom) ? byDomain.get(dom) : undefined);
    if (!company) {
      const subject = ` ${normCompany(e.subject)} `;
      company = [...(companiesOf.get(personOf(e)) ?? [])]
        .filter((c) => normCompany(c).length >= 4 && subject.includes(` ${normCompany(c)} `))
        .sort((a, b) => normCompany(b).length - normCompany(a).length)[0];
    }
    return company ? { ...e, company } : e;
  });
}

export function buildSchedule(input: BuildInput): BuildResult {
  const receivedAt = new Map(input.events.map((e) => [e.id, e.received_at]));
  const rows: ScheduleRow[] = input.base.map((r) =>
    // Emails are replayed below, so a stored row starts with none of their effects.
    lockRounds({
      ...r, rounds: r.rounds.map((x) => ({ ...x })), email_ids: [...r.email_ids], changes: [], task: null,
      since: r.id.startsWith("mail:") ? receivedAt.get(r.id.slice(5)) : undefined,
    }, input.overrides.get(r.id))
  );
  const appsById = new Map(input.apps.map((a) => [a.id, a]));
  const unplaced: InterviewEvent[] = [];
  const ordered = inferCompanies(input.events, input.personOf, input.base)
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
    let created = false;
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
      created = true;
    }
    if (!row.application_id && ev.application_id && ["auto_matched", "confirmed"].includes(ev.match_status)) {
      const app = appsById.get(ev.application_id);
      if (app) {
        row.application_id = app.id;
        if (!row.applied) row.applied = app.created_at.slice(0, 10);
      }
    }
    if (!row.role && ev.role) row.role = ev.role;
    applyAndRecord(row, ev, input.nowMs, input.overrides.get(row.id), created);
  }

  const quietSince = new Date(Date.parse(input.todayIso) - NO_RESPONSE_DAYS * 86400000).toISOString().slice(0, 10);
  for (const row of rows) {
    const ov = input.overrides.get(row.id);
    if (ov?.note !== undefined) row.note = ov.note;
    if (ov && ov.closed !== undefined) row.closed = ov.closed;
    // Removed stays removed, unless a newer email books or moves an interview
    // on it: then it's real after all and comes back (marked New).
    if (ov?.removed) {
      const revived = (row.changes ?? []).some((c) => c.at > ov.removed! && ["new", "booked", "time", "advanced", "offer"].includes(c.what));
      if (!revived) row.removed = true;
    }
    if (ov && etDate(ov.updated_at) > row.last_activity) row.last_activity = etDate(ov.updated_at);

    // Time passes: a booked interview whose time has gone by now needs a result.
    // One booked without a time we could read is taken as over after two weeks.
    for (const x of row.rounds) {
      if (x.state === "sched" && x.date && etMs(x.date, x.time) < input.nowMs) x.state = "wait";
      else if (x.state === "sched" && !x.date && x.at && Date.parse(x.at) < input.nowMs - UNTIMED_BOOKING_DAYS * 86400000) x.state = "wait";
    }

    // Gone quiet: no email and no hand edit for more than NO_RESPONSE_DAYS, and
    // nothing booked ahead. Not when a person has set the row open or closed.
    const upcoming = row.rounds.some((x) => x.state === "sched" && x.date);
    const failed = row.rounds.some((x) => x.state === "failed");
    if (ov?.closed === undefined && !row.closed && !row.offer && !failed && !upcoming && row.last_activity && row.last_activity < quietSince) {
      row.closed = "No response";
      row.auto_closed = true;
    }
  }
  return { rows, unplaced };
}
