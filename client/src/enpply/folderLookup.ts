import type { ApplicationLogEntry } from "./types";

/**
 * Turns a pasted column of job links into the matching output-folder names, one line per input line,
 * so the result pastes straight back into the spreadsheet next to the links.
 *
 * Two copies of the same posting rarely share an exact URL: job boards append click-tracking
 * (jr_id, utm_*, source=LinkedIn) and the app often saved the apply page rather than the posting
 * ("/application", "/apply"). Links are compared after removing both.
 */

const TRACKING_PARAM =
  /^(jr_id|utm_.*|source|src|gh_src|lever-source|iis|iisn|feedid|trid|mode|lang|mobile|width|height|bga|needsredirect|jan1offset|jun1offset|ref|referrer)$/i;

export function normalizeJobLink(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return text.toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let path = decodeURIComponent(url.pathname).replace(/\/+$/, "").toLowerCase();
  path = path.replace(/\/(application|apply)$/, "");
  const params = [...url.searchParams.entries()]
    .filter(([k, v]) => v !== "" && !TRACKING_PARAM.test(k))
    .map(([k, v]) => `${k.toLowerCase()}=${v}`)
    .sort();
  return `${host}${path}?${params.join("&")}#${url.hash.replace(/^#/, "").toLowerCase()}`;
}

/** The last segment of a stored output path: "output/09_15/_batch/015513_Road_Scholar_…" -> "015513_Road_Scholar_…". */
function folderName(outputFolder: string): string {
  const parts = outputFolder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export type FolderLookupLine = {
  link: string;
  folder: string;
  /** Other, older folders generated for the same posting. */
  olderCount: number;
  /** True when the same posting already appeared on an earlier line of this paste. */
  repeated: boolean;
};

export type FolderLookupResult = {
  lines: FolderLookupLine[];
  /** One entry per input line, blank lines kept blank, ready to paste into a sheet column. */
  text: string;
  matched: number;
  notFound: number;
  repeated: number;
};

export const NOT_FOUND = "NOT FOUND";

export function findFoldersByLinks(pasted: string, rows: ApplicationLogEntry[]): FolderLookupResult {
  // Newest folder per posting, and how many older folders the same posting has.
  const byKey = new Map<string, { created: string; folders: Map<string, string> }>();
  for (const row of rows) {
    if (!row.job_link || !row.output_folder) continue;
    const key = normalizeJobLink(row.job_link);
    if (!key) continue;
    const name = folderName(row.output_folder);
    if (!name) continue;
    const entry = byKey.get(key) ?? { created: "", folders: new Map<string, string>() };
    // Batch rows share one folder across profiles: keep the earliest timestamp seen for that folder.
    const prev = entry.folders.get(name);
    if (!prev || row.created_at < prev) entry.folders.set(name, row.created_at);
    byKey.set(key, entry);
  }

  const seen = new Set<string>();
  const lines: FolderLookupLine[] = pasted
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const link = line.trim();
      if (!link) return { link: "", folder: "", olderCount: 0, repeated: false };
      const key = normalizeJobLink(link);
      const entry = byKey.get(key);
      const repeated = seen.has(key);
      seen.add(key);
      if (!entry || entry.folders.size === 0) return { link, folder: NOT_FOUND, olderCount: 0, repeated };
      const ordered = [...entry.folders.entries()].sort((a, b) => b[1].localeCompare(a[1]));
      return { link, folder: ordered[0][0], olderCount: ordered.length - 1, repeated };
    });

  // A trailing newline from the sheet copy would add an empty last row; drop it so rows stay aligned.
  while (lines.length && !lines[lines.length - 1].link) lines.pop();

  return {
    lines,
    text: lines.map((l) => l.folder).join("\n"),
    matched: lines.filter((l) => l.folder && l.folder !== NOT_FOUND).length,
    notFound: lines.filter((l) => l.folder === NOT_FOUND).length,
    repeated: lines.filter((l) => l.repeated).length,
  };
}
