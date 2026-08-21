// Thin promise wrappers around chrome.storage.local. Everything Tryvify
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

// --- Typed accessors for the keys Tryvify cares about -----------------------

const DEFAULT_API_BASE = "https://tealbridge.online";

/** Resolve the configured Tryvera API base URL (no trailing slash). */
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
 * Auto-download folder preference — the extension's mirror of Tryvera's
 * `enpply.autoDownloadDir` localStorage pref. A content script on a job page
 * can't read the web app's localStorage (different origin), so we keep our own
 * copy. When enabled, this folder is preferred over the server's absolute
 * output path for the "Copy path" button (same priority as Tryvera's
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

/**
 * Chrome can only write into the browser's own Downloads directory: a
 * `chrome.downloads.download` filename is always resolved relative to it, and
 * absolute paths are rejected outright. So the true destination is only
 * knowable after the fact — we read it back via `chrome.downloads.search` and
 * cache the root here. That buys two things: an exact "Copy path", and the
 * ability to honour a custom folder whenever it happens to sit inside Downloads.
 */
export async function getDownloadsRoot() {
  const { downloadsRoot } = await get("downloadsRoot");
  return typeof downloadsRoot === "string" ? downloadsRoot : "";
}

/** @param {string} dir */
export async function setDownloadsRoot(dir) {
  await set({ downloadsRoot: String(dir || "") });
}

/**
 * Where each run's files actually landed on this computer, keyed by appId:
 * { dir, file } — the run folder, and the résumé PDF's full path. "Copy path"
 * hands out `file` so it can be pasted straight into a file picker when the
 * automatic attach fails and the résumé has to be uploaded by hand.
 */
export async function getSavedRunDirs() {
  const { savedRunDirs } = await get("savedRunDirs");
  return savedRunDirs && typeof savedRunDirs === "object" ? savedRunDirs : {};
}

/** @param {string} appId @param {{ dir?: string, file?: string }} info */
export async function setSavedRunDir(appId, info) {
  if (!appId) return;
  const dirs = await getSavedRunDirs();
  const prev = dirs[appId] && typeof dirs[appId] === "object" ? dirs[appId] : {};
  dirs[appId] = {
    dir: String(info?.dir || prev.dir || ""),
    file: String(info?.file || prev.file || ""),
  };
  // Only recent runs matter for "Copy path"; keep the map from growing forever.
  const keys = Object.keys(dirs);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete dirs[k];
  await set({ savedRunDirs: dirs });
}

/**
 * UI theme for the popup and the in-page panel: "system" follows the OS/browser
 * preference, "light"/"dark" pin it. Stored here so both surfaces agree and the
 * choice survives service-worker restarts.
 */
export async function getTheme() {
  const { uiTheme } = await get("uiTheme");
  return uiTheme === "light" || uiTheme === "dark" ? uiTheme : "system";
}

/** @param {"system"|"light"|"dark"} value */
export async function setTheme(value) {
  await set({ uiTheme: value === "light" || value === "dark" ? value : "system" });
}
