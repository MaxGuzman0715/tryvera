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
  getAllSessions,
  getTabSession,
  saveTabSession,
  clearTabSession,
  clearAllTabSessions,
  forgetSession,
  normalizeJobLink,
} from "./lib/session.js";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[enpplify] installed");
  // Tab links saved by an older version may point at the wrong job (see the
  // typed-navigation rule below); start every open tab clean.
  void clearAllTabSessions();
});

// Forget a tab's anchored application when the tab closes, so a future tab with
// the same id starts clean.
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabSession(tabId);
});

// A URL typed or pasted into the address bar (or opened from a bookmark) is a
// new job of your choosing, never the next step of the one the tab showed
// before. So that tab starts clean: its old run is dropped, and it must not
// borrow its opener's run either (a Ctrl+T tab records the tab you were on as
// its opener). Pasting four LinkedIn links into new tabs showed one earlier
// Svitla run on all of them. Link clicks, redirects, form submits and reloads
// are untouched, so Apply → application form keeps its run as before.
const TYPED = new Set(["typed", "auto_bookmark", "generated", "keyword", "start_page"]);
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, transitionType, transitionQualifiers }) => {
  if (frameId !== 0) return;
  const typed = TYPED.has(transitionType) || (transitionQualifiers || []).includes("from_address_bar");
  if (!typed) return;
  void (async () => {
    await clearTabSession(tabId);
    await saveTabSession(tabId, { typedStart: true });
  })();
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
  // This tab's page was typed or pasted in: it isn't continuing the opener's job.
  if ((await getTabSession(tabId))?.typedStart) return null;
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

/**
 * A job's jobright id, the one value that identifies the SAME job across its
 * jobright page and the apply link jobright opens:
 *   jobright posting : jobright.ai/jobs/info/<id>   (last path segment)
 *   apply link       : <ats-url>?jr_id=<id>          (query param)
 * Returns "" when the URL carries no such id (e.g. the /jobs/recommend feed, or
 * a non-jobright page reached directly), which keeps the caller's behavior
 * unchanged in those cases.
 */
function jobIdOf(url) {
  try {
    const u = new URL(url);
    const q =
      u.searchParams.get("jr_id") ||
      u.searchParams.get("gh_jid") ||
      u.searchParams.get("ashby_jid");
    if (q) return q.trim().toLowerCase();
    const m = u.pathname.match(/\/jobs\/info\/([a-z0-9]{8,})/i);
    if (m) return m[1].toLowerCase();
  } catch {
    /* not a URL */
  }
  return "";
}

/** Query params that only say where a click came from, never which job it is. */
const TRACKING_PARAM = /^(utm_.*|src|source|ref|referrer|jr_id|gh_src|lever-source|lever-origin|trk|trackingid|refid|iis|iisn|mode|flowselection|ccuid|codes)$/i;

/**
 * One posting's identity: host + path (minus a leading locale like /en-CA/ and
 * a trailing /application or /apply) + the params that aren't tracking.
 */
function postingKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname
      .replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "")
      .replace(/\/(application|apply)\/?$/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    const query = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM.test(k))
      .map(([k, v]) => `${k.toLowerCase()}=${v}`)
      .sort()
      .join("&");
    return { where: `${u.host.toLowerCase()}${path}`, query };
  } catch {
    return null;
  }
}

/**
 * The same posting on both URLs: the same page, or the same jobright id. A side
 * whose only extra params are tracking ones still matches
 * (ramp/…?src=LinkedIn is ramp/…?jr_id=…).
 */
function samePosting(a, b) {
  const ida = jobIdOf(a);
  if (ida && ida === jobIdOf(b)) return true;
  const x = postingKey(a);
  const y = postingKey(b);
  if (!x || !y || x.where !== y.where) return false;
  return x.query === y.query || !x.query || !y.query;
}

/**
 * The company a careers-site URL names, for the hosts that put it in the URL
 * (jobs.ashbyhq.com/<company>/…, <company>.bamboohr.com, …); "" when the URL
 * doesn't say (Workday's tenant names, LinkedIn, job boards).
 */
function urlCompany(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const seg = u.pathname.split("/").filter(Boolean);
    if (/(^|\.)greenhouse\.io$/.test(host)) return u.searchParams.get("for") || (seg[0] !== "embed" ? seg[0] : "") || "";
    if (/^(jobs\.ashbyhq\.com|jobs\.lever\.co|jobs\.smartrecruiters\.com|apply\.workable\.com|jobs\.jobvite\.com)$/.test(host)) return seg[0] || "";
    if (host === "jobs.dayforcehcm.com") {
      // …/<locale>/<company>/CANDIDATEPORTAL/…; its sign-in pages (/api/auth/…) name no company.
      const rest = /^[a-z]{2}-[a-z]{2}$/i.test(seg[0] || "") ? seg.slice(1) : seg;
      return /^candidateportal$/i.test(rest[1] || "") ? rest[0] : "";
    }
    const sub = host.match(/^([a-z0-9-]+)\.(bamboohr\.com|recruitee\.com|applytojob\.com|breezy\.hr|teamtailor\.com)$/);
    return sub ? sub[1] : "";
  } catch {
    return "";
  }
}

const COMPANY_FILLER = /\b(inc|llc|ltd|corp|corporation|co|company|group|the|systems|technologies|technology|software|solutions|labs|holdings)\b/g;

/** The page names a company and the run is plainly another one (Svitla on /miovision/). */
function companyConflict(pageUrl, runCompany) {
  const slug = urlCompany(pageUrl).toLowerCase().replace(/[^a-z0-9]/g, "");
  const company = String(runCompany || "").toLowerCase();
  if (slug.length < 3 || !company || /^unknown$/.test(company.trim())) return false;
  const words = company.replace(COMPANY_FILLER, " ").split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const joined = company.replace(/[^a-z0-9]/g, "");
  if (joined.includes(slug) || slug.includes(joined)) return false;
  return !words.some((w) => slug.includes(w) || w.includes(slug));
}

/**
 * A jobright feed/list page — a list of many jobs, not a single job. The panel
 * must not pin a specific run to these. A specific job is /jobs/info/<id>, which
 * is deliberately NOT matched here.
 */
function isJobBoardFeed(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)jobright\.ai$/i.test(u.hostname)) return false;
    return /^\/jobs(\/(recommend|liked|applied|external|search))?\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
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
  const pageJobId = jobIdOf(jobLink);
  // 1. EXACT MATCH BY JOB ID WINS. jobright stamps one id on a job's posting
  //    (/jobs/info/<id>) and on the apply link it opens (?jr_id=<id>), so the run
  //    generated for THIS job is found on its apply form no matter how the tab
  //    was opened. Being exact, it beats the tab/opener anchor — whose job is
  //    only a guess (the tab you came from) and was showing the wrong job.
  if (pageJobId && profileId) {
    const all = await getAllSessions();
    for (const k in all) {
      const s = all[k];
      if (s?.appId && s.profileId === profileId && jobIdOf(s.jobLink) === pageJobId) {
        session = s;
        break;
      }
    }
  }
  // 2. Otherwise the ORIGINAL resolution: this tab's anchor, the URL+profile
  //    session, or the opener tab. Only runs when the exact id match found
  //    nothing (a job not generated yet, or a page/run with no id).
  if (!session?.appId) {
    const tabSession = await getTabSession(tabId);
    const urlSession = profileId ? await getSession(jobLink, profileId) : null;
    const tabOk = tabSession?.appId && (!tabSession.profileId || tabSession.profileId === profileId);
    if (tabOk && !(urlSession?.appId && urlSession.appId !== tabSession.appId)) {
      session = tabSession;
    } else if (urlSession?.appId) {
      session = urlSession;
    } else {
      const inherited = await inheritFromOpener(tabId, profileId);
      if (inherited?.appId) session = inherited;
    }
  }
  // Guards (subtractive — only ever REMOVE a wrong run, never add one):
  if (session?.jobLink) {
    const runJobId = jobIdOf(session.jobLink);
    // (a) Both carry a job id and they differ → a stale previous job.
    if (pageJobId && runJobId && pageJobId !== runJobId) session = null;
    // (b) This page is a SPECIFIC job, but the run is anchored to a jobright
    //     FEED (/jobs/recommend etc.) with no specific job of its own. A
    //     feed-anchored run has no claim to this job — it only reached here via
    //     the tab/opener anchor — so it must not carry over. This is the
    //     "generated on the feed, then a different job's apply shows it" bug.
    else if (pageJobId && !runJobId && isJobBoardFeed(session.jobLink)) session = null;
  }
  // The feed page itself lists many jobs, so it never pins one run.
  if (session && isJobBoardFeed(jobLink)) session = null;
  // Server check. The server knows each run's real job link and company, which
  // the local records don't, so it settles what they can get wrong:
  //   - the run generated for THIS posting (same page, ignoring tracking params,
  //     locale and /application) wins over anything saved locally. A wrong
  //     record had stuck Svitla's run on Ramp's and Cority's pages although
  //     each had its own run;
  //   - a run for another company can't sit on a careers page that names its
  //     company (jobs.ashbyhq.com/miovision/… with Svitla's run): dropped, and
  //     its record forgotten;
  //   - no local session at all: an earlier run for this posting, generated
  //     from the dashboard or another device, so the panel can say "you
  //     already applied".
  if (profileId && !isJobBoardFeed(jobLink)) {
    try {
      const { applications } = await listApplications();
      const apps = applications || [];
      const own = apps
        .filter((a) => a.resume_profile === profileId && a.status === "completed" && samePosting(a.job_link, jobLink))
        .sort((x, y) => String(y.created_at || "").localeCompare(String(x.created_at || "")))[0];
      const run = session?.appId ? apps.find((a) => a.id === session.appId) : null;
      // Only when nothing is shown, or what's shown is another posting's run: a
      // newer run of this same posting (a regenerate) is never swapped back.
      const foreign = !session?.appId || (run && !samePosting(run.job_link, jobLink));
      if (own && foreign && own.id !== session?.appId) {
        session = await saveSession(jobLink, profileId, { appId: own.id, runUuid: own.run_uuid, status: own.status });
        if (tabId != null) await saveTabSession(tabId, { appId: own.id, runUuid: own.run_uuid, status: own.status, profileId, jobLink });
      } else if (!own && run && foreign && companyConflict(jobLink, run.company_name)) {
        await forgetSession(jobLink, profileId);
        if (tabId != null && (await getTabSession(tabId))?.appId === run.id) await clearTabSession(tabId);
        session = null;
      }
    } catch {
      /* listing failed — non-fatal, keep what was resolved locally */
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
async function handleGenerate({ jobLink, jobDescription, applyForm, genResume, genCoverLetter, aiPlatform, companyName, roleName }, tabId) {
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
      // AI training / expert platform résumé (separate prompt on the server); absent otherwise.
      ...(aiPlatform ? { ai_platform: true } : {}),
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
            ...(aiPlatform ? { ai_platform: true } : {}),
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
// Q&A slots being created right now, per job+profile. Several frames of one page (or
// a few quick presses) asking at once share one slot instead of each making a run.
const qaCreating = new Map();

async function handleQaCreate(payload, tabId) {
  const profileId = await getSelectedProfile();
  const key = `${normalizeJobLink(payload.jobLink)}::${profileId}`;
  if (qaCreating.has(key)) return qaCreating.get(key);
  const p = createQaSlot(payload, tabId).finally(() => qaCreating.delete(key));
  qaCreating.set(key, p);
  return p;
}

async function createQaSlot({ jobLink, jobDescription, applyForm }, tabId) {
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
async function handleRegenerate({ jobLink, jobDescription, applyForm, genResume, genCoverLetter, aiPlatform, companyName, roleName }, tabId) {
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
      ...(aiPlatform ? { ai_platform: true } : {}),
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
    // Remember this page's run, but never pin one company's run onto a page
    // that names another company: that's how Svitla's run got saved against
    // Ramp's, Cority's and Miovision's pages and kept coming back.
    if (profileId && jobLink && !companyConflict(jobLink, row.company_name)) {
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
