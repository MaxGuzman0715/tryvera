import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { InterviewAppSummary, InterviewEvent, InterviewMatchStatus } from "../types";
import { useAuth } from "../auth/AuthContext";
import { IconInbox } from "../../ui/icons";
import { kindLabel } from "../interviewLabels";
import { useOnChange, usePersistentState, useScrollRestore } from "../viewState";
import { refreshInterviewCounts } from "../useInterviewCounts";
import {
  anchorOf,
  countBy,
  dateMatches,
  FilterBar,
  InfoButton,
  PageSwitch,
  Popover,
  QuickViews,
  type FilterDef,
  type FilterValues,
  ConfirmDialog,
  SelectionBar,
  TickBox,
  TrashIcon,
  Pager,
} from "../components/ListControls";


/** Plain words for the match states, and what each asks of you. */
const STATUS: Record<InterviewMatchStatus, { label: string; tone: string; hint: string }> = {
  needs_check: { label: "Needs check", tone: "pending", hint: "No application, or several equally likely. Pick one." },
  auto_matched: { label: "Auto-matched", tone: "sched", hint: "Linked automatically. Confirm it, or pick another." },
  confirmed: { label: "Confirmed", tone: "offer", hint: "The linked application was checked by a person." },
  not_from_tryvera: { label: "Not from Tryvera", tone: "closed", hint: "A real interview, from an application made elsewhere." },
  ignored: { label: "Ignored", tone: "closed", hint: "Not a real interview (a misread email)." },
};
const STATUS_ORDER: InterviewMatchStatus[] = ["needs_check", "auto_matched", "confirmed", "not_from_tryvera", "ignored"];

/** Email type, with MAYBE and rejections as their own kinds. */
const typeOf = (r: InterviewEvent) => (r.verdict === "REJECTION" ? "REJECTION" : r.verdict === "MAYBE" ? "MAYBE" : r.kind || "OTHER");
const TYPE_TONE: Record<string, string> = {
  SCHEDULING: "sched", RESCHEDULE: "sched", NEXT_ROUND: "offer", ASSESSMENT: "wait", OFFER: "offer",
  REJECTION: "rejected", MAYBE: "closed",
};

const etDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
const etWhen = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
/** "hansal_maniar_ai" → "Hansal Maniar": who the inbox belongs to. */
const personLabel = (r: InterviewEvent) => {
  const id = (r.profile_ids[0] ?? r.to_addr ?? "").replace(/_(ai|swe)$/i, "");
  return id.includes("@") ? id : id.split(/[_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};

/** Why an email is in "Needs your attention" (decided on the server, same as the sidebar badge). */
const WHY: Record<string, { label: string; hint: string }> = {
  not_placed: { label: "Not on the schedule", hint: "A scheduling email that names no company, so it couldn’t be placed on a row. Add the interview by hand, or Ignore it." },
  asks: { label: "Asks you something", hint: "Documents, answers, a test or an offer: the schedule doesn’t track these. Mark done once handled." },
};

type EmailMap = Awaited<ReturnType<typeof api.scheduleEmailMap>>;
type Candidate = InterviewAppSummary & { suggested: boolean };
type MenuPop = { rowId: string; x: number; y: number; top: number };

export default function Interviews() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const appFilter = params.get("app") ?? "";
  const [rows, setRows] = useState<InterviewEvent[]>([]);
  const [map, setMap] = useState<EmailMap>({ placed: {}, attention: {}, attention_days: 7 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The last Remove (one email or many), so it can be undone in one click.
  const [removed, setRemoved] = useState<InterviewEvent[] | null>(null);
  // Ticked emails, and the ones waiting on "are you sure?".
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Remembered for this tab, so opening an application and coming back keeps the view.
  const [q, setQ] = usePersistentState("interviews:q", "");
  const [quick, setQuick] = usePersistentState("interviews:quick", "attention");
  const [filtersRaw, setFilters] = usePersistentState<FilterValues>("interviews:filters", {});
  const filters: FilterValues = filtersRaw && typeof filtersRaw === "object" && !Array.isArray(filtersRaw) ? filtersRaw : {};
  const [sort, setSort] = usePersistentState("interviews:sort", "newest");
  const [page, setPage] = usePersistentState("interviews:page", 1);
  const [pageSizeRaw, setPageSize] = usePersistentState("interviews:pageSize", 50);
  const PAGE_SIZE = [25, 50, 100].includes(pageSizeRaw) ? pageSizeRaw : 50;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuPop | null>(null);

  async function reload() {
    const [r, m] = await Promise.all([api.listInterviews(), api.scheduleEmailMap().catch(() => null)]);
    setRows(r.interviews);
    if (m) setMap(m);
    setLoaded(true);
  }

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // A link can open a given view (?view=attention); the choice is then remembered as usual.
  const viewParam = params.get("view");
  useEffect(() => {
    if (!viewParam) return;
    setQuick(viewParam);
    params.delete("view");
    setParams(params, { replace: true });
  }, [viewParam]); // eslint-disable-line react-hooks/exhaustive-deps

  // While a Done/Reopen is on its way to Slack, refresh until the bot confirms it.
  const anyPending = rows.some((r) => r.handled_pending);
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => void reload().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [anyPending]);

  // The actions menu closes on Escape or a click elsewhere.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".sc-pop, [data-pop-anchor]")) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menu]);

  /* ---------- filters ---------- */
  const facets = (r: InterviewEvent) => ({
    person: r.to_addr || "unknown",
    type: typeOf(r),
    done: r.verdict === "REJECTION" ? "none" : r.handled ? "done" : "open",
    linked: r.application_id ? "linked" : "unlinked",
  });

  const afterFilters = useMemo(() => {
    const s = q.trim().toLowerCase();
    const todayEt = etDay(new Date().toISOString());
    return rows.filter((r) => {
      if (appFilter && r.application_id !== appFilter) return false;
      if (s && ![r.company, r.role, r.subject, r.sender, r.asked, r.application?.company_name, r.application?.role_name]
        .some((v) => String(v ?? "").toLowerCase().includes(s))) return false;
      const f = facets(r);
      for (const [key, sel] of Object.entries(filters)) {
        if (!sel?.length) continue;
        if (key === "date") { if (!sel.some((v) => dateMatches(etDay(r.received_at), v, todayEt))) return false; continue; }
        if (!sel.includes(f[key as keyof typeof f])) return false;
      }
      return true;
    });
  }, [rows, q, filters, appFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const quickKey = quick === "all" || quick === "attention" || quick in STATUS ? quick : "attention";
  const quickViews = [
    { key: "attention", label: "Needs your attention", count: afterFilters.filter((r) => map.attention[r.id]).length, tone: "pending" as const },
    { key: "all", label: "All emails", count: afterFilters.length },
    ...STATUS_ORDER.map((s) => ({
      key: s,
      label: STATUS[s].label,
      count: afterFilters.filter((r) => r.match_status === s).length,
      tone: (s === "needs_check" ? "pending" : s === "auto_matched" ? "sched" : s === "confirmed" ? "ok" : "muted") as "pending" | "sched" | "ok" | "muted",
    })),
  ];

  const filterDefs: FilterDef[] = useMemo(() => {
    const n = (k: "person" | "type" | "done" | "linked") => countBy(rows, (r) => facets(r)[k]);
    const people = n("person");
    const labelFor = new Map(rows.map((r) => [r.to_addr || "unknown", personLabel(r)]));
    const types = n("type");
    const done = n("done");
    const linked = n("linked");
    const TYPES = ["SCHEDULING", "RESCHEDULE", "NEXT_ROUND", "ASSESSMENT", "SCREENING_QUESTION", "DOCUMENT_REQUEST", "OFFER", "OTHER", "MAYBE", "REJECTION"];
    return [
      { key: "person", label: "Person", kind: "multi", options: [...people.keys()].sort().map((k) => ({ value: k, label: labelFor.get(k) ?? k, count: people.get(k) })) },
      { key: "type", label: "Type", kind: "multi", options: TYPES.filter((t) => types.has(t)).map((t) => ({ value: t, label: t === "REJECTION" ? "Rejection" : kindLabel(t, t === "MAYBE" ? "MAYBE" : "ACTION"), count: types.get(t) })) },
      { key: "date", label: "Received", kind: "date" },
      { key: "done", label: "Done", kind: "multi", options: [{ value: "open", label: "Still open", count: done.get("open") ?? 0 }, { value: "done", label: "Done", count: done.get("done") ?? 0 }] },
      { key: "linked", label: "Application", kind: "multi", options: [{ value: "linked", label: "Linked to one", count: linked.get("linked") ?? 0 }, { value: "unlinked", label: "Not linked", count: linked.get("unlinked") ?? 0 }] },
    ];
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const out =
      quickKey === "all" ? [...afterFilters]
      : quickKey === "attention" ? afterFilters.filter((r) => map.attention[r.id])
      : afterFilters.filter((r) => r.match_status === quickKey);
    if (sort === "oldest") out.sort((a, b) => a.received_at.localeCompare(b.received_at));
    else if (sort === "company") out.sort((a, b) => a.company.localeCompare(b.company) || b.received_at.localeCompare(a.received_at));
    else out.sort((a, b) => b.received_at.localeCompare(a.received_at));
    // Emails nothing else will surface go first: only you can place them.
    if (quickKey === "attention") out.sort((a, b) => Number(map.attention[b.id] === "not_placed") - Number(map.attention[a.id] === "not_placed"));
    return out;
  }, [afterFilters, quickKey, sort, map]);

  useOnChange([q, quickKey, filters, sort, appFilter, PAGE_SIZE], () => setPage(1));

  // Only emails in the current view count as ticked: switching view never acts on hidden ones.
  const tickedShown = visible.filter((r) => ticked.has(r.id));
  const allTicked = visible.length > 0 && tickedShown.length === visible.length;
  const tick = (id: string, on: boolean) => setTicked((cur) => { const n = new Set(cur); if (on) n.add(id); else n.delete(id); return n; });
  useScrollRestore("interviews", loaded);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  async function patch(row: InterviewEvent, body: Parameters<typeof api.updateInterview>[1]): Promise<void> {
    setBusyId(row.id);
    setError(null);
    setMenu(null);
    try {
      const r = await api.updateInterview(row.id, body);
      setRows((prev) => prev.map((x) => (x.id === row.id ? r.interview : x)));
      setPickerId(null);
      // Done / Ignore / a new link can move it in or out of the attention list.
      api.scheduleEmailMap().then(setMap).catch(() => {});
      refreshInterviewCounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  /** Each email as it was, so Undo restores its status and its link exactly. */
  const restoreBody = (r: InterviewEvent): Parameters<typeof api.updateInterview>[1] => ({
    match_status: r.match_status,
    ...(r.application_id ? { application_id: r.application_id } : {}),
  });

  /** Apply one change to many emails, then refresh once. */
  async function bulk(list: InterviewEvent[], body: (r: InterviewEvent) => Parameters<typeof api.updateInterview>[1]): Promise<boolean> {
    setBulkBusy(true);
    setError(null);
    setMenu(null);
    try {
      for (const r of list) await api.updateInterview(r.id, body(r));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      await reload().catch(() => {});
      refreshInterviewCounts();
      setBulkBusy(false);
    }
  }

  async function removeEmails(ids: string[]) {
    setConfirm(null);
    const list = rows.filter((r) => ids.includes(r.id) && r.match_status !== "ignored");
    if (await bulk(list, () => ({ match_status: "ignored" }))) {
      setRemoved(list);
      setTicked(new Set());
    }
  }

  async function undoRemove() {
    const list = removed ?? [];
    if (await bulk(list, restoreBody)) setRemoved(null);
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
  const menuRow = menu ? rows.find((r) => r.id === menu.rowId) ?? null : null;

  return (
    <div className="sc">
      <PageSwitch />
      <header className="sc-head">
        <div>
          <h1>
            <IconInbox />
            Inbox
          </h1>
          <p className="sub">
            {quickKey === "attention"
              ? `What the schedule can’t show you: requests from the last ${map.attention_days} days (documents, questions, tests), and scheduling emails it couldn’t place. Mark one done once handled and it leaves this list. Your interviews live on the Schedule.`
              : "Every hiring email the Slack bot flagged, linked to the application it came from. Times in ET. Click a status to change it."}
          </p>
        </div>
        <div className="sc-actions">
          {isAdmin && (
            <button className="sc-btn" type="button" onClick={() => void rematch()}
              title="Run matching again on rows nobody has decided yet (e.g. after adding applications or fixing a profile email)">
              Re-run matching
            </button>
          )}
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {notice && <p className="dim">{notice}</p>}
      {removed && (
        <p className="dim sc-undo-note">
          {removed.length === 1 ? `Removed “${removed[0].subject || removed[0].company}”.` : `Removed ${removed.length} emails.`} They’re under Ignored if you need them.
          <button className="sc-btn sm" type="button" disabled={bulkBusy} onClick={() => void undoRemove()}>Undo</button>
        </p>
      )}

      {appFilter && (
        <div className="sc-chipbar">
          <button type="button" className="sc-fchip" onClick={() => { params.delete("app"); setParams(params); }}>
            Application: {appFilterRow ? `${appFilterRow.company_name} — ${appFilterRow.role_name}` : appFilter} <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      <QuickViews
        views={quickViews}
        value={quickKey}
        onChange={setQuick}
        right={
          <InfoButton label="What these mean">
            <div className="sc-legend col">
              {STATUS_ORDER.map((s) => (
                <span key={s}><span className={`sc-pill static ${STATUS[s].tone}`}>{STATUS[s].label}</span>{STATUS[s].hint}</span>
              ))}
            </div>
          </InfoButton>
        }
      />

      <FilterBar
        search={q}
        onSearch={setQ}
        placeholder="Search company, role, subject or sender"
        defs={filterDefs}
        values={filters}
        onChange={setFilters}
        right={
          <label className="sc-field">Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="company">Company A–Z</option>
            </select>
          </label>
        }
      />

      <SelectionBar count={tickedShown.length} onClear={() => setTicked(new Set())}>
        {tickedShown.some((r) => r.match_status !== "ignored") && (
          <button className="sc-btn sm danger" type="button" disabled={bulkBusy} onClick={() => setConfirm(tickedShown.map((r) => r.id))}>
            <TrashIcon /> Remove {tickedShown.filter((r) => r.match_status !== "ignored").length}
          </button>
        )}
        {tickedShown.some((r) => !r.handled && r.verdict !== "REJECTION") && (
          <button className="sc-btn sm" type="button" disabled={bulkBusy}
            onClick={() => void bulk(tickedShown.filter((r) => !r.handled && r.verdict !== "REJECTION"), () => ({ handled: true })).then((ok) => ok && setTicked(new Set()))}>
            Mark {tickedShown.filter((r) => !r.handled && r.verdict !== "REJECTION").length} done
          </button>
        )}
        {tickedShown.some((r) => r.match_status === "ignored") && (
          <button className="sc-btn sm" type="button" disabled={bulkBusy}
            onClick={() => void bulk(tickedShown.filter((r) => r.match_status === "ignored"), () => ({ match_status: "needs_check" })).then((ok) => ok && setTicked(new Set()))}>
            Put {tickedShown.filter((r) => r.match_status === "ignored").length} back
          </button>
        )}
        {bulkBusy && <span className="dim small">Working…</span>}
      </SelectionBar>

      {confirm && (
        <ConfirmDialog
          title={`Remove ${confirm.length === 1 ? "this email" : `${confirm.length} emails`}?`}
          names={rows.filter((r) => confirm.includes(r.id) && r.match_status !== "ignored").map((r) => `${r.company || "—"} · ${r.subject}`)}
          note="Use this for emails that aren’t real hiring emails. They leave the inbox and the schedule. Nothing is deleted: they move to Ignored, and Undo puts them back exactly as they were."
          confirmLabel={`Remove ${rows.filter((r) => confirm.includes(r.id) && r.match_status !== "ignored").length}`}
          busy={bulkBusy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void removeEmails(confirm)}
        />
      )}

      <div className="sc-card sc-table-wrap">
        <table className="sc-table">
          <thead>
            <tr>
              <th className="sc-tickcell"><TickBox checked={allTicked} some={tickedShown.length > 0} onChange={(on) => setTicked(on ? new Set(visible.map((r) => r.id)) : new Set())} label={`Tick all ${visible.length} in this view`} /></th>
              <th>Received</th><th>Email</th><th>Type</th><th>What they asked</th><th>Person</th><th>Application</th><th>Status</th></tr>
          </thead>
          <tbody>
            {!loaded ? (
              <tr><td colSpan={8} className="sc-empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="sc-empty">No interview emails yet. They appear once the Slack triage bot runs with TRYVERA_URL and TRYVERA_INGEST_TOKEN set.</td></tr>
            ) : pageRows.length === 0 ? (
              <tr><td colSpan={8} className="sc-empty">
                {quickKey === "attention" ? "All caught up: nothing needs your attention. Your interviews are on the Schedule." : "Nothing here. Try another quick view, or clear the filters."}
              </td></tr>
            ) : pageRows.map((r) => {
              const t = typeOf(r);
              return (
                <Fragment key={r.id}>
                  <tr className={[r.verdict === "MAYBE" ? "dimmed" : "", ticked.has(r.id) ? "is-ticked" : ""].join(" ").trim() || undefined}>
                    <td className="sc-tickcell">
                      <TickBox checked={ticked.has(r.id)} onChange={(on) => tick(r.id, on)} label={`Tick ${r.company || r.subject}`} />
                      {r.match_status !== "ignored" ? (
                        <button className="sc-trash" type="button" disabled={bulkBusy || busyId === r.id} aria-label="Remove this email"
                          title="Not a real hiring email? Remove it from the inbox and the schedule (asks first; can be undone)"
                          onClick={() => setConfirm([r.id])}>
                          <TrashIcon />
                        </button>
                      ) : (
                        <button className="sc-trash put" type="button" disabled={bulkBusy || busyId === r.id} aria-label="Put this email back" title="Put back (Needs check)"
                          onClick={() => void patch(r, { match_status: "needs_check" })}>↩</button>
                      )}
                    </td>
                    <td className="sc-when">{etWhen(r.received_at)}</td>
                    <td>
                      <span className="sc-co static"><span className="co">{r.company || map.placed[r.id]?.company || "—"}</span><span className="role">{r.role || "—"}</span></span>
                      {map.attention[r.id] && (
                        <span className={`sc-why ${map.attention[r.id]}`} title={WHY[map.attention[r.id]].hint}>{WHY[map.attention[r.id]].label}</span>
                      )}
                      <span className="sc-contact" title={r.subject}>
                        {r.permalink ? <a href={r.permalink} target="_blank" rel="noreferrer">{r.subject || "Open email"}</a> : r.subject}
                      </span>
                    </td>
                    <td><span className={`sc-pill static ${TYPE_TONE[t] ?? "pending"}`}>{t === "REJECTION" ? "Rejected" : kindLabel(r.kind, r.verdict)}</span></td>
                    <td className="sc-asked">
                      <span title={`${r.asked}\n\n${r.reason}`}>{r.asked || r.reason || "—"}</span>
                      {r.meeting_date && (
                        <small className="sc-meeting">
                          Interview: {new Date(`${r.meeting_date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                          {r.meeting_time ? ` · ${Number(r.meeting_time.slice(0, 2)) % 12 || 12}:${r.meeting_time.slice(3)} ${Number(r.meeting_time.slice(0, 2)) >= 12 ? "PM" : "AM"}` : ""}
                        </small>
                      )}
                      {r.deadline && <small>Due: {r.deadline}</small>}
                    </td>
                    <td><span className="sc-person">{personLabel(r)}</span></td>
                    <td className="sc-app">
                      {r.application ? (
                        <>
                          <Link to={`/result/${encodeURIComponent(r.application.id)}`}>{r.application.company_name} — {r.application.role_name}</Link>
                          <small>{r.application.resume_profile} · applied {etDay(r.application.created_at)}</small>
                        </>
                      ) : r.application_id ? (
                        <span className="dim" title="Linked to an application created by another user">Another user’s application</span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                      {r.match_status !== "confirmed" && r.match_note && <small>{r.match_note}</small>}
                      {map.placed[r.id] && (
                        <Link className="sc-onsched" to={`/schedule?row=${encodeURIComponent(map.placed[r.id].row)}`} title="Open this interview on the Schedule">
                          On the schedule →
                        </Link>
                      )}
                    </td>
                    <td className="sc-status-cell">
                      <button className={`sc-pill ${STATUS[r.match_status].tone}`} type="button" data-pop-anchor aria-haspopup="dialog"
                        title={r.status_by ? `${STATUS[r.match_status].hint}\nSet by ${r.status_by}` : STATUS[r.match_status].hint}
                        onClick={(e) => setMenu({ rowId: r.id, ...anchorOf(e.currentTarget) })}>
                        {STATUS[r.match_status].label}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                      <div className="sc-row-actions">
                        {r.match_status === "auto_matched" && (
                          <button className="sc-btn sm primary" type="button" disabled={busyId === r.id} onClick={() => void patch(r, { match_status: "confirmed" })}>Confirm</button>
                        )}
                        {r.match_status === "needs_check" && (
                          <button className="sc-btn sm" type="button" disabled={busyId === r.id} onClick={() => setPickerId(pickerId === r.id ? null : r.id)}>
                            {pickerId === r.id ? "Close" : "Pick application"}
                          </button>
                        )}
                        {r.verdict !== "REJECTION" && (
                          <button className={`sc-done ${r.handled ? "on" : ""}`} type="button" disabled={busyId === r.id}
                            onClick={() => void patch(r, { handled: !r.handled })}
                            title={r.handled ? `Done${r.handled_by ? ` by ${r.handled_by}` : " in Slack"}. Click to reopen here and on the Slack card.` : "Mark done here and on the Slack card"}>
                            {r.handled ? "✓ Done" : "Mark done"}
                          </button>
                        )}
                        {r.handled_pending && <span className="dim small" title="Waiting for the triage bot to update the Slack card">syncing…</span>}
                      </div>
                    </td>
                  </tr>
                  {pickerId === r.id && (
                    <tr className="sc-picker-row">
                      <td colSpan={8}>
                        <CandidatePicker row={r} busy={busyId === r.id} onPick={(appId) => void patch(r, { application_id: appId })} onClose={() => setPickerId(null)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pager page={safePage} pageSize={PAGE_SIZE} total={visible.length} noun="emails"
        onPage={(n) => { setPage(n); window.scrollTo({ top: 0, behavior: "smooth" }); }} onPageSize={setPageSize} />

      {menu && menuRow && (
        <Popover pop={menu} layoutKey={menuRow.id}>
          <div className="sc-menu">
            <div><h3>{menuRow.company || "This email"}</h3><div className="sub">{STATUS[menuRow.match_status].hint}</div></div>
            <div className="sc-menu-list">
              {menuRow.application_id && menuRow.match_status !== "confirmed" && (
                <button type="button" onClick={() => void patch(menuRow, { match_status: "confirmed" })}><b>Confirm</b> the linked application</button>
              )}
              {menuRow.match_status !== "ignored" && menuRow.match_status !== "not_from_tryvera" && (
                <button type="button" onClick={() => { setMenu(null); setPickerId(menuRow.id); }}>
                  <b>{menuRow.application_id ? "Change" : "Pick"} application…</b>
                </button>
              )}
              {menuRow.match_status !== "not_from_tryvera" && (
                <button type="button" onClick={() => void patch(menuRow, { match_status: "not_from_tryvera" })}><b>Not from Tryvera</b> (applied elsewhere)</button>
              )}
              {menuRow.match_status !== "ignored" && (
                <button type="button" onClick={() => void patch(menuRow, { match_status: "ignored" })}><b>Ignore</b> (not a real interview)</button>
              )}
              {menuRow.match_status !== "needs_check" && menuRow.match_status !== "auto_matched" && (
                <button type="button" onClick={() => void patch(menuRow, { match_status: "needs_check" })}><b>Undo</b> (back to Needs check, no link)</button>
              )}
              {menuRow.verdict !== "REJECTION" && (
                <button type="button" onClick={() => void patch(menuRow, { handled: !menuRow.handled })}>
                  <b>{menuRow.handled ? "Reopen" : "Mark done"}</b> (here and on the Slack card)
                </button>
              )}
              {menuRow.permalink && <a href={menuRow.permalink} target="_blank" rel="noreferrer"><b>Open the email</b> in Slack</a>}
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}

function CandidatePicker({ row, busy, onPick, onClose }: { row: InterviewEvent; busy: boolean; onPick: (appId: string) => void; onClose: () => void }) {
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
    <div className="sc-picker">
      <div className="sc-picker-head">
        <label className="sc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input autoFocus placeholder={`Search this person’s applications (showing ${row.company || "same company"})`} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="sc-btn sm" type="button" onClick={onClose}>Close</button>
      </div>
      {err && <p className="error">{err}</p>}
      {items === null ? (
        <p className="dim">Loading…</p>
      ) : items.length === 0 ? (
        <p className="dim">{q ? "No application matches that search." : "No application to this company. Search by another name, or mark it Not from Tryvera."}</p>
      ) : (
        <div className="sc-picker-list">
          {items.map((c) => (
            <div key={c.id} className="sc-picker-item">
              <span className="star" title={c.suggested ? "Suggested by the matcher" : undefined}>{c.suggested ? "★" : ""}</span>
              <span className="what"><b>{c.company_name}</b> — {c.role_name}</span>
              <span className="dim small">{c.resume_profile}</span>
              <span className="dim small">{etDay(c.created_at)}</span>
              {c.job_link ? <a href={c.job_link} target="_blank" rel="noreferrer" className="small">posting</a> : <span />}
              <button className="sc-btn sm primary" type="button" disabled={busy || c.id === row.application_id} onClick={() => onPick(c.id)}>
                {c.id === row.application_id ? "Linked" : "Link"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
