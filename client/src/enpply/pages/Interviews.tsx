import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { InterviewAppSummary, InterviewEvent, InterviewMatchStatus } from "../types";
import { formatDateTimeJst } from "../timeJst";
import { useAuth } from "../auth/AuthContext";
import { IconInbox } from "../../ui/icons";
import { kindBadge, kindLabel } from "../interviewLabels";
import { useOnChange, usePersistentState, useScrollRestore } from "../viewState";

const PAGE_SIZE = 50;

const STATUS: Record<InterviewMatchStatus, { label: string; badge: string; hint: string }> = {
  needs_check: { label: "Needs check", badge: "gen", hint: "No application, or several equally likely. Pick one." },
  auto_matched: { label: "Auto-matched", badge: "info", hint: "Linked automatically. Confirm or change it." },
  confirmed: { label: "Confirmed", badge: "ok", hint: "Linked application checked by a person." },
  not_from_tryvera: { label: "Not from Tryvera", badge: "skip", hint: "Real interview, but not from an application made here." },
  ignored: { label: "Ignored", badge: "skip", hint: "Not a real interview." },
};
const STATUS_ORDER: InterviewMatchStatus[] = ["needs_check", "auto_matched", "confirmed", "not_from_tryvera", "ignored"];

type Candidate = InterviewAppSummary & { suggested: boolean };

export default function Interviews() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const appFilter = params.get("app") ?? "";
  const [rows, setRows] = useState<InterviewEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Remembered for this tab, so opening an application and coming back keeps the view.
  const [q, setQ] = usePersistentState("interviews:q", "");
  const [statusFilter, setStatusFilter] = usePersistentState<InterviewMatchStatus | "">("interviews:status", "");
  const [profileFilter, setProfileFilter] = usePersistentState("interviews:profile", "");
  const [hideHandled, setHideHandled] = usePersistentState("interviews:hideHandled", false);
  const [hideMaybe, setHideMaybe] = usePersistentState("interviews:hideMaybe", false);
  const [hideRejections, setHideRejections] = usePersistentState("interviews:hideRejections", false);
  const [page, setPage] = usePersistentState("interviews:page", 1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickerId, setPickerId] = useState<string | null>(null);

  async function reload() {
    const r = await api.listInterviews();
    setRows(r.interviews);
    setLoaded(true);
  }

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // While a Done/Reopen is on its way to Slack, refresh until the bot confirms it.
  const anyPending = rows.some((r) => r.handled_pending);
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => void reload().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [anyPending]);

  const profileOptions = useMemo(
    () => Array.from(new Set(rows.flatMap((r) => r.profile_ids))).sort((a, b) => a.localeCompare(b)),
    [rows]
  );

  /** Every filter except status, so the status chips can show what each would leave. */
  const baseRows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (appFilter && r.application_id !== appFilter) return false;
      if (profileFilter && !r.profile_ids.includes(profileFilter)) return false;
      if (hideHandled && r.handled) return false;
      if (hideMaybe && r.verdict === "MAYBE") return false;
      if (hideRejections && r.verdict === "REJECTION") return false;
      if (!s) return true;
      return [r.company, r.role, r.subject, r.sender, r.asked, r.application?.company_name, r.application?.role_name]
        .some((v) => String(v ?? "").toLowerCase().includes(s));
    });
  }, [rows, q, appFilter, profileFilter, hideHandled, hideMaybe, hideRejections]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<InterviewMatchStatus, number>;
    for (const r of baseRows) c[r.match_status]++;
    return c;
  }, [baseRows]);

  const visible = useMemo(
    () => (statusFilter ? baseRows.filter((r) => r.match_status === statusFilter) : baseRows),
    [baseRows, statusFilter]
  );

  useOnChange([q, statusFilter, profileFilter, hideHandled, hideMaybe, hideRejections, appFilter], () => setPage(1));
  useScrollRestore("interviews", loaded);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  async function patch(
    row: InterviewEvent,
    body: Parameters<typeof api.updateInterview>[1]
  ): Promise<void> {
    setBusyId(row.id);
    setError(null);
    try {
      const r = await api.updateInterview(row.id, body);
      setRows((prev) => prev.map((x) => (x.id === row.id ? r.interview : x)));
      setPickerId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function rematch() {
    setError(null);
    setNotice(null);
    try {
      const r = await api.rematchInterviews();
      setNotice(`Re-checked ${r.rematched} undecided row(s); ${r.matched} now auto-matched.`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const appFilterRow = appFilter ? rows.find((r) => r.application_id === appFilter)?.application : null;

  return (
    <>
      <h1>
        <IconInbox />
        Interviews
      </h1>
      <p className="sub">
        Hiring emails the Slack triage bot flagged, tied to the application they came from. Newest first.
      </p>
      <p className="hint">
        {STATUS_ORDER.map((s, i) => (
          <Fragment key={s}>
            {i > 0 ? " · " : ""}
            <span className={`badge ${STATUS[s].badge}`}>{STATUS[s].label}</span> {STATUS[s].hint}
          </Fragment>
        ))}
      </p>

      {error && <p className="error">{error}</p>}
      {notice && <p className="hint">{notice}</p>}

      {appFilter && (
        <div className="actions" style={{ alignItems: "center", marginBottom: "0.4rem" }}>
          <span className="mono">
            Showing emails for{" "}
            <b>{appFilterRow ? `${appFilterRow.company_name} — ${appFilterRow.role_name}` : appFilter}</b>
          </span>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              params.delete("app");
              setParams(params);
            }}
          >
            Show all
          </button>
        </div>
      )}

      <input
        className="search search-lg"
        placeholder="Search company, role, subject, sender…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="actions" style={{ marginTop: "0.4rem", marginBottom: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className={`btn small${statusFilter === "" ? " primary" : ""}`}
          onClick={() => setStatusFilter("")}
        >
          All ({baseRows.length})
        </button>
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={`btn small${statusFilter === s ? " primary" : ""}`}
            onClick={() => setStatusFilter(s)}
          >
            {STATUS[s].label} ({counts[s]})
          </button>
        ))}
      </div>

      <div className="actions" style={{ marginBottom: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
        {profileOptions.length > 0 && (
          <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            Profile
            <select value={profileFilter} onChange={(e) => setProfileFilter(e.target.value)}>
              <option value="">All</option>
              {profileOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
          <input type="checkbox" checked={hideHandled} onChange={(e) => setHideHandled(e.target.checked)} />
          Hide done
        </label>
        <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
          <input type="checkbox" checked={hideMaybe} onChange={(e) => setHideMaybe(e.target.checked)} />
          Hide maybes
        </label>
        <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
          <input type="checkbox" checked={hideRejections} onChange={(e) => setHideRejections(e.target.checked)} />
          Hide rejections
        </label>
        {isAdmin && (
          <button
            type="button"
            className="btn small"
            onClick={() => void rematch()}
            title="Run matching again on rows nobody has decided yet (e.g. after adding applications or fixing a profile email)"
          >
            Re-run matching
          </button>
        )}
      </div>

      {loaded && rows.length === 0 ? (
        <div className="card" style={{ padding: "1rem" }}>
          <p className="sub" style={{ margin: 0 }}>
            No interview emails yet. They appear here once the Slack triage bot is running with TRYVERA_URL and
            TRYVERA_INGEST_TOKEN set.
          </p>
        </div>
      ) : (
        <div className="card logs-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Email: company / role</th>
                <th>Type</th>
                <th>Asked</th>
                <th>Profile</th>
                <th>Application</th>
                <th>Status</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <Fragment key={r.id}>
                  <tr className={r.verdict === "MAYBE" ? "interview-maybe" : undefined}>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {formatDateTimeJst(r.received_at)}
                    </td>
                    <td>
                      <b className="logs-cell-clamp" title={r.company}>
                        {r.company || "—"}
                      </b>
                      <div className="sub logs-cell-clamp" title={r.role}>
                        {r.role || "—"}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${kindBadge(r.kind, r.verdict)}`}>{kindLabel(r.kind, r.verdict)}</span>
                      <HandledToggle row={r} busy={busyId === r.id} onPatch={(b) => void patch(r, b)} />
                    </td>
                    <td style={{ minWidth: "220px" }}>
                      <span className="logs-cell-clamp" title={`${r.asked}\n\n${r.reason}`}>
                        {r.asked || r.reason || "—"}
                      </span>
                      {r.deadline && (
                        <div className="sub" style={{ fontSize: "0.76rem" }}>
                          Due: {r.deadline}
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: "0.78rem", whiteSpace: "nowrap" }} title={r.to}>
                      {r.profile_ids.length ? (
                        r.profile_ids.map((p) => <div key={p}>{p}</div>)
                      ) : (
                        <span className="sub">{r.to_addr || "—"}</span>
                      )}
                    </td>
                    <td style={{ minWidth: "220px" }}>
                      {r.application ? (
                        <>
                          <Link to={`/result/${encodeURIComponent(r.application.id)}`} className="logs-cell-clamp">
                            {r.application.company_name} — {r.application.role_name}
                          </Link>
                          <div className="sub" style={{ fontSize: "0.74rem" }}>
                            {r.application.resume_profile} · applied {formatDateTimeJst(r.application.created_at).slice(0, 10)}
                          </div>
                        </>
                      ) : r.application_id ? (
                        <span className="sub" title="Linked to an application created by another user">
                          Another user's application
                        </span>
                      ) : (
                        <span className="sub">—</span>
                      )}
                      {r.match_status !== "confirmed" && r.match_note && (
                        <div className="sub" style={{ fontSize: "0.74rem" }}>
                          {r.match_note}
                        </div>
                      )}
                    </td>
                    <td style={{ minWidth: "190px" }}>
                      <span
                        className={`badge ${STATUS[r.match_status].badge}`}
                        title={r.status_by ? `${STATUS[r.match_status].hint}\nSet by ${r.status_by}` : STATUS[r.match_status].hint}
                      >
                        {STATUS[r.match_status].label}
                      </span>
                      <div className="logs-actions-cell" style={{ marginTop: "0.3rem", flexWrap: "wrap" }}>
                        <RowActions
                          row={r}
                          busy={busyId === r.id}
                          onPatch={(b) => void patch(r, b)}
                          onPick={() => setPickerId(pickerId === r.id ? null : r.id)}
                          picking={pickerId === r.id}
                        />
                      </div>
                    </td>
                    <td>
                      {r.permalink ? (
                        <a href={r.permalink} target="_blank" rel="noreferrer" title={r.subject}>
                          Open
                        </a>
                      ) : (
                        <span className="sub">—</span>
                      )}
                    </td>
                  </tr>
                  {pickerId === r.id && (
                    <tr>
                      <td colSpan={8}>
                        <CandidatePicker
                          row={r}
                          busy={busyId === r.id}
                          onPick={(appId) => void patch(r, { application_id: appId })}
                          onClose={() => setPickerId(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="actions" style={{ marginTop: "0.65rem" }}>
          <button type="button" className="btn small" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
            Prev
          </button>
          <span className="mono">
            Page {safePage} / {totalPages}
          </span>
          <button
            type="button"
            className="btn small"
            disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Done / Reopen. For emails with a Slack card, the bot applies the click to
 * the card within a few seconds; until then the row says it is syncing.
 */
function HandledToggle({
  row,
  busy,
  onPatch,
}: {
  row: InterviewEvent;
  busy: boolean;
  onPatch: (body: Parameters<typeof api.updateInterview>[1]) => void;
}) {
  // A rejection asks nothing of anyone; there is nothing to mark done.
  if (row.verdict === "REJECTION") return null;
  const who = row.handled_by ? `by ${row.handled_by}` : "in Slack";
  return (
    <div className="sub" style={{ fontSize: "0.74rem", marginTop: "0.25rem", display: "flex", gap: "0.35rem", alignItems: "center" }}>
      {row.handled ? <span title={row.handled_at}>✓ done {who}</span> : null}
      <button
        type="button"
        className="btn small"
        disabled={busy}
        onClick={() => onPatch({ handled: !row.handled })}
        title={row.handled ? "Reopen here and on the Slack card" : "Mark done here and on the Slack card"}
      >
        {row.handled ? "Reopen" : "Done"}
      </button>
      {row.handled_pending ? <span title="Waiting for the triage bot to update the Slack card">syncing…</span> : null}
    </div>
  );
}

function RowActions({
  row,
  busy,
  picking,
  onPatch,
  onPick,
}: {
  row: InterviewEvent;
  busy: boolean;
  picking: boolean;
  onPatch: (body: Parameters<typeof api.updateInterview>[1]) => void;
  onPick: () => void;
}) {
  const s = row.match_status;
  const pickLabel = picking ? "Close" : row.application_id ? "Change" : "Pick application";
  return (
    <>
      {s === "auto_matched" && (
        <button type="button" className="btn small primary" disabled={busy} onClick={() => onPatch({ match_status: "confirmed" })}>
          Confirm
        </button>
      )}
      {(s === "auto_matched" || s === "needs_check" || s === "confirmed") && (
        <button type="button" className="btn small" disabled={busy} onClick={onPick}>
          {pickLabel}
        </button>
      )}
      {(s === "auto_matched" || s === "needs_check") && (
        <>
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() => onPatch({ match_status: "not_from_tryvera" })}
            title={STATUS.not_from_tryvera.hint}
          >
            Not from Tryvera
          </button>
          <button
            type="button"
            className="btn small"
            disabled={busy}
            onClick={() => onPatch({ match_status: "ignored" })}
            title={STATUS.ignored.hint}
          >
            Ignore
          </button>
        </>
      )}
      {(s === "confirmed" || s === "not_from_tryvera" || s === "ignored") && (
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() => onPatch({ match_status: "needs_check" })}
          title="Back to Needs check, with no link. Automatic matching leaves it alone from now on, so it can't re-pick the link you just removed."
        >
          Undo
        </button>
      )}
    </>
  );
}

function CandidatePicker({
  row,
  busy,
  onPick,
  onClose,
}: {
  row: InterviewEvent;
  busy: boolean;
  onPick: (appId: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api
        .interviewCandidates(row.id, q)
        .then((r) => {
          if (!live) return;
          setErr(null);
          setItems(r.candidates);
        })
        .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    }, q ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [row.id, q]);

  return (
    <div style={{ padding: "0.4rem 0.2rem" }}>
      <div className="actions" style={{ alignItems: "center", marginBottom: "0.4rem" }}>
        <input
          className="search"
          autoFocus
          placeholder={`Search this profile's applications (showing ${row.company || "same company"})`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, marginBottom: 0 }}
        />
        <button type="button" className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      {err && <p className="error">{err}</p>}
      {items === null ? (
        <p className="sub">Loading…</p>
      ) : items.length === 0 ? (
        <p className="sub">
          {q ? "No application matches that search." : "No application to this company. Search by another name, or mark it Not from Tryvera."}
        </p>
      ) : (
        <table>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td style={{ width: "1.5rem" }} title={c.suggested ? "Suggested by the matcher" : undefined}>
                  {c.suggested ? "★" : ""}
                </td>
                <td>
                  <b>{c.company_name}</b> — {c.role_name}
                </td>
                <td className="mono" style={{ fontSize: "0.78rem" }}>
                  {c.resume_profile}
                </td>
                <td className="mono" style={{ fontSize: "0.78rem" }}>
                  {formatDateTimeJst(c.created_at)}
                </td>
                <td>
                  {c.job_link ? (
                    <a href={c.job_link} target="_blank" rel="noreferrer">
                      posting
                    </a>
                  ) : null}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn small primary"
                    disabled={busy || c.id === row.application_id}
                    onClick={() => onPick(c.id)}
                  >
                    {c.id === row.application_id ? "Linked" : "Link"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
