import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  subscribeGenerationToasts,
  upsertGenerationToast,
  dismissGenerationToast,
  type GenerationToast,
} from "../generationToasts";
import { api } from "../api";
import { autoDownloadArtifacts, getAutoDownloadRecord } from "../autoDownload";
import { useAuth } from "../auth/AuthContext";
import CopyButton from "./CopyButton";

// Module-scope dedupe: survives React StrictMode's double-mount and any
// subsequent remounts, so a given application is only auto-downloaded once
// per page load regardless of how many times the effect re-runs.
const autoDownloadedApps = new Set<string>();
const autoDownloadInFlight = new Set<string>();
/**
 * The "don't retroactively download history" seed runs ONCE per page load.
 *
 * It used to live inside the effect, so every remount re-ran it and marked whatever was
 * complete at that moment as already handled — including a run that had just finished and
 * never been downloaded. Module scope matches `autoDownloadedApps` above, which is the
 * set it writes into.
 */
let autoDownloadSeeded = false;
// Rejected-duplicate marker rows we've already cleaned up (deleted), so the
// 1.5s poll doesn't try to delete them repeatedly.
const handledDuplicates = new Set<string>();

/**
 * How far back to still catch up a completed run that was never downloaded. Long enough to
 * cover a batch you walked away from, short enough that opening the app tomorrow does not
 * re-download yesterday.
 */
const AUTO_DL_CATCHUP_MS = 2 * 60 * 60 * 1000;

const COLLAPSED_STORAGE_KEY = "enpply.genToast.collapsed";
const GROUPS_STORAGE_KEY = "enpply.genToast.groups";
const IDLE_FADE_MS = 4000;

type GroupKey = "failed" | "running" | "completed" | "viewed";
const GROUP_ORDER: GroupKey[] = ["failed", "running", "completed", "viewed"];
type GroupCollapsed = Record<GroupKey, boolean>;
const DEFAULT_GROUP_COLLAPSED: GroupCollapsed = {
  failed: false,
  running: false,
  completed: false,
  viewed: true,
};
const GROUP_LABEL: Record<GroupKey, string> = {
  failed: "Failed",
  running: "Running",
  completed: "Completed",
  viewed: "Viewed",
};

/**
 * True when the user's browser is talking to a server on the same machine —
 * in that case the server's `output_folder_abs` is also a valid path on the
 * user's filesystem, so we can offer a "Copy path" fallback when auto-
 * download is not configured. For remote servers the path is meaningless on
 * the client side and we hide the button instead.
 */
function isLocalServer(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export default function GenerationToasts() {
  const { user } = useAuth();
  const [items, setItems] = useState<GenerationToast[]>([]);
  const [leavingIds, setLeavingIds] = useState<Record<string, true>>({});
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [idle, setIdle] = useState<boolean>(false);
  const [viewedIds, setViewedIds] = useState<Set<string>>(() => new Set());
  const [itemCollapsed, setItemCollapsed] = useState<Record<string, boolean>>({});
  const [groupCollapsed, setGroupCollapsed] = useState<GroupCollapsed>(() => {
    try {
      const raw = window.localStorage.getItem(GROUPS_STORAGE_KEY);
      if (raw) return { ...DEFAULT_GROUP_COLLAPSED, ...(JSON.parse(raw) as Partial<GroupCollapsed>) };
    } catch {
      /* ignore */
    }
    return DEFAULT_GROUP_COLLAPSED;
  });
  const idleTimerRef = useRef<number | null>(null);
  const dismissTimers = useRef<Record<string, number>>({});
  const currentUserIdRef = useRef<string | null>(null);
  // Role is read the same way as the id: through a ref, because the polling
  // effect below mounts once and would otherwise close over a stale value.
  const currentUserRoleRef = useRef<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    try {
      window.localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groupCollapsed));
    } catch {
      /* ignore quota */
    }
  }, [groupCollapsed]);

  function toggleGroup(key: GroupKey): void {
    setGroupCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function toggleItem(id: string): void {
    setItemCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }
  function markViewed(id: string): void {
    setViewedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore quota/denied */
    }
  }, [collapsed]);

  function armIdleTimer() {
    if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
    setIdle(false);
    idleTimerRef.current = window.setTimeout(() => setIdle(true), IDLE_FADE_MS);
  }

  useEffect(() => {
    armIdleTimer();
    return () => {
      if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
    };
  }, [items.length, collapsed]);

  // Keep a ref of the current user id so the long-lived polling effect
  // below always reads the latest value without needing to restart on
  // every login/logout. When the user signs out we also drop any toasts
  // that belonged to the previous session.
  useEffect(() => {
    const prev = currentUserIdRef.current;
    currentUserIdRef.current = user?.id ?? null;
    currentUserRoleRef.current = user?.role ?? null;
    if (prev !== currentUserIdRef.current) {
      // User changed (login, logout, switch) — clear the toast stack so
      // the previous user's transient notifications don't bleed through.
      setItems([]);
    }
  }, [user?.id]);

  useEffect(() => subscribeGenerationToasts(setItems), []);
  useEffect(() => {
    const stageLabel: Record<string, string> = {
      queued: "Queued",
      extracting_keywords: "Extracting keywords",
      generating_resume: "Generating resume",
      generating_cover_letter: "Generating cover letter",
      generating_answers: "Generating answers",
      completed: "Completed",
      failed: "Failed",
    };
    const shownTerminal = new Set<string>();
    // Remember the most-recent completion toast payload per app so the
    // auto-download hook can upsert the same toast with an added field
    // instead of overwriting the company/role/message state.
    const lastCompletionToast = new Map<string, GenerationToast>();
    const tick = async () => {
      try {
        // If nobody is logged in, skip polling entirely — it would 401
        // anyway and we have nothing to show.
        const currentUserId = currentUserIdRef.current;
        if (!currentUserId) return;
        const { applications } = await api.listApplications();
        // Seed pass: on the first tick, mark every already-completed app as
        // "already handled" so we don't retroactively try to auto-download
        // historical runs. Only apps that transition to completed during
        // this session will fire a download.
        if (!autoDownloadSeeded) {
          for (const a of applications) {
            // Skip only what has ALREADY been downloaded, or what is old enough that the
            // user is clearly not waiting on it. A run that finished minutes ago with no
            // record is one we missed — typically because the tab was reloaded while it
            // was still generating — and it should still land on disk.
            if (a.status !== "completed") continue;
            const already = getAutoDownloadRecord(a.id) !== null;
            const createdMs = Date.parse(a.created_at);
            const recent = Number.isFinite(createdMs) && Date.now() - createdMs < AUTO_DL_CATCHUP_MS;
            if (already || !recent) autoDownloadedApps.add(a.id);
          }
          autoDownloadSeeded = true;
        }
        for (const a of applications.slice(0, 30)) {
          if (!a.run_uuid) continue;
          // When a run transitions back to "generating" (user hit Rerun on
          // the Result page), wipe its auto-download bookkeeping so the
          // next completion fires a fresh download of the new artifacts
          // instead of being deduped by the first run.
          if (a.status === "generating") {
            autoDownloadedApps.delete(a.id);
          }
          // Toasts are "my runs only" — admins still see every row in
          // Logs and Analytics, but the transient toast feed only reacts
          // to runs this user personally started — EXCEPT for admins, who
          // see every run's progress here too (matching what Logs already
          // shows them). Legacy rows without a user_id stay skipped for
          // non-admins, since nobody owns them.
          const isAdmin = currentUserRoleRef.current === "admin";
          if (!isAdmin && a.user_id !== currentUserId) continue;
          // Rejected-duplicate rows are throwaway markers (status failed +
          // duplicate_of). Surface a brief "already generated" notice and
          // delete the row so it doesn't litter Logs — this is the cleanup
          // path for dashboard generation (the extension cleans up its own).
          if (a.status === "failed" && a.duplicate_of) {
            if (!handledDuplicates.has(a.id)) {
              handledDuplicates.add(a.id);
              upsertGenerationToast({
                id: `genapp-${a.id}`,
                applicationId: a.duplicate_of,
                message: "Already generated — duplicate skipped.",
                level: "ok",
                ...(a.company_name && a.company_name !== "Duplicate" ? { companyName: a.company_name } : {}),
              });
              void api.deleteApplication(a.id).catch(() => {});
            }
            continue;
          }
          const id = `genapp-${a.id}`;
          const msg = stageLabel[a.status_step ?? ""] ?? stageLabel[a.status] ?? "Generating";
          const level = a.status === "failed" ? "error" : a.status === "completed" ? "ok" : "info";
          const showDetails = (a.company_name && a.company_name !== "Generating…") || (a.role_name && a.role_name !== "…");
          const toast: GenerationToast = {
            id,
            applicationId: a.id,
            runId: a.run_uuid,
            message: level === "info" ? `${msg}...` : msg,
            level,
            ...(showDetails ? { companyName: a.company_name, roleName: a.role_name } : {}),
            ...(a.status === "failed" && a.generation_error ? { detail: a.generation_error } : {}),
          };
          if (a.status === "completed") {
            const prior = lastCompletionToast.get(a.id);
            if (prior?.autoDownload) toast.autoDownload = prior.autoDownload;
            if (prior?.serverLocalPath) toast.serverLocalPath = prior.serverLocalPath;
            lastCompletionToast.set(a.id, toast);
          }
          upsertGenerationToast(toast);
          if ((a.status === "completed" || a.status === "failed") && !shownTerminal.has(id)) {
            shownTerminal.add(id);
          }
          if (
            a.status === "completed" &&
            !autoDownloadedApps.has(a.id) &&
            !autoDownloadInFlight.has(a.id)
          ) {
            autoDownloadInFlight.add(a.id);
            void runAutoDownload(a.id, toast).finally(() => {
              autoDownloadInFlight.delete(a.id);
              autoDownloadedApps.add(a.id);
            });
          }
        }
      } catch {
        /* ignore polling hiccups */
      }
    };

    function patchCompletionToast(appId: string, patch: Partial<GenerationToast>): void {
      const prior = lastCompletionToast.get(appId);
      if (!prior) return;
      const next: GenerationToast = { ...prior, ...patch };
      lastCompletionToast.set(appId, next);
      upsertGenerationToast(next);
    }

    async function runAutoDownload(appId: string, toast: GenerationToast) {
      patchCompletionToast(appId, { autoDownload: { status: "pending" } });
      try {
        const full = await api.getApplication(appId);
        // Always stash the server path so the toast can fall back to it for
        // "Copy path" when auto-download isn't configured (and the user is on
        // the same machine as the server — gated by isLocalServer() in JSX).
        if (full.output_folder_abs) {
          patchCompletionToast(appId, { serverLocalPath: full.output_folder_abs });
        }
        const result = await autoDownloadArtifacts({
          appId,
          outputFolder: full.output_folder,
          artifacts: full.artifacts ?? {},
          artifactStatus: full.artifact_status ?? {},
          resumeProfile: typeof full.resume_profile === "string" ? full.resume_profile : undefined,
        });
        if (result.status === "ok" && result.files.length > 0) {
          patchCompletionToast(appId, { autoDownload: { status: "ok", displayPath: result.displayPath } });
        } else if (
          result.status === "disabled" ||
          result.status === "no-folder" ||
          result.status === "unsupported"
        ) {
          // User opted out — clear the pending marker (the server-local path
          // fallback, if any, will still drive the Copy-path button).
          patchCompletionToast(appId, { autoDownload: undefined });
        } else if (result.status === "permission-denied") {
          patchCompletionToast(appId, {
            autoDownload: {
              status: "failed",
              error: "Write permission denied for the auto-download folder.",
            },
          });
        } else if (result.status === "stale-handle") {
          patchCompletionToast(appId, {
            autoDownload: {
              status: "failed",
              error: "Auto-download folder is no longer reachable — re-pick it in Config.",
            },
          });
        } else if (result.status === "error") {
          patchCompletionToast(appId, { autoDownload: { status: "failed", error: result.error } });
        }
      } catch (e) {
        patchCompletionToast(appId, {
          autoDownload: {
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
      void toast;
    }
    void tick();
    const t = window.setInterval(() => void tick(), 1500);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    return () => {
      for (const t of Object.values(dismissTimers.current)) window.clearTimeout(t);
      dismissTimers.current = {};
    };
  }, []);

  function dismissWithAnimation(t: GenerationToast) {
    if (leavingIds[t.id]) return;
    setLeavingIds((prev) => ({ ...prev, [t.id]: true }));
    dismissTimers.current[t.id] = window.setTimeout(() => {
      dismissGenerationToast(t.id, t.level);
      setLeavingIds((prev) => {
        const next = { ...prev };
        delete next[t.id];
        return next;
      });
      delete dismissTimers.current[t.id];
    }, 220);
  }

  function dismissAllWithAnimation() {
    for (const t of items) dismissWithAnimation(t);
  }

  async function cancelRun(t: GenerationToast) {
    if (!t.applicationId) return;
    try {
      await api.cancelApplication(t.applicationId);
      upsertGenerationToast({
        ...t,
        message: "Cancelling...",
        level: "info",
      });
    } catch {
      // ignore cancel hiccups
    }
  }

  if (items.length === 0) return null;

  const counts = items.reduce(
    (acc, t) => {
      if (t.level === "ok") acc.ok += 1;
      else if (t.level === "error") acc.error += 1;
      else acc.info += 1;
      return acc;
    },
    { info: 0, ok: 0, error: 0 },
  );

  if (collapsed) {
    const label =
      counts.info > 0
        ? `${counts.info} running`
        : counts.error > 0
          ? `${counts.error} failed`
          : `${counts.ok} done`;
    return (
      <button
        type="button"
        className="gen-toast-pill"
        onClick={() => setCollapsed(false)}
        aria-label="Expand generation toasts"
        title="Show generation toasts"
      >
        {counts.info > 0 ? <span className="gen-toast-spinner" aria-hidden="true" /> : null}
        <span>{label}</span>
        {counts.info + counts.ok + counts.error > 1 ? (
          <span className="gen-toast-pill-group" aria-hidden="true">
            {counts.info > 0 ? <span className="gen-toast-pill-dot info" /> : null}
            {counts.ok > 0 ? <span className="gen-toast-pill-dot ok" /> : null}
            {counts.error > 0 ? <span className="gen-toast-pill-dot error" /> : null}
          </span>
        ) : null}
        <span aria-hidden="true">▾</span>
      </button>
    );
  }

  return (
    <div
      className={`gen-toast-stack${idle ? " idle" : ""}`}
      aria-live="polite"
      onMouseEnter={armIdleTimer}
      onMouseMove={armIdleTimer}
      onFocus={armIdleTimer}
    >
      <div className="gen-toast-controls">
        <button type="button" className="btn danger gen-toast-dismiss-all" onClick={dismissAllWithAnimation}>
          Dismiss all
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse toasts"
          title="Collapse to pill (click pill to expand)"
        >
          ▴
        </button>
      </div>
      {GROUP_ORDER.map((groupKey) => {
        const groupItems = items.filter((t) => {
          if (viewedIds.has(t.id)) return groupKey === "viewed";
          if (t.level === "error") return groupKey === "failed";
          if (t.level === "ok") return groupKey === "completed";
          return groupKey === "running";
        });
        if (groupItems.length === 0) return null;
        const isCollapsed = groupCollapsed[groupKey];
        return (
          <div key={groupKey} className="gen-toast-group">
            <div className={`gen-toast-group-headerrow ${groupKey}`} style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
              <button
                type="button"
                className={`gen-toast-group-header ${groupKey}`}
                onClick={() => toggleGroup(groupKey)}
                aria-expanded={!isCollapsed}
                style={{ flex: 1 }}
              >
                <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                <span className="gen-toast-group-label">{GROUP_LABEL[groupKey]}</span>
                <span className="gen-toast-group-count">{groupItems.length}</span>
              </button>
              <button
                type="button"
                className="btn small"
                title={`Dismiss all ${GROUP_LABEL[groupKey].toLowerCase()}`}
                aria-label={`Dismiss all ${GROUP_LABEL[groupKey].toLowerCase()}`}
                onClick={() => {
                  for (const t of groupItems) dismissWithAnimation(t);
                }}
              >
                Dismiss
              </button>
            </div>
            {isCollapsed
              ? null
              : groupItems.map((t) => {
                  const compact = !!itemCollapsed[t.id];
                  return (
                    <div
                      key={t.id}
                      className={`gen-toast ${t.level} ${leavingIds[t.id] ? "leaving" : ""} ${compact ? "compact" : ""}`}
                    >
                      <div className="gen-toast-topline">
                        <div className="mono gen-toast-runid">{t.runId ?? t.id}</div>
                        <button
                          type="button"
                          className="gen-toast-item-toggle"
                          onClick={() => toggleItem(t.id)}
                          aria-label={compact ? "Expand toast" : "Collapse toast"}
                          title={compact ? "Expand" : "Collapse"}
                        >
                          {compact ? "▸" : "▾"}
                        </button>
                      </div>
                      {compact ? (
                        <div className="gen-toast-compact-body">
                          {t.level === "info" ? <span className="gen-toast-spinner" aria-hidden="true" /> : null}
                          {t.companyName ? (
                            <span className="gen-toast-company gen-toast-company-compact">{t.companyName}</span>
                          ) : (
                            <span>{t.message}</span>
                          )}
                          {t.roleName ? <span className="gen-toast-role-compact">{t.roleName}</span> : null}
                        </div>
                      ) : (
                        <>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                            {t.level === "info" ? <span className="gen-toast-spinner" aria-hidden="true" /> : null}
                            <span>{t.message}</span>
                          </div>
                          {t.companyName ? <div className="gen-toast-company">{t.companyName}</div> : null}
                          {t.roleName ? <div className="mono gen-toast-role">{t.roleName}</div> : null}
                          {t.detail ? (
                            <div
                              className="mono"
                              style={{
                                fontSize: "0.72rem",
                                marginTop: "0.35rem",
                                opacity: 0.95,
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {t.detail}
                            </div>
                          ) : null}
                          {t.autoDownload ? (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.4rem",
                                marginTop: "0.35rem",
                                fontSize: "0.74rem",
                              }}
                            >
                              {t.autoDownload.status === "pending" ? (
                                <>
                                  <span className="gen-toast-spinner" aria-hidden="true" />
                                  <span>Auto-downloading…</span>
                                </>
                              ) : t.autoDownload.status === "ok" ? (
                                <>
                                  <span>Autodownloaded</span>
                                  <span className="mono" style={{ opacity: 0.85 }}>
                                    {t.autoDownload.displayPath}
                                  </span>
                                  <CopyButton text={t.autoDownload.displayPath} label="Copy path" />
                                </>
                              ) : (
                                <>
                                  <span style={{ color: "var(--danger, #c66)" }}>Auto-download failed</span>
                                  {t.autoDownload.error ? (
                                    <span className="mono" style={{ opacity: 0.8 }}>
                                      {t.autoDownload.error}
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </div>
                          ) : null}
                          {/*
                            Fallback Copy-path row: shown on completed toasts
                            only when the auto-download path is NOT the canonical
                            one to copy (either missing or failed) AND the server
                            is running on the same machine as the browser, so the
                            absolute server path actually resolves in the user's
                            file explorer. The button is intentionally hidden
                            when no usable path exists (no client folder picked
                            and server is remote) per the product spec.
                          */}
                          {t.level === "ok" &&
                          t.serverLocalPath &&
                          isLocalServer() &&
                          (!t.autoDownload || t.autoDownload.status !== "ok") ? (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.4rem",
                                marginTop: "0.35rem",
                                fontSize: "0.74rem",
                              }}
                            >
                              <span>Saved on server</span>
                              <span className="mono" style={{ opacity: 0.85 }}>
                                {t.serverLocalPath}
                              </span>
                              <CopyButton text={t.serverLocalPath} label="Copy path" />
                            </div>
                          ) : null}
                          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
                            {t.applicationId && (t.level === "ok" || t.level === "error") ? (
                              <button
                                type="button"
                                className="btn small"
                                onClick={() => {
                                  markViewed(t.id);
                                  navigate(`/result/${encodeURIComponent(t.applicationId!)}`);
                                }}
                              >
                                View result
                              </button>
                            ) : null}
                            {t.level === "info" && t.applicationId ? (
                              <button
                                type="button"
                                className="btn small danger"
                                onClick={() => void cancelRun(t)}
                              >
                                Cancel
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => dismissWithAnimation(t)}
                            >
                              Dismiss
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
          </div>
        );
      })}
    </div>
  );
}
