// MV3 service worker — the single place that reads chrome.storage and talks to
// the Tryvera API. Content scripts (which can't use ES module imports) send
// message "intents" here and get plain-object responses back. The worker is
// ephemeral; all durable state lives in chrome.storage (see lib/session.js).

import { me, listProfiles, generate, qaCreate, rerun, setApplyForm, listApplications, getApplication, deleteApplication, fillMap, fillMapProfile, fetchArtifactBlob, fetchBaseResumeBlob, getEnpplifySettings, getProfileAnswers, saveProfileAnswer, saveApplicationAnswer, ApiError } from "./lib/api.js";
import {
  getAuth,
  getSelectedProfile,
  getAutoDownloadPrefs,
  getDownloadsRoot,
  setDownloadsRoot,
  getSavedRunDirs,
  setSavedRunDir,
  getTheme,
  setTheme,
} from "./lib/storage.js";
import {
  getSession,
  saveSession,
  getTabSession,
  saveTabSession,
  clearTabSession,
  normalizeJobLink,
} from "./lib/session.js";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[enpplify] installed");
});

// Forget a tab's anchored application when the tab closes, so a future tab with
// the same id starts clean.
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabSession(tabId);
});

/** Promise wrapper for chrome.tabs.get (returns null on any error). */
function getTab(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(tab || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Link-based session inheritance: when a job's Apply/Next opens the application
 * in a NEW tab, Chrome records the spawning tab as `openerTabId`. If this tab
 * has no anchor yet, inherit the opener tab's run so the new tab continues the
 * same application. Returns the inherited session (also persisted to this tab),
 * or null.
 */
async function inheritFromOpener(tabId, profileId) {
  const tab = await getTab(tabId);
  const openerId = tab?.openerTabId;
  if (openerId == null) return null;
  const opener = await getTabSession(openerId);
  if (!opener?.appId) return null;
  if (opener.profileId && profileId && opener.profileId !== profileId) return null;
  // Copy the opener's run onto this tab so future calls resolve instantly.
  return saveTabSession(tabId, {
    appId: opener.appId,
    runUuid: opener.runUuid,
    status: opener.status,
    profileId: opener.profileId,
    jobLink: opener.jobLink,
  });
}

/** Normalize any thrown error into a serializable shape for the content script. */
function errPayload(e) {
  if (e instanceof ApiError) return { ok: false, status: e.status, error: e.message };
  return { ok: false, status: 0, error: e?.message || String(e) };
}

/**
 * Report whether the user is signed in and which profile is selected, plus any
 * existing run for this job page (so the panel can show Generate vs Regenerate).
 */
async function handleGetState({ jobLink }, tabId) {
  const { token, user } = await getAuth();
  if (!token) return { ok: true, signedIn: false };
  // Validate token + resolve the selected profile's display name.
  let resolvedUser = user;
  try {
    const res = await me();
    resolvedUser = res.user || user;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return { ok: true, signedIn: false };
    // Network error — report so the panel can show it, but treat as not-ready.
    return { ok: false, signedIn: false, error: e?.message || String(e) };
  }
  const profileId = await getSelectedProfile();
  let profileName = profileId;
  try {
    const profiles = await listProfiles();
    const p = profiles.find((x) => x.id === profileId) || profiles[0];
    if (p) profileName = p.basic?.fullName ? `${p.basic.fullName} (${p.id})` : p.id;
  } catch {
    /* non-fatal — fall back to the id */
  }
  // Session resolution, in order of confidence:
  //   1. this tab's own anchor (Apply/Next within the same tab) — UNLESS this
  //      exact page has its own different run (the tab was reused for another
  //      job; the anchor is stale, so the page's own run wins).
  //   2. the URL+profile session (same posting reopened anywhere).
  //   3. the opener tab's anchor (Apply opened the form in a NEW tab — link),
  //      only when this page has no run of its own. This is LAST so a new tab
  //      navigated to a *different* known job doesn't inherit the opener's run
  //      and show the wrong company/role in the memory panel.
  let session = null;
  const tabSession = await getTabSession(tabId);
  const urlSession = profileId ? await getSession(jobLink, profileId) : null;
  const tabOk = tabSession?.appId && (!tabSession.profileId || tabSession.profileId === profileId);
  // If both exist and disagree, the tab was reused for a different posting:
  // trust the page's own run over the stale tab anchor.
  if (tabOk && !(urlSession?.appId && urlSession.appId !== tabSession.appId)) {
    session = tabSession;
  } else if (urlSession?.appId) {
    session = urlSession;
  } else {
    const inherited = await inheritFromOpener(tabId, profileId);
    if (inherited?.appId) session = inherited;
  }
  // Server-backed fallback: no local session, but this user may have already
  // generated for this exact job link + profile from the dashboard or another
  // device. Match by normalized link so the panel can say "you already applied".
  if (!session?.appId && profileId) {
    try {
      const wanted = normalizeJobLink(jobLink);
      if (wanted) {
        const { applications } = await listApplications();
        const prior = (applications || []).find(
          (a) =>
            a.resume_profile === profileId &&
            a.status === "completed" &&
            normalizeJobLink(a.job_link) === wanted,
        );
        if (prior) {
          session = await saveSession(jobLink, profileId, {
            appId: prior.id,
            runUuid: prior.run_uuid,
            status: prior.status,
          });
        }
      }
    } catch {
      /* listing failed — non-fatal, just no server-backed prior */
    }
  }
  return {
    ok: true,
    signedIn: true,
    email: resolvedUser?.email || "",
    // The account role drives what the panel shows (logger / manual_logger hide
    // résumé/CV and, for manual_logger, the AI features). Default to "user".
    role: resolvedUser?.role || "user",
    profileId,
    profileName,
    session,
  };
}

/** Persist a run to both the URL+profile index and the tab anchor. */
async function persistRun(tabId, jobLink, profileId, patch) {
  const saved = await saveSession(jobLink, profileId, patch);
  await saveTabSession(tabId, { ...patch, profileId, jobLink });
  return saved;
}

/** Kick off a fresh generation, or rerun the existing one for this job. */
async function handleGenerate({ jobLink, jobDescription, applyForm, genResume, genCoverLetter, companyName, roleName }, tabId) {
  const profileId = await getSelectedProfile();
  if (!profileId) return { ok: false, error: "No profile selected. Open the Tryvify popup and pick a profile." };
  if (!jobDescription || !jobDescription.trim()) {
    return { ok: false, error: "Could not read any job-description text on this page." };
  }

  // An existing run can come from the tab anchor (Apply/Next within this tab) or
  // the URL+profile session (same posting reopened). Tab anchor wins.
  const tabSession = await getTabSession(tabId);
  const existing =
    (tabSession?.appId && (!tabSession.profileId || tabSession.profileId === profileId) ? tabSession : null) ||
    (await getSession(jobLink, profileId));

  // A brand-new generation (also the fallback when the anchored run is gone).
  const freshGenerate = async () => {
    const res = await generate({
      resume_profile: profileId,
      job_link: jobLink,
      job_description: jobDescription,
      apply_form: applyForm || null,
      gen_resume: !!genResume,
      gen_cover_letter: !!genCoverLetter,
      gen_answers: false,
      gen_fit_answer: false,
      ignore_duplicate_check: false,
      // Manual company/role for a log-only run → server skips extraction.
      ...(companyName && roleName ? { company_name: companyName, role_name: roleName } : {}),
    });
    const saved = await persistRun(tabId, jobLink, profileId, {
      appId: res.id,
      runUuid: res.run_uuid,
      status: res.status || "generating",
    });
    return { ok: true, appId: res.id, status: res.status || "generating", session: saved };
  };

  try {
    if (existing?.appId) {
      // A Q&A-only slot (created by the Q&A button) has no résumé yet — pressing
      // Generate should FILL IT IN by reusing this slot: deep re-extract with the
      // strong model, generate the résumé/cover letter, and preserve the Q&A
      // answers already stored. That's exactly what /:id/rerun does.
      if (existing.qaOnly) {
        try {
          const res = await rerun(existing.appId, {
            gen_resume: !!genResume,
            gen_cover_letter: !!genCoverLetter,
            gen_answers: false,
            gen_fit_answer: false,
          });
          const saved = await persistRun(tabId, jobLink, profileId, {
            appId: res.id || existing.appId,
            runUuid: res.run_uuid || existing.runUuid,
            status: res.status || "generating",
            qaOnly: false,
          });
          return { ok: true, appId: res.id || existing.appId, status: res.status || "generating", session: saved };
        } catch (e) {
          return errPayload(e);
        }
      }
      // Match the dashboard's "generate same job" behavior: DON'T overwrite an
      // existing run. If it's already done, surface "you already applied" and
      // load it; if it's still generating, attach to it. Only a previously
      // failed run falls through to a fresh attempt.
      if (existing.status === "completed") {
        return {
          ok: true,
          appId: existing.appId,
          status: "completed",
          session: existing,
          alreadyApplied: true,
        };
      }
      if (existing.status === "generating") {
        return { ok: true, appId: existing.appId, status: "generating", session: existing };
      }
      // failed/unknown → fall through to a fresh generation below.
    }
    return await freshGenerate();
  } catch (e) {
    return errPayload(e);
  }
}

/**
 * Create a Q&A-only slot for this page (lightweight extraction: company/role +
 * JD answers with the cheap model, no résumé/cover letter). Makes Q&A + Fill
 * work before — or entirely without — generating a résumé. Reuses an existing
 * run for this job+profile if there already is one. The slot is flagged qaOnly
 * so a later Generate reuses it (handleGenerate → rerun) instead of saying
 * "already applied".
 */
async function handleQaCreate({ jobLink, jobDescription, applyForm }, tabId) {
  const profileId = await getSelectedProfile();
  if (!profileId) return { ok: false, error: "No profile selected. Open the Tryvify popup and pick a profile." };
  if (!jobDescription || !jobDescription.trim()) {
    return { ok: false, error: "Could not read any job-description text on this page." };
  }
  // If a run already exists for this job+profile, the Q&A store lives on it —
  // reuse it instead of minting a second slot.
  const tabSession = await getTabSession(tabId);
  const existing =
    (tabSession?.appId && (!tabSession.profileId || tabSession.profileId === profileId) ? tabSession : null) ||
    (await getSession(jobLink, profileId));
  if (existing?.appId) {
    return {
      ok: true,
      appId: existing.appId,
      status: existing.status || "completed",
      session: existing,
    };
  }
  try {
    const res = await qaCreate({
      resume_profile: profileId,
      job_link: jobLink,
      job_description: jobDescription,
      apply_form: applyForm || null,
    });
    const saved = await persistRun(tabId, jobLink, profileId, {
      appId: res.id,
      runUuid: res.run_uuid,
      status: res.status || "completed",
      qaOnly: true,
    });
    return {
      ok: true,
      appId: res.id,
      status: res.status || "completed",
      companyName: res.company_name || "",
      roleName: res.role_name || "",
      session: saved,
    };
  } catch (e) {
    return errPayload(e);
  }
}

/**
 * Force a regeneration: IGNORE whatever existed and always start a brand-new
 * run. The old run is kept; if this would duplicate it (same company+role+
 * profile), the server appends "-1" (then -2, …) to the new run's role so it's
 * distinct (suffix_on_duplicate).
 */
async function handleRegenerate({ jobLink, jobDescription, applyForm, genResume, genCoverLetter, companyName, roleName }, tabId) {
  const profileId = await getSelectedProfile();
  if (!profileId) return { ok: false, error: "No profile selected. Open the Tryvify popup and pick a profile." };
  if (!jobDescription || !jobDescription.trim()) {
    return { ok: false, error: "Could not read any job-description text on this page." };
  }
  try {
    const res = await generate({
      resume_profile: profileId,
      job_link: jobLink,
      job_description: jobDescription,
      apply_form: applyForm || null,
      gen_resume: !!genResume,
      gen_cover_letter: !!genCoverLetter,
      gen_answers: false,
      gen_fit_answer: false,
      // Don't dead-end on a duplicate; make a distinct "-N" run instead.
      suffix_on_duplicate: true,
      // Manual company/role for a log-only re-log → server skips extraction.
      ...(companyName && roleName ? { company_name: companyName, role_name: roleName } : {}),
    });
    const saved = await persistRun(tabId, jobLink, profileId, {
      appId: res.id,
      runUuid: res.run_uuid,
      status: res.status || "generating",
    });
    return { ok: true, appId: res.id, status: res.status || "generating", session: saved };
  } catch (e) {
    return errPayload(e);
  }
}

// --- "Copy path" resolution (mirrors Tryvera's autoDownload.buildDisplayPath) ---
// Tryvera's "Copy path" copies the FINAL folder that holds the run's outputs.
// For the server-side path that's already `output_folder_abs`. For the client
// auto-download dir we must append the run's trailing folder segments to the
// configured root — otherwise we'd copy the root, not the dir with the files.

/** Last three path segments of the relative output_folder (MM_DD/profile/TS_company_role). */
function subfolderSegments(outputFolder) {
  return String(outputFolder || "").split(/[/\\]/).filter(Boolean).slice(-3);
}

/** Choose `\` for Windows-looking paths, else `/` (mirrors Tryvera chooseSeparator). */
function chooseSeparator(absolutePath) {
  if (absolutePath && absolutePath.length > 0) {
    if (absolutePath.includes("\\")) return "\\";
    if (/^[A-Za-z]:/.test(absolutePath)) return "\\";
    return "/";
  }
  return "\\"; // extension runs on the user's machine; default to Windows style
}

/** Join a root dir with the run's subfolder segments, like Tryvera's displayPath. */
function buildDisplayPath(rootDir, segments) {
  const sep = chooseSeparator(rootDir);
  const trimmed = String(rootDir || "").replace(/[\\/]+$/, "");
  return [trimmed, ...segments].join(sep);
}

/**
 * Resolve the "Copy path" string with the same priority Tryvera uses:
 * client auto-download dir (root + run subfolder) → server absolute → relative.
 */
/**
 * Resolve what "Copy path" hands out, plus whether that path exists on THIS
 * computer. Only a path Chrome reported after saving is treated as local; a
 * prediction built from settings is not, because the folder may never have been
 * created. Predictions also run through safeSegment(), since the download
 * rewrites punctuation in folder names and an un-rewritten guess will not open.
 */
function resolveCopyPath(auto, outputFolderAbs, outputFolder, saved, downloadsRoot) {
  if (saved && saved.dir) return { path: saved.dir, local: true };
  if (saved && saved.file) return { path: splitPath(saved.file)[0], local: true };
  const segments = subfolderSegments(outputFolder).map(safeSegment);
  if (downloadsRoot && segments.length) {
    const prefix = auto.enabled ? relativePrefix(auto.dir, downloadsRoot) : "";
    const parts = prefix ? [...prefix.split("/"), ...segments] : segments;
    return { path: buildDisplayPath(downloadsRoot, parts), local: false };
  }
  if (auto.enabled && auto.dir && segments.length) {
    return { path: buildDisplayPath(auto.dir, segments), local: false };
  }
  return { path: outputFolderAbs || outputFolder || "", local: false };
}

/**
 * Poll run progress. While generating, the per-run GET endpoint 500s (no
 * result file yet), so we read it from the list endpoint instead. Once
 * completed we fetch the full result for artifacts.
 */
async function handleStatus({ appId, jobLink }, tabId) {
  try {
    const { applications } = await listApplications();
    let row = (applications || []).find((a) => a.id === appId);
    if (!row) return { ok: true, found: false };

    // Duplicate recovery: a run rejected as a duplicate carries duplicate_of =
    // the pre-existing run's id. Transparently switch to that existing run so
    // the user can keep filling from already-generated documents/answers
    // instead of hitting a dead end.
    let usedExisting = false;
    if (row.status === "failed" && row.duplicate_of) {
      const dupMarkerId = row.id; // the throwaway rejected-duplicate row
      let existing = (applications || []).find((a) => a.id === row.duplicate_of);
      if (!existing) {
        // Not in the caller's list (the duplicate can be another user's run for
        // this shared profile, or just paged out). Access is profile-based, so
        // fetch it directly — this lets the user load and continue from it.
        try {
          existing = await getApplication(row.duplicate_of);
        } catch {
          /* no access / gone — fall through to surfacing the duplicate error */
        }
      }
      if (existing && existing.id) {
        usedExisting = true;
        appId = existing.id;
        row = existing;
        // The marker row exists only to carry duplicate_of to us; now that we've
        // recovered the real run, delete it so it doesn't litter the Logs page.
        try {
          await deleteApplication(dupMarkerId);
        } catch {
          /* best-effort cleanup — recovery already succeeded */
        }
      }
    }

    const profileId = await getSelectedProfile();
    if (profileId && jobLink) {
      await saveSession(jobLink, profileId, { appId, status: row.status });
    }
    // Keep the tab anchor's status/appId fresh too (e.g. after duplicate
    // recovery switched appId), so the panel stays "stuck" to this tab.
    if (tabId != null) {
      await saveTabSession(tabId, { appId, status: row.status, ...(profileId ? { profileId } : {}) });
    }

    let result = null;
    if (row.status === "completed") {
      try {
        result = await getApplication(appId);
      } catch {
        /* artifacts not critical for the status line */
      }
    }

    // Path priority mirrors Tryvera's Result page displayFolder:
    // client auto-download dir (root + run subfolder) → server absolute → relative.
    const auto = await getAutoDownloadPrefs();
    const outputFolderAbs = result?.output_folder_abs || row.output_folder_abs || "";
    const outputFolder = result?.output_folder || row.output_folder || "";
    const savedRun = (await getSavedRunDirs())[appId] || null;
    const rootDir = await getDownloadsRoot();
    const resolved = resolveCopyPath(auto, outputFolderAbs, outputFolder, savedRun, rootDir);
    const copyPath = resolved.path;
    const copyPathIsLocal = resolved.local;

    // Memory summary: what this run actually has on disk.
    const artifacts = result?.artifacts || {};
    const artifactStatus = result?.artifact_status || {};
    const has = (key) =>
      (artifactStatus[key] === "completed" && !!artifacts[key]) || !!artifacts[key];
    const memory = {
      appId,
      runUuid: row.run_uuid || "",
      companyName: row.company_name || "",
      roleName: row.role_name || "",
      hasResume: has("resume_pdf"),
      hasCoverLetter: has("cover_letter_pdf"),
      answersCount: Array.isArray(result?.answers) ? result.answers.length : 0,
    };

    return {
      ok: true,
      found: true,
      appId,
      usedExisting,
      status: row.status,
      statusStep: row.status_step || "",
      companyName: row.company_name || "",
      roleName: row.role_name || "",
      generationError: row.generation_error || "",
      artifactStatus: result?.artifact_status || null,
      outputFolderAbs,
      outputFolder,
      copyPath,
      copyPathIsLocal,
      memory,
    };
  } catch (e) {
    return errPayload(e);
  }
}

/**
 * Fetch a generated artifact (résumé or cover-letter PDF) as a data URL so the
 * content script can open it in a new tab. `key` is the artifact map key.
 */
async function handleArtifact({ appId, key }) {
  if (!appId) return { ok: false, error: "No generated run for this page yet." };
  try {
    const result = await getApplication(appId);
    const name = result?.artifacts?.[key] || "";
    if (!name) return { ok: false, error: "That document was not generated for this run." };
    const { blob, filename, contentType } = await fetchArtifactBlob(appId, name);
    const dataUrl = await blobToDataUrl(blob);
    return { ok: true, dataUrl, filename, contentType };
  } catch (e) {
    return errPayload(e);
  }
}

/** Map harvested form fields to values for the page's active run. */
async function handleFillMap({ appId, fields, mode }) {
  if (!appId) return { ok: false, error: "No generated run for this page yet — Generate first." };
  if (!Array.isArray(fields) || fields.length === 0) {
    return { ok: false, error: "No fillable fields were found on this page." };
  }
  try {
    const res = await fillMap(appId, fields, mode);
    return { ok: true, values: res.values || [], unmatchedRefs: res.unmatchedRefs || [] };
  } catch (e) {
    return errPayload(e);
  }
}

/**
 * Profile-scoped fill-map — no run required. Easy Fill (heuristic) uses profile
 * basics + reusable answers; run-free Q&A (mode "ai"/"both") also forwards
 * `context` (the current page's job text) so the server's AI pass can answer
 * open questions. Falls back to the popup-selected profile when none is passed.
 */
async function handleFillMapProfile({ profileId, fields, mode, context }) {
  const pid = profileId || (await getSelectedProfile());
  if (!pid) return { ok: false, error: "No profile selected. Open the Tryvify popup and pick a profile." };
  if (!Array.isArray(fields) || fields.length === 0) {
    return { ok: false, error: "No fillable fields were found on this page." };
  }
  try {
    const res = await fillMapProfile(pid, fields, mode, context);
    return { ok: true, values: res.values || [], unmatchedRefs: res.unmatchedRefs || [] };
  } catch (e) {
    return errPayload(e);
  }
}

/** Read a Blob as a base64 data URL (message passing can't carry a Blob). */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("Failed to read blob"));
    fr.readAsDataURL(blob);
  });
}

/**
 * Resolve the run's résumé PDF and return it as a data URL the content script
 * can turn into a File for the upload field.
 */
async function handleResume({ appId }) {
  if (!appId) return { ok: false, error: "No generated run for this page yet — Generate first." };
  try {
    const result = await getApplication(appId);
    const artifacts = result?.artifacts || {};
    const status = result?.artifact_status || {};
    // Prefer the résumé; the artifact map keys mirror the server (resume_pdf).
    const name =
      (status.resume_pdf === "completed" && artifacts.resume_pdf) ||
      artifacts.resume_pdf ||
      "";
    if (!name) return { ok: false, error: "No résumé PDF found for this run." };
    const { blob, filename, contentType } = await fetchArtifactBlob(appId, name);
    const dataUrl = await blobToDataUrl(blob);
    return { ok: true, dataUrl, filename, contentType };
  } catch (e) {
    return errPayload(e);
  }
}

/** Fetch the user's Tryvify settings (flags, fill LLM, autofill password). */
async function handleSettings() {
  try {
    const settings = await getEnpplifySettings();
    return { ok: true, settings };
  } catch (e) {
    return errPayload(e);
  }
}

// --- download generated files to the CLIENT machine -------------------------
// The server always writes the run's files on the SERVER's disk; the web app's
// auto-download writes to the browser user's disk but only runs when the Tryvera
// site is open. The extension is a separate client (esp. for a remote/LAN
// backend), so it must fetch the artifacts and save them locally itself. MV3
// service workers can't use the File System Access API, so we use
// chrome.downloads, which lands files in the user's Downloads folder.

/** Sanitize a single path segment for use in a download filename. */
function safeSegment(s) {
  return String(s || "")
    .replace(/[<>:"/\\|?* -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "file";
}

/**
 * Resolve the absolute path Chrome wrote for a download. `download()` resolves
 * when the transfer STARTS, so the filename is frequently empty or a
 * .crdownload temp at that moment; poll until the item reports complete.
 */
function waitForDownloadPath(id, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      chrome.downloads.search({ id }, (items) => {
        const it = items && items[0];
        if (it && it.filename && it.state === "complete") return resolve(it.filename);
        if (Date.now() - started > timeoutMs) {
          return resolve(it && it.filename && it.state !== "interrupted" ? it.filename : "");
        }
        setTimeout(tick, 120);
      });
    };
    tick();
  });
}

/**
 * The Downloads directory, which Chrome exposes through no API. Probe for it
 * once by saving a scratch file at the root and reading back its absolute path,
 * then remove both the file and its history entry. Doing this BEFORE the first
 * real download is what lets a custom sub-folder apply from the very first run.
 */
async function ensureDownloadsRoot() {
  const cached = await getDownloadsRoot();
  if (cached) return cached;
  try {
    const id = await startDownload({
      url: "data:text/plain;base64,MA==",
      filename: "tryvify-path-probe.txt",
      conflictAction: "overwrite",
      saveAs: false,
    });
    const abs = await waitForDownloadPath(id);
    chrome.downloads.removeFile(id, () => void chrome.runtime.lastError);
    chrome.downloads.erase({ id }, () => void chrome.runtime.lastError);
    if (abs) {
      const root = splitPath(abs)[0];
      if (root) {
        await setDownloadsRoot(root);
        return root;
      }
    }
  } catch {
    /* probing is best-effort; without a root the prefix is simply skipped */
  }
  return "";
}

/** Split an absolute path into [dir, base] using whichever separator it uses. */
function splitPath(abs) {
  const i = Math.max(String(abs).lastIndexOf("/"), String(abs).lastIndexOf("\\"));
  return i < 0 ? ["", String(abs)] : [String(abs).slice(0, i), String(abs).slice(i + 1)];
}

/**
 * Derive the browser Downloads root from one observed download: strip the
 * relative filename we asked for off the absolute path Chrome reported. Cached,
 * because Chrome exposes no API for it.
 */
async function learnDownloadsRoot(absPath, relFilename) {
  if (!absPath || !relFilename) return "";
  const BS = String.fromCharCode(92);
  const toSlash = (x) => String(x).split(BS).join("/");
  const abs = toSlash(absPath);
  const rel = toSlash(relFilename);
  let root = "";
  const idx = abs.toLowerCase().lastIndexOf(rel.toLowerCase());
  if (idx > 0) {
    // Slicing on the normalised index is safe: separator swapping is 1:1, so
    // offsets match the original string and its separators are preserved.
    root = absPath.slice(0, idx);
    while (root.endsWith("/") || root.endsWith(BS)) root = root.slice(0, -1);
  } else {
    root = splitPath(absPath)[0];
  }
  if (root) await setDownloadsRoot(root);
  return root;
}

/**
 * Chrome rejects absolute download paths, so a custom folder can only be
 * honoured when it lives inside Downloads — then its remainder becomes a
 * filename prefix. Returns "" when the folder is elsewhere (nothing we can do)
 * or equals the root.
 */
function relativePrefix(customDir, downloadsRoot) {
  if (!customDir || !downloadsRoot) return "";
  const BS = String.fromCharCode(92);
  const trimEnd = (x) => {
    let v = String(x);
    while (v.endsWith("/") || v.endsWith(BS)) v = v.slice(0, -1);
    return v;
  };
  const toSlash = (x) => trimEnd(String(x).split(BS).join("/"));
  const custom = toSlash(customDir);
  const root = toSlash(downloadsRoot);
  if (!root || custom.toLowerCase() === root.toLowerCase()) return "";
  // Outside Downloads: nothing can be done, chrome.downloads would reject it.
  if (!custom.toLowerCase().startsWith(root.toLowerCase() + "/")) return "";
  let rest = custom.slice(root.length);
  while (rest.startsWith("/")) rest = rest.slice(1);
  return rest;
}

/** Promise wrapper for chrome.downloads.download → resolves the downloadId. */
function startDownload(options) {
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.download(options, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Download the run's generated files (résumé + cover letter PDFs + result.json)
 * to the client's Downloads folder, under <MM_DD>/<profile>/<TS_…>/ so
 * the layout mirrors the server. Returns which files were saved and where.
 */
async function handleDownload({ appId }) {
  if (!appId) return { ok: false, error: "No generated run for this page yet — Generate first." };
  try {
    const result = await getApplication(appId);
    const artifacts = result?.artifacts || {};
    const status = result?.artifact_status || {};
    const has = (key) => (status[key] === "completed" && artifacts[key]) || artifacts[key] || "";

    // The server's subfolder (MM_DD/profile/TS_company_role) → a relative dir
    // under Downloads. chrome.downloads always uses "/" separators.
    const segments = subfolderSegments(result?.output_folder || "").map(safeSegment);
    // A custom folder can only be honoured when it sits inside the browser's
    // Downloads directory, since chrome.downloads rejects absolute paths. When it
    // does, its remainder becomes a prefix so files land where the user asked.
    const auto = await getAutoDownloadPrefs();
    const root = await ensureDownloadsRoot();
    const prefix = auto.enabled ? relativePrefix(auto.dir, root) : "";
    const outsideDownloads = !!(auto.enabled && auto.dir && root && !prefix);
    const dir = [prefix, ...segments].filter(Boolean).join("/");

    // Build the file list: the two PDFs (by their server filenames), the JD
    // text, and result.json.
    const targets = [];
    const resumeName = has("resume_pdf");
    const coverName = has("cover_letter_pdf");
    const jdName = has("job_description_txt");
    if (resumeName) targets.push(resumeName);
    if (coverName) targets.push(coverName);
    // The captured job description, saved alongside the docs as a .txt artifact.
    if (jdName) targets.push(jdName);
    // result.json isn't in the artifacts map but the artifact endpoint serves
    // any .json basename in the output folder.
    targets.push("result.json");

    const saved = [];
    const failed = [];
    let savedAbsDir = "";
    let savedResumeFile = "";
    for (const name of targets) {
      try {
        const { blob } = await fetchArtifactBlob(appId, name);
        const dataUrl = await blobToDataUrl(blob);
        const rel = dir ? `${dir}/${safeSegment(name)}` : safeSegment(name);
        const id = await startDownload({
          url: dataUrl,
          filename: rel,
          conflictAction: "overwrite",
          saveAs: false,
        });
        saved.push(name);
        // First file only: ask Chrome where it actually landed. That yields both
        // the Downloads root (cached for next time) and this run's exact folder,
        // so "Copy path" reports an observed location rather than a prediction.
        // Read back where Chrome actually put it: the first file establishes the
        // Downloads root and the run folder; the résumé's own path is kept
        // separately because that is what "Copy path" hands out.
        if (!savedAbsDir || (name === resumeName && !savedResumeFile)) {
          const abs = await waitForDownloadPath(id);
          if (abs) {
            if (!savedAbsDir) {
              await learnDownloadsRoot(abs, rel);
              savedAbsDir = splitPath(abs)[0];
            }
            if (name === resumeName) savedResumeFile = abs;
          }
        }
      } catch (e) {
        failed.push({ name, error: e?.message || String(e) });
      }
    }
    if (saved.length === 0) {
      return { ok: false, error: failed[0]?.error || "Nothing was generated to download." };
    }
    if (savedAbsDir || savedResumeFile) {
      await setSavedRunDir(appId, { dir: savedAbsDir, file: savedResumeFile });
    }
    return {
      ok: true, saved, failed, dir,
      savedDir: savedAbsDir, savedFile: savedResumeFile, outsideDownloads,
    };
  } catch (e) {
    return errPayload(e);
  }
}

/** Fetch the uploaded base résumé as a data URL (for "Use base resume" attach).
 * Base résumés are per profile; use the explicitly-passed profile, else the
 * currently-selected one. */
async function handleBaseResume({ profileId } = {}) {
  try {
    const pid = profileId || (await getSelectedProfile());
    if (!pid) return { ok: false, error: "No profile selected." };
    const { blob, filename, contentType } = await fetchBaseResumeBlob(pid);
    const dataUrl = await blobToDataUrl(blob);
    return { ok: true, dataUrl, filename, contentType };
  } catch (e) {
    return errPayload(e);
  }
}

/**
 * Save (or, with an empty answer, clear) a reusable answer for a profile. The
 * profile defaults to the currently-selected one. Reusable answers are served
 * with no LLM for every application on that profile (Without-AI).
 */
async function handleSaveProfileAnswer({ profileId, question, answer } = {}) {
  try {
    const pid = profileId || (await getSelectedProfile());
    if (!pid) return { ok: false, error: "No profile selected." };
    if (!question || !String(question).trim()) return { ok: false, error: "No question to save." };
    const res = await saveProfileAnswer(pid, question, answer ?? "");
    return { ok: true, items: res.items || [] };
  } catch (e) {
    return errPayload(e);
  }
}

/**
 * Save (or, with an empty answer, delete) one answer in an application's shared
 * result.json answers — used when the user edits a Without-AI answer that came
 * from this application.
 */
async function handleSaveAppAnswer({ appId, question, answer } = {}) {
  try {
    if (!appId) return { ok: false, error: "No generated run for this page yet." };
    if (!question || !String(question).trim()) return { ok: false, error: "No question to save." };
    await saveApplicationAnswer(appId, question, answer ?? "");
    return { ok: true };
  } catch (e) {
    return errPayload(e);
  }
}

/** List a profile's reusable answers (Easy Fill store). Defaults to selected. */
async function handleProfileAnswers({ profileId } = {}) {
  try {
    const pid = profileId || (await getSelectedProfile());
    if (!pid) return { ok: false, error: "No profile selected." };
    const res = await getProfileAnswers(pid);
    return { ok: true, items: res.items || [] };
  } catch (e) {
    return errPayload(e);
  }
}

/** Store/refresh the full application-form page text on a run (separate from
 * the JD). Best-effort; failures are non-fatal to the Q&A flow. */
async function handleSetApplyForm({ appId, applyForm } = {}) {
  try {
    if (!appId) return { ok: false, error: "No run for this page yet." };
    await setApplyForm(appId, applyForm || "");
    return { ok: true };
  } catch (e) {
    return errPayload(e);
  }
}

/** Read an application's Q&A store: result.json answers + dashboard followups. */
async function handleAppQA({ appId } = {}) {
  try {
    if (!appId) return { ok: false, error: "No generated run for this page yet." };
    const result = await getApplication(appId);
    return {
      ok: true,
      answers: Array.isArray(result?.answers) ? result.answers : [],
      followups: Array.isArray(result?.followups) ? result.followups : [],
    };
  } catch (e) {
    return errPayload(e);
  }
}

/** UI theme for the popup and every in-page panel. */
async function handleGetTheme() {
  return { ok: true, theme: await getTheme() };
}

async function handleSetTheme({ theme } = {}) {
  await setTheme(theme);
  return { ok: true, theme: await getTheme() };
}

const HANDLERS = {
  "enpplify:getState": handleGetState,
  "enpplify:generate": handleGenerate,
  "enpplify:qaCreate": handleQaCreate,
  "enpplify:regenerate": handleRegenerate,
  "enpplify:status": handleStatus,
  "enpplify:fillMap": handleFillMap,
  "enpplify:fillMapProfile": handleFillMapProfile,
  "enpplify:resume": handleResume,
  "enpplify:artifact": handleArtifact,
  "enpplify:settings": handleSettings,
  "enpplify:baseResume": handleBaseResume,
  "enpplify:download": handleDownload,
  "enpplify:getTheme": handleGetTheme,
  "enpplify:setTheme": handleSetTheme,
  "enpplify:saveProfileAnswer": handleSaveProfileAnswer,
  "enpplify:saveAppAnswer": handleSaveAppAnswer,
  "enpplify:setApplyForm": handleSetApplyForm,
  "enpplify:profileAnswers": handleProfileAnswers,
  "enpplify:appQA": handleAppQA,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return false;
  const tabId = sender?.tab?.id;
  Promise.resolve(handler(msg.payload || {}, tabId))
    .then(sendResponse)
    .catch((e) => sendResponse(errPayload(e)));
  return true; // keep the message channel open for the async response
});
