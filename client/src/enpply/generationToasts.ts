export type GenerationToastAutoDownload =
  | { status: "pending" }
  | { status: "ok"; displayPath: string }
  | { status: "failed"; error?: string };

export type GenerationToast = {
  id: string;
  applicationId?: string;
  runId?: string;
  companyName?: string;
  roleName?: string;
  /** Extra detail for failed runs (e.g. API error message). */
  detail?: string;
  message: string;
  level: "info" | "ok" | "error";
  /** Auto-download status shown inline on completion toasts. */
  autoDownload?: GenerationToastAutoDownload;
  /**
   * Server-side absolute path to the run's output folder (from
   * `output_folder_abs`). When the user is running the server on the same
   * machine as the browser, this is a valid filesystem path they can paste
   * into Explorer / Finder — used as a fallback "Copy path" source when
   * the user has not configured an auto-download folder.
   */
  serverLocalPath?: string;
};

type Listener = (toasts: GenerationToast[]) => void;

const toasts = new Map<string, GenerationToast>();
const DISMISSED_KEY = "enpply:generation_toasts:dismissed";
const dismissedTerminal = new Set<string>();
const mutedInProgress = new Set<string>();
const listeners = new Set<Listener>();

try {
  const raw = localStorage.getItem(DISMISSED_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // Backward compatibility: old format stored a single string[].
      for (const x of parsed) {
        if (typeof x === "string" && x) dismissedTerminal.add(x);
      }
    } else if (parsed && typeof parsed === "object") {
      const p = parsed as { terminal?: unknown; progress?: unknown };
      if (Array.isArray(p.terminal)) {
        for (const x of p.terminal) {
          if (typeof x === "string" && x) dismissedTerminal.add(x);
        }
      }
      if (Array.isArray(p.progress)) {
        for (const x of p.progress) {
          if (typeof x === "string" && x) mutedInProgress.add(x);
        }
      }
    }
  }
} catch {
  /* ignore storage issues */
}

function persistDismissed() {
  try {
    localStorage.setItem(
      DISMISSED_KEY,
      JSON.stringify({
        terminal: Array.from(dismissedTerminal).slice(-500),
        progress: Array.from(mutedInProgress).slice(-500),
      })
    );
  } catch {
    /* ignore storage issues */
  }
}

function emit() {
  const arr = Array.from(toasts.values());
  for (const cb of listeners) cb(arr);
}

export function subscribeGenerationToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(Array.from(toasts.values()));
  return () => listeners.delete(listener);
}

export function upsertGenerationToast(t: GenerationToast): void {
  if (t.level === "info") {
    if (mutedInProgress.has(t.id)) return;
  } else {
    if (dismissedTerminal.has(t.id)) return;
    // If user hid progress updates, terminal state should still be shown.
    if (mutedInProgress.delete(t.id)) persistDismissed();
  }
  toasts.set(t.id, t);
  emit();
}

export function removeGenerationToast(id: string): void {
  toasts.delete(id);
  emit();
}

export function dismissGenerationToast(id: string, level: GenerationToast["level"]): void {
  if (level === "info") mutedInProgress.add(id);
  else dismissedTerminal.add(id);
  persistDismissed();
  toasts.delete(id);
  emit();
}

/** Force-dismiss a toast by id (used by logs-row deletion). */
export function dismissGenerationToastById(id: string): void {
  mutedInProgress.add(id);
  dismissedTerminal.add(id);
  persistDismissed();
  toasts.delete(id);
  emit();
}

/**
 * Clear any dismissal for this toast id so future `upsertGenerationToast`
 * calls will show it again. Used when the user reruns a generation whose
 * completion toast was previously dismissed — otherwise the rerun's
 * completion would be silently suppressed.
 */
export function reviveGenerationToast(id: string): void {
  const wasDismissed = mutedInProgress.delete(id);
  const wasTerminal = dismissedTerminal.delete(id);
  if (wasDismissed || wasTerminal) persistDismissed();
}
