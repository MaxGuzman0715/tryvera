import type { SchedRound, SchedRoundState, ScheduleRow } from "./types";

/** Pure helpers for the Schedule tab: status, grouping, the round cascade, dates. */

export const ROUNDS = ["Intro", "HR", "Tech", "Final"] as const;
export const CLOSE_REASONS = ["Not remote", "Low budget", "Job ended", "I withdrew", "No response"];

export const STATE_NAME: Record<SchedRoundState, string> = {
  ask: "Needs scheduling",
  pending: "Waiting on them",
  sched: "Scheduled",
  wait: "Awaiting result",
  done: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  none: "Empty",
};

/** States that carry a date and time. */
export const DATED: SchedRoundState[] = ["sched", "wait", "done", "failed"];

/** ask and task are your move; pending is theirs. */
export type StatusKind = "ask" | "task" | "sched" | "pending" | "wait" | "offer" | "rejected" | "closed";
export type Status = { label: string; kind: StatusKind; closed?: boolean; i?: number };

/** A row's status always follows from its rounds: one source of truth. */
export function deriveStatus(r: Pick<ScheduleRow, "rounds" | "closed" | "offer"> & { task?: ScheduleRow["task"] }): Status {
  if (r.rounds.some((x) => x.state === "failed")) return { label: "Rejected", kind: "rejected", closed: true };
  if (r.closed) return { label: `Closed · ${r.closed}`, kind: "closed", closed: true };
  if (r.offer) return { label: "Offer", kind: "offer" };
  for (let i = 3; i >= 0; i--) {
    const x = r.rounds[i];
    if (x.state === "none" || x.state === "skipped") continue;
    // An open assessment is the next thing to do, unless an interview is booked ahead.
    if (r.task && x.state !== "sched") return { label: "Assessment to do", kind: "task", i };
    if (x.state === "ask") return { label: `${ROUNDS[i]} · ${ASK_WHY[x.why ?? ""] ?? ASK_WHY[""]}`, kind: "ask", i };
    if (x.state === "wait") return { label: `${ROUNDS[i]} · awaiting result`, kind: "wait", i };
    if (x.state === "sched") return { label: x.date ? `${ROUNDS[i]} Scheduled` : `${ROUNDS[i]} booked · time not set`, kind: "sched", i };
    if (x.state === "pending") return { label: `${ROUNDS[i]} · waiting on them`, kind: "pending", i };
    if (x.state === "done") return i === 3 ? { label: "Offer pending", kind: "pending", i } : { label: `${ROUNDS[i]} passed · waiting on them`, kind: "pending", i };
  }
  if (r.task) return { label: "Assessment to do", kind: "task" };
  return { label: "Applied", kind: "closed" };
}

/** What a "needs scheduling" round is waiting on you for. */
export const ASK_WHY: Record<string, string> = {
  "": "needs scheduling",
  reschedule: "needs rescheduling",
  confirm: "confirm their time",
};

const blank = (): SchedRound => ({ state: "none", date: "", time: "", source: "" });

/**
 * Set round i and keep the others consistent: an active or passed round means
 * every earlier one is behind you (passed if it happened, skipped if not); a
 * passed round opens the next one as Pending; going back to an earlier round
 * clears the later ones. Returns the new rounds and which ones changed.
 */
export function setRound(
  rounds: SchedRound[],
  i: number,
  state: SchedRoundState,
  date = "",
  time = ""
): { rounds: SchedRound[]; changed: number[] } {
  const next = rounds.map((x) => ({ ...x }));
  const dated = DATED.includes(state);
  next[i] = { state, date: dated ? date : "", time: dated ? time : "", source: "manual" };
  if (["ask", "pending", "sched", "wait", "done"].includes(state)) {
    for (let j = 0; j < i; j++) {
      const x = next[j];
      if (["none", "ask", "pending", "sched", "wait"].includes(x.state)) next[j] = { ...x, state: x.date ? "done" : "skipped", source: "manual" };
    }
  }
  if (state === "done" && i < 3 && next[i + 1].state === "none") next[i + 1] = { ...blank(), state: "pending", source: "manual" };
  if (state !== "done" && state !== "none") for (let j = i + 1; j < 4; j++) if (next[j].state !== "none") next[j] = { ...blank(), source: "manual" };
  const changed = next.flatMap((x, k) =>
    x.state !== rounds[k].state || x.date !== rounds[k].date || x.time !== rounds[k].time ? [k] : []
  );
  return { rounds: next, changed };
}

/* ---------- dates (all ET calendar dates, YYYY-MM-DD) ---------- */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_NAME = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const parseDay = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const shortDay = (iso: string): string => {
  if (!iso) return "";
  const d = parseDay(iso);
  return `${MON[d.getMonth()]} ${d.getDate()}`;
};
export const time12 = (t: string): string => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
export const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export const startOfWeek = (d: Date): Date => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function relativeDay(iso: string, todayIso: string): string {
  const days = Math.round((parseDay(iso).getTime() - parseDay(todayIso).getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/* ---------- list grouping ---------- */

/** Your moves first, then what's booked, then what's on them. */
export const GROUP_ORDER = ["Needs scheduling", "Assessment to do", "Awaiting result", "Next 7 days", "Later", "Waiting on them", "Offer", "Closed"] as const;

export function groupOf(r: ScheduleRow, todayIso: string): (typeof GROUP_ORDER)[number] {
  const s = deriveStatus(r);
  if (s.closed) return "Closed";
  if (s.kind === "ask") return "Needs scheduling";
  if (s.kind === "task") return "Assessment to do";
  if (s.kind === "wait") return "Awaiting result";
  if (s.kind === "offer") return "Offer";
  if (s.kind === "sched" && s.i !== undefined) {
    return r.rounds[s.i].date <= isoDay(addDays(parseDay(todayIso), 7)) ? "Next 7 days" : "Later";
  }
  return "Waiting on them";
}

/** Days without a word since a meeting that already happened (0 = there's been news, or it's too soon to tell). */
export const NO_WORD_AFTER_DAYS = 3;
export function noWordDays(r: ScheduleRow, todayIso: string): number {
  const s = deriveStatus(r);
  if (s.kind !== "wait" || s.i === undefined) return 0;
  const met = r.rounds[s.i].date;
  // Something arrived (or was changed) after the meeting: there's been a word.
  if (!met || r.last_activity > met) return 0;
  const days = Math.round((parseDay(todayIso).getTime() - parseDay(met).getTime()) / 86400000);
  return days >= NO_WORD_AFTER_DAYS ? days : 0;
}

/* ---------- what's new since you last looked ---------- */

export const CHANGE_LABEL: Record<string, string> = {
  new: "New interview",
  booked: "Time booked",
  time: "Time changed",
  cancelled: "Cancelled",
  ask: "Asks you to book",
  assessment: "Assessment",
  rejected: "Rejected",
  offer: "Offer",
  advanced: "Next round",
  email: "New email",
};

/** The changes made after `seenAt`, newest first. */
export function newChanges(r: ScheduleRow, seenAt: string) {
  return (r.changes ?? []).filter((c) => c.at > seenAt).reverse();
}

/** The one to show on the row: the most telling change, not just the latest. */
const WEIGHT: Record<string, number> = { new: 7, offer: 6, rejected: 5, cancelled: 4, ask: 4, time: 3, booked: 3, assessment: 3, advanced: 2, email: 1 };
export function headlineChange(r: ScheduleRow, seenAt: string) {
  const list = newChanges(r, seenAt);
  return list.sort((a, b) => (WEIGHT[b.what] ?? 0) - (WEIGHT[a.what] ?? 0) || b.at.localeCompare(a.at))[0] ?? null;
}

/** "2h ago", "3 days ago". */
export function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins || 1}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** The date that places a row in time: its current round's date, else its last activity. */
export function keyDate(r: ScheduleRow): string {
  const s = deriveStatus(r);
  if (s.kind === "task" && r.task) return r.task.at.slice(0, 10);
  if (s.kind === "ask" && s.i !== undefined && r.rounds[s.i].at) return r.rounds[s.i].at!.slice(0, 10);
  if (s.i !== undefined && r.rounds[s.i].date) return r.rounds[s.i].date;
  return r.last_activity;
}

/* ---------- export in the sheet's own layout ---------- */

export function scheduleCsv(rows: ScheduleRow[]): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ["Person", "Company", "Job Info", "Company/Interviewer", "Status", "Applied Date",
    "Intro date", "Intro time", "HR date", "HR time", "Tech date", "Tech time", "Final date", "Final time", "Note"];
  const lines = rows.map((r) => [
    r.person_label, r.company, r.role, r.contact, deriveStatus(r).label, r.applied || (r.application_id ? "" : "From Other"),
    ...r.rounds.flatMap((x) => [x.date, x.time]), r.note,
  ].map((v) => q(String(v ?? ""))).join(","));
  return [head.join(","), ...lines].join("\n");
}
