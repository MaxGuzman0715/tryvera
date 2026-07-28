// Export application log rows to a CSV the user can open in Excel/Sheets.
// Pure client-side: works off the rows already loaded in the Logs page (so it
// honors whatever filters are applied), with optional profile + date-range
// narrowing applied here.

import type { ApplicationLogEntry } from "./types";
import { formatDateTimeJst } from "./timeJst";

/** RFC-4180 field quoting: wrap in quotes and double any embedded quotes. */
function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const COLUMNS: Array<{ header: string; get: (r: ApplicationLogEntry) => unknown }> = [
  { header: "Created (JST)", get: (r) => formatDateTimeJst(String(r.created_at)) },
  { header: "Created (ISO)", get: (r) => r.created_at },
  { header: "Company", get: (r) => r.company_name },
  { header: "Role", get: (r) => r.role_name },
  { header: "Profile", get: (r) => r.resume_profile },
  { header: "Run id", get: (r) => r.run_uuid ?? "" },
  { header: "Status", get: (r) => r.status_step || r.status },
  { header: "Tracking", get: (r) => r.tracking_status ?? "" },
  { header: "Job link", get: (r) => r.job_link ?? "" },
  { header: "Recruiter", get: (r) => r.recruiter_name ?? "" },
  { header: "Note", get: (r) => r.note ?? "" },
  { header: "Error", get: (r) => r.generation_error ?? "" },
  { header: "Output folder", get: (r) => r.output_folder_abs || r.output_folder || "" },
  { header: "User", get: (r) => r.user_email ?? r.user_id ?? "" },
];

export type CsvFilter = {
  /** Only rows with this resume_profile. Empty = all. */
  profile?: string;
  /** Inclusive start date (YYYY-MM-DD, local). Empty = no lower bound. */
  fromDate?: string;
  /** Inclusive end date (YYYY-MM-DD, local). Empty = no upper bound. */
  toDate?: string;
};

/** Apply the export filters to a row set (created_at is an ISO timestamp). */
export function filterForCsv(rows: ApplicationLogEntry[], f: CsvFilter): ApplicationLogEntry[] {
  const from = f.fromDate ? new Date(`${f.fromDate}T00:00:00`).getTime() : null;
  // End of the selected day.
  const to = f.toDate ? new Date(`${f.toDate}T23:59:59.999`).getTime() : null;
  return rows.filter((r) => {
    if (f.profile && r.resume_profile !== f.profile) return false;
    if (from != null || to != null) {
      const t = new Date(String(r.created_at)).getTime();
      if (Number.isNaN(t)) return false;
      if (from != null && t < from) return false;
      if (to != null && t > to) return false;
    }
    return true;
  });
}

/** Build the CSV text (with header row) for the given applications. */
export function applicationsToCsv(rows: ApplicationLogEntry[]): string {
  const head = COLUMNS.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((r) => COLUMNS.map((c) => csvCell(c.get(r))).join(",")).join("\r\n");
  // Prepend a UTF-8 BOM so Excel reads non-ASCII (accents, em-dashes) correctly.
  return `﻿${head}\r\n${body}\r\n`;
}

/** Trigger a browser download of the CSV. `stamp` is a caller-supplied time tag. */
export function downloadApplicationsCsv(rows: ApplicationLogEntry[], stamp: string): void {
  const csv = applicationsToCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tryvera_applications_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
