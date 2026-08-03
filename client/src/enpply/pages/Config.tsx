import { useEffect, useState } from "react";
import { api } from "../api";
import KeyboardTextarea from "../components/KeyboardTextarea";
import ProfileThemeMatrix from "../components/ProfileThemeMatrix";
import type {
  AppSettings,
  LlmModelConfig,
  LlmProvider,
  PromptKey,
  PromptMeta,
  Prompts,
} from "../types";
import { DEFAULT_LLM_MODEL, LLM_MODELS_BY_PROVIDER, LLM_PROVIDER_LABELS } from "../llmDefaults";
import { IconSliders } from "../../ui/icons";

const PROMPT_KEYS: PromptKey[] = ["extraction", "resume", "coverLetter", "qa", "matchScore"];

const PROMPT_LABELS: Record<PromptKey, string> = {
  extraction: "Extraction (JD metadata + application answers)",
  resume: "Résumé",
  coverLetter: "Cover letter",
  qa: "Follow-up Q&A (Result page)",
  matchScore: "Match score (Result page)",
};

export default function Config() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [profiles, setProfiles] = useState<{ id: string }[]>([]);
  const [themes, setThemes] = useState<{ id: string; label: string }[]>([]);
  const [prompts, setPrompts] = useState<Prompts | null>(null);
  const [meta, setMeta] = useState<PromptMeta | null>(null);
  const [defaults, setDefaults] = useState<Prompts | null>(null);
  const [selectedVariantByKey, setSelectedVariantByKey] = useState<Record<PromptKey, string> | null>(
    null,
  );
  const [draftByKey, setDraftByKey] = useState<Record<PromptKey, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getSettings(),
      api.getPromptsFull(),
      api.getPromptDefaults(),
      api.listProfiles(),
      api.getThemes(),
    ])
      .then(([s, full, d, profs, th]) => {
        setSettings({
          ...s,
          ui_theme: s.ui_theme === "light" ? "light" : "dark",
          llm_light: s.llm_light ?? { provider: "openrouter", model: DEFAULT_LLM_MODEL.openrouter },
          llm_heavy: s.llm_heavy ?? { provider: "openai", model: DEFAULT_LLM_MODEL.openai },
        });
        setProfiles(profs);
        setThemes(th.themes);
        setPrompts(full.prompts);
        setMeta(full.meta);
        setDefaults(d);
        const sel = {} as Record<PromptKey, string>;
        const draft = {} as Record<PromptKey, string>;
        for (const k of PROMPT_KEYS) {
          sel[k] = full.meta.activeByKey[k];
          draft[k] = full.prompts[k];
        }
        setSelectedVariantByKey(sel);
        setDraftByKey(draft);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function saveSettings() {
    if (!settings) return;
    setError(null);
    try {
      await api.saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveOnePrompt(key: PromptKey) {
    if (!selectedVariantByKey || !draftByKey) return;
    setError(null);
    try {
      await api.savePromptVariant(key, selectedVariantByKey[key], draftByKey[key]);
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSelectVariant(key: PromptKey, name: string) {
    if (!selectedVariantByKey || !draftByKey || !meta) return;
    const prev = selectedVariantByKey[key];
    if (prev === name) return;
    setError(null);
    try {
      await api.savePromptVariant(key, prev, draftByKey[key]);
      const { content } = await api.getPromptVariant(key, name);
      setSelectedVariantByKey((m) => (m ? { ...m, [key]: name } : m));
      setDraftByKey((m) => (m ? { ...m, [key]: content } : m));
      const full = await api.getPromptsFull();
      setPrompts(full.prompts);
      setMeta(full.meta);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function setActiveForKey(key: PromptKey) {
    if (!selectedVariantByKey || !meta) return;
    const name = selectedVariantByKey[key];
    setError(null);
    try {
      const res = await api.setActivePromptVariant(key, name);
      setMeta({ activeByKey: res.activeByKey, variantsByKey: res.variantsByKey });
      const full = await api.getPromptsFull();
      setPrompts(full.prompts);
      setDraftByKey((m) => (m ? { ...m, [key]: full.prompts[key] } : m));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function createVariant(key: PromptKey) {
    if (!draftByKey || !selectedVariantByKey) return;
    const raw = window.prompt("Name for the new prompt variant (letters, numbers, dashes):");
    if (raw == null || !raw.trim()) return;
    setError(null);
    try {
      const res = await api.createPromptVariant(key, raw.trim(), draftByKey[key]);
      setMeta({ activeByKey: res.activeByKey, variantsByKey: res.variantsByKey });
      const { content } = await api.getPromptVariant(key, res.name);
      setSelectedVariantByKey((m) => (m ? { ...m, [key]: res.name } : m));
      setDraftByKey((m) => (m ? { ...m, [key]: content } : m));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeVariant(key: PromptKey) {
    if (!meta || !selectedVariantByKey) return;
    const name = selectedVariantByKey[key];
    if (name === "default") return;
    if (meta.activeByKey[key] === name) {
      setError("Switch the active variant before deleting this one.");
      return;
    }
    if (!window.confirm(`Delete variant "${name}" for ${PROMPT_LABELS[key]}?`)) return;
    setError(null);
    try {
      const res = await api.deletePromptVariant(key, name);
      setMeta({ activeByKey: res.activeByKey, variantsByKey: res.variantsByKey });
      const variants = res.variantsByKey[key];
      const active = res.activeByKey[key];
      const nextName =
        active && variants.includes(active) ? active : (variants[0] ?? "default");
      const loaded = await api.getPromptVariant(key, nextName);
      setSelectedVariantByKey((m) => (m ? { ...m, [key]: nextName } : m));
      setDraftByKey((d) => (d ? { ...d, [key]: loaded.content } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function resetOne(key: PromptKey) {
    setError(null);
    try {
      await api.resetPrompt(key);
      const full = await api.getPromptsFull();
      setPrompts(full.prompts);
      setMeta(full.meta);
      setSelectedVariantByKey((m) =>
        m ? { ...m, [key]: full.meta.activeByKey[key] } : m,
      );
      setDraftByKey((d) => (d ? { ...d, [key]: full.prompts[key] } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!settings || !prompts || !defaults || !meta || !selectedVariantByKey || !draftByKey) {
    return <p className="sub">Loading…</p>;
  }

  return (
    <>
      <h1><IconSliders />Config</h1>
      <p className="sub">Default paths, theme, and LLM prompts.</p>

      {error && <p className="error">{error}</p>}
      {saved && <p style={{ color: "var(--ok)" }}>Saved.</p>}

      <div className="card">
        <h2>Prompts</h2>
        <p className="sub">
          Resume is shown first. For each field, first <strong>Save draft</strong>, then click{" "}
          <strong>Set active</strong> when you want that variant used for generation.
        </p>
        <div className="prompt-grid">
          {PROMPT_KEYS.map((key) => {
            const variants = meta.variantsByKey[key];
            const activeName = meta.activeByKey[key];
            const selected = selectedVariantByKey[key];
            const canDelete =
              variants.length > 1 && selected !== "default" && selected !== activeName;
            return (
              <div key={key} className="prompt-box">
                <div className="prompt-toolbar">
                  <label htmlFor={`pv-${key}`}>{PROMPT_LABELS[key]}</label>
                  <span className="prompt-state">
                    Active: <span className="mono">{activeName}</span>
                  </span>
                  <select
                    id={`pv-${key}`}
                    className="form-control"
                    value={selected}
                    onChange={(e) => void onSelectVariant(key, e.target.value)}
                  >
                    {variants.map((v) => (
                      <option key={v} value={v}>
                        {v}
                        {v === activeName ? " (active)" : ""}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn small" onClick={() => void createVariant(key)}>
                    New variant
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!canDelete}
                    title={
                      !canDelete
                        ? "Cannot delete default, the only variant, or the active variant"
                        : undefined
                    }
                    onClick={() => void removeVariant(key)}
                  >
                    Delete variant
                  </button>
                </div>
                <KeyboardTextarea
                  rows={14}
                  value={draftByKey[key]}
                  onValueChange={(v) => setDraftByKey({ ...draftByKey, [key]: v })}
                  onSaveShortcut={() => void saveOnePrompt(key)}
                />
                <div className="prompt-actions">
                  <button type="button" className="btn primary small" onClick={() => void saveOnePrompt(key)}>
                    Save draft
                  </button>
                  {selected !== activeName && (
                    <button type="button" className="btn small" onClick={() => void setActiveForKey(key)}>
                      Set active
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      setDraftByKey({ ...draftByKey, [key]: defaults[key] })
                    }
                  >
                    Reset draft (local)
                  </button>
                  <button type="button" className="btn small" onClick={() => void resetOne(key)}>
                    Reset server default
                  </button>
                </div>
                <p className="hint prompt-reset-hint">
                  <strong>Local</strong> — fills the editor with the built-in default text only; use{" "}
                  <strong>Save prompts</strong> to write it to the server.{" "}
                  <strong>Server</strong> — immediately overwrites the <code>default</code> variant on disk and
                  sets it as the active prompt for this field (then reloads the editor).
                </p>
              </div>
            );
          })}
        </div>
      </div>
      <div className="card">
        <h2>Paths & theme</h2>
        <p className="sub" style={{ marginBottom: "0.75rem" }}>
          UI theme is a per-user preference — manage it under{" "}
          <strong>Settings</strong> instead. Everything on this card is a global,
          admin-only default that applies to all users.
        </p>

        <div className="config-subsection">
          <h3>Default output path</h3>
          <label>Default output path (relative to project root)</label>
          <input
            value={settings.default_output_path}
            onChange={(e) => setSettings({ ...settings, default_output_path: e.target.value })}
          />
          <div className="actions">
            <button type="button" className="btn small" onClick={saveSettings}>
              Save
            </button>
          </div>
        </div>

        <div className="config-subsection">
          <h3>Auto-download folder</h3>
          <p className="sub">
            Auto-download is a per-user preference. Manage it under{" "}
            <strong>Settings</strong> (the nav link next to your email).
          </p>
        </div>

        <div className="config-subsection">
          <h3>Default theme by profile</h3>
          <p className="sub">
            Each profile renders with the theme chosen here — applied for every user, from the web app
            and the extension alike. New profiles default to a 1-by-1 match against the theme list
            (cycling back to the start when there are more profiles than themes); change any below.
          </p>
          <ProfileThemeMatrix
            profiles={profiles}
            themes={themes}
            value={settings.default_theme_by_profile}
            onChange={(next) => setSettings({ ...settings, default_theme_by_profile: next })}
          />
          <div className="actions">
            <button type="button" className="btn small" onClick={saveSettings}>
              Save
            </button>
          </div>
        </div>

        <hr className="sep" />
        <h3 style={{ marginTop: "0.5rem" }}>Models (light &amp; heavy)</h3>
        <p className="sub" style={{ marginBottom: "0.75rem" }}>
          The whole app runs on exactly two models. Pick a cheap <strong>Light</strong> model and a strong{" "}
          <strong>Heavy</strong> model here; each user chooses which functions use which tier in{" "}
          <strong>My settings</strong>. API keys live only in the server <code>.env</code>.
        </p>
        {(["llm_light", "llm_heavy"] as const).map((key) => {
          const tier = settings[key];
          const label = key === "llm_light" ? "Light model (cheap / fast)" : "Heavy model (strong)";
          const setTier = (next: LlmModelConfig) => setSettings({ ...settings, [key]: next });
          return (
            <div key={key} className="config-subsection">
              <h3>{label}</h3>
              <label htmlFor={`tier-prov-${key}`}>Provider</label>
              <select
                id={`tier-prov-${key}`}
                className="form-control"
                value={tier.provider}
                onChange={(e) => {
                  const p = e.target.value as LlmProvider;
                  setTier({ provider: p, model: DEFAULT_LLM_MODEL[p] });
                }}
              >
                {(Object.keys(LLM_PROVIDER_LABELS) as LlmProvider[]).map((id) => (
                  <option key={id} value={id}>
                    {LLM_PROVIDER_LABELS[id]}
                  </option>
                ))}
              </select>
              <label htmlFor={`tier-model-${key}`} style={{ marginTop: "0.75rem" }}>
                Model
              </label>
              <input
                id={`tier-model-${key}`}
                list={`tier-model-list-${key}`}
                className="form-control"
                value={tier.model}
                onChange={(e) => setTier({ provider: tier.provider, model: e.target.value })}
                placeholder={DEFAULT_LLM_MODEL[tier.provider]}
              />
              <datalist id={`tier-model-list-${key}`}>
                {LLM_MODELS_BY_PROVIDER[tier.provider].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            </div>
          );
        })}

        <h3 style={{ marginTop: "1rem" }}>Résumé-pipeline model overrides (optional)</h3>
        <p className="sub" style={{ marginBottom: "0.75rem" }}>
          Pin a specific model to the <strong>extraction</strong> or <strong>generation</strong> step, overriding
          the tier. When off, the step uses its tier (résumé = Heavy).
        </p>
        {(
          [
            ["llm_extraction", "Extraction model"],
            ["llm_generation", "Generation model"],
          ] as const
        ).map(([key, label]) => {
          const ov = settings[key] ?? null;
          const setOverride = (next: LlmModelConfig | null) => setSettings({ ...settings, [key]: next });
          return (
            <div key={key} className="config-subsection">
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  checked={!!ov}
                  onChange={(e) =>
                    setOverride(e.target.checked ? { provider: "openai", model: DEFAULT_LLM_MODEL.openai } : null)
                  }
                />
                <strong>{label}</strong> <span className="sub">— override the tier</span>
              </label>
              {ov && (
                <>
                  <label htmlFor={`ov-prov-${key}`} style={{ marginTop: "0.5rem" }}>
                    Provider
                  </label>
                  <select
                    id={`ov-prov-${key}`}
                    className="form-control"
                    value={ov.provider}
                    onChange={(e) => {
                      const p = e.target.value as LlmProvider;
                      setOverride({ provider: p, model: DEFAULT_LLM_MODEL[p] });
                    }}
                  >
                    {(Object.keys(LLM_PROVIDER_LABELS) as LlmProvider[]).map((id) => (
                      <option key={id} value={id}>
                        {LLM_PROVIDER_LABELS[id]}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`ov-model-${key}`} style={{ marginTop: "0.75rem" }}>
                    Model
                  </label>
                  <input
                    id={`ov-model-${key}`}
                    list={`ov-model-list-${key}`}
                    className="form-control"
                    value={ov.model}
                    onChange={(e) => setOverride({ provider: ov.provider, model: e.target.value })}
                    placeholder={DEFAULT_LLM_MODEL[ov.provider]}
                  />
                  <datalist id={`ov-model-list-${key}`}>
                    {LLM_MODELS_BY_PROVIDER[ov.provider].map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </datalist>
                </>
              )}
            </div>
          );
        })}
        <p className="hint">
          Set <span className="mono">OPENROUTER_API_KEY</span>, <span className="mono">OPENAI_API_KEY</span>,{" "}
          <span className="mono">DEEPSEEK_API_KEY</span>, or <span className="mono">GEMINI_API_KEY</span> in{" "}
          <span className="mono">.env</span> to match each provider.
        </p>

        <div className="actions">
          <button type="button" className="btn primary" onClick={saveSettings}>
            Save settings
          </button>
        </div>
      </div>

      
      
    </>
  );
}
