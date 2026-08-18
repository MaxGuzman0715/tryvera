import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "./paths.js";
import type { ApplicationLogEntry } from "./types.js";

/**
 * Application logs are stored in SQLite rather than a JSON file.
 *
 * The JSON store rewrote the ENTIRE array on every write (`fs.writeFile`
 * truncates first), with no locking. A single generation performs ~6 of those
 * read-modify-write cycles, so a batch of concurrent runs interleaved hundreds
 * of them against one file. Two things followed: overlapping writes silently
 * dropped entries, and any read landing inside a truncate window parsed a
 * half-written file, returned "no logs", and the next append then persisted
 * that emptiness over the whole history.
 *
 * SQLite removes both: every statement is atomic, writes are serialized by the
 * database, and WAL means a crash mid-write can never leave a torn file.
 *
 * `node:sqlite` is built into Node 22.5+, so this needs no npm dependency and
 * no native build step on the VPS.
 *
 * The public API is unchanged — same five functions, same signatures — so
 * routes, the admin panel, and the extension all keep working untouched.
 */

const dbPath = () => path.join(dataDir(), "application_logs.db");
const legacyJsonPath = () => path.join(dataDir(), "application_logs.json");

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(dataDir(), { recursive: true });
  const d = new DatabaseSync(dbPath());
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("PRAGMA synchronous = NORMAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL,
      resume_profile  TEXT,
      user_id         TEXT,
      status          TEXT,
      tracking_status TEXT,
      data            TEXT NOT NULL
    )
  `);
  d.exec("CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications(created_at DESC)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_applications_profile ON applications(resume_profile)");
  d.exec("CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id)");
  db = d;
  importLegacyJson(d);
  return d;
}

/**
 * One-time import of the old `application_logs.json`. Runs only when the table
 * is empty, so it can't duplicate rows on restart. The JSON file is left in
 * place as a backup — nothing deletes it.
 */
function importLegacyJson(d: DatabaseSync): void {
  try {
    const count = d.prepare("SELECT COUNT(*) AS n FROM applications").get() as { n: number };
    if (count.n > 0) return;
    if (!fs.existsSync(legacyJsonPath())) return;
    const parsed = JSON.parse(fs.readFileSync(legacyJsonPath(), "utf8")) as {
      applications?: ApplicationLogEntry[];
    };
    const rows = Array.isArray(parsed?.applications) ? parsed.applications : [];
    if (!rows.length) return;
    d.exec("BEGIN");
    try {
      for (const r of rows) insertRow(d, r);
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    }
    console.log(`[enpply] imported ${rows.length} application logs from application_logs.json into SQLite`);
  } catch (err) {
    console.warn("[enpply] legacy application_logs.json import skipped —", err);
  }
}

/**
 * The full entry is kept as JSON in `data`; the columns beside it are copies
 * used for indexing and sorting. New fields on ApplicationLogEntry therefore
 * need no schema migration.
 */
function insertRow(d: DatabaseSync, entry: ApplicationLogEntry): void {
  d.prepare(
    `INSERT OR REPLACE INTO applications
       (id, created_at, resume_profile, user_id, status, tracking_status, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.id,
    entry.created_at ?? "",
    entry.resume_profile ?? "",
    entry.user_id ?? "",
    entry.status ?? "",
    entry.tracking_status ?? "",
    JSON.stringify(entry)
  );
}

const toEntry = (row: { data: string }): ApplicationLogEntry =>
  JSON.parse(row.data) as ApplicationLogEntry;

export async function listApplications(): Promise<ApplicationLogEntry[]> {
  const rows = open()
    .prepare("SELECT data FROM applications ORDER BY created_at DESC")
    .all() as { data: string }[];
  return rows.map(toEntry);
}

export async function getApplication(id: string): Promise<ApplicationLogEntry | undefined> {
  const row = open().prepare("SELECT data FROM applications WHERE id = ?").get(id) as
    | { data: string }
    | undefined;
  return row ? toEntry(row) : undefined;
}

export async function appendApplication(entry: ApplicationLogEntry): Promise<void> {
  insertRow(open(), entry);
}

export async function updateApplication(
  id: string,
  patch: Partial<ApplicationLogEntry>
): Promise<ApplicationLogEntry | null> {
  const d = open();
  // Read and write inside one transaction so a concurrent update can't be lost
  // between the read and the write.
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d.prepare("SELECT data FROM applications WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    if (!row) {
      d.exec("ROLLBACK");
      return null;
    }
    const next = { ...toEntry(row), ...patch };
    insertRow(d, next);
    d.exec("COMMIT");
    return next;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

export async function removeApplication(id: string): Promise<ApplicationLogEntry | null> {
  const d = open();
  d.exec("BEGIN IMMEDIATE");
  try {
    const row = d.prepare("SELECT data FROM applications WHERE id = ?").get(id) as
      | { data: string }
      | undefined;
    if (!row) {
      d.exec("ROLLBACK");
      return null;
    }
    d.prepare("DELETE FROM applications WHERE id = ?").run(id);
    d.exec("COMMIT");
    return toEntry(row);
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}
