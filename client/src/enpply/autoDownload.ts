/**
 * Auto-download helper: persists a FileSystemDirectoryHandle in IndexedDB
 * and, when a generation completes, mirrors the server's subfolder layout
 * (MM_DD / profile / TS_company_role) into the user-chosen folder and
 * writes the resume + cover letter PDFs there.
 *
 * Note on Windows Defender: writing new `.pdf` files via the File System
 * Access API can race with Defender's real-time scan and fail on `close()`
 * with `InvalidStateError`. The fix is user-side — exclude the target
 * folder from real-time scanning (Windows Security → Exclusions).
 */

const DB_NAME = "enpply-auto-download";
const STORE = "handles";
const KEY = "root";
const RESULTS_PREFIX = "enpply.auto-dl.";

type StoredHandle = {
  handle: FileSystemDirectoryHandle;
  label: string;
  enabled: boolean;
  /**
   * Optional absolute filesystem path the user typed in Config. The browser
   * does not expose absolute paths from `showDirectoryPicker`, so this is
   * the only way to build clickable/pasteable absolute display paths.
   * Empty or undefined falls back to using `label` as the display root.
   */
  absolutePath?: string;
};

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
};

function supported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.indexedDB !== "undefined" &&
    typeof (window as Partial<WindowWithDirectoryPicker>).showDirectoryPicker === "function"
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(): Promise<StoredHandle | null> {
  if (!supported()) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => {
      const raw = req.result as Partial<StoredHandle> | undefined;
      if (!raw || !raw.handle || typeof raw.label !== "string") {
        resolve(null);
        return;
      }
      resolve({
        handle: raw.handle,
        label: raw.label,
        enabled: raw.enabled !== false,
        absolutePath: typeof raw.absolutePath === "string" ? raw.absolutePath : undefined,
      });
    };
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(value: StoredHandle): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function isAutoDownloadSupported(): boolean {
  return supported();
}

export type AutoDownloadConfig = {
  label: string;
  enabled: boolean;
  absolutePath: string;
};

export async function getAutoDownloadConfig(): Promise<AutoDownloadConfig | null> {
  try {
    const stored = await idbGet();
    return stored
      ? { label: stored.label, enabled: stored.enabled, absolutePath: stored.absolutePath ?? "" }
      : null;
  } catch {
    return null;
  }
}

export async function setAutoDownloadAbsolutePath(absolutePath: string): Promise<void> {
  const stored = await idbGet();
  if (!stored) return;
  await idbSet({ ...stored, absolutePath: absolutePath.trim() });
}

export async function pickAutoDownloadFolder(): Promise<AutoDownloadConfig> {
  if (!supported()) {
    throw new Error("File System Access API is not available in this browser.");
  }
  const handle = await (window as unknown as WindowWithDirectoryPicker).showDirectoryPicker({
    mode: "readwrite",
    id: "enpply-auto-download",
  });
  const existing = await idbGet();
  const value: StoredHandle = {
    handle,
    label: handle.name,
    enabled: existing?.enabled ?? true,
    absolutePath: existing?.absolutePath,
  };
  await idbSet(value);
  return {
    label: value.label,
    enabled: value.enabled,
    absolutePath: value.absolutePath ?? "",
  };
}

export async function setAutoDownloadEnabled(enabled: boolean): Promise<void> {
  const stored = await idbGet();
  if (!stored) return;
  await idbSet({ ...stored, enabled });
}

export async function clearAutoDownloadFolder(): Promise<void> {
  if (!supported()) return;
  await idbDelete();
}

async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  };
  if (h.queryPermission) {
    const q = await h.queryPermission({ mode: "readwrite" });
    if (q === "granted") return true;
  }
  if (h.requestPermission) {
    const r = await h.requestPermission({ mode: "readwrite" });
    return r === "granted";
  }
  return true;
}

/**
 * Check (and if necessary prompt for) write permission on the stored auto-
 * download folder. MUST be called synchronously from a user gesture handler
 * (a click, keydown, etc.) because Chrome's `requestPermission` requires
 * user activation and rejects with SecurityError when called from a
 * background async chain like the GenerationToasts polling tick.
 *
 * Returns:
 *   - "granted"    → good to go, auto-download will work
 *   - "denied"     → user said no; auto-download will be skipped
 *   - "no-folder"  → no folder configured; nothing to do
 *   - "disabled"   → user turned off auto-download; nothing to do
 *   - "unsupported"→ File System Access API not available
 *   - "error"      → something went wrong; error message attached
 */
export type TouchPermissionResult =
  | { status: "granted" | "denied" | "no-folder" | "disabled" | "unsupported" }
  | { status: "error"; error: string };

export async function touchAutoDownloadPermission(): Promise<TouchPermissionResult> {
  if (!supported()) return { status: "unsupported" };
  try {
    const stored = await idbGet();
    if (!stored) return { status: "no-folder" };
    if (!stored.enabled) return { status: "disabled" };
    const ok = await ensurePermission(stored.handle);
    return { status: ok ? "granted" : "denied" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Split the server-side `output_folder` into the trailing three segments
 * produced by `makeOutputFolderName` (MM_DD / profile / TS_company_role).
 */
function subfolderSegments(outputFolder: string): string[] {
  const parts = outputFolder.split(/[/\\]/).filter(Boolean);
  return parts.slice(-3);
}

/**
 * Pick the path separator based on the absolute path's style: Windows paths
 * (containing `\` or starting with a drive letter) use `\`; anything else
 * uses `/`. Falls back to `\` on Windows-looking platforms when no
 * absolute path is available.
 */
function chooseSeparator(absolutePath: string | undefined): string {
  if (absolutePath && absolutePath.length > 0) {
    if (absolutePath.includes("\\")) return "\\";
    if (/^[A-Za-z]:/.test(absolutePath)) return "\\";
    return "/";
  }
  if (typeof navigator !== "undefined" && /windows/i.test(navigator.platform || navigator.userAgent)) {
    return "\\";
  }
  return "/";
}

function buildDisplayPath(
  absolutePath: string | undefined,
  label: string,
  segments: string[],
): string {
  const sep = chooseSeparator(absolutePath);
  if (absolutePath && absolutePath.trim().length > 0) {
    const trimmed = absolutePath.replace(/[\\/]+$/, "");
    return [trimmed, ...segments].join(sep);
  }
  return [label, ...segments].join(sep);
}

async function resolveSubfolder(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

type DirHandleWithRemove = FileSystemDirectoryHandle & {
  removeEntry: (name: string) => Promise<void>;
};
type FileHandleWithWritable = FileSystemFileHandle & {
  createWritable: (opts?: {
    keepExistingData?: boolean;
  }) => Promise<FileSystemWritableFileStream>;
};

async function removeIfExists(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await (dir as DirHandleWithRemove).removeEntry(name);
  } catch {
    /* not found — expected */
  }
}

async function writeBlob(
  dir: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  await removeIfExists(dir, filename);
  await removeIfExists(dir, `${filename}.crswap`);
  const fileHandle = (await dir.getFileHandle(filename, { create: true })) as FileHandleWithWritable;
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  try {
    await writable.write(blob);
    await writable.close();
  } catch (e) {
    try {
      await writable.abort();
    } catch {
      /* ignore secondary abort failures */
    }
    throw e;
  }
}

async function fetchArtifact(appId: string, filename: string): Promise<Blob> {
  const url = `/api/applications/${encodeURIComponent(appId)}/artifacts/${encodeURIComponent(filename)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: HTTP ${res.status}`);
  return res.blob();
}

export type AutoDownloadInput = {
  appId: string;
  outputFolder: string;
  artifacts: Record<string, string>;
  artifactStatus: Record<string, string>;
  /**
   * Profile id, used only to find this run's result.json. In a batch several profiles
   * share one folder, so the file is "<profile>_result.json" rather than "result.json".
   */
  resumeProfile?: string;
};

/**
 * Record of a successful auto-download. Stored in localStorage keyed by
 * application id so pages loaded later (e.g. Result.tsx) can display
 * where the files landed.
 */
export type AutoDownloadRecord = {
  /** Root folder's display name (as reported by the browser handle). */
  folderLabel: string;
  /** Subfolder segments joined with backslashes (MM_DD\profile\TS_...). */
  subPath: string;
  /** Display path: `folderLabel\subPath` — used for the copy button. */
  displayPath: string;
  /** Filenames written into the subfolder. */
  files: string[];
  /** Unix ms when the download completed. */
  writtenAt: number;
};

export type AutoDownloadResult =
  | ({ status: "ok" } & AutoDownloadRecord)
  | { status: "disabled" | "unsupported" | "no-folder" | "permission-denied" | "stale-handle" }
  | { status: "error"; error: string };

function resultsKey(appId: string): string {
  return `${RESULTS_PREFIX}${appId}`;
}

function persistRecord(appId: string, record: AutoDownloadRecord): void {
  try {
    window.localStorage.setItem(resultsKey(appId), JSON.stringify(record));
  } catch {
    /* quota or private mode — ignore */
  }
}

export function getAutoDownloadRecord(appId: string): AutoDownloadRecord | null {
  try {
    const raw = window.localStorage.getItem(resultsKey(appId));
    if (!raw) return null;
    return JSON.parse(raw) as AutoDownloadRecord;
  } catch {
    return null;
  }
}

export async function autoDownloadArtifacts(input: AutoDownloadInput): Promise<AutoDownloadResult> {
  if (!supported()) return { status: "unsupported" };

  let stored: StoredHandle | null;
  try {
    stored = await idbGet();
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
  if (!stored) return { status: "no-folder" };
  if (!stored.enabled) return { status: "disabled" };

  try {
    const ok = await ensurePermission(stored.handle);
    if (!ok) return { status: "permission-denied" };

    const segments = subfolderSegments(input.outputFolder);
    if (segments.length === 0) return { status: "error", error: "empty output_folder" };

    let dir: FileSystemDirectoryHandle;
    try {
      dir = await resolveSubfolder(stored.handle, segments);
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") {
        return { status: "stale-handle" };
      }
      throw e;
    }

    const targets: string[] = [];
    const pushIfCompleted = (key: string) => {
      const filename = input.artifacts[key];
      const status = input.artifactStatus[key];
      if (filename && status === "completed") targets.push(filename);
    };
    pushIfCompleted("resume_pdf");
    pushIfCompleted("cover_letter_pdf");

    const written: string[] = [];
    for (const filename of targets) {
      const blob = await fetchArtifact(input.appId, filename);
      await writeBlob(dir, filename, blob);
      written.push(filename);
    }

    // result.json is not in the artifacts map. It is a convenience copy, and its name is
    // NOT fixed: a batch run shares one folder between profiles, so each owns
    // "<profile>_result.json" instead. Fetch it best-effort and never let it fail the
    // download — the PDFs above are the point, and they are already on disk by here.
    for (const candidate of ["result.json", `${input.resumeProfile ?? ""}_result.json`]) {
      if (!candidate || candidate.startsWith("_")) continue;
      try {
        const blob = await fetchArtifact(input.appId, candidate);
        await writeBlob(dir, candidate, blob);
        written.push(candidate);
        break;
      } catch {
        /* try the next name; absence is not an error */
      }
    }

    const displayPath = buildDisplayPath(stored.absolutePath, stored.label, segments);
    const subPath = segments.join(chooseSeparator(stored.absolutePath));
    const record: AutoDownloadRecord = {
      folderLabel: stored.label,
      subPath,
      displayPath,
      files: written,
      writtenAt: Date.now(),
    };
    persistRecord(input.appId, record);
    return { status: "ok", ...record };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
