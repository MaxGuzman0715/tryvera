import { useEffect, useState } from "react";
import { api } from "../api";
import KeyboardTextarea from "../components/KeyboardTextarea";
import type { LlmProvider } from "../types";
import { DEFAULT_LLM_MODEL, LLM_MODELS_BY_PROVIDER, LLM_PROVIDER_LABELS } from "../llmDefaults";
import BulletsExperiment from "./BulletsExperiment";
import { IconFlask } from "../../ui/icons";

type PlaygroundTab = "chat" | "bullets";

type Result = {
  text: string;
  provider: LlmProvider;
  model: string;
  finish_reason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  elapsed_ms: number;
};

/** One completed (or failed) send, persisted in localStorage. */
type HistoryEntry = {
  id: string;
  createdAt: number;
  provider: LlmProvider;
  model: string;
  system: string;
  user: string;
  result: Result | null;
  error?: string;
};

const HISTORY_KEY = "enpply_playground_history";
const HISTORY_CAP = 50;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function entryTitle(e: HistoryEntry): string {
  const firstLine = e.user.split("\n").find((l) => l.trim()) ?? "";
  const t = firstLine.trim();
  return t ? (t.length > 44 ? `${t.slice(0, 44)}…` : t) : "(empty prompt)";
}

export default function Playground() {
  const [tab, setTab] = useState<PlaygroundTab>("chat");
  const [provider, setProvider] = useState<LlmProvider>("openai");
  const [model, setModel] = useState<string>(DEFAULT_LLM_MODEL.openai);
  const [system, setSystem] = useState("");
  const [user, setUser] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* quota / disabled storage — history just won't persist */
    }
  }, [history]);

  const modelKnown = LLM_MODELS_BY_PROVIDER[provider].some((m) => m.id === model);

  function newChat() {
    setSelectedId(null);
    setSystem("");
    setUser("");
    setResult(null);
    setError(null);
  }

  function selectEntry(e: HistoryEntry) {
    setSelectedId(e.id);
    setProvider(e.provider);
    setModel(e.model);
    setSystem(e.system);
    setUser(e.user);
    setResult(e.result);
    setError(e.error ?? null);
  }

  function deleteEntry(id: string) {
    setHistory((h) => h.filter((e) => e.id !== id));
    if (selectedId === id) newChat();
  }

  function clearAll() {
    if (!window.confirm("Clear all playground history?")) return;
    setHistory([]);
    newChat();
  }

  async function run() {
    if (!user.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const base = { provider, model, system, user };
    try {
      const res = await api.playgroundChat(base);
      setResult(res);
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        ...base,
        result: res,
      };
      setHistory((h) => [entry, ...h].slice(0, HISTORY_CAP));
      setSelectedId(entry.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        ...base,
        result: null,
        error: msg,
      };
      setHistory((h) => [entry, ...h].slice(0, HISTORY_CAP));
      setSelectedId(entry.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1><IconFlask />Playground</h1>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", borderBottom: "1px solid var(--border, rgba(255,255,255,0.12))" }}>
        {([
          ["chat", "Chat"],
          ["bullets", "Bullets Experiment"],
        ] as [PlaygroundTab, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              padding: "0.5rem 0.85rem",
              color: "inherit",
              fontWeight: tab === id ? 700 : 400,
              borderBottom: tab === id ? "2px solid var(--accent, #5aa0ff)" : "2px solid transparent",
              marginBottom: "-1px",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "bullets" ? (
        <BulletsExperiment />
      ) : (
      <>
      <p className="sub">
        Send a system + user message straight to a model. Admin-only; history is stored locally in this
        browser. API keys stay in the server <code>.env</code>.
      </p>

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
        {/* History sidebar */}
        <aside
          style={{
            flex: "0 0 240px",
            maxWidth: "240px",
            position: "sticky",
            top: "1rem",
            maxHeight: "calc(100vh - 6rem)",
            overflow: "auto",
          }}
        >
          <div className="card" style={{ padding: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <strong>History</strong>
              <button type="button" className="btn small" onClick={newChat}>
                New
              </button>
            </div>
            {history.length === 0 ? (
              <p className="sub" style={{ margin: 0 }}>No sends yet.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {history.map((e) => (
                  <li key={e.id}>
                    <div
                      onClick={() => selectEntry(e)}
                      style={{
                        cursor: "pointer",
                        padding: "0.45rem 0.5rem",
                        borderRadius: "6px",
                        border: "1px solid var(--border, rgba(255,255,255,0.12))",
                        background: e.id === selectedId ? "var(--accent-soft, rgba(80,160,255,0.15))" : "transparent",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.4rem" }}>
                        <span style={{ fontSize: "0.82rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {entryTitle(e)}
                        </span>
                        <button
                          type="button"
                          title="Delete"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            deleteEntry(e.id);
                          }}
                          style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", opacity: 0.6, padding: 0, lineHeight: 1 }}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="mono" style={{ fontSize: "0.68rem", opacity: 0.7, marginTop: "0.15rem" }}>
                        {e.error ? "⚠ error · " : ""}
                        {e.model}
                      </div>
                      <div style={{ fontSize: "0.66rem", opacity: 0.55 }}>
                        {new Date(e.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {history.length > 0 && (
              <button type="button" className="btn small" style={{ marginTop: "0.6rem", width: "100%" }} onClick={clearAll}>
                Clear all
              </button>
            )}
          </div>
        </aside>

        {/* Main editor + output */}
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          {error && <p className="error">{error}</p>}

          <div className="card">
            <div
              style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}
            >
              <div>
                <label htmlFor="pg-provider">Provider</label>
                <select
                  id="pg-provider"
                  className="form-control"
                  value={provider}
                  onChange={(e) => {
                    const p = e.target.value as LlmProvider;
                    setProvider(p);
                    setModel(DEFAULT_LLM_MODEL[p]);
                  }}
                >
                  {(Object.keys(LLM_PROVIDER_LABELS) as LlmProvider[]).map((id) => (
                    <option key={id} value={id}>
                      {LLM_PROVIDER_LABELS[id]}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: "1 1 320px", minWidth: "240px" }}>
                <label htmlFor="pg-model">Model</label>
                <select
                  id="pg-model"
                  className="form-control"
                  value={modelKnown ? model : "__custom__"}
                  onChange={(e) => {
                    if (e.target.value !== "__custom__") setModel(e.target.value);
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
                  style={{ marginTop: "0.4rem" }}
                  value={model}
                  placeholder="model id (e.g. gpt-5-mini)"
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
            </div>

            <label htmlFor="pg-system">System message</label>
            <KeyboardTextarea
              id="pg-system"
              rows={6}
              value={system}
              onValueChange={setSystem}
              onSaveShortcut={() => void run()}
            />

            <label htmlFor="pg-user" style={{ marginTop: "0.75rem", display: "block" }}>
              User message
            </label>
            <KeyboardTextarea
              id="pg-user"
              rows={10}
              value={user}
              onValueChange={setUser}
              onSaveShortcut={() => void run()}
            />

            <div className="actions" style={{ marginTop: "0.75rem" }}>
              <button type="button" className="btn primary" disabled={busy || !user.trim()} onClick={() => void run()}>
                {busy ? "Sending…" : "Send"}
              </button>
              <button type="button" className="btn small" disabled={busy} onClick={newChat}>
                New chat
              </button>
            </div>
            <p className="hint">Tip: Ctrl/Cmd+S in either field also sends.</p>
          </div>

          {result && (
            <div className="card">
              <h2>Response</h2>
              <p className="sub">
                <span className="mono">
                  {LLM_PROVIDER_LABELS[result.provider]} / {result.model}
                </span>{" "}
                · {result.elapsed_ms} ms
                {result.finish_reason ? ` · finish: ${result.finish_reason}` : ""}
                {result.usage?.total_tokens != null
                  ? ` · ${result.usage.prompt_tokens ?? "?"}+${result.usage.completion_tokens ?? "?"} = ${result.usage.total_tokens} tokens`
                  : ""}
              </p>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  background: "var(--panel, rgba(0,0,0,0.2))",
                  padding: "0.85rem",
                  borderRadius: "8px",
                  maxHeight: "60vh",
                  overflow: "auto",
                }}
              >
                {result.text || "(empty response)"}
              </pre>
              <div className="actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void navigator.clipboard?.writeText(result.text)}
                >
                  Copy response
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      </>
      )}
    </>
  );
}
