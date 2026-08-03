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

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDoneId(null);
    setFallbackNotice(null);
    setLoading(true);
    // Chrome's FileSystemHandle.requestPermission() requires user activation,
    // which the background GenerationToasts poll doesn't have. Trigger the
    // prompt here (inside the form-submit click handler) so later auto-
    // downloads find permission already granted. Fire-and-forget — the
    // generation proceeds regardless of the outcome.
    void touchAutoDownloadPermission();
    try {
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
      {doneId && (
        <p>
          Generation queued. Track progress in global toasts or <Link to="/logs">Application Logs</Link>.
        </p>
      )}

      <form className="card apply-form apply-form-grid" onSubmit={handleGenerate}>
        <div className="apply-form-col apply-form-col-1">
          <h2 style={{ marginTop: 0 }}>Inputs</h2>

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
            <button type="submit" className="btn primary" disabled={!resumeProfile}>
              {loading ? "Queueing…" : "Generate"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
