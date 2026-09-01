import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import ThemePreview from "../components/ThemePreview";
import KeyboardTextarea from "../components/KeyboardTextarea";
import { FALLBACK_THEME_OPTIONS, normalizeThemeId } from "../themes";
import { upsertGenerationToast } from "../generationToasts";
import { touchAutoDownloadPermission } from "../autoDownload";
import { IconSend } from "../../ui/icons";

const APPLY_GEN_STORAGE_KEY = "enpply:apply:generationOptions";
const APPLY_RESUME_PROFILE_KEY = "enpply:apply:lastResumeProfile";
const APPLY_THEME_KEY = "enpply:apply:lastTheme";
/** Remembered batch selection: [{ id, theme }]. Kept even while batch mode is off. */
const APPLY_BATCH_KEY = "enpply:apply:batchProfiles";
/** Whether batch mode is on. Stored separately so turning it off does not erase the picks. */
const APPLY_BATCH_MODE_KEY = "enpply:apply:batchMode";

type BatchPick = { id: string; theme: string };

function readStoredBatchPicks(): BatchPick[] {
  try {
    const raw = localStorage.getItem(APPLY_BATCH_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is BatchPick =>
        !!x && typeof x === "object" &&
        typeof (x as BatchPick).id === "string" && (x as BatchPick).id.length > 0 &&
        typeof (x as BatchPick).theme === "string"
      )
      .slice(0, 6);
  } catch {
    return [];
  }
}

function readStoredBatchMode(): boolean {
  try {
    return localStorage.getItem(APPLY_BATCH_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function readStoredResumeProfileId(): string | null {
  try {
    const raw = localStorage.getItem(APPLY_RESUME_PROFILE_KEY);
    if (raw == null || typeof raw !== "string") return null;
    const id = raw.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function readStoredThemeId(): string | null {
  try {
    const raw = localStorage.getItem(APPLY_THEME_KEY);
    if (!raw || typeof raw !== "string") return null;
    const id = raw.trim();
    return id.length ? id : null;
  } catch {
    return null;
  }
}

function readStoredGenerationOptions(): {
  gen_resume: boolean;
  gen_cover_letter: boolean;
  gen_answers: boolean;
  gen_fit_answer: boolean;
} {
  const defaults = { gen_resume: true, gen_cover_letter: true, gen_answers: true, gen_fit_answer: false };
  try {
    const raw = localStorage.getItem(APPLY_GEN_STORAGE_KEY);
    if (!raw) return defaults;
    const p = JSON.parse(raw) as Record<string, unknown>;
    const cover =
      typeof p.gen_cover_letter === "boolean"
        ? p.gen_cover_letter
        : typeof p.gen_cv === "boolean"
          ? p.gen_cv
          : defaults.gen_cover_letter;
    return {
      gen_resume: typeof p.gen_resume === "boolean" ? p.gen_resume : defaults.gen_resume,
      gen_cover_letter: cover,
      gen_answers: typeof p.gen_answers === "boolean" ? p.gen_answers : defaults.gen_answers,
      gen_fit_answer: typeof p.gen_fit_answer === "boolean" ? p.gen_fit_answer : defaults.gen_fit_answer,
    };
  } catch {
    return defaults;
  }
}

function initialThemeFromStorage(): string {
  const stored = readStoredThemeId();
  return normalizeThemeId(stored ?? "standard", FALLBACK_THEME_OPTIONS.map((o) => o.id));
}

export default function Apply() {
  const [profiles, setProfiles] = useState<{ id: string }[]>([]);
  const [resumeProfile, setResumeProfile] = useState("");
  const [jobLink, setJobLink] = useState("");
  const [recruiterName, setRecruiterName] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [applyForm, setApplyForm] = useState("");
  const [theme, setTheme] = useState(initialThemeFromStorage);
  const [themeOptions, setThemeOptions] = useState(FALLBACK_THEME_OPTIONS);
  /** Avoid writing localStorage with default theme before API themes/settings have hydrated (prevents clobbering saved choice). */
  const [themeStorageReady, setThemeStorageReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  /** Batch mode: one JD, several profiles, one output folder. */
  const [batchMode, setBatchMode] = useState(readStoredBatchMode);
  const [batchPicks, setBatchPicks] = useState<BatchPick[]>(readStoredBatchPicks);
  const [doneBatch, setDoneBatch] = useState<{ id: string; resume_profile: string }[] | null>(null);
  /** Live status per queued batch profile, so the ZIP is only offered once all are done. */
  const [batchStatus, setBatchStatus] = useState<Record<string, string>>({});
  /**
   * The profile list is long. Once a selection exists it only gets in the way, so it
   * starts collapsed and the summary line carries the chosen profiles.
   */
  const [batchListOpen, setBatchListOpen] = useState(() => readStoredBatchPicks().length === 0);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [genResume, setGenResume] = useState(() => readStoredGenerationOptions().gen_resume);
  const [genCoverLetter, setGenCoverLetter] = useState(() => readStoredGenerationOptions().gen_cover_letter);
  const [genAnswers, setGenAnswers] = useState(() => readStoredGenerationOptions().gen_answers);
  const [genFitAnswer, setGenFitAnswer] = useState(() => readStoredGenerationOptions().gen_fit_answer);
  const [ignoreDuplicateCheck, setIgnoreDuplicateCheck] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(
        APPLY_GEN_STORAGE_KEY,
        JSON.stringify({
          gen_resume: genResume,
          gen_cover_letter: genCoverLetter,
          gen_answers: genAnswers,
          gen_fit_answer: genFitAnswer,
        })
      );
    } catch {
      /* ignore */
    }
  }, [genResume, genCoverLetter, genAnswers, genFitAnswer]);

  useEffect(() => {
    if (!resumeProfile) return;
    try {
      localStorage.setItem(APPLY_RESUME_PROFILE_KEY, resumeProfile);
    } catch {
      /* ignore */
    }
  }, [resumeProfile]);

  useEffect(() => {
    if (!themeStorageReady || !theme) return;
    try {
      localStorage.setItem(APPLY_THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme, themeStorageReady]);

  useEffect(() => {
    api
      .listProfiles()
      .then((rows) => {
        setProfiles(rows);
        const stored = readStoredResumeProfileId();
        const ids = new Set(rows.map((r) => r.id));
        if (stored && ids.has(stored)) {
          setResumeProfile(stored);
        } else {
          setResumeProfile(rows[0]?.id ?? "");
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([api.getSettings(), api.getThemes()])
      .then(([s, th]) => {
        const ids = th.themes.map((x) => x.id);
        setThemeOptions(th.themes);
        const stored = readStoredThemeId();
        if (stored) {
          setTheme(normalizeThemeId(stored, ids));
        } else {
          setTheme(normalizeThemeId(s.default_theme, ids));
        }
        setThemeStorageReady(true);
      })
      .catch(() => {
        setThemeStorageReady(true);
      });
  }, []);

  // Persist the batch selection so the next job description starts from the same set.
  // The picks are stored even when batch mode is off, so toggling the mode off and on
  // does not silently wipe the three profiles the user had chosen.
  useEffect(() => {
    try {
      localStorage.setItem(APPLY_BATCH_KEY, JSON.stringify(batchPicks));
      localStorage.setItem(APPLY_BATCH_MODE_KEY, batchMode ? "1" : "0");
    } catch {
      /* storage disabled - selection just will not persist */
    }
  }, [batchMode, batchPicks]);

  // Drop remembered picks whose profile no longer exists. Without this a deleted profile
  // stays in localStorage, renders no row (so it is invisible), and is still POSTed — the
  // server answers 400 "Profile not found" and the whole batch dies for no visible reason.
  useEffect(() => {
    if (profiles.length === 0) return;
    const live = new Set(profiles.map((p) => p.id));
    setBatchPicks((prev) => (prev.every((p) => live.has(p.id)) ? prev : prev.filter((p) => live.has(p.id))));
  }, [profiles]);

  // Poll the queued batch until every profile settles. The résumés share one output
  // folder, so the ZIP must not be offered until the last one has been written into it.
  useEffect(() => {
    if (!doneBatch || doneBatch.length === 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = new Set(doneBatch.map((a) => a.id));

    const tick = async () => {
      try {
        const { applications } = await api.listApplications();
        if (!alive) return;
        const next: Record<string, string> = {};
        for (const row of applications) {
          if (ids.has(row.id)) next[row.id] = row.status;
        }
        setBatchStatus(next);
        const settled = doneBatch.every((a) => next[a.id] && next[a.id] !== "generating");
        if (!settled) timer = setTimeout(() => void tick(), 2000);
      } catch {
        // Transient failure: keep waiting rather than declaring the batch finished.
        if (alive) timer = setTimeout(() => void tick(), 4000);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [doneBatch]);

  const batchSettled =
    !!doneBatch && doneBatch.length > 0 && doneBatch.every((a) => batchStatus[a.id] && batchStatus[a.id] !== "generating");
  const batchCompleted = doneBatch?.filter((a) => batchStatus[a.id] === "completed") ?? [];

  const pickedIds = new Set(batchPicks.map((p) => p.id));
  /** Theme an unticked row displays, and the one a newly ticked profile inherits. */
  const defaultBatchTheme = normalizeThemeId(theme, themeOptions.map((o) => o.id));
  /**
   * In batch mode the single-profile select is unmounted, so gating on `resumeProfile`
   * would disable Generate on a value the user can no longer set. `loading` is included
   * so a slow queue cannot be submitted twice — in batch mode that queued six runs, not three.
   */
  const submitDisabled = loading || (batchMode ? batchPicks.length === 0 : !resumeProfile);

  function toggleBatchProfile(id: string) {
    setBatchPicks((prev) => {
      const hit = prev.find((p) => p.id === id);
      if (hit) return prev.filter((p) => p.id !== id);
      if (prev.length >= 6) return prev;
      // Seed a newly ticked profile with the theme currently shown in the single-profile
      // picker, so the common case (same layout for everyone) needs no extra clicks.
      return [...prev, { id, theme: defaultBatchTheme }];
    });
  }

  function setBatchTheme(id: string, nextTheme: string) {
    setBatchPicks((prev) => prev.map((p) => (p.id === id ? { ...p, theme: nextTheme } : p)));
  }

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDoneId(null);
    setDoneBatch(null);
    setFallbackNotice(null);
    setLoading(true);
    // Chrome's FileSystemHandle.requestPermission() requires user activation,
    // which the background GenerationToasts poll doesn't have. Trigger the
    // prompt here (inside the form-submit click handler) so later auto-
    // downloads find permission already granted. Fire-and-forget — the
    // generation proceeds regardless of the outcome.
    void touchAutoDownloadPermission();
    try {
      if (batchMode) {
        if (batchPicks.length === 0) {
          setError("Tick at least one profile, or turn off multiple-profile mode.");
          setLoading(false);
          return;
        }
        const allowed = themeOptions.map((o) => o.id);
        const batch = await api.generateBatch({
          profiles: batchPicks.map((p) => ({
            resume_profile: p.id,
            theme: normalizeThemeId(p.theme, allowed),
          })),
          job_link: jobLink,
          recruiter_name: recruiterName.trim() ? recruiterName : null,
          job_description: jobDescription,
          apply_form: applyForm.trim() ? applyForm : null,
          gen_resume: genResume,
          gen_cover_letter: genCoverLetter,
          gen_answers: genAnswers,
          gen_fit_answer: genFitAnswer,
          ignore_duplicate_check: ignoreDuplicateCheck,
        });
        setDoneBatch(batch.applications.map((a) => ({ id: a.id, resume_profile: a.resume_profile })));
        setDoneId(null);
        for (const a of batch.applications) {
          upsertGenerationToast({
            id: `genapp-${a.id}`,
            runId: a.run_uuid,
            message: `Queued (${a.resume_profile})`,
            level: "info",
          });
        }
        setJobLink("");
        setRecruiterName("");
        setJobDescription("");
        setApplyForm("");
        setIgnoreDuplicateCheck(false);
        return;
      }
      const res = await api.generate({
        resume_profile: resumeProfile,
        job_link: jobLink,
        recruiter_name: recruiterName.trim() ? recruiterName : null,
        job_description: jobDescription,
        apply_form: applyForm.trim() ? applyForm : null,
        theme: normalizeThemeId(theme, themeOptions.map((o) => o.id)),
        gen_resume: genResume,
        gen_cover_letter: genCoverLetter,
        gen_answers: genAnswers,
        gen_fit_answer: genFitAnswer,
        ignore_duplicate_check: ignoreDuplicateCheck,
      });
      setDoneId(res.id);
      upsertGenerationToast({ id: `genapp-${res.id}`, runId: res.run_uuid, message: "Queued", level: "info" });
      // Keep profile/theme/generation options; clear only job-specific inputs for quick next run.
      setJobLink("");
      setRecruiterName("");
      setJobDescription("");
      setApplyForm("");
      if (res.llm_fallback_used && res.user_message) {
        setFallbackNotice(res.user_message);
      }
      setIgnoreDuplicateCheck(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      upsertGenerationToast({
        id: `generr-${Date.now()}`,
        message: `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
        level: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <h1><IconSend />Job Apply</h1>
      <p className="sub">
        Paste a job description and choose what to generate (résumé PDF, cover letter PDF, application answers). Résumé profile, PDF
        theme, and generate options are remembered on this browser.
      </p>

      <p>
        <Link to="/logs">Application Logs</Link>
        {" · "}
        <Link to="/">Profiles</Link>
      </p>

      {profiles.length === 0 && (
        <p className="error">
          Create a profile on the <Link to="/">Profiles</Link> page before generating.
        </p>
      )}

      {error && <p className="error">{error}</p>}
      {fallbackNotice && (
        <div className="notice-warn" role="status">
          <strong>API key or model error — placeholder documents.</strong> {fallbackNotice}
        </div>
      )}
      {doneBatch && doneBatch.length > 0 && (
        <div className="card batch-progress">
          <p style={{ marginTop: 0 }}>
            {batchSettled ? (
              <>
                <strong>
                  Batch finished — {batchCompleted.length} of {doneBatch.length} succeeded.
                </strong>{" "}
                All résumés are in one folder.
              </>
            ) : (
              <>
                <strong>Generating {doneBatch.length} résumés for one job description.</strong> They
                run one after another, so the last one finishes last.
              </>
            )}{" "}
            Full detail in <Link to="/logs">Application Logs</Link>.
          </p>
          <ul className="batch-progress-list">
            {doneBatch.map((a) => {
              const st = batchStatus[a.id] ?? "queued";
              return (
                <li key={a.id}>
                  <span className="mono">{a.resume_profile}</span>
                  <span className={`batch-status batch-status-${st}`}>
                    {st === "generating" ? "generating…" : st}
                  </span>
                </li>
              );
            })}
          </ul>
          {batchCompleted.length > 0 && (
            <div className="actions">
              {/* Any completed run works: every profile in the batch shares one folder,
                  so its ZIP already contains all of them. */}
              <a className="btn primary" href={api.folderZipUrl(batchCompleted[0]!.id)}>
                {batchSettled
                  ? `Download all ${batchCompleted.length} as ZIP`
                  : `Download ${batchCompleted.length} finished so far (ZIP)`}
              </a>
            </div>
          )}
        </div>
      )}
      {doneId && (
        <p>
          Generation queued. Track progress in global toasts or <Link to="/logs">Application Logs</Link>.
        </p>
      )}

      <form className="card apply-form apply-form-grid" onSubmit={handleGenerate}>
        <div className="apply-form-col apply-form-col-1">
          <h2 style={{ marginTop: 0 }}>Inputs</h2>

          <label className="checkbox-row" htmlFor="apply-batch-mode">
            <input
              id="apply-batch-mode"
              type="checkbox"
              checked={batchMode}
              onChange={(e) => setBatchMode(e.target.checked)}
            />
            <span>Generate for multiple profiles (one job description)</span>
          </label>

          {!batchMode && (
            <>
              <label htmlFor="apply-profile">Resume profile</label>
              <select
                id="apply-profile"
                required
                className="form-control"
                value={resumeProfile}
                onChange={(e) => setResumeProfile(e.target.value)}
              >
                <option value="" disabled>
                  — select —
                </option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </>
          )}

          {batchMode && (
            <fieldset className="apply-batch-profiles">
              <legend>Profiles and themes ({batchPicks.length} selected, max 6)</legend>

              <button
                type="button"
                className="btn small apply-batch-toggle"
                onClick={() => setBatchListOpen((v) => !v)}
                aria-expanded={batchListOpen}
                aria-controls="apply-batch-list"
              >
                {batchListOpen ? "▾ Hide profiles" : "▸ Choose profiles"}
              </button>

              {!batchListOpen && (
                <p className="hint apply-batch-summary">
                  {batchPicks.length === 0 ? (
                    <>No profiles selected yet — open the list to choose.</>
                  ) : (
                    batchPicks.map((pick) => (
                      <span key={pick.id} className="apply-batch-chip">
                        <span className="mono">{pick.id}</span>
                        <span className="apply-batch-chip-theme">
                          {themeOptions.find((o) => o.id === pick.theme)?.label.split(" — ")[0] ?? pick.theme}
                        </span>
                      </span>
                    ))
                  )}
                </p>
              )}

              {batchListOpen && (
                <div id="apply-batch-list">
              <p className="hint" style={{ marginTop: 0 }}>
                All selected profiles answer the same job description and land in ONE output
                folder, each résumé named after its profile. They are generated one after
                another, not simultaneously.
              </p>
              {profiles.length === 0 && <p className="hint">No profiles available.</p>}
              {profiles.map((p) => {
                const picked = pickedIds.has(p.id);
                const pick = batchPicks.find((x) => x.id === p.id);
                return (
                  <div key={p.id} className="apply-batch-row">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={picked}
                        onChange={() => toggleBatchProfile(p.id)}
                      />
                      <span className="mono">{p.id}</span>
                    </label>
                    <select
                      className="form-control"
                      value={pick ? pick.theme : defaultBatchTheme}
                      disabled={!picked}
                      onChange={(e) => setBatchTheme(p.id, e.target.value)}
                      aria-label={`PDF theme for ${p.id}`}
                    >
                      {themeOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
                </div>
              )}
            </fieldset>
          )}

          <label htmlFor="apply-job-link">Job posting URL (optional)</label>
          <p className="hint" style={{ marginTop: 0 }}>
            Use a full <span className="mono">https://</span> link when you have one. If there
            is no posting, leave this empty and put the recruiter or contact name below — it
            will be stored and used in the output folder name.
          </p>
          <input
            id="apply-job-link"
            type="url"
            className="form-control"
            value={jobLink}
            onChange={(e) => setJobLink(e.target.value)}
            placeholder="https://…"
            autoComplete="url"
            inputMode="url"
          />

          <label htmlFor="apply-recruiter">Recruiter / contact name (optional)</label>
          <input
            id="apply-recruiter"
            type="text"
            className="form-control"
            value={recruiterName}
            onChange={(e) => setRecruiterName(e.target.value)}
            placeholder="When there is no job URL"
            autoComplete="off"
          />

          {!batchMode && (
            <>
          <label htmlFor="apply-theme">Theme (PDF layout when using Chromium)</label>
          <p className="hint" style={{ marginTop: 0 }}>
            Layouts come from <span className="mono">server/templates/</span> (
            <span className="mono">registry.json</span>). Used by default (Chromium). Set{" "}
            <span className="mono">ENPPLY_PDF_ENGINE=pdfkit</span> in{" "}
            <span className="mono">.env</span> for faster plain PDFs (theme choice is ignored).
          </p>
          <select
            id="apply-theme"
            className="form-control"
            name="theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            aria-label="Résumé and cover letter PDF theme"
          >
            {themeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <ThemePreview themeId={normalizeThemeId(theme, themeOptions.map((o) => o.id))} />
            </>
          )}
        </div>

        <div className="apply-form-col apply-form-col-2">
          <h2 style={{ marginTop: 0 }}>Job description</h2>
          <div className="apply-jd-field">
            <label htmlFor="apply-jd">Job description (required)</label>
            <KeyboardTextarea
              id="apply-jd"
              required
              className="form-control"
              value={jobDescription}
              onValueChange={setJobDescription}
              placeholder="Paste the full job description"
            />
          </div>
        </div>

        <div className="apply-form-col apply-form-col-3">
          <h2 style={{ marginTop: 0 }}>Apply form</h2>

          <label htmlFor="apply-form-text">Apply form text (optional)</label>
          <KeyboardTextarea
            id="apply-form-text"
            className="form-control"
            value={applyForm}
            onValueChange={setApplyForm}
            placeholder="Questions from the application form"
          />

          <fieldset className="apply-gen-options">
            <legend>Generate</legend>
            <p className="hint" style={{ marginTop: 0 }}>
              Uncheck items you do not need. Extraction (requirements and questions from the
              JD) still runs; answers are only drafted when &quot;Generate answers&quot; is on.
              If no explicit question exists, enable &quot;Generate fit answer&quot; to still
              output one short fit response.
            </p>
            <label className="checkbox-row">
              <input type="checkbox" checked={genResume} onChange={(e) => setGenResume(e.target.checked)} />
              <span>Generate résumé (PDF)</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={genCoverLetter}
                onChange={(e) => setGenCoverLetter(e.target.checked)}
              />
              <span>Generate cover letter (PDF)</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={genAnswers} onChange={(e) => setGenAnswers(e.target.checked)} />
              <span>Generate answers</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={genFitAnswer} onChange={(e) => setGenFitAnswer(e.target.checked)} />
              <span>Generate fit answer (when no explicit questions)</span>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={ignoreDuplicateCheck}
                onChange={(e) => setIgnoreDuplicateCheck(e.target.checked)}
              />
              <span>Ignore duplicate check</span>
            </label>
          </fieldset>

          <div className="actions">
            <button type="submit" className="btn primary" disabled={submitDisabled}>
              {loading ? "Queueing…" : "Generate"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
