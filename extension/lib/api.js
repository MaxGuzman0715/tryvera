// enpply API client for the extension. Every call sends the stored session
// token as `Authorization: Bearer` (see server middleware `getBearerToken`).
// A 401 means the token expired or was revoked — callers should re-prompt
// sign-in.

import { getApiBase, getToken, clearAuth } from "./storage.js";

export class ApiError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Hard cap on every request. Without this a hung/unreachable base (e.g. a down
// production server) leaves the fetch pending forever; the MV3 service worker is
// then torn down before it can respond, and the content script only sees the
// opaque "The message port closed before a response was received." A timeout
// turns that into a clear, surfaced error instead.
const REQUEST_TIMEOUT_MS = 30000;

/** fetch() with an AbortController timeout. Throws on timeout so callers can
 * report "server didn't respond" rather than hanging. */
async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`Server did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} path API path beginning with "/api/..."
 * @param {RequestInit & { auth?: boolean, timeoutMs?: number }} [opts]
 */
async function request(path, opts = {}) {
  const base = await getApiBase();
  const headers = new Headers(opts.headers || {});
  if (opts.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (opts.auth !== false) {
    const token = await getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const { timeoutMs, ...init } = opts;
  let res;
  try {
    res = await fetchWithTimeout(`${base}${path}`, { ...init, headers }, timeoutMs);
  } catch (e) {
    throw new ApiError(0, `Cannot reach ${base} — is the server running and the API base correct? (${e.message})`);
  }
  if (res.status === 401) {
    await clearAuth();
    throw new ApiError(401, "Session expired. Please sign in again.");
  }
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const payload = isJson ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const msg = isJson && payload && payload.error
      ? (typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error))
      : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return payload;
}

/** @param {string} email @param {string} password */
export function login(email, password) {
  return request("/api/auth/login", {
    method: "POST",
    auth: false,
    body: JSON.stringify({ email, password }),
  });
}

export function me() {
  return request("/api/auth/me", { method: "GET" });
}

export function listProfiles() {
  return request("/api/profiles", { method: "GET" });
}

/** Per-user enpplify settings (feature flags, fill LLM, autofill password). */
export function getEnpplifySettings() {
  return request("/api/enpplify/settings", { method: "GET" });
}

/** List a profile's reusable answers (Without-AI source across its apps). */
export function getProfileAnswers(profileId) {
  return request(`/api/enpplify/profile-answers?profileId=${encodeURIComponent(profileId || "")}`, {
    method: "GET",
  });
}

/** Upsert (or, with empty answer, remove) a profile's reusable answer. */
export function saveProfileAnswer(profileId, question, answer) {
  return request("/api/enpplify/profile-answers", {
    method: "PUT",
    body: JSON.stringify({ profileId, question, answer }),
  });
}

/** Upsert (or, with empty answer, remove) one answer in an application's
 * shared result.json answers — used when editing a Without-AI app answer. */
export function saveApplicationAnswer(id, question, answer) {
  return request(`/api/applications/${encodeURIComponent(id)}/answers`, {
    method: "PUT",
    body: JSON.stringify({ question, answer }),
  });
}

/**
 * Start a generation run. Mirrors the dashboard's Job Apply form.
 * @param {{
 *   resume_profile: string,
 *   job_link?: string,
 *   job_description: string,
 *   apply_form?: string|null,
 *   gen_resume?: boolean,
 *   gen_cover_letter?: boolean,
 *   gen_answers?: boolean,
 *   gen_fit_answer?: boolean,
 *   ignore_duplicate_check?: boolean,
 * }} body
 */
export function generate(body) {
  return request("/api/applications/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Create a Q&A-only generation slot via a LIGHTWEIGHT extraction (company/role
 * + JD answers, cheap model) — no résumé/cover letter. Synchronous: resolves
 * once the slot is created so the caller gets company/role + answers back and
 * can render the Q&A list immediately. Pressing Generate later reuses this slot.
 * @param {{
 *   resume_profile: string,
 *   job_link?: string,
 *   job_description: string,
 *   apply_form?: string|null,
 *   gen_answers?: boolean,
 *   gen_fit_answer?: boolean,
 * }} body
 */
export function qaCreate(body) {
  // Synchronous on the server (runs the extraction inline), so allow more than
  // the default 30s — a slow provider can push a single extraction past it.
  return request("/api/applications/qa-create", {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: 90000,
  });
}

/** Store/refresh the full application-form page text on a run (separate from
 * the JD). Empty clears it. */
export function setApplyForm(id, applyForm) {
  return request(`/api/applications/${encodeURIComponent(id)}/apply-form`, {
    method: "PUT",
    body: JSON.stringify({ apply_form: applyForm || "" }),
  });
}

/** Re-run an existing application (reuses its output folder). */
export function rerun(id, body) {
  return request(`/api/applications/${encodeURIComponent(id)}/rerun`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** List the caller's applications (used to poll run status/progress). */
export function listApplications() {
  return request("/api/applications", { method: "GET" });
}

/** Full result.json for a completed run (artifacts, answers, metadata). */
export function getApplication(id) {
  return request(`/api/applications/${encodeURIComponent(id)}`, { method: "GET" });
}

/** Delete an application by id (cleans up rejected-duplicate marker rows). */
export function deleteApplication(id) {
  return request(`/api/applications/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Map harvested form fields to values for a run.
 * @param {string} id @param {Array<object>} fields
 */
export function fillMap(id, fields, mode) {
  const aiPass = mode === "ai" || mode === "both";
  return request(`/api/applications/${encodeURIComponent(id)}/fill-map`, {
    method: "POST",
    body: JSON.stringify({ fields, ...(mode ? { mode } : {}) }),
    // The AI pass calls the LLM (slow provider + retries can exceed the default
    // 30s); the heuristic pass is instant, so keep its fast-fail timeout.
    ...(aiPass ? { timeoutMs: 120000 } : {}),
  });
}

/**
 * Profile-scoped fill-map — no generated run required.
 *  - Easy Fill (no/heuristic mode): profile basics + reusable answers only.
 *  - Run-free Q&A (mode "ai"/"both"): pass `context` with the current page's job
 *    text so the server's AI pass can answer open questions without a run.
 * @param {string} profileId
 * @param {Array<object>} fields
 * @param {string} [mode]
 * @param {{ job_description?: string, apply_form?: string, company?: string, role?: string }} [context]
 */
export function fillMapProfile(profileId, fields, mode, context) {
  const aiPass = mode === "ai" || mode === "both";
  return request(`/api/enpplify/fill-map`, {
    method: "POST",
    body: JSON.stringify({ profileId, fields, ...(mode ? { mode } : {}), ...(context || {}) }),
    // Run-free Q&A hits the LLM (slow + retries); Easy Fill (heuristic) is instant.
    ...(aiPass ? { timeoutMs: 120000 } : {}),
  });
}

/**
 * Fetch a generated artifact (e.g. résumé PDF) as a Blob, with the bearer
 * token attached. Returns { blob, filename, contentType }.
 * @param {string} id @param {string} name artifact basename, e.g. "<profile>.pdf"
 */
export async function fetchArtifactBlob(id, name) {
  const base = await getApiBase();
  const token = await getToken();
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const url = `${base}/api/applications/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers });
  } catch (e) {
    throw new ApiError(0, `Cannot reach ${base} (${e.message})`);
  }
  if (res.status === 401) {
    await clearAuth();
    throw new ApiError(401, "Session expired. Please sign in again.");
  }
  if (!res.ok) throw new ApiError(res.status, `Failed to fetch ${name} (${res.status})`);
  const blob = await res.blob();
  return { blob, filename: name, contentType: res.headers.get("content-type") || "application/pdf" };
}

/**
 * Fetch the user's uploaded base résumé PDF for a given profile as a Blob
 * (bearer token attached). Base résumés are stored per profile.
 */
export async function fetchBaseResumeBlob(profileId) {
  const base = await getApiBase();
  const token = await getToken();
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const url = `${base}/api/enpplify/base-resume?profileId=${encodeURIComponent(profileId || "")}`;
  let res;
  try {
    res = await fetchWithTimeout(url, { headers });
  } catch (e) {
    throw new ApiError(0, `Cannot reach ${base} (${e.message})`);
  }
  if (res.status === 401) {
    await clearAuth();
    throw new ApiError(401, "Session expired. Please sign in again.");
  }
  if (res.status === 404) throw new ApiError(404, "No base resume uploaded for this profile.");
  if (!res.ok) throw new ApiError(res.status, `Failed to fetch base resume (${res.status})`);
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  return {
    blob,
    filename: m ? m[1] : "base_resume.pdf",
    contentType: res.headers.get("content-type") || "application/pdf",
  };
}

export { request };
