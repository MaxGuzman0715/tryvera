import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FALLBACK_THEME_OPTIONS, normalizeThemeId } from "../themes";
import { api } from "../api";
import type { FollowupQa, LlmProvider, MatchScoreSummary, ResultJson } from "../types";
import { formatDateTimeJst } from "../timeJst";
import { getAutoDownloadRecord, type AutoDownloadRecord } from "../autoDownload";
import { reviveGenerationToast, upsertGenerationToast } from "../generationToasts";
import CopyButton from "../components/CopyButton";

const MATCH_FACTOR_LABELS: Record<keyof MatchScoreSummary["breakdown"], string> = {
  experience_level: "Experience level",
  relevant_experience: "Relevant experience",
  core_skills: "Core skills",
  industry_experience: "Industry experience",
};

function scoreColor(n: number): string {
  if (n >= 80) return "#2e7d32";
  if (n >= 60) return "#ed8c00";
  return "#c62828";
}

const KW_STATUS_ICON: Record<"yes" | "partial" | "no", string> = { yes: "✓", partial: "~", no: "✗" };
const KW_STATUS_COLOR: Record<"yes" | "partial" | "no", string> = { yes: "#2e7d32", partial: "#ed8c00", no: "#c62828" };
const KW_STATUS_LABEL: Record<"yes" | "partial" | "no", string> = { yes: "Matched", partial: "Partial / transferable", no: "Missing" };
const KW_IMPORTANCE_LABEL: Record<"required" | "preferred" | "nice_to_have", string> = {
  required: "Required",
  preferred: "Preferred",
  nice_to_have: "Nice-to-have",
};

function isOpenableArtifactFilename(fn: string): boolean {
  if (!fn || fn.includes("/") || fn.includes("\\") || fn.includes("..")) return false;
  return /\.(pdf|json|md|txt)$/i.test(fn);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}

function asAnswers(v: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const o = x as { question?: unknown; answer?: unknown };
      return { question: String(o.question ?? ""), answer: String(o.answer ?? "") };
    })
    .filter((x): x is { question: string; answer: string } => Boolean(x && (x.question || x.answer)));
}

export default function Result() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ResultJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editCompany, setEditCompany] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editJobLink, setEditJobLink] = useState("");
  const [editRecruiter, setEditRecruiter] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);
  const [saveMetaError, setSaveMetaError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setError(null);
    api
      .getApplication(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    if (!data) return;
    setEditCompany(data.company_name);
    setEditRole(data.role_name);
    setEditJobLink(data.job_link ?? "");
    setEditRecruiter(data.recruiter_name ?? "");
    setSaveMetaError(null);
  }, [data]);

  // Q&A follow-ups: persisted to result.json so they survive a refresh.
  // The newest answer is appended to the bottom of the list.
  const [qaQuestion, setQaQuestion] = useState("");
  const [qaItems, setQaItems] = useState<FollowupQa[]>([]);
  const [qaBusy, setQaBusy] = useState(false);
  const [qaError, setQaError] = useState<string | null>(null);

  // Match score: user picks the provider + model (defaults to OpenAI gpt-5.5, the best).
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchScore, setMatchScore] = useState<MatchScoreSummary | null>(null);
  const [matchProvider, setMatchProvider] = useState<LlmProvider>("openai");
  const [matchModel, setMatchModel] = useState("gpt-5.5");

  // Hydrate the persisted match score / follow-ups whenever the data loads.
  useEffect(() => {
    if (!data) return;
    if (data.match_score) setMatchScore(data.match_score);
    if (Array.isArray(data.followups) && data.followups.length > 0) {
      setQaItems(data.followups);
    }
  }, [data]);

  const [autoDlRecord, setAutoDlRecord] = useState<AutoDownloadRecord | null>(null);
  const [rerunResume, setRerunResume] = useState(false);
  const [rerunCoverLetter, setRerunCoverLetter] = useState(false);
  const [rerunAnswers, setRerunAnswers] = useState(false);
  const [rerunFitAnswer, setRerunFitAnswer] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [rerunInitialized, setRerunInitialized] = useState(false);
  const [rerunJd, setRerunJd] = useState("");
  const [rerunJdDirty, setRerunJdDirty] = useState(false);
  const [rerunApplyForm, setRerunApplyForm] = useState("");
  const [rerunApplyFormDirty, setRerunApplyFormDirty] = useState(false);
  /** Theme for the next rerun. Seeded from the run's stored theme; empty = keep it. */
  const [rerunTheme, setRerunTheme] = useState("");
  const [themeOptions, setThemeOptions] = useState(FALLBACK_THEME_OPTIONS);
  // Pull the registry list so this picker can never offer a theme the server lacks.
  useEffect(() => {
    let alive = true;
    api
      .getThemes()
      .then((t) => {
        if (alive && t?.themes?.length) setThemeOptions(t.themes);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!id) {
      setAutoDlRecord(null);
      return;
    }
    setAutoDlRecord(getAutoDownloadRecord(id));
  }, [id]);

  // First time we load a result, pre-check every artifact the last run didn't
  // finish (skipped or failed). After that leave the boxes under user control so
  // toggling doesn't get stomped when the poll refreshes `data`.
  useEffect(() => {
    if (!data || rerunInitialized) return;
    const st = data.artifact_status ?? {};
    const missing = (k: string) => st[k] !== "completed";
    const opts = data.generation_options;
    const originallyWantedFit = opts?.gen_fit_answer === true;
    setRerunResume(missing("resume_pdf"));
    setRerunCoverLetter(missing("cover_letter_pdf"));
    setRerunAnswers(missing("answers_json") || missing("answers_md"));
    setRerunFitAnswer(originallyWantedFit && (missing("answers_json") || missing("answers_md")));
    setRerunJd(typeof data.job_description === "string" ? data.job_description : "");
    setRerunJdDirty(false);
    setRerunApplyForm(typeof data.apply_form === "string" ? data.apply_form : "");
    setRerunApplyFormDirty(false);
    setRerunTheme(
      normalizeThemeId(typeof data.theme === "string" ? data.theme : "", themeOptions.map((o) => o.id))
    );
    setRerunInitialized(true);
  }, [data, rerunInitialized]);

  // After a rerun completes and we refetch, the stored JD may have changed
  // (user edited it for the rerun). Keep the textarea in sync with disk as
  // long as the user hasn't started editing again since the last submit.
  useEffect(() => {
    if (!data || !rerunInitialized || rerunJdDirty) return;
    const serverJd = typeof data.job_description === "string" ? data.job_description : "";
    setRerunJd((current) => (current === serverJd ? current : serverJd));
  }, [data, rerunInitialized, rerunJdDirty]);

  // Same for the stored application-form text — the extension refreshes it on
  // disk each time Q&A runs, so reflect updates until the user edits here.
  useEffect(() => {
    if (!data || !rerunInitialized || rerunApplyFormDirty) return;
    const serverAf = typeof data.apply_form === "string" ? data.apply_form : "";
    setRerunApplyForm((current) => (current === serverAf ? current : serverAf));
  }, [data, rerunInitialized, rerunApplyFormDirty]);

  // Poll while a rerun is in flight so the artifact table reflects the new
  // state without a manual refresh.
  useEffect(() => {
    if (!id) return;
    if (data?.status !== "generating") return;
    const t = window.setInterval(() => {
      void api
        .getApplication(id)
        .then(setData)
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(t);
  }, [id, data?.status]);

  async function handleRerun() {
    if (!id) return;
    if (!rerunResume && !rerunCoverLetter && !rerunAnswers && !rerunFitAnswer) {
      setRerunError("Pick at least one item to rerun.");
      return;
    }
    setRerunError(null);
    setRerunning(true);
    try {
      const storedJd = typeof data?.job_description === "string" ? data.job_description : "";
      const editedJd = rerunJd.trim();
      const jdOverride = editedJd.length > 0 && editedJd !== storedJd.trim() ? rerunJd : undefined;
      const applyFormTrimmed = rerunApplyForm.trim();
      const res = await api.rerunApplication(id, {
        gen_resume: rerunResume,
        gen_cover_letter: rerunCoverLetter,
        gen_answers: rerunAnswers,
        gen_fit_answer: rerunFitAnswer,
        ...(jdOverride !== undefined ? { job_description: jdOverride } : {}),
        ...(applyFormTrimmed.length > 0 ? { apply_form: rerunApplyForm } : {}),
        ...(rerunTheme ? { theme: rerunTheme } : {}),
      });
      setRerunJdDirty(false);
      // If the user dismissed this run's previous completion toast, the
      // rerun's final success/failure toast would be silently suppressed by
      // the persisted dismissal. Revive it so the poll tick can repopulate.
      reviveGenerationToast(`genapp-${res.id}`);
      upsertGenerationToast({
        id: `genapp-${res.id}`,
        applicationId: res.id,
        runId: res.run_uuid,
        message: "Queued (rerun)",
        level: "info",
      });
      const fresh = await api.getApplication(id);
      setData(fresh);
    } catch (e) {
      setRerunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRerunning(false);
    }
  }

  async function handleAskQa() {
    if (!id) return;
    const q = qaQuestion.trim();
    if (!q) {
      setQaError("Type a question first.");
      return;
    }
    setQaError(null);
    setQaBusy(true);
    try {
      const res = await api.askApplicationQuestion(id, { question: q });
      if (res.items.length === 0) {
        setQaError("No questions detected. Try rephrasing as one or more questions.");
        return;
      }
      setQaItems((prev) => [...prev, ...res.items]);
      setQaQuestion("");
    } catch (e) {
      setQaError(e instanceof Error ? e.message : String(e));
    } finally {
      setQaBusy(false);
    }
  }

  async function handleComputeMatchScore() {
    if (!id) return;
    setMatchError(null);
    setMatchBusy(true);
    try {
      const res = await api.computeApplicationMatchScore(id, {
        provider: matchProvider,
        model: matchModel.trim(),
      });
      setMatchScore(res);
    } catch (e) {
      setMatchError(e instanceof Error ? e.message : String(e));
    } finally {
      setMatchBusy(false);
    }
  }

  async function saveOverviewMeta() {
    if (!id) return;
    const co = editCompany.trim();
    const ro = editRole.trim();
    if (!co || !ro) {
      setSaveMetaError("Company and role cannot be empty.");
      return;
    }
    setSavingMeta(true);
    setSaveMetaError(null);
    try {
      await api.updateApplicationMeta(id, {
        company_name: co,
        role_name: ro,
        job_link: editJobLink.trim(),
        recruiter_name: editRecruiter.trim(),
      });
      const fresh = await api.getApplication(id);
      setData(fresh);
    } catch (e) {
      setSaveMetaError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingMeta(false);
    }
  }

  if (!id) return <p>Missing id.</p>;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="sub">Loading…</p>;

  const appId = data.id;
  const keys = Object.keys(data.artifacts ?? {}) as string[];
  const keyRequirements = asStringArray((data.metadata as { key_requirements?: unknown })?.key_requirements);
  const questions = asStringArray((data.metadata as { questions?: unknown })?.questions);
  const warnings = asStringArray((data.metadata as { warnings?: unknown })?.warnings);
  const answers = asAnswers((data as { answers?: unknown }).answers);
  const quickRemember = asStringArray((data.quick_reference as { what_to_remember?: unknown })?.what_to_remember);
  const quickTalking = asStringArray((data.quick_reference as { top_talking_points?: unknown })?.top_talking_points);

  function artifactOpenHref(filename: string): string {
    return `/api/applications/${encodeURIComponent(appId)}/artifacts/${encodeURIComponent(filename)}`;
  }

  return (
    <>
      <h1>Result</h1>
      <p className="sub">
        Loaded from server — <span className="mono">{data.id}</span>
        {data.run_uuid ? <> · <span className="mono">{data.run_uuid}</span></> : null}
      </p>
      <p>
        <Link to="/apply">Job Apply</Link>
        {" · "}
        <Link to="/logs">Application Logs</Link>
      </p>

      {data.error && (
        <div className="card">
          <p className="error">{data.error}</p>
        </div>
      )}

      {data.llm_fallback_used && (
        <div className="notice-warn" role="status">
          <strong>LLM fallback was used.</strong> Extraction or another step failed (see error above if present). Job
          title/company may be placeholders. Ensure your API keys match the configured models (
          <span className="mono">
            {data.llm_config ? `${data.llm_config.light.provider} / ${data.llm_config.heavy.provider}` : "—"}
          </span>
          ) and check <span className="mono">.env</span>.
        </div>
      )}

      <div className="card">
        <h2>Overview</h2>
        <p className="mono">Generated (JST): {formatDateTimeJst(data.created_at)}</p>

        <div style={{ marginTop: "0.75rem" }}>
          <p className="sub" style={{ marginBottom: "0.35rem" }}>
            Company, role, job URL, and recruiter (editable — saved to logs and result file)
          </p>
          <label htmlFor="result-edit-company">Company</label>
          <input
            id="result-edit-company"
            className="form-control"
            value={editCompany}
            onChange={(e) => setEditCompany(e.target.value)}
            autoComplete="organization"
          />
          <label htmlFor="result-edit-role">Role</label>
          <input
            id="result-edit-role"
            className="form-control"
            value={editRole}
            onChange={(e) => setEditRole(e.target.value)}
            autoComplete="off"
          />
          <label htmlFor="result-edit-job-link">Job posting URL</label>
          <input
            id="result-edit-job-link"
            type="url"
            className="form-control"
            value={editJobLink}
            onChange={(e) => setEditJobLink(e.target.value)}
            placeholder="https://… or leave empty"
            autoComplete="url"
          />
          <label htmlFor="result-edit-recruiter">Recruiter / contact</label>
          <input
            id="result-edit-recruiter"
            className="form-control"
            value={editRecruiter}
            onChange={(e) => setEditRecruiter(e.target.value)}
            placeholder="Plain-text name when there is no URL"
            autoComplete="off"
          />
          {saveMetaError && <p className="error">{saveMetaError}</p>}
          <div className="actions" style={{ marginTop: "0.5rem" }}>
            <button type="button" className="btn primary" disabled={savingMeta} onClick={() => void saveOverviewMeta()}>
              {savingMeta ? "Saving…" : "Save overview"}
            </button>
          </div>
        </div>

        {data.job_link ? (
          <p className="hint" style={{ marginTop: "0.5rem" }}>
            <a href={data.job_link} target="_blank" rel="noreferrer">
              Open job posting in new tab
            </a>
          </p>
        ) : null}
        {typeof data.job_description === "string" && data.job_description.trim() && (
          <details style={{ marginTop: "0.5rem" }}>
            <summary>Stored full JD text</summary>
            <textarea
              readOnly
              value={data.job_description}
              rows={Math.min(18, Math.max(6, data.job_description.split("\n").length + 1))}
              style={{ width: "100%", marginTop: "0.5rem" }}
            />
          </details>
        )}
        <p>
          Profile: <span className="mono">{data.resume_profile}</span> · Theme:{" "}
          <span className="mono">{data.theme}</span>
        </p>
        <p className="mono">Output folder (relative): {data.output_folder}</p>
        {data.output_folder_abs && (
          <div className="result-path-row">
            <p className="hint mono result-path-label">
              Local debug absolute path: {data.output_folder_abs}
            </p>
            <CopyButton
              text={data.output_folder_abs}
              label="Copy path"
              className="btn primary result-copy-path-btn"
            />
          </div>
        )}
        {autoDlRecord && (
          <div className="result-path-row">
            <p className="hint mono result-path-label">
              Auto-downloaded to: {autoDlRecord.displayPath}
              {autoDlRecord.files.length > 0 ? ` (${autoDlRecord.files.length} files)` : ""}
            </p>
            <CopyButton
              text={autoDlRecord.displayPath}
              label="Copy path"
              className="btn primary result-copy-path-btn"
            />
          </div>
        )}
        {data.generation_options && (
          <div style={{ marginTop: "0.75rem" }}>
            <p className="sub" style={{ marginBottom: "0.35rem" }}>
              Run options
            </p>
            <p className="mono" style={{ margin: 0 }}>
              gen_resume={String(data.generation_options.gen_resume)} | gen_cover_letter=
              {String(data.generation_options.gen_cover_letter ?? data.generation_options.gen_cv)}{" "}
              | gen_answers={String(data.generation_options.gen_answers)} | gen_fit_answer=
              {String(data.generation_options.gen_fit_answer)} | ignore_duplicate_check=
              {String(data.generation_options.ignore_duplicate_check)}
            </p>
          </div>
        )}
        {data.llm_config && (
          <div style={{ marginTop: "0.5rem" }}>
            <p className="sub" style={{ marginBottom: "0.35rem" }}>
              LLM config
            </p>
            <p className="mono" style={{ margin: 0 }}>
              light={data.llm_config.light.provider}/{data.llm_config.light.model} | heavy=
              {data.llm_config.heavy.provider}/{data.llm_config.heavy.model}
            </p>
            <p className="mono" style={{ margin: "0.15rem 0 0" }}>
              tiers: résumé={data.llm_config.tiers.resume} · cover={data.llm_config.tiers.coverLetter} · answers=
              {data.llm_config.tiers.answers} · match={data.llm_config.tiers.matchScore}
            </p>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Artifacts</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Open PDFs and other files in the browser (served from this app). Files also exist on disk under the output
          folder above.
        </p>
        {/*
          The Apply page only offers this for the run you just started, so without it here
          an earlier batch becomes undownloadable the moment you queue the next one. For a
          batch the folder is shared, so this one link fetches every profile's résumé.
        */}
        <div className="actions" style={{ marginTop: 0, marginBottom: "0.75rem" }}>
          <a className="btn small" href={api.folderZipUrl(appId)}>
            Download this folder as ZIP
          </a>
          <span className="hint" style={{ marginLeft: "0.5rem" }}>
            Résumés, cover letters and the job description. Prompts and internal records are not included.
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Artifact</th>
              <th>File</th>
              <th>Status</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const st = data.artifact_status?.[k] ?? "—";
              const fn = data.artifacts[k];
              const canOpen = st === "completed" && fn && isOpenableArtifactFilename(fn);
              const badgeClass =
                st === "completed" ? "ok" : st === "skipped" ? "skip" : st === "failed" ? "fail" : "fail";
              return (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="mono">{fn}</td>
                  <td>
                    <span className={`badge ${badgeClass}`}>{st}</span>
                    {data.artifact_errors?.[k] && (
                      <div className="mono error" style={{ marginTop: "0.35rem" }}>
                        {data.artifact_errors[k]}
                      </div>
                    )}
                  </td>
                  <td>
                    {canOpen ? (
                      <a href={artifactOpenHref(fn)} target="_blank" rel="noreferrer">
                        {fn.endsWith(".pdf") ? "View PDF" : "Open"}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Rerun missing items</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Generate only the selected artifacts into this run's existing output folder. Unselected items keep
          their current status and files untouched. Uses the stored job description; an original apply form
          (if any) is not re-sent.
        </p>
        {data.status === "generating" ? (
          <p className="sub">A generation is already in progress for this run…</p>
        ) : (
          <>
            <fieldset className="apply-gen-options">
              <legend>Rerun</legend>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={rerunResume}
                  onChange={(e) => setRerunResume(e.target.checked)}
                />
                <span>
                  Résumé (PDF){" "}
                  <span className="sub">
                    — current: {data.artifact_status?.resume_pdf ?? "—"}
                  </span>
                </span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={rerunCoverLetter}
                  onChange={(e) => setRerunCoverLetter(e.target.checked)}
                />
                <span>
                  Cover letter (PDF){" "}
                  <span className="sub">
                    — current: {data.artifact_status?.cover_letter_pdf ?? "—"}
                  </span>
                </span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={rerunAnswers}
                  onChange={(e) => setRerunAnswers(e.target.checked)}
                />
                <span>
                  Answers{" "}
                  <span className="sub">
                    — current: {data.artifact_status?.answers_json ?? "—"}/
                    {data.artifact_status?.answers_md ?? "—"}
                  </span>
                </span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={rerunFitAnswer}
                  onChange={(e) => setRerunFitAnswer(e.target.checked)}
                />
                <span>Fit answer (when no explicit questions)</span>
              </label>
            </fieldset>

            <div style={{ marginTop: "0.75rem" }}>
              <label htmlFor="result-rerun-theme">PDF theme for this rerun</label>
              <select
                id="result-rerun-theme"
                name="rerunTheme"
                value={rerunTheme}
                onChange={(e) => setRerunTheme(e.target.value)}
                aria-label="PDF theme for this rerun"
              >
                {themeOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="hint">
                Applies to the résumé and cover letter regenerated by this rerun. The run was created with{" "}
                <span className="mono">{data.theme}</span>.
              </p>
              <label htmlFor="result-rerun-jd">Job description for this rerun (editable)</label>
              <p className="hint" style={{ marginTop: 0 }}>
                Pre-filled with the JD stored for this run. Edit it to replace the whole JD, or
                just add a few lines to nudge the model. If you submit a change, the edited text
                overwrites the stored JD for future reruns too.
              </p>
              <textarea
                id="result-rerun-jd"
                className="form-control"
                value={rerunJd}
                onChange={(e) => {
                  setRerunJd(e.target.value);
                  setRerunJdDirty(true);
                }}
                rows={10}
                placeholder="Paste or edit the job description"
              />
            </div>

            <div style={{ marginTop: "0.75rem" }}>
              <label htmlFor="result-rerun-apply-form">Application form (stored)</label>
              <p className="hint" style={{ marginTop: 0 }}>
                The application-page text captured for this run (refreshed by the extension each time
                Q&amp;A runs on the page), plus any recruiter notes or extra instructions. Stored with
                the run and used as context for this rerun; editing here overwrites the stored value.
              </p>
              <textarea
                id="result-rerun-apply-form"
                className="form-control"
                value={rerunApplyForm}
                onChange={(e) => {
                  setRerunApplyForm(e.target.value);
                  setRerunApplyFormDirty(true);
                }}
                rows={5}
                placeholder="Application-form questions / extra context"
              />
            </div>

            {rerunError && <p className="error">{rerunError}</p>}
            <div className="actions" style={{ marginTop: "0.5rem" }}>
              <button
                type="button"
                className="btn primary"
                disabled={rerunning || (!rerunResume && !rerunCoverLetter && !rerunAnswers && !rerunFitAnswer)}
                onClick={() => void handleRerun()}
              >
                {rerunning ? "Queueing…" : "Rerun selected"}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Role summary</h2>
        <p>{data.metadata.role_summary || "—"}</p>
        <h2 style={{ marginTop: "1rem" }}>Key requirements</h2>
        <ul>
          {keyRequirements.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        <h2 style={{ marginTop: "1rem" }}>Extracted questions</h2>
        <ul>
          {questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
        {warnings.length > 0 && (
          <>
            <h2 style={{ marginTop: "1rem" }}>Warnings</h2>
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {data.extraction_detail && (
        <div className="card">
          <h2>Extraction detail (K1 / K2)</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            <strong>Signal:</strong> {data.extraction_detail.signal_quality} ·{" "}
            <strong>Primary domain:</strong> {data.extraction_detail.primary_domain || "—"} ·{" "}
            <strong>Clearance:</strong>{" "}
            {data.extraction_detail.clearance_required
              ? `required (${data.extraction_detail.clearance_level})`
              : "not required"}
          </p>

          {Object.keys(data.extraction_detail.domain_breakdown ?? {}).length > 0 && (
            <div style={{ marginTop: "0.5rem", display: "grid", gap: "0.35rem", maxWidth: "30rem" }}>
              {Object.entries(data.extraction_detail.domain_breakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([d, w]) => (
                  <div key={d}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem" }}>
                      <span>{d}</span>
                      <span className="mono">{w}%</span>
                    </div>
                    <div style={{ height: "8px", borderRadius: "4px", background: "var(--border)", overflow: "hidden" }}>
                      <div style={{ width: `${Math.min(100, w)}%`, height: "100%", background: "var(--accent, #5aa0ff)" }} />
                    </div>
                  </div>
                ))}
            </div>
          )}

          <h3 style={{ marginBottom: "0.25rem" }}>K1 hard (gate stacks)</h3>
          {Object.keys(data.extraction_detail.K1?.hard ?? {}).length === 0 ? (
            <p className="sub" style={{ margin: 0 }}>None.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
              {Object.entries(data.extraction_detail.K1.hard).map(([domain, stacks]) => (
                <span key={domain} style={{ fontSize: "0.8rem" }}>
                  <span className="sub">{domain}:</span>{" "}
                  {stacks.map((s) => (
                    <span
                      key={s}
                      className="mono"
                      style={{ padding: "0.05rem 0.4rem", marginRight: "0.25rem", borderRadius: "6px", background: "var(--accent-soft, rgba(90,160,255,0.18))" }}
                    >
                      {s}
                    </span>
                  ))}
                </span>
              ))}
            </div>
          )}

          {(data.extraction_detail.K1?.soft?.length ?? 0) > 0 && (
            <>
              <h3 style={{ marginBottom: "0.25rem" }}>K1 soft (gate requirements)</h3>
              <ul style={{ marginTop: 0 }}>
                {data.extraction_detail.K1.soft.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}

          {(data.extraction_detail.K2?.length ?? 0) > 0 && (
            <>
              <h3 style={{ marginBottom: "0.25rem" }}>K2 (contextual keywords)</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                {data.extraction_detail.K2.map((k, i) => (
                  <span
                    key={i}
                    style={{ fontSize: "0.78rem", padding: "0.1rem 0.45rem", borderRadius: "999px", border: "1px solid var(--border, rgba(127,127,127,0.3))" }}
                  >
                    {Array.isArray(k) ? k.join(" / ") : k}
                  </span>
                ))}
              </div>
            </>
          )}

          {(data.extraction_detail.competency_signals?.length ?? 0) > 0 && (
            <>
              <h3 style={{ marginBottom: "0.25rem" }}>Competency signals</h3>
              <ul style={{ marginTop: 0 }}>
                {data.extraction_detail.competency_signals.map((c, i) => (
                  <li key={i}>
                    <span className="sub">{c.category}:</span> {c.raw}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {data.tailoring && (
        <div className="card">
          <h2>How the résumé was divided</h2>

          {(data.tailoring.domain_scores?.length ?? 0) > 0 && (
            <>
              <h3 style={{ marginBottom: "0.25rem" }}>Skill domains — relevance to this role</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                {data.tailoring.domain_scores.map((d) => (
                  <span
                    key={d.domain}
                    style={{
                      fontSize: "0.78rem",
                      padding: "0.1rem 0.5rem",
                      borderRadius: "999px",
                      border: "1px solid var(--border, rgba(127,127,127,0.3))",
                      background:
                        d.score === 3
                          ? "rgba(60,180,90,0.18)"
                          : d.score === 2
                            ? "rgba(230,170,0,0.18)"
                            : "rgba(127,127,127,0.12)",
                    }}
                  >
                    {d.domain} · {d.score === 3 ? "core" : d.score === 2 ? "supporting" : "minor"} ({d.score})
                  </span>
                ))}
              </div>
              <p className="sub" style={{ fontSize: "0.8rem" }}>
                Core (3) keeps every skill, supporting (2) ~4-5, minor (1) just the top 2 — most-relevant first.
              </p>
            </>
          )}

          {(data.tailoring.variations?.length ?? 0) > 0 && (
            <>
              <h3 style={{ marginBottom: "0.25rem", marginTop: "0.75rem" }}>
                Two JD angles — A drives the real anchor, B the consulting company
              </h3>
              {data.tailoring.variations.map((v) => (
                <div
                  key={v.label}
                  style={{ marginTop: "0.6rem", paddingLeft: "0.6rem", borderLeft: "3px solid var(--accent, #5aa0ff)" }}
                >
                  <div>
                    <strong>Variation {v.label}</strong>
                    <span className="sub"> · {v.label.toUpperCase() === "B" ? "consulting" : "anchor"}</span>
                    {v.company && <span className="sub"> → {v.company}</span>}
                    {v.angle && <span className="sub"> · angle: {v.angle}</span>}
                  </div>
                  {(v.summary_lines?.length ?? 0) > 0 && (
                    <ul style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                      {v.summary_lines.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  )}
                  {v.reframed_jd && (
                    <details style={{ marginTop: "0.3rem" }}>
                      <summary className="sub" style={{ cursor: "pointer", fontSize: "0.8rem" }}>
                        reframed JD
                      </summary>
                      <p style={{ fontSize: "0.82rem", whiteSpace: "pre-wrap", marginTop: "0.25rem" }}>{v.reframed_jd}</p>
                    </details>
                  )}
                </div>
              ))}
            </>
          )}

          {(data.tailoring.industries?.length ?? 0) > 0 && (
            <p className="sub" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
              <strong>Consulting industries:</strong> {data.tailoring.industries.join(" · ")}
            </p>
          )}

          {(data.tailoring.companies?.length ?? 0) > 0 && (
            <>
              <h3 style={{ marginBottom: "0.25rem", marginTop: "0.75rem" }}>How each company was sourced</h3>
              <ul style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                {data.tailoring.companies.map((c, i) => (
                  <li key={i}>
                    <strong>{c.company}</strong> —{" "}
                    {c.role === "anchor"
                      ? "tailored live from variation A"
                      : c.role === "consulting"
                        ? `variation B — consulting engagements${c.industries?.length ? ` (${c.industries.join(", ")})` : ""}`
                        : "stored flagship bullets"}{" "}
                    · {c.bullet_count} bullets
                  </li>
                ))}
              </ul>
            </>
          )}

          {(data.tailoring.rare_nice_to_haves?.length ?? 0) > 0 && (
            <p className="sub" style={{ fontSize: "0.85rem" }}>
              <strong>Dropped as rare / niche:</strong> {data.tailoring.rare_nice_to_haves.join(", ")}
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h2>Answers</h2>
        {answers.map((a, i) => (
          <div key={i} style={{ marginBottom: "1.25rem" }}>
            <p>
              <strong>{a.question}</strong>
            </p>
            <textarea readOnly value={a.answer} rows={Math.min(12, 3 + a.answer.split("\n").length)} />
            <CopyButton text={a.answer} label="Copy answer" />
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Match rate (JD ↔ résumé)</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Pick the model to score with (defaults to OpenAI <strong>gpt-5.5</strong>). Scores experience
          level, relevant experience, core skills, and industry experience based on the stored profile and JD.
        </p>
        {matchError && <p className="error">{matchError}</p>}
        <div className="actions" style={{ marginTop: "0.5rem", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <label className="sub" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            Provider
            <select
              value={matchProvider}
              onChange={(e) => setMatchProvider(e.target.value as LlmProvider)}
              disabled={matchBusy}
            >
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="deepseek">DeepSeek</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
          <label className="sub" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            Model
            <input
              type="text"
              value={matchModel}
              onChange={(e) => setMatchModel(e.target.value)}
              placeholder="gpt-5.5"
              disabled={matchBusy}
              style={{ minWidth: "11rem" }}
            />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={matchBusy || !matchModel.trim()}
            onClick={() => void handleComputeMatchScore()}
          >
            {matchBusy ? "Scoring…" : matchScore ? "Recalculate match rate" : "Calculate match rate"}
          </button>
        </div>
        {matchScore && (
          <div style={{ marginTop: "1rem" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
              <span style={{ fontSize: "2rem", fontWeight: 700, color: scoreColor(matchScore.overall) }}>
                {matchScore.overall}%
              </span>
              <span className="sub">overall match</span>
              <span className="mono sub">
                · {matchScore.llm.provider} / {matchScore.llm.model}
              </span>
            </div>
            <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem" }}>
              {(Object.keys(matchScore.breakdown) as (keyof MatchScoreSummary["breakdown"])[]).map((k) => {
                const v = matchScore.breakdown[k];
                return (
                  <div key={k}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem" }}>
                      <span>{MATCH_FACTOR_LABELS[k]}</span>
                      <span className="mono" style={{ color: scoreColor(v) }}>{v}%</span>
                    </div>
                    <div
                      style={{
                        height: "8px",
                        borderRadius: "4px",
                        background: "var(--border)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${v}%`,
                          height: "100%",
                          background: scoreColor(v),
                          transition: "width 240ms ease",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {matchScore.summary && (
              <p style={{ marginTop: "0.75rem" }}>{matchScore.summary}</p>
            )}
            {matchScore.strengths.length > 0 && (
              <>
                <p style={{ marginTop: "0.75rem", marginBottom: "0.25rem" }}>
                  <strong>Strengths</strong>
                </p>
                <ul style={{ marginTop: 0 }}>
                  {matchScore.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </>
            )}
            {matchScore.gaps.length > 0 && (
              <>
                <p style={{ marginBottom: "0.25rem" }}>
                  <strong>Gaps</strong>
                </p>
                <ul style={{ marginTop: 0 }}>
                  {matchScore.gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </>
            )}
            {(matchScore.keyword_matches?.length ?? 0) > 0 && (
              <>
                <p style={{ marginTop: "0.75rem", marginBottom: "0.25rem" }}>
                  <strong>Keyword match</strong>{" "}
                  <span className="sub">
                    ({matchScore.keyword_matches.filter((k) => k.status === "yes").length} matched ·{" "}
                    {matchScore.keyword_matches.filter((k) => k.status === "partial").length} partial ·{" "}
                    {matchScore.keyword_matches.filter((k) => k.status === "no").length} missing)
                  </span>
                </p>
                <div style={{ display: "grid", gap: "0.3rem", fontSize: "0.85rem" }}>
                  {matchScore.keyword_matches.map((k, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
                      <span
                        title={KW_STATUS_LABEL[k.status]}
                        style={{ flex: "0 0 auto", width: "1.1rem", textAlign: "center", fontWeight: 700, color: KW_STATUS_COLOR[k.status] }}
                      >
                        {KW_STATUS_ICON[k.status]}
                      </span>
                      <span
                        style={{ flex: "0 0 5.5rem", fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--muted)" }}
                      >
                        {KW_IMPORTANCE_LABEL[k.importance]}
                      </span>
                      <span style={{ flex: "0 0 auto", fontWeight: 600 }}>{k.keyword}</span>
                      {k.evidence && (
                        <span className="sub" style={{ marginLeft: "auto", textAlign: "right", maxWidth: "55%" }}>
                          {k.evidence}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            {matchScore.credibility &&
              (matchScore.credibility.assessment || (matchScore.credibility.red_flags?.length ?? 0) > 0) && (
                <>
                  <p style={{ marginTop: "0.75rem", marginBottom: "0.25rem" }}>
                    <strong>Résumé credibility</strong>{" "}
                    <span className="mono" style={{ color: scoreColor(matchScore.credibility.score) }}>
                      {matchScore.credibility.score}%
                    </span>
                  </p>
                  {matchScore.credibility.assessment && (
                    <p style={{ marginTop: 0 }}>{matchScore.credibility.assessment}</p>
                  )}
                  {(matchScore.credibility.red_flags?.length ?? 0) > 0 && (
                    <ul style={{ marginTop: 0 }}>
                      {matchScore.credibility.red_flags.map((r, i) => (
                        <li key={i} style={{ color: "#c62828" }}>{r}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            {matchScore.force_tailoring &&
              (matchScore.force_tailoring.assessment ||
                (matchScore.force_tailoring.signals?.length ?? 0) > 0) && (
                <>
                  <p style={{ marginTop: "0.75rem", marginBottom: "0.25rem" }}>
                    <strong>Force-tailored to the JD</strong>{" "}
                    <span className="mono" style={{ color: scoreColor(100 - matchScore.force_tailoring.score) }}>
                      {matchScore.force_tailoring.score}%
                    </span>{" "}
                    <span className="sub">(higher = looks more intentionally tailored)</span>
                  </p>
                  {matchScore.force_tailoring.assessment && (
                    <p style={{ marginTop: 0 }}>{matchScore.force_tailoring.assessment}</p>
                  )}
                  {(matchScore.force_tailoring.signals?.length ?? 0) > 0 && (
                    <ul style={{ marginTop: 0 }}>
                      {matchScore.force_tailoring.signals.map((s, i) => (
                        <li key={i} style={{ color: "#c62828" }}>{s}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Ask follow-ups</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Ask one question or paste several at once — the model splits them and answers each separately.
          Context sent each call: company, role, role summary, key requirements, full JD, and the full
          candidate profile JSON (no prior Q&A history). Saved with this run.
        </p>

        {qaItems.length > 0 && (
          <div style={{ marginBottom: "1rem" }}>
            {qaItems.map((item, i) => (
              <div key={i} style={{ marginBottom: "1.25rem" }}>
                <p style={{ marginBottom: "0.25rem" }}>
                  <strong>Q{i + 1}.</strong> {item.question}{" "}
                  <span className="mono sub">
                    · {item.llm.provider} / {item.llm.model}
                  </span>
                </p>
                <textarea
                  readOnly
                  value={item.answer}
                  rows={Math.min(10, 2 + item.answer.split("\n").length)}
                />
                <CopyButton text={item.answer} label="Copy answer" />
              </div>
            ))}
          </div>
        )}

        <label htmlFor="result-qa-question" style={{ marginTop: "0.5rem" }}>
          {qaItems.length > 0 ? "Next question(s)" : "Question(s)"}
        </label>
        <textarea
          id="result-qa-question"
          className="form-control"
          rows={4}
          value={qaQuestion}
          onChange={(e) => setQaQuestion(e.target.value)}
          placeholder={"Paste one or several questions, e.g.\n- How would you approach the first 90 days?\n- What's your experience with our stack?"}
          disabled={qaBusy}
        />
        {qaError && <p className="error">{qaError}</p>}
        <div className="actions" style={{ marginTop: "0.25rem" }}>
          <button
            type="button"
            className="btn primary"
            disabled={qaBusy || qaQuestion.trim().length === 0}
            onClick={() => void handleAskQa()}
          >
            {qaBusy ? "Asking…" : "Ask"}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Quick reference</h2>
        <p>
          <strong>Remember</strong>
        </p>
        <ul>
          {quickRemember.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
        <p>
          <strong>Talking points</strong>
        </p>
        <ul>
          {quickTalking.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    </>
  );
}
