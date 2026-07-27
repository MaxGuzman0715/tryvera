import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import type { AnswerPolicy, EnpplifyFeatureFlags, EnpplifyUserSettings, ProfileAnswer } from "../types";
import { IconPlug } from "../../ui/icons";

/** The /api/profiles list returns just the profile ids. */
type ProfileRef = { id: string };

/**
 * Settings for the Tryvify browser extension. Lives inside the Tryvera web app
 * (reusing its auth + storage); the extension reads these via
 * GET /api/enpplify/settings.
 */

const FLAG_META: { key: keyof EnpplifyFeatureFlags; label: string; help: string }[] = [
  {
    key: "password_autofill",
    label: "Auto-fill account-creation passwords",
    help: "On sign-up pages (password + confirm-password fields), fill both with your autofill password below.",
  },
  {
    key: "combobox_fill",
    label: "Fill custom dropdowns",
    help: "Engage react-select / typeahead handling when filling (Greenhouse, Lever, Ashby, …).",
  },
  {
    key: "attach_cover_letter",
    label: "Attach cover letter / CV",
    help: "When a separate cover-letter upload field exists and a CV was generated, attach it too.",
  },
  {
    key: "ai_fill_remaining",
    label: "Auto-fill remaining fields with AI",
    help: "After the instant pass fills easy fields (name, email, …), automatically use AI for the rest. Off = you click “Fill remaining with AI” when you want it.",
  },
  {
    key: "drop_to_upload",
    label: "Drop-a-file upload zone",
    help: "Show a drop target in the panel; drop any résumé file onto it to upload it to the page’s résumé field.",
  },
  {
    key: "gen_resume_default",
    label: "Generate résumé by default",
    help: "Pre-tick the panel’s “Résumé” checkbox. Off by default. Ignored when “Use base resume” is on (the base PDF replaces a generated résumé).",
  },
  {
    key: "gen_cover_letter_default",
    label: "Generate cover letter by default",
    help: "Pre-tick the panel’s “Cover letter” checkbox. Off by default.",
  },
];

/** One editable reusable answer (its own draft state so edits are per-row). */
function ReusableAnswerRow({
  answer,
  busy,
  onSave,
  onDelete,
}: {
  answer: ProfileAnswer;
  busy: boolean;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(answer.answer);
  const dirty = text.trim() !== answer.answer;
  return (
    <div style={{ borderTop: "1px solid #e3ebed", padding: "0.55rem 0" }}>
      <p className="mono" style={{ fontWeight: 600, marginBottom: "0.35rem" }}>{answer.question}</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} style={{ width: "100%" }} />
      <div className="actions" style={{ marginTop: "0.35rem" }}>
        <button
          type="button"
          className="btn small"
          disabled={busy || !dirty || !text.trim()}
          onClick={() => onSave(text.trim())}
        >
          Save
        </button>
        <button type="button" className="btn small danger" disabled={busy} onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** One editable answering policy (free-text rule, with an enabled toggle). */
function PolicyRow({
  policy,
  busy,
  onSave,
  onToggle,
  onDelete,
}: {
  policy: AnswerPolicy;
  busy: boolean;
  onSave: (text: string) => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(policy.text);
  const dirty = text.trim() !== policy.text;
  return (
    <div style={{ borderTop: "1px solid #e3ebed", padding: "0.55rem 0" }}>
      <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.35rem" }}>
        <input
          type="checkbox"
          checked={policy.enabled}
          disabled={busy}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="sub">{policy.enabled ? "Active" : "Disabled"}</span>
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        style={{ width: "100%", opacity: policy.enabled ? 1 : 0.6 }}
      />
      <div className="actions" style={{ marginTop: "0.35rem" }}>
        <button
          type="button"
          className="btn small"
          disabled={busy || !dirty || !text.trim()}
          onClick={() => onSave(text.trim())}
        >
          Save
        </button>
        <button type="button" className="btn small danger" disabled={busy} onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

export default function EnpplifySettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<EnpplifyUserSettings | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<ProfileRef[]>([]);
  // The profile id whose base résumé is currently uploading/removing (or null).
  const [busyId, setBusyId] = useState<string | null>(null);
  // Reusable-answers manager state (its own profile selector).
  const [answersProfileId, setAnswersProfileId] = useState("");
  const [answers, setAnswers] = useState<ProfileAnswer[]>([]);
  const [answersBusy, setAnswersBusy] = useState(false);
  const [newQ, setNewQ] = useState("");
  const [newA, setNewA] = useState("");
  // Answering policies (free-text rules) — share the reusable-answers profile
  // selector since both are per-profile.
  const [policies, setPolicies] = useState<AnswerPolicy[]>([]);
  const [policiesBusy, setPoliciesBusy] = useState(false);
  const [newPolicy, setNewPolicy] = useState("");

  useEffect(() => {
    Promise.all([api.getEnpplifySettings(), api.listProfiles()])
      .then(([s, profs]) => {
        setSettings(s);
        setPassword(s.autofill_password ?? "");
        setProfiles(profs);
        setAnswersProfileId((prev) => prev || profs[0]?.id || "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Load the chosen profile's reusable answers + policies whenever it changes.
  useEffect(() => {
    if (!answersProfileId) {
      setAnswers([]);
      setPolicies([]);
      return;
    }
    let cancelled = false;
    api
      .getProfileAnswers(answersProfileId)
      .then((r) => {
        if (!cancelled) setAnswers(r.items ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api
      .getAnswerPolicies(answersProfileId)
      .then((r) => {
        if (!cancelled) setPolicies(r.items ?? []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [answersProfileId]);

  async function savePolicy(policy: { id?: string; text?: string; enabled?: boolean }) {
    if (!answersProfileId) return;
    setPoliciesBusy(true);
    setError(null);
    try {
      const r = await api.saveAnswerPolicy(answersProfileId, policy);
      setPolicies(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPoliciesBusy(false);
    }
  }

  async function removePolicy(id: string) {
    if (!answersProfileId) return;
    setPoliciesBusy(true);
    setError(null);
    try {
      const r = await api.deleteAnswerPolicy(answersProfileId, id);
      setPolicies(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPoliciesBusy(false);
    }
  }

  async function addPolicy() {
    const text = newPolicy.trim();
    if (!text) return;
    await savePolicy({ text });
    setNewPolicy("");
  }

  async function saveAnswer(question: string, answer: string) {
    if (!answersProfileId || !question.trim()) return;
    setAnswersBusy(true);
    setError(null);
    try {
      const r = await api.saveProfileAnswer(answersProfileId, question, answer);
      setAnswers(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnswersBusy(false);
    }
  }

  async function removeAnswer(question: string) {
    if (!answersProfileId) return;
    setAnswersBusy(true);
    setError(null);
    try {
      const r = await api.deleteProfileAnswer(answersProfileId, question);
      setAnswers(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnswersBusy(false);
    }
  }

  async function addAnswer() {
    const q = newQ.trim();
    const a = newA.trim();
    if (!q || !a) return;
    await saveAnswer(q, a);
    setNewQ("");
    setNewA("");
  }

  function setFlag(key: keyof EnpplifyFeatureFlags, value: boolean) {
    setSettings((s) => (s ? { ...s, flags: { ...s.flags, [key]: value } } : s));
  }

  async function save() {
    if (!settings) return;
    setError(null);
    setSaved(false);
    try {
      const patch: Partial<EnpplifyUserSettings> = {
        flags: settings.flags,
        // empty password string clears it server-side
        autofill_password: password,
      };
      const next = await api.updateEnpplifySettings(patch);
      setSettings(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error ?? new Error("Failed to read file"));
      fr.readAsDataURL(file);
    });
  }

  async function uploadBase(pid: string, file: File | undefined) {
    if (!file || !pid) return;
    setError(null);
    setBusyId(pid);
    try {
      const dataUrl = await fileToBase64(file);
      const next = await api.uploadBaseResume(pid, file.name, dataUrl);
      setSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function removeBase(pid: string) {
    if (!pid) return;
    setError(null);
    setBusyId(pid);
    try {
      const next = await api.deleteBaseResume(pid);
      setSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  // Per-profile "Use base resume by default" preference. Sent on its own so it
  // never touches the password/LLM fields (the server merges the map).
  async function setBaseDefault(pid: string, on: boolean) {
    if (!pid || !settings) return;
    setError(null);
    const nextMap = { ...(settings.base_resume_default ?? {}), [pid]: on };
    try {
      const next = await api.updateEnpplifySettings({ base_resume_default: nextMap });
      setSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) return <div className="container">Loading…</div>;
  if (!settings) return <div className="container">{error ?? "Failed to load settings."}</div>;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}><IconPlug />Tryvify (extension)</h1>
        <button type="button" className="btn primary" onClick={() => void save()}>
          {saved ? "Saved" : "Save Tryvify settings"}
        </button>
      </div>
      <p className="sub">
        Settings for the Tryvify browser extension, for <span className="mono">{user?.email}</span>.
        The extension reads these after you sign in there.
      </p>
      {error && <p className="error">{error}</p>}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))",
          gap: "1rem",
          alignItems: "start",
        }}
      >
        {/* ------------------ Answering policies (per profile) ------------------ */}
        <div className="card">
          <h3>Answering policies</h3>
          <p className="sub" style={{ marginBottom: "0.5rem" }}>
            Plain-English <strong>rules</strong> the AI follows when filling forms and answering
            questions for the profile selected below — not fixed answers, but instructions it applies
            per job. Use these for things the AI must <em>derive</em>, e.g. computing a salary figure
            from the posted range, or how to handle “I accept that …” checkboxes. They override the
            default “don’t guess salary” behavior.
          </p>

          {/* Shared per-profile selector: also governs Reusable answers below. */}
          <label htmlFor="enpplify-answers-profile">Profile</label>
          <select
            id="enpplify-answers-profile"
            value={answersProfileId}
            onChange={(e) => setAnswersProfileId(e.target.value)}
            disabled={profiles.length === 0}
          >
            {profiles.length === 0 && <option value="">(no profiles)</option>}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>

          <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <textarea
              placeholder="New policy, e.g. For a posted salary range X–Y, answer the 80th percentile rounded to the nearest $5,000; if none is posted, use $150,000."
              rows={3}
              value={newPolicy}
              onChange={(e) => setNewPolicy(e.target.value)}
              style={{ width: "100%" }}
            />
            <div className="actions">
              <button
                type="button"
                className="btn small primary"
                disabled={policiesBusy || !answersProfileId || !newPolicy.trim()}
                onClick={() => void addPolicy()}
              >
                Add policy
              </button>
            </div>
          </div>

          {policies.length === 0 ? (
            <p className="sub" style={{ marginTop: "0.5rem" }}>No policies yet for this profile.</p>
          ) : (
            <div style={{ marginTop: "0.5rem" }}>
              {policies.map((p) => (
                <PolicyRow
                  key={p.id}
                  policy={p}
                  busy={policiesBusy}
                  onSave={(text) => void savePolicy({ id: p.id, text })}
                  onToggle={(enabled) => void savePolicy({ id: p.id, enabled })}
                  onDelete={() => void removePolicy(p.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ------------------ Reusable answers (per profile) ------------------ */}
        <div className="card">
          <h3>Reusable answers</h3>
          <p className="sub" style={{ marginBottom: "0.5rem" }}>
            Saved answers for frequently-asked questions, reused with <strong>no AI</strong> on
            every application for the chosen profile (selected in <strong>Answering policies</strong>).
            Add them here, or save them from the extension panel’s “♻ Reusable” button.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            <input
              placeholder="Question (e.g. Why do you want to work here?)"
              value={newQ}
              onChange={(e) => setNewQ(e.target.value)}
            />
            <textarea
              placeholder="Answer"
              rows={2}
              value={newA}
              onChange={(e) => setNewA(e.target.value)}
              style={{ width: "100%" }}
            />
            <div className="actions">
              <button
                type="button"
                className="btn small primary"
                disabled={answersBusy || !answersProfileId || !newQ.trim() || !newA.trim()}
                onClick={() => void addAnswer()}
              >
                Add reusable answer
              </button>
            </div>
          </div>

          {answers.length === 0 ? (
            <p className="sub" style={{ marginTop: "0.5rem" }}>No reusable answers yet for this profile.</p>
          ) : (
            <div style={{ marginTop: "0.5rem", maxHeight: "22rem", overflowY: "auto" }}>
              {answers.map((a) => (
                <ReusableAnswerRow
                  key={a.question}
                  answer={a}
                  busy={answersBusy}
                  onSave={(text) => void saveAnswer(a.question, text)}
                  onDelete={() => void removeAnswer(a.question)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ------------------ Feature flags ------------------ */}
        <div className="card">
          <h3>Features</h3>
          <p className="sub" style={{ marginBottom: "0.75rem" }}>
            Turn individual extension behaviors on or off.
          </p>
          {FLAG_META.map((f) => (
            <label
              key={f.key}
              style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", marginBottom: "0.75rem" }}
            >
              <input
                type="checkbox"
                checked={settings.flags[f.key]}
                onChange={(e) => setFlag(f.key, e.target.checked)}
                style={{ marginTop: "0.2rem" }}
              />
              <span>
                <strong>{f.label}</strong>
                <br />
                <span className="sub">{f.help}</span>
              </span>
            </label>
          ))}
        </div>

        {/* --------- Autofill password + Base résumé (stacked column) --------- */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {/* Autofill password */}
          <div className="card">
            <p className="sub" style={{ marginBottom: "0.5rem" }}>
              Which model fills forms is your <strong>Answers</strong> tier in{" "}
              <strong>My settings</strong> — not configured here.
            </p>
            <h3 style={{ marginTop: "0.25rem" }}>Autofill password</h3>
            <p className="sub" style={{ marginBottom: "0.5rem" }}>
              Used only when “Auto-fill account-creation passwords” is on. Stored on the server and
              returned only to you. Leave blank to disable.
            </p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="(none)"
                style={{ flex: 1 }}
              />
              <button type="button" className="btn small" onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            <p className="sub" style={{ marginTop: "0.5rem" }}>
              Note: stored in plaintext on your own server. Use a password dedicated to job-site
              signups, not a reused personal one.
            </p>
          </div>

          {/* Base résumé (per profile) */}
          <div className="card">
            <h3>Base résumé</h3>
            <p className="sub" style={{ marginBottom: "0.5rem" }}>
              A fixed résumé PDF to attach when you don’t want to tailor per job — uploaded{" "}
              <strong>per profile</strong>. In the extension, tick “Use base resume” to attach the
              base PDF for the active profile instead of a generated one. Set <strong>Default on</strong>{" "}
              to have the extension pre-tick it for that profile.
            </p>

            {profiles.length === 0 && <p className="sub">No profiles yet.</p>}

            {profiles.map((p) => {
              const name = settings.base_resume_names?.[p.id];
              const defaultOn = settings.base_resume_default?.[p.id] === true;
              const busy = busyId === p.id;
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                    padding: "0.55rem 0",
                    borderTop: "1px solid #e3ebed",
                  }}
                >
                  <span className="mono" style={{ minWidth: "6rem", fontWeight: 600 }}>
                    {p.id}
                  </span>
                  <span
                    className={name ? "mono" : "sub"}
                    style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={name ?? ""}
                  >
                    {busy ? "Working…" : name ? name : "— no base résumé —"}
                  </span>
                  {name && (
                    <label
                      style={{ display: "flex", alignItems: "center", gap: "0.35rem", flex: "0 0 auto", cursor: "pointer" }}
                      title="Pre-tick “Use base resume” for this profile in the extension"
                    >
                      <input
                        type="checkbox"
                        checked={defaultOn}
                        disabled={busy}
                        onChange={(e) => void setBaseDefault(p.id, e.target.checked)}
                      />
                      <span className="sub">Default on</span>
                    </label>
                  )}
                  <label className="btn small" style={{ cursor: busy ? "default" : "pointer", flex: "0 0 auto" }}>
                    {name ? "Replace" : "Upload"}
                    <input
                      type="file"
                      accept="application/pdf,.pdf"
                      style={{ display: "none" }}
                      disabled={busy}
                      onChange={(e) => {
                        void uploadBase(p.id, e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {name && (
                    <button
                      type="button"
                      className="btn small danger"
                      style={{ flex: "0 0 auto" }}
                      disabled={busy}
                      onClick={() => void removeBase(p.id)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
