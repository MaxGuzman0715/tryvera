// Thin promise wrappers around chrome.storage.local. Everything enpplify
// persists (auth token, API base, selected profile, active application
// session) lives here so it survives MV3 service-worker termination.

/** @param {string|string[]} keys */
export function get(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => resolve(items));
  });
}

/** @param {Record<string, unknown>} items */
export function set(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
}

/** @param {string|string[]} keys */
export function remove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

// --- Typed accessors for the keys enpplify cares about -----------------------

const DEFAULT_API_BASE = "https://tealbridge.online";

/** Resolve the configured enpply API base URL (no trailing slash). */
export async function getApiBase() {
  const { apiBase } = await get("apiBase");
  return (apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}

export async function setApiBase(value) {
  await set({ apiBase: String(value || "").replace(/\/+$/, "") });
}

export async function getToken() {
  const { token } = await get("token");
  return token || "";
}

export async function getAuth() {
  const { token, user } = await get(["token", "user"]);
  return { token: token || "", user: user || null };
}

export async function setAuth(token, user) {
  await set({ token, user });
}

export async function clearAuth() {
  await remove(["token", "user"]);
}

export async function getSelectedProfile() {
  const { selectedProfile } = await get("selectedProfile");
  return selectedProfile || "";
}

export async function setSelectedProfile(id) {
  await set({ selectedProfile: id });
}

/**
 * Auto-download folder preference — the extension's mirror of enpply's
 * `enpply.autoDownloadDir` localStorage pref. A content script on a job page
 * can't read the web app's localStorage (different origin), so we keep our own
 * copy. When enabled, this folder is preferred over the server's absolute
 * output path for the "Copy path" button (same priority as enpply's
 * displayFolder: client dir → output_folder_abs → output_folder).
 *
 * @returns {Promise<{ enabled: boolean, dir: string }>}
 */
export async function getAutoDownloadPrefs() {
  const { autoDownload } = await get("autoDownload");
  return {
    enabled: !!(autoDownload && autoDownload.enabled),
    dir: (autoDownload && typeof autoDownload.dir === "string" ? autoDownload.dir : "").trim(),
  };
}

/** @param {{ enabled: boolean, dir: string }} prefs */
export async function setAutoDownloadPrefs(prefs) {
  await set({
    autoDownload: {
      enabled: !!prefs.enabled,
      dir: String(prefs.dir || "").trim(),
    },
  });
}

export { DEFAULT_API_BASE };
