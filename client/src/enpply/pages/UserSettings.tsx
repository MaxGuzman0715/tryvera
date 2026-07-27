import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { applyAppUiTheme } from "../uiTheme";
import type { AppUiTheme, LlmFunc, LlmTier } from "../types";
import { IconGear } from "../../ui/icons";

/** The four user-facing LLM functions, with their default tier. */
const LLM_FUNC_META: { key: LlmFunc; label: string; help: string; def: LlmTier }[] = [
  { key: "resume", label: "Résumé", help: "JD extraction + résumé tailoring.", def: "heavy" },
  { key: "coverLetter", label: "Cover letter", help: "Cover-letter prose.", def: "light" },
  { key: "answers", label: "Answers / Q&A / form fill", help: "Application answers, follow-up Q&A, and form filling.", def: "light" },
  { key: "matchScore", label: "Match score", help: "Résumé ↔ JD match scoring on the Result page.", def: "light" },
];
import {
  clearAutoDownloadFolder,
  getAutoDownloadConfig,
  isAutoDownloadSupported,
  pickAutoDownloadFolder,
  setAutoDownloadAbsolutePath,
  setAutoDownloadEnabled,
} from "../autoDownload";

type ThemeOption = { id: string; label: string };

export default function UserSettings() {
  const { user, setUser } = useAuth();
  const [uiTheme, setUiTheme] = useState<AppUiTheme>(user?.preferences?.ui_theme ?? "dark");
  const [defaultResumeTheme, setDefaultResumeTheme] = useState<string>(
    user?.preferences?.default_resume_theme ?? "",
  );
  const [llmTiers, setLlmTiers] = useState<Partial<Record<LlmFunc, LlmTier>>>(
    user?.preferences?.llm_tiers ?? {},
  );
  const [resumeThemes, setResumeThemes] = useState<ThemeOption[]>([]);
  const [prefsSaved, setPrefsSaved] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);

  // Password change form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwSaved, setPwSaved] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaving, setPwSaving] = useState(false);

  // Auto-download
  const autoDownloadSupported = isAutoDownloadSupported();
  const [autoDownloadLabel, setAutoDownloadLabel] = useState<string | null>(null);
  const [autoDownloadEnabledState, setAutoDownloadEnabledLocal] = useState(true);
  const [autoDownloadAbsPath, setAutoDownloadAbsPath] = useState("");
  const [autoDownloadAbsSaved, setAutoDownloadAbsSaved] = useState(false);
  const [autoDownloadError, setAutoDownloadError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getThemes()
      .then((r) => setResumeThemes(r.themes))
      .catch(() => setResumeThemes([]));
  }, []);

  useEffect(() => {
    void getAutoDownloadConfig().then((cfg) => {
      setAutoDownloadLabel(cfg?.label ?? null);
      setAutoDownloadEnabledLocal(cfg?.enabled ?? true);
      setAutoDownloadAbsPath(cfg?.absolutePath ?? "");
    });
  }, []);

  async function savePreferences() {
    setPrefsError(null);
    setPrefsSaved(false);
    try {
      const { user: updated } = await api.updateMyPreferences({
        ui_theme: uiTheme,
        ...(defaultResumeTheme ? { default_resume_theme: defaultResumeTheme } : {}),
        llm_tiers: llmTiers,
      });
      setUser(updated);
      applyAppUiTheme(uiTheme);
      setPrefsSaved(true);
      window.setTimeout(() => setPrefsSaved(false), 1500);
    } catch (e) {
      setPrefsError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    if (pwSaving) return;
    setPwError(null);
    setPwSaved(false);
    if (newPassword.length < 6) {
      setPwError("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError("Passwords do not match.");
      return;
    }
    setPwSaving(true);
    try {
      await api.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwSaved(true);
      window.setTimeout(() => setPwSaved(false), 2500);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : String(err));
    } finally {
      setPwSaving(false);
    }
  }

  async function chooseAutoDownloadFolder() {
    setAutoDownloadError(null);
    try {
      const cfg = await pickAutoDownloadFolder();
      setAutoDownloadLabel(cfg.label);
      setAutoDownloadEnabledLocal(cfg.enabled);
      setAutoDownloadAbsPath(cfg.absolutePath);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setAutoDownloadError(e instanceof Error ? e.message : String(e));
    }
  }

  async function clearAutoDownload() {
    setAutoDownloadError(null);
    try {
      await clearAutoDownloadFolder();
      setAutoDownloadLabel(null);
      setAutoDownloadAbsPath("");
    } catch (e) {
      setAutoDownloadError(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleAutoDownloadEnabled(next: boolean) {
    setAutoDownloadError(null);
    setAutoDownloadEnabledLocal(next);
    try {
      await setAutoDownloadEnabled(next);
    } catch (e) {
      setAutoDownloadError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveAutoDownloadAbsPath() {
    setAutoDownloadError(null);
    try {
      await setAutoDownloadAbsolutePath(autoDownloadAbsPath);
      setAutoDownloadAbsSaved(true);
      window.setTimeout(() => setAutoDownloadAbsSaved(false), 1500);
    } catch (e) {
      setAutoDownloadError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <h1><IconGear />My settings</h1>
      <p className="sub">
        Signed in as <span className="mono">{user?.email}</span> ({user?.role}).
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))",
          gap: "1rem",
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* ------------------ Appearance + defaults ------------------ */}
      <div className="card">
        <h3>Appearance &amp; defaults</h3>
        <p className="sub" style={{ marginBottom: "0.5rem" }}>
          These override the app-wide defaults for your account only.
        </p>

        <label htmlFor="settings-ui-theme">UI theme</label>
        <select
          id="settings-ui-theme"
          value={uiTheme}
          onChange={(e) => {
            const next = e.target.value as AppUiTheme;
            setUiTheme(next);
            applyAppUiTheme(next);
          }}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>

        <label htmlFor="settings-default-theme" style={{ marginTop: "0.75rem" }}>
          Default resume theme
        </label>
        <select
          id="settings-default-theme"
          value={defaultResumeTheme}
          onChange={(e) => setDefaultResumeTheme(e.target.value)}
        >
          <option value="">(use app default)</option>
          {resumeThemes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>

        {prefsError && <p className="error">{prefsError}</p>}
        <div className="actions" style={{ marginTop: "0.75rem" }}>
          <button type="button" className="btn primary" onClick={() => void savePreferences()}>
            {prefsSaved ? "Saved" : "Save preferences"}
          </button>
        </div>
      </div>

      {/* ------------------ Model tiers ------------------ */}
      <div className="card">
        <h3>Models</h3>
        <p className="sub" style={{ marginBottom: "0.75rem" }}>
          The app runs on two models (a cheap <strong>Light</strong> and a strong <strong>Heavy</strong>,
          set by an admin). Choose which tier each function uses. This also controls which model the
          Tryvify extension uses to fill forms.
        </p>
        {LLM_FUNC_META.map((f) => (
          <div key={f.key} style={{ marginBottom: "0.75rem" }}>
            <label htmlFor={`tier-${f.key}`} style={{ fontWeight: 600 }}>
              {f.label}
            </label>
            <select
              id={`tier-${f.key}`}
              value={llmTiers[f.key] ?? f.def}
              onChange={(e) => setLlmTiers((prev) => ({ ...prev, [f.key]: e.target.value as LlmTier }))}
            >
              <option value="light">Light</option>
              <option value="heavy">Heavy</option>
            </select>
            <p className="sub" style={{ margin: "0.2rem 0 0" }}>{f.help}</p>
          </div>
        ))}
        <div className="actions" style={{ marginTop: "0.5rem" }}>
          <button type="button" className="btn primary" onClick={() => void savePreferences()}>
            {prefsSaved ? "Saved" : "Save preferences"}
          </button>
        </div>
      </div>

      {/* ------------------ Change password ------------------ */}
      <div className="card">
        <h3>Change password</h3>
        <form onSubmit={handleChangePassword}>
          <label htmlFor="settings-current-pw">Current password</label>
          <input
            id="settings-current-pw"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <label htmlFor="settings-new-pw">New password (min 6 chars)</label>
          <input
            id="settings-new-pw"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          <label htmlFor="settings-confirm-pw">Confirm new password</label>
          <input
            id="settings-confirm-pw"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
          {pwError && <p className="error">{pwError}</p>}
          {pwSaved && <p className="sub" style={{ color: "var(--ok, #5fbf5f)" }}>Password changed.</p>}
          <div className="actions" style={{ marginTop: "0.75rem" }}>
            <button type="submit" className="btn primary" disabled={pwSaving}>
              {pwSaving ? "Changing…" : "Change password"}
            </button>
          </div>
        </form>
      </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* ------------------ Auto-download ------------------ */}
      <div className="card">
        <h3>Auto-download folder</h3>
        <p className="sub" style={{ marginBottom: "0.5rem" }}>
          When a generation finishes, PDFs are saved into this folder under the same
          <span className="mono"> MM_DD / profile / TS_company_role </span>
          layout the server uses. The folder is remembered in this browser only — other devices
          will need their own pick.
        </p>
        {autoDownloadSupported ? (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <input
                type="checkbox"
                checked={autoDownloadEnabledState}
                disabled={!autoDownloadLabel}
                onChange={(e) => void toggleAutoDownloadEnabled(e.target.checked)}
              />
              <span>Enable auto-download when generation completes</span>
            </label>
            <div className="mono" style={{ marginBottom: "0.5rem" }}>
              {autoDownloadLabel ? `Selected: ${autoDownloadLabel}` : "No folder selected"}
            </div>
            <div className="actions">
              <button type="button" className="btn small" onClick={() => void chooseAutoDownloadFolder()}>
                {autoDownloadLabel ? "Change folder" : "Choose folder"}
              </button>
              {autoDownloadLabel && (
                <button type="button" className="btn small danger" onClick={() => void clearAutoDownload()}>
                  Clear
                </button>
              )}
            </div>
            {autoDownloadLabel && (
              <div style={{ marginTop: "0.75rem" }}>
                <label htmlFor="settings-autodl-abs">
                  Absolute path (optional — shown on toasts and the Result page)
                </label>
                <input
                  id="settings-autodl-abs"
                  value={autoDownloadAbsPath}
                  placeholder="e.g. E:\\resumes"
                  onChange={(e) => setAutoDownloadAbsPath(e.target.value)}
                />
                <div className="actions">
                  <button type="button" className="btn small" onClick={() => void saveAutoDownloadAbsPath()}>
                    {autoDownloadAbsSaved ? "Saved" : "Save path"}
                  </button>
                </div>
              </div>
            )}
            <p className="sub" style={{ marginTop: "0.5rem" }}>
              Your browser may prompt for write permission after each reload — that is a browser
              security requirement. If writes fail with <span className="mono">InvalidStateError</span>,
              exclude the target folder from Windows Defender real-time scanning.
            </p>
          </>
        ) : (
          <p className="sub">
            Your browser does not support the File System Access API. Auto-download requires
            Chrome, Edge, Brave, or another Chromium-based browser.
          </p>
        )}
        {autoDownloadError && <p className="error">{autoDownloadError}</p>}
      </div>

        </div>
      </div>
    </>
  );
}
