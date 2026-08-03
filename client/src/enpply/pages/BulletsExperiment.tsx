import { useEffect, useState } from "react";
import { api } from "../api";
import KeyboardTextarea from "../components/KeyboardTextarea";
import type { BulletExperimentResult, LlmProvider } from "../types";
import { DEFAULT_LLM_MODEL, LLM_MODELS_BY_PROVIDER, LLM_PROVIDER_LABELS } from "../llmDefaults";

/**
 * Admin "Bullets Experiment" tab — drives the bullets-based tailoring harness
 * (Experiment/enpply_tailoring_system.md). Pick a profile with a pre-built
 * bullet store, paste a JD, and inspect: K-extraction, stack→company
 * distribution, gaps, and bullets before/after the K2 injection pass.
 */
function ProviderModel(props: {
  label: string;
  provider: LlmProvider;
  model: string;
  onProvider: (p: LlmProvider) => void;
  onModel: (m: string) => void;
}) {
  const { label, provider, model, onProvider, onModel } = props;
  const modelKnown = LLM_MODELS_BY_PROVIDER[provider].some((m) => m.id === model);
  return (
    <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "flex-end" }}>
      <div>
        <label>{label} provider</label>
        <select
          className="form-control"
          value={provider}
          onChange={(e) => {
            const p = e.target.value as LlmProvider;
            onProvider(p);
            onModel(DEFAULT_LLM_MODEL[p]);
          }}
        >
          {(Object.keys(LLM_PROVIDER_LABELS) as LlmProvider[]).map((id) => (
            <option key={id} value={id}>
              {LLM_PROVIDER_LABELS[id]}
            </option>
          ))}
        </select>
      </div>
      <div style={{ flex: "1 1 260px", minWidth: "200px" }}>
        <label>{label} model</label>
        <select
          className="form-control"
          value={modelKnown ? model : "__custom__"}
          onChange={(e) => {
            if (e.target.value !== "__custom__") onModel(e.target.value);
          }}
        >
          {LLM_MODELS_BY_PROVIDER[provider].map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value="__custom__">Custom (type below)…</option>
        </select>
        <input
          className="form-control"
          style={{ marginTop: "0.35rem" }}
          value={model}
          placeholder="model id"
          onChange={(e) => onModel(e.target.value)}
        />
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "var(--panel, rgba(0,0,0,0.2))",
  padding: "0.85rem",
  borderRadius: "8px",
  maxHeight: "50vh",
  overflow: "auto",
  fontSize: "0.8rem",
};

function BulletList({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      {items.map((b, i) => (
        <li key={i} style={{ fontSize: "0.85rem", lineHeight: 1.4 }}>
          {b}
        </li>
      ))}
    </ul>
  );
}

export default function BulletsExperiment() {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profileId, setProfileId] = useState<string>("");
  const [jd, setJd] = useState("");
  const [provider, setProvider] = useState<LlmProvider>("openrouter");
  const [model, setModel] = useState<string>("openai/gpt-5-mini");
  const [sameModelForInjection, setSameModelForInjection] = useState(true);
  const [injProvider, setInjProvider] = useState<LlmProvider>("openrouter");
  const [injModel, setInjModel] = useState<string>("openai/gpt-5-mini");
  const [runInjection, setRunInjection] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulletExperimentResult | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    api
      .bulletsProfiles()
      .then((r) => {
        setProfiles(r.profiles);
        if (r.profiles.length && !profileId) setProfileId(r.profiles[0]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (!profileId || !jd.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.bulletsRun({
        profileId,
        jd_text: jd,
        provider,
        model,
        inject_provider: sameModelForInjection ? provider : injProvider,
        inject_model: sameModelForInjection ? model : injModel,
        run_injection: runInjection,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const breakdownStr = (b: Record<string, number>) =>
    Object.entries(b)
      .sort((a, c) => c[1] - a[1])
      .map(([k, v]) => `${k} ${v}%`)
      .join(" · ");

  return (
    <div>
      <p className="sub">
        Bullets-based tailoring harness. Reads <code>Experiment/bullets/&lt;profile&gt;.json</code>,
        the JD extraction prompt, and the K2 injection prompt. Nothing here touches the production
        generation pipeline.
      </p>

      {error && <p className="error">{error}</p>}

      <div className="card">
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label htmlFor="be-profile">Profile (bullet store)</label>
            <select
              id="be-profile"
              className="form-control"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {profiles.length === 0 && <option value="">(no bullet stores found)</option>}
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginTop: "1rem" }}>
          <ProviderModel
            label="Extraction"
            provider={provider}
            model={model}
            onProvider={setProvider}
            onModel={setModel}
          />
        </div>

        <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginTop: "0.85rem" }}>
          <input type="checkbox" checked={runInjection} onChange={(e) => setRunInjection(e.target.checked)} />
          Run K2 injection pass
        </label>
        {runInjection && (
          <>
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginTop: "0.4rem" }}>
              <input
                type="checkbox"
                checked={sameModelForInjection}
                onChange={(e) => setSameModelForInjection(e.target.checked)}
              />
              Use the same model for injection
            </label>
            {!sameModelForInjection && (
              <div style={{ marginTop: "0.6rem" }}>
                <ProviderModel
                  label="Injection"
                  provider={injProvider}
                  model={injModel}
                  onProvider={setInjProvider}
                  onModel={setInjModel}
                />
              </div>
            )}
          </>
        )}

        <label htmlFor="be-jd" style={{ marginTop: "0.85rem", display: "block" }}>
          Job description
        </label>
        <KeyboardTextarea id="be-jd" rows={12} value={jd} onValueChange={setJd} onSaveShortcut={() => void run()} />

        <div className="actions" style={{ marginTop: "0.75rem" }}>
          <button type="button" className="btn primary" disabled={busy || !profileId || !jd.trim()} onClick={() => void run()}>
            {busy ? "Running…" : "Run experiment"}
          </button>
        </div>
        <p className="hint">Tip: Ctrl/Cmd+S in the JD field also runs.</p>
      </div>

      {result && (
        <>
          <div className="card">
            <h2>Extraction summary</h2>
            <p className="sub" style={{ marginBottom: "0.5rem" }}>
              <strong>Signal:</strong> {result.signal_quality} · <strong>Primary:</strong> {result.primary_domain} ·{" "}
              <strong>Clearance:</strong> {result.clearance_required ? `yes (${result.clearance_level})` : "no"}
            </p>
            <p className="sub" style={{ marginBottom: "0.5rem" }}>
              <strong>Domains:</strong> {breakdownStr(result.domain_breakdown)}
            </p>
            <p className="mono" style={{ fontSize: "0.72rem", opacity: 0.7 }}>
              extraction {result.models.extraction} · {result.timings.extraction_ms} ms
              {result.usage.extraction?.total_tokens != null ? ` · ${result.usage.extraction.total_tokens} tok` : ""} ·
              injection {result.models.injection} · {result.timings.injection_ms} ms · total {result.timings.total_ms} ms
            </p>

            {result.warnings.length > 0 && (
              <div style={{ marginTop: "0.6rem" }}>
                {result.warnings.map((w, i) => (
                  <p key={i} className="error" style={{ margin: "0.2rem 0", fontSize: "0.82rem" }}>
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}

            {result.gaps.length > 0 && (
              <p className="sub" style={{ marginTop: "0.5rem", fontSize: "0.82rem" }}>
                <strong>Gaps (K1 stacks with no pre-built bullets):</strong>{" "}
                {result.gaps.map((g) => `${g.stack} (${g.domain})`).join(", ")}
              </p>
            )}

            <button
              type="button"
              className="btn small"
              style={{ marginTop: "0.6rem" }}
              onClick={() => setShowRaw((s) => !s)}
            >
              {showRaw ? "Hide" : "Show"} raw extraction JSON
            </button>
            {showRaw && <pre style={{ ...panelStyle, marginTop: "0.6rem" }}>{JSON.stringify(result.extraction, null, 2)}</pre>}
          </div>

          <div className="card">
            <h2 style={{ marginBottom: "0.25rem" }}>Assembled résumé</h2>
            <p className="sub" style={{ marginTop: 0 }}>
              Last 2 companies tailored from the bullet store; older companies shown as-is from the profile.
            </p>
            {result.resume.map((sec, i) => (
              <div key={i} style={{ marginTop: "0.9rem" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: "0.95rem" }}>{sec.company}</strong>
                  <span className="sub" style={{ fontSize: "0.82rem" }}>
                    {sec.title} · {sec.startDate} – {sec.endDate}
                  </span>
                  <span
                    style={{
                      fontSize: "0.66rem",
                      padding: "0.05rem 0.4rem",
                      borderRadius: "999px",
                      border: "1px solid var(--border, rgba(255,255,255,0.2))",
                      opacity: 0.8,
                    }}
                  >
                    {sec.source === "tailored"
                      ? "tailored"
                      : sec.source === "tailored_fallback"
                        ? "tailored (fallback)"
                        : "as-is"}
                  </span>
                </div>
                {sec.note && (
                  <p className="sub" style={{ fontSize: "0.76rem", margin: "0.2rem 0 0", opacity: 0.8 }}>{sec.note}</p>
                )}
                <BulletList items={sec.bullets} />
              </div>
            ))}
            <button
              type="button"
              className="btn small"
              style={{ marginTop: "0.8rem" }}
              onClick={() =>
                void navigator.clipboard?.writeText(
                  result.resume
                    .map((s) => `${s.company} — ${s.title} (${s.startDate} – ${s.endDate})\n` + s.bullets.map((b) => `• ${b}`).join("\n"))
                    .join("\n\n"),
                )
              }
            >
              Copy full résumé
            </button>
          </div>

          {result.companies.length === 0 && (
            <div className="card">
              <p className="sub">No companies received distributed stacks. Check the gaps and the bullet store.</p>
            </div>
          )}

          <h2 style={{ marginTop: "1.5rem" }}>Per-company tailoring detail</h2>

          {result.companies.map((co) => (
            <div className="card" key={co.company}>
              <h2 style={{ marginBottom: "0.25rem" }}>{co.company}</h2>
              {co.project && <p className="sub" style={{ marginTop: 0 }}>{co.project}</p>}

              <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse", margin: "0.5rem 0" }}>
                <thead>
                  <tr style={{ textAlign: "left", opacity: 0.7 }}>
                    <th>Stack</th>
                    <th>Domain</th>
                    <th>Tier</th>
                    <th>Weight</th>
                    <th>Lines</th>
                  </tr>
                </thead>
                <tbody>
                  {co.stacks.map((s) => (
                    <tr key={s.stack}>
                      <td>
                        {s.stack}
                        {s.aliasUsed ? <span style={{ opacity: 0.6 }}> → {s.resolvedKey}</span> : ""}
                      </td>
                      <td>{s.domain}</td>
                      <td>{s.tier}</td>
                      <td>{s.weight}%</td>
                      <td>
                        {s.bullets.length}
                        {s.bullets.length !== s.linesRequested ? ` (wanted ${s.linesRequested})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {co.injectionNote && (
                <p className="sub" style={{ fontSize: "0.8rem", opacity: 0.8 }}>{co.injectionNote}</p>
              )}
              {(co.k2Placed.length > 0 || co.k2Skipped.length > 0) && (
                <p className="sub" style={{ fontSize: "0.8rem" }}>
                  <strong>K2 placed:</strong> {co.k2Placed.join(", ") || "—"}
                  <br />
                  <strong>K2 skipped:</strong> {co.k2Skipped.join(", ") || "—"}
                </p>
              )}

              <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                <div style={{ flex: "1 1 320px", minWidth: "280px" }}>
                  <strong style={{ fontSize: "0.85rem" }}>Before injection</strong>
                  <BulletList items={co.preInjectionBullets} />
                </div>
                <div style={{ flex: "1 1 320px", minWidth: "280px" }}>
                  <strong style={{ fontSize: "0.85rem" }}>Final (after K2)</strong>
                  <BulletList items={co.finalBullets} />
                </div>
              </div>

              <button
                type="button"
                className="btn small"
                style={{ marginTop: "0.6rem" }}
                onClick={() => void navigator.clipboard?.writeText(co.finalBullets.join("\n"))}
              >
                Copy final bullets
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
