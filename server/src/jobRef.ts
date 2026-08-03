/** True if `s` is a valid http(s) URL (after trim). */
export function isHttpUrl(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Split the Apply form into stored `job_link` (URL only) and `recruiter_name` (plain text).
 * If the user pastes a non-URL into the job-link field and leaves recruiter empty, treat it as recruiter name.
 */
export function normalizeJobRefForGenerate(rawLink: string, rawRecruiter: string): { job_link: string; recruiter_name: string } {
  const rec = String(rawRecruiter ?? "").trim();
  const link = String(rawLink ?? "").trim();
  if (isHttpUrl(link)) {
    return { job_link: link, recruiter_name: rec };
  }
  if (link && !isHttpUrl(link)) {
    return { job_link: "", recruiter_name: rec || link };
  }
  return { job_link: "", recruiter_name: rec };
}
