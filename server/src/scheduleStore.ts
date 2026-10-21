import { appDb } from "./logStore.js";
import type { ScheduleOverride, ScheduleRow } from "./scheduleBuild.js";

/**
 * What the schedule can't rebuild from email: rows imported from a person's
 * Google Sheet or added by hand ("base"), and every change made by hand
 * ("overrides"). The schedule itself is rebuilt from these plus the interview
 * emails on each request, so it never drifts from the inbox.
 */

let ready = false;

function db() {
  const d = appDb();
  if (!ready) {
    d.exec(`CREATE TABLE IF NOT EXISTS schedule_base (id TEXT PRIMARY KEY, person TEXT NOT NULL, data TEXT NOT NULL)`);
    d.exec(`CREATE TABLE IF NOT EXISTS schedule_overrides (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    d.exec(`CREATE TABLE IF NOT EXISTS schedule_seen (user_id TEXT PRIMARY KEY, at TEXT NOT NULL)`);
    ready = true;
  }
  return d;
}

function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export function listBase(): ScheduleRow[] {
  return (db().prepare("SELECT data FROM schedule_base").all() as { data: string }[]).map(
    (r) => JSON.parse(r.data) as ScheduleRow
  );
}

/** Replace one person's imported sheet rows. Rows added by hand are kept. */
export function replaceSheetRows(person: string, rows: ScheduleRow[]): void {
  tx(() => {
    const d = db();
    d.prepare("DELETE FROM schedule_base WHERE person = ? AND id LIKE 'sheet:%'").run(person);
    const ins = d.prepare("INSERT OR REPLACE INTO schedule_base (id, person, data) VALUES (?, ?, ?)");
    for (const r of rows) ins.run(r.id, person, JSON.stringify(r));
  });
}

export function addBaseRow(row: ScheduleRow): void {
  db().prepare("INSERT OR IGNORE INTO schedule_base (id, person, data) VALUES (?, ?, ?)").run(row.id, row.person, JSON.stringify(row));
}

export function listOverrides(): Map<string, ScheduleOverride> {
  const rows = db().prepare("SELECT id, data FROM schedule_overrides").all() as { id: string; data: string }[];
  return new Map(rows.map((r) => [r.id, JSON.parse(r.data) as ScheduleOverride]));
}

/** Merge a change into a row's override inside one transaction, so two quick edits can't drop each other. */
export function mergeOverride(id: string, change: (cur: ScheduleOverride | undefined) => ScheduleOverride): ScheduleOverride {
  return tx(() => {
    const d = db();
    const row = d.prepare("SELECT data FROM schedule_overrides WHERE id = ?").get(id) as { data: string } | undefined;
    const next = change(row ? (JSON.parse(row.data) as ScheduleOverride) : undefined);
    d.prepare("INSERT OR REPLACE INTO schedule_overrides (id, data) VALUES (?, ?)").run(id, JSON.stringify(next));
    return next;
  });
}

export function getOverride(id: string): ScheduleOverride | undefined {
  const row = db().prepare("SELECT data FROM schedule_overrides WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as ScheduleOverride) : undefined;
}

/** Put a row's hand changes back exactly as they were (Undo). null = no hand changes at all. */
export function setOverride(id: string, ov: ScheduleOverride | null): void {
  if (ov) db().prepare("INSERT OR REPLACE INTO schedule_overrides (id, data) VALUES (?, ?)").run(id, JSON.stringify(ov));
  else db().prepare("DELETE FROM schedule_overrides WHERE id = ?").run(id);
}

/**
 * When this person last marked the schedule seen. Anything an email changed
 * after it shows as "New". A first visit starts a day back, so the latest
 * arrivals show as new straight away rather than nothing at all.
 */
export function getSeen(userId: string): string {
  const row = db().prepare("SELECT at FROM schedule_seen WHERE user_id = ?").get(userId) as { at: string } | undefined;
  if (row) return row.at;
  const start = new Date(Date.now() - 24 * 3600_000).toISOString();
  setSeen(userId, start);
  return start;
}

export function setSeen(userId: string, at: string): void {
  db().prepare("INSERT OR REPLACE INTO schedule_seen (user_id, at) VALUES (?, ?)").run(userId, at);
}
