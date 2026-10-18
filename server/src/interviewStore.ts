import { appDb } from "./logStore.js";
import type { InterviewEvent } from "./types.js";

/**
 * Interview emails live beside applications in the same SQLite file, on the
 * same connection (see appDb). Same layout as `applications`: the full record
 * is JSON in `data`, and the columns are copies for indexing, so new fields
 * need no migration.
 */

let ready = false;

function db() {
  const d = appDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS interview_events (
        id             TEXT PRIMARY KEY,
        received_at    TEXT NOT NULL,
        match_status   TEXT,
        application_id TEXT,
        data           TEXT NOT NULL
      )
    `);
    d.exec("CREATE INDEX IF NOT EXISTS idx_interviews_received ON interview_events(received_at DESC)");
    d.exec("CREATE INDEX IF NOT EXISTS idx_interviews_application ON interview_events(application_id)");
    ready = true;
  }
  return d;
}

function writeRow(ev: InterviewEvent): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO interview_events (id, received_at, match_status, application_id, data)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(ev.id, ev.received_at, ev.match_status, ev.application_id ?? "", JSON.stringify(ev));
}

const toEvent = (row: { data: string }): InterviewEvent => JSON.parse(row.data) as InterviewEvent;

export function listInterviews(): InterviewEvent[] {
  const rows = db()
    .prepare("SELECT data FROM interview_events ORDER BY received_at DESC")
    .all() as { data: string }[];
  return rows.map(toEvent);
}

export function getInterview(id: string): InterviewEvent | undefined {
  const row = db().prepare("SELECT data FROM interview_events WHERE id = ?").get(id) as
    | { data: string }
    | undefined;
  return row ? toEvent(row) : undefined;
}

/**
 * Read-modify-write one row inside a transaction. `fn` gets the current row
 * (undefined for a new one) and returns the row to store, or null to leave it.
 */
export function upsertInterview(
  id: string,
  fn: (current: InterviewEvent | undefined) => InterviewEvent | null
): InterviewEvent | null {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const next = fn(getInterview(id));
    if (next) writeRow(next);
    d.exec("COMMIT");
    return next;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}
