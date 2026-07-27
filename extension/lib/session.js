// "Application session" state, persisted in chrome.storage so it survives MV3
// service-worker termination.
//
// Two indexes, because one job application spans multiple URLs (JD page →
// Apply → multi-step form), all within ONE browser tab:
//   1. tabSessions[tabId]  — the PRIMARY anchor. An application is "stuck" to
//      the tab the user generated in, so navigating Apply/Next keeps the same
//      run even though the URL changes.
//   2. sessions[link::profile] — a URL+profile fallback, so reopening the exact
//      same posting later (or in a fresh tab) still finds its run.

import { get, set, remove } from "./storage.js";

const KEY = "sessions";
const TAB_KEY = "tabSessions";

/** Mirror of the server's normalizeJobLinkForDup so keys line up. */
export function normalizeJobLink(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${pathname}${u.search}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\s+/g, " ");
  }
}

/** @param {string} jobLink @param {string} profileId */
export function sessionKey(jobLink, profileId) {
  return `${normalizeJobLink(jobLink)}::${profileId}`;
}

async function readAll() {
  const { [KEY]: map } = await get(KEY);
  return map && typeof map === "object" ? map : {};
}

/** Look up the stored run for this job+profile, or null. */
export async function getSession(jobLink, profileId) {
  const all = await readAll();
  return all[sessionKey(jobLink, profileId)] || null;
}

/**
 * Create/update the session for this job+profile.
 * @param {string} jobLink @param {string} profileId
 * @param {{ appId: string, runUuid?: string, status?: string }} patch
 */
export async function saveSession(jobLink, profileId, patch) {
  const all = await readAll();
  const k = sessionKey(jobLink, profileId);
  all[k] = { ...(all[k] || {}), jobLink, profileId, ...patch };
  await set({ [KEY]: all });
  return all[k];
}

// --- tab-anchored sessions ---------------------------------------------------

async function readTabSessions() {
  const { [TAB_KEY]: map } = await get(TAB_KEY);
  return map && typeof map === "object" ? map : {};
}

/** The run anchored to this tab, or null. */
export async function getTabSession(tabId) {
  if (tabId == null) return null;
  const all = await readTabSessions();
  return all[String(tabId)] || null;
}

/**
 * Anchor (or update) a run to a tab. profileId is recorded so we can ignore the
 * tab session if the user later switches to a different profile.
 * @param {number} tabId
 * @param {{ appId: string, runUuid?: string, status?: string, profileId?: string, jobLink?: string }} patch
 */
export async function saveTabSession(tabId, patch) {
  if (tabId == null) return null;
  const all = await readTabSessions();
  const k = String(tabId);
  all[k] = { ...(all[k] || {}), ...patch };
  await set({ [TAB_KEY]: all });
  return all[k];
}

/** Forget a tab's session (call when the tab is closed). */
export async function clearTabSession(tabId) {
  if (tabId == null) return;
  const all = await readTabSessions();
  if (all[String(tabId)]) {
    delete all[String(tabId)];
    await set({ [TAB_KEY]: all });
  }
}

export { remove };
