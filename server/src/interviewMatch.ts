import type { ApplicationLogEntry, InterviewMatchStatus } from "./types.js";

/**
 * Ties an interview email to the application that produced it.
 *
 * The recipient address decides the profiles (done by the caller); here the
 * company narrows to that company's applications, and the role breaks ties
 * between several postings at one company. Anything less than one clear
 * winner goes to a person as `needs_check` — a wrong automatic link is worse
 * than no link, because nobody looks twice at a row that already has one.
 */

/** Legal suffixes and filler that differ between a JD's company name and the email's. */
const COMPANY_FILLER = new Set([
  "inc", "llc", "ltd", "corp", "corporation", "co", "company", "group", "the", "holdings",
  "incorporated", "limited", "plc", "gmbh", "of", "and", "usa", "us",
  "technologies", "technology", "solutions", "systems", "labs", "software", "services",
]);

/**
 * Words that say nothing about which posting a role is. "Engineer" and
 * "developer" are in every title, so letting them count linked "Senior Backend,
 * Database & Performance Engineer" to a plain "Software Engineer". Seniority is
 * NOT filler: it is what separates "Staff Software Developer" from "Senior
 * Software Developer" at the same company.
 */
const ROLE_FILLER = new Set([
  "engineer", "engineering", "developer", "software", "remote", "hybrid", "onsite", "contract",
  "the", "and", "of", "for", "a", "an", "to", "in", "at", "with",
  "position", "role", "opportunity", "unknown",
]);

/** Spellings of one seniority, so "Sr" and "Senior" agree. */
const ROLE_ALIASES: Record<string, string> = { sr: "senior", jr: "junior" };

function words(s: string, filler: Set<string>): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((w) => ROLE_ALIASES[w] ?? w)
    .filter((w) => w && !filler.has(w));
}

const normCache = new Map<string, string>();

export function normCompany(s: string): string {
  const key = String(s ?? "");
  let v = normCache.get(key);
  if (v === undefined) {
    v = words(key, COMPANY_FILLER).join(" ");
    if (normCache.size > 20_000) normCache.clear();
    normCache.set(key, v);
  }
  return v;
}

/** Only the legal form: dropping these never changes which company a name means. */
const LEGAL_SUFFIX = new Set([
  "inc", "llc", "ltd", "corp", "corporation", "co", "company", "incorporated", "limited", "plc", "gmbh", "the",
]);

/**
 * Same company if equal after normalising, or one name is a whole-word run
 * inside the other ("EPAM" / "EPAM Systems", "Turing" / "Turing Enterprises,
 * Inc."). Containment alone is too loose once filler is stripped — "US Bank"
 * becomes "bank", which sits inside "Bank of America" — so the shorter name
 * must also keep every one of its own words, minus legal suffixes, in the longer.
 */
export function sameCompany(a: string, b: string): boolean {
  const x = normCompany(a);
  const y = normCompany(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "Lutrapartners" in a sheet, "Lutra Partners" in the email.
  if (x.replace(/ /g, "") === y.replace(/ /g, "")) return true;
  const inside = (short: string, long: string, shortRaw: string, longRaw: string) => {
    if (!` ${long} `.includes(` ${short} `)) return false;
    const longWords = new Set(words(longRaw, LEGAL_SUFFIX));
    return words(shortRaw, LEGAL_SUFFIX).every((w) => longWords.has(w));
  };
  return inside(y, x, b, a) || inside(x, y, a, b);
}

/** Share of the shorter role's meaningful words found in the other, 0..1. */
export function roleOverlap(a: string, b: string): number {
  const x = new Set(words(a, ROLE_FILLER));
  const y = new Set(words(b, ROLE_FILLER));
  if (!x.size || !y.size) return 0;
  return overlap(x, y);
}

/**
 * Seniority separates postings at one company, but agreeing on it alone does
 * not make two roles the same posting: "Senior Software Engineer II -
 * Integrations" and "Senior Software Engineer I - Platform Enablement" share
 * only "senior".
 */
const SENIORITY = new Set(["senior", "junior", "lead", "staff", "principal", "i", "ii", "iii", "iv"]);

/** Both roles say something specific, and none of it agrees: a different posting. */
export function rolesConflict(a: string, b: string): boolean {
  const specific = (s: string) => new Set(words(s, ROLE_FILLER).filter((w) => !SENIORITY.has(w)));
  const x = specific(a);
  const y = specific(b);
  return x.size > 0 && y.size > 0 && overlap(x, y) === 0;
}

function overlap(x: Set<string>, y: Set<string>): number {
  let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  return hit / Math.min(x.size, y.size);
}

/** Margin the best role score must clear over the runner-up to be picked automatically. */
const ROLE_MARGIN = 0.25;
/** An application made more than a day after the email can't have produced it. */
const AFTER_EMAIL_GRACE_MS = 24 * 60 * 60 * 1000;

export type MatchResult = {
  match_status: Extract<InterviewMatchStatus, "auto_matched" | "needs_check">;
  application_id: string | null;
  candidate_ids: string[];
  match_note: string;
};

export function matchInterview(
  ev: { company: string; role: string; received_at: string; profile_ids: string[] },
  apps: ApplicationLogEntry[]
): MatchResult {
  const none = (match_note: string, candidate_ids: string[] = []): MatchResult => ({
    match_status: "needs_check",
    application_id: null,
    candidate_ids,
    match_note,
  });

  if (!ev.profile_ids.length) return none("No profile uses the address this email was sent to.");
  if (!normCompany(ev.company)) return none("The email names no company.");

  const latest = Date.parse(ev.received_at) + AFTER_EMAIL_GRACE_MS;
  const candidates = apps.filter(
    (a) =>
      ev.profile_ids.includes(a.resume_profile) &&
      // A run that failed produced no résumé, so nothing was sent from it.
      a.status !== "failed" &&
      !(Number.isFinite(latest) && Date.parse(a.created_at) > latest) &&
      sameCompany(a.company_name, ev.company)
  );
  if (!candidates.length) return none(`No application to ${ev.company} for this profile.`);

  const scored = candidates
    .map((a) => ({ a, score: roleOverlap(ev.role, a.role_name) }))
    .sort((p, q) => q.score - p.score || q.a.created_at.localeCompare(p.a.created_at));
  const ids = scored.slice(0, 10).map((s) => s.a.id);

  if (scored.length === 1) {
    if (rolesConflict(ev.role, scored[0].a.role_name)) {
      return none(
        `The only application to ${scored[0].a.company_name} is for "${scored[0].a.role_name}", not "${ev.role}".`,
        ids
      );
    }
    return {
      match_status: "auto_matched",
      application_id: scored[0].a.id,
      candidate_ids: ids,
      match_note: `Only application to ${scored[0].a.company_name} for this profile.`,
    };
  }

  const [best, second] = scored;
  // Same test as the single-candidate case: winning on "senior" alone while
  // the specific words disagree is still a different posting.
  if (best.score > 0 && best.score - second.score >= ROLE_MARGIN && !rolesConflict(ev.role, best.a.role_name)) {
    return {
      match_status: "auto_matched",
      application_id: best.a.id,
      candidate_ids: ids,
      match_note: `Best role match among ${scored.length} applications to ${best.a.company_name}.`,
    };
  }
  return none(
    `${scored.length} applications to ${best.a.company_name}; the role doesn't single one out.`,
    ids
  );
}
