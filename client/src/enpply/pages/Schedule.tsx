import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import type { SchedRoundState, ScheduleResponse, ScheduleRow } from "../types";
import { useAuth } from "../auth/AuthContext";
import { useOnChange, usePersistentState, useScrollRestore } from "../viewState";
import { IconCalendar } from "../../ui/icons";
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
import {
  addDays,
  CLOSE_REASONS,
  DATED,
  deriveStatus,
  DOW,
  GROUP_ORDER,
  groupOf,
  isoDay,
  keyDate,
  MONTH_NAME,
  noWordDays,
  newChanges,
  headlineChange,
  CHANGE_LABEL,
  ago,
  parseDay,
  relativeDay,
  ROUNDS,
  sameDay,
  scheduleCsv,
  setRound,
  shortDay,
  startOfWeek,
  STATE_NAME,
  time12,
} from "../scheduleLogic";

type View = "week" | "month" | "hours";
type Pop =
  | { kind: "cell"; rowId: string; i: number; x: number; y: number; top: number; draft: { state: SchedRoundState; date: string; time: string } }
  | { kind: "status"; rowId: string; x: number; y: number; top: number };
type Toast = { msg: string; undo?: () => Promise<void> } | null;
/** Omit applied to each member of a union (plain Omit keeps only the shared keys). */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const Chevron = ({ dir }: { dir: "left" | "right" | "down" }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={dir === "left" ? "M15 18l-6-6 6-6" : dir === "right" ? "M9 18l6-6-6-6" : "M6 9l6 6 6-6"} />
  </svg>
);

/** On a weekend, open on the coming week: that's the one being planned. */
function defaultAnchor(todayIso: string): string {
  const t = parseDay(todayIso);
  const dow = t.getDay();
  return dow === 6 ? isoDay(addDays(t, 2)) : dow === 0 ? isoDay(addDays(t, 1)) : todayIso;
}

export default function Schedule() {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"add" | "import" | null>(null);
  // Ticked rows (for Remove selected), and the rows waiting on "are you sure?".
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ ids: string[]; removed: boolean } | null>(null);

  // Remembered for this tab: leave the page, come back, same view.
  const [person, setPerson] = usePersistentState("schedule:person", "all");
  const [viewRaw, setView] = usePersistentState<View>("schedule:view", "week");
  const [anchorRaw, setAnchor] = usePersistentState("schedule:anchor", "");
  // Remembered values from an older version of the page may not be valid any more.
  const view: View = (["week", "month", "hours"] as const).includes(viewRaw) ? viewRaw : "week";
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(anchorRaw) ? anchorRaw : "";
  const [q, setQ] = usePersistentState("schedule:q", "");
  const [quick, setQuick] = usePersistentState("schedule:quick", "active");
  const [filtersRaw, setFilters] = usePersistentState<FilterValues>("schedule:filters", {});
  const filters: FilterValues = filtersRaw && typeof filtersRaw === "object" && !Array.isArray(filtersRaw) ? filtersRaw : {};
  const [sort, setSort] = usePersistentState("schedule:sort", "date");
  const [calOpen, setCalOpen] = usePersistentState("schedule:calOpen", true);
  const [page, setPage] = usePersistentState("schedule:page", 1);
  const [pageSize, setPageSize] = usePersistentState("schedule:pageSize", 25);
  const tableRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api.getSchedule();
      setData(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    // New emails arrive all day: refresh when the tab comes back into view.
    const onVis = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reload]);
  useScrollRestore("schedule", data !== null);

  // Opened from the Inbox (?row=id): show that interview's details.
  const [params, setParams] = useSearchParams();
  const rowParam = params.get("row");
  useEffect(() => {
    if (!rowParam || !data) return;
    if (data.rows.some((r) => r.id === rowParam)) setDrawerId(rowParam);
    else setError("That interview isn’t on your schedule any more.");
    params.delete("row");
    setParams(params, { replace: true });
  }, [rowParam, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const today = data?.today ?? isoDay(new Date());
  const anchorIso = anchor || defaultAnchor(today);

  // A remembered person who no longer has rows falls back to everyone.
  const personKey = person !== "all" && data && !data.people.some((p) => p.key === person) ? "all" : person;
  const allInPerson = useMemo(
    () => (data?.rows ?? []).filter((r) => personKey === "all" || r.person === personKey),
    [data, personKey]
  );
  // Removed rows only show in the "Removed" view, where they can be put back.
  const inPerson = useMemo(() => allInPerson.filter((r) => !r.removed), [allInPerson]);
  const shownRows = useMemo(() => (data?.rows ?? []).filter((r) => !r.removed), [data]);

  const replaceRow = (row: ScheduleRow | null) => {
    if (!row) return void reload();
    setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.id === row.id ? row : r)) } : d));
  };

  const toastTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const showToast = (t: Toast) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 7000);
  };

  /** Every hand change goes through here: saved, reflected, undoable. */
  async function patch(row: ScheduleRow, body: Parameters<typeof api.updateScheduleRow>[1], msg: string) {
    setBusy(true);
    setPop(null);
    try {
      const r = await api.updateScheduleRow(row.id, body);
      replaceRow(r.row);
      showToast({
        msg,
        undo: async () => {
          setToast(null); // one undo per change: the button goes away at once
          setBusy(true);
          try {
            const u = await api.restoreScheduleRow(row.id, r.undo);
            replaceRow(u.row);
            showToast({ msg: "Undone." });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function roundsPatch(row: ScheduleRow, i: number, state: SchedRoundState, date = "", time = "") {
    const { rounds, changed } = setRound(row.rounds, i, state, date, time);
    const body: Parameters<typeof api.updateScheduleRow>[1] = {
      rounds: Object.fromEntries(changed.map((k) => [String(k), { state: rounds[k].state, date: rounds[k].date, time: rounds[k].time }])),
    };
    // Working on a closed row reopens it; anything but "passed" undoes an offer.
    if (row.closed) body.closed = null;
    if (row.offer && state !== "done") body.offer = false;
    return body;
  }

  const setCell = (row: ScheduleRow, i: number, state: SchedRoundState, date = "", time = "") =>
    patch(row, roundsPatch(row, i, state, date, time),
      `${row.company}: ${ROUNDS[i]} ${STATE_NAME[state].toLowerCase()}${DATED.includes(state) && date ? ` (${shortDay(date)}${time ? `, ${time12(time)}` : ""})` : ""}.`);

  const verdict = (row: ScheduleRow, i: number, pass: boolean) => {
    const x = row.rounds[i];
    return patch(row, roundsPatch(row, i, pass ? "done" : "failed", x.date, x.time),
      pass ? `${row.company}: ${ROUNDS[i]} passed.${i < 3 ? ` ${ROUNDS[i + 1]} is now Pending.` : " Waiting on the offer."}`
        : `${row.company}: ${ROUNDS[i]} failed. Moved to closed.`);
  };

  /** An assessment was submitted: mark its email done (here and on the Slack card), which closes it on the row. */
  async function taskDone(row: ScheduleRow) {
    if (!row.task) return;
    setBusy(true);
    setPop(null);
    try {
      await api.updateInterview(row.task.email_id, { handled: true });
      await reload();
      showToast({ msg: `${row.company}: assessment marked done.` });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Take a row off the schedule (a misread email, a duplicate), or put it back. Undoable; nothing is deleted. */
  function removeRow(row: ScheduleRow, removed: boolean) {
    if (removed) setDrawerId(null);
    return patch(row, { removed },
      removed ? `${row.company}: removed from the schedule. Find it under Removed.` : `${row.company}: back on the schedule.`);
  }

  function openPop(el: HTMLElement, p: DistOmit<Pop, "x" | "y" | "top">) {
    setPop({ ...p, ...anchorOf(el) } as Pop);
  }

  // Close popovers on Escape or a click elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirm) setConfirm(null);
      else if (pop) setPop(null);
      else if (modal) setModal(null);
      else setDrawerId(null);
    };
    const onDown = (e: MouseEvent) => {
      if (pop && !(e.target as HTMLElement).closest(".sc-pop, [data-pop-anchor]")) setPop(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [pop, modal, confirm]);

  /* ---------- filters ---------- */
  const facets = (r: ScheduleRow) => {
    const st = deriveStatus(r);
    return {
      status: st.kind,
      round: st.i !== undefined ? ROUNDS[st.i] : "none",
      source: [r.application_id ? "tryvera" : "other", r.id.startsWith("manual:") ? "manual" : r.from_sheet ? "sheet" : "email"],
      edited: r.rounds.some((x) => x.source === "manual") || r.note ? "edited" : "untouched",
    };
  };
  const passesFilters = (r: ScheduleRow) => {
    const s = q.trim().toLowerCase();
    if (s && !`${r.company} ${r.role} ${r.contact} ${r.note}`.toLowerCase().includes(s)) return false;
    const f = facets(r);
    for (const [key, sel] of Object.entries(filters)) {
      if (!sel?.length) continue;
      if (key === "date") { if (!sel.some((v) => dateMatches(keyDate(r), v, today))) return false; continue; }
      const have = f[key as keyof typeof f];
      const vals = Array.isArray(have) ? have : [have];
      if (!sel.some((v) => vals.includes(v))) return false;
    }
    return true;
  };
  const seenAt = data?.seen_at ?? "";
  const rowSeen = data?.row_seen ?? {};
  // A row's news is whatever changed after the LATER of the global "Mark all seen"
  // and that row's own mark, so clearing one row leaves the others New.
  const seenFor = (r: ScheduleRow) => {
    const own = rowSeen[r.id] ?? "";
    return own > seenAt ? own : seenAt;
  };
  const isNew = (r: ScheduleRow) => Boolean(seenAt) && newChanges(r, seenFor(r)).length > 0;
  const QUICK: Record<string, (r: ScheduleRow) => boolean> = {
    new: isNew,
    active: (r) => !deriveStatus(r).closed,
    wait: (r) => deriveStatus(r).kind === "wait",
    next7: (r) => groupOf(r, today) === "Next 7 days",
    later: (r) => groupOf(r, today) === "Later",
    ask: (r) => deriveStatus(r).kind === "ask",
    task: (r) => deriveStatus(r).kind === "task",
    waiting: (r) => groupOf(r, today) === "Waiting on them",
    offer: (r) => deriveStatus(r).kind === "offer",
    closed: (r) => Boolean(deriveStatus(r).closed),
    all: () => true,
  };
  // The Removed view only exists while something is removed.
  const quickKey = quick in QUICK || (quick === "removed" && allInPerson.some((r) => r.removed)) ? quick : "active";
  const inView = (k: string) => (r: ScheduleRow) => (k === "removed" ? Boolean(r.removed) : !r.removed && QUICK[k](r));
  const afterFilters = useMemo(() => allInPerson.filter(passesFilters), [allInPerson, q, filters, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const quickViews = [
    { key: "new", label: "New since you looked", tone: "sched" as const },
    { key: "active", label: "Active" },
    { key: "ask", label: "Needs scheduling", tone: "ask" as const },
    { key: "task", label: "Assessments", tone: "task" as const },
    { key: "wait", label: "Awaiting result", tone: "wait" as const },
    { key: "next7", label: "Next 7 days", tone: "sched" as const },
    { key: "later", label: "Later" },
    { key: "waiting", label: "Waiting on them", tone: "pending" as const },
    { key: "offer", label: "Offers", tone: "ok" as const },
    { key: "closed", label: "Closed", tone: "muted" as const },
    { key: "all", label: "Everything" },
    { key: "removed", label: "Removed", tone: "muted" as const },
  ]
    .map((v) => ({ ...v, count: afterFilters.filter(inView(v.key)).length }))
    .filter((v) => v.key !== "removed" || v.count > 0 || quickKey === "removed");

  const filterDefs: FilterDef[] = useMemo(() => {
    const c = <K extends "status" | "round" | "source" | "edited">(k: K) => countBy(inPerson, (r) => facets(r)[k] as string | string[]);
    const opts = (k: "status" | "round" | "source" | "edited", list: [string, string][]) => {
      const n = c(k);
      return list.map(([value, label]) => ({ value, label, count: n.get(value) ?? 0 }));
    };
    return [
      { key: "status", label: "Status", kind: "multi", options: opts("status", [["ask", "Needs scheduling"], ["task", "Assessment to do"], ["sched", "Scheduled"], ["wait", "Awaiting result"], ["pending", "Waiting on them"], ["offer", "Offer"], ["rejected", "Rejected"], ["closed", "Closed"]]) },
      { key: "round", label: "Round", kind: "multi", options: opts("round", [["Intro", "Intro"], ["HR", "HR"], ["Tech", "Tech"], ["Final", "Final"], ["none", "Not started"]]) },
      { key: "date", label: "Date", kind: "date", hint: "The current round’s date, or the last activity when nothing is booked." },
      { key: "source", label: "Source", kind: "multi", options: opts("source", [["tryvera", "Applied with Tryvera"], ["other", "Applied elsewhere"], ["sheet", "From your sheet"], ["email", "Found in email"], ["manual", "Added by hand"]]) },
      { key: "edited", label: "Changed", kind: "multi", options: opts("edited", [["edited", "Changed by hand"], ["untouched", "Untouched"]]) },
    ];
  }, [inPerson]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- table rows ---------- */
  const filtered = useMemo(() => {
    const out = afterFilters.filter(inView(quickKey));
    if (sort === "company") out.sort((a, b) => a.company.localeCompare(b.company));
    else if (sort === "activity") out.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
    else
      out.sort((a, b) => {
        const ga = groupOf(a, today);
        const byGroup = GROUP_ORDER.indexOf(ga) - GROUP_ORDER.indexOf(groupOf(b, today));
        if (byGroup) return byGroup;
        // Your moves: the newest ask first (the old ones have usually gone cold). The rest by date.
        return ga === "Needs scheduling" || ga === "Assessment to do" ? keyDate(b).localeCompare(keyDate(a)) : keyDate(a).localeCompare(keyDate(b));
      });
    // A group header goes before the first row of each group (date sort only).
    let last = "";
    return out.map((row) => {
      const g = sort === "date" ? groupOf(row, today) : "";
      const header = g && g !== last ? g : null;
      if (g) last = g;
      return { row, header };
    });
  }, [afterFilters, quickKey, sort, today]); // eslint-disable-line react-hooks/exhaustive-deps

  // One page at a time. A new view, filter or sort starts again at page 1.
  useOnChange([quickKey, filters, q, personKey, sort, pageSize], () => setPage(1));
  const size = [25, 50, 100].includes(pageSize) ? pageSize : 25;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const curPage = Math.min(Math.max(1, page), pages);
  const pageItems = useMemo(() => {
    const items = filtered.slice((curPage - 1) * size, curPage * size);
    // A page that starts mid-group still says which group it is.
    if (items[0] && !items[0].header && sort === "date") items[0] = { ...items[0], header: groupOf(items[0].row, today) };
    return items;
  }, [filtered, curPage, size, sort, today]);
  const goPage = (n: number) => {
    setPage(n);
    tableRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  // Only rows on this page count as ticked: changing page, view or filters never acts on hidden rows.
  const shownIds = pageItems.map((x) => x.row.id);
  const tickedShown = shownIds.filter((id) => ticked.has(id));
  const allTicked = shownIds.length > 0 && tickedShown.length === shownIds.length;
  const tick = (id: string, on: boolean) => setTicked((cur) => { const n = new Set(cur); if (on) n.add(id); else n.delete(id); return n; });
  const tickAll = (on: boolean) => setTicked(on ? new Set(shownIds) : new Set());

  /** Remove (or put back) the given rows, after "are you sure?". One Undo puts them all back. */
  async function bulkRemove(ids: string[], removed: boolean) {
    setBusy(true);
    setConfirm(null);
    try {
      const r = await api.bulkRemoveSchedule(ids, removed);
      setTicked(new Set());
      setDrawerId(null);
      await reload();
      showToast({
        msg: removed ? `Removed ${r.count} from the schedule. Find ${r.count === 1 ? "it" : "them"} under Removed.` : `Put ${r.count} back on the schedule.`,
        undo: async () => {
          setToast(null);
          setBusy(true);
          try {
            await api.bulkRestoreSchedule(r.undo);
            await reload();
            showToast({ msg: "Undone." });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const drawerRow = data?.rows.find((r) => r.id === drawerId) ?? null;
  const popRow = pop ? data?.rows.find((r) => r.id === pop.rowId) ?? null : null;

  const newCount = inPerson.filter(isNew).length;
  async function markSeen() {
    try {
      const r = await api.markScheduleSeen();
      setData((d) => (d ? { ...d, seen_at: r.seen_at } : d));
      if (quickKey === "new") setQuick("active");
      window.dispatchEvent(new Event("schedule-seen"));
      showToast({ msg: "All caught up. New changes will show here as they arrive." });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Clear ONE row's New badge (e.g. after moving its email to a label in Gmail). */
  async function markRowSeen(id: string) {
    const at = new Date().toISOString();
    setData((d) => (d ? { ...d, row_seen: { ...(d.row_seen ?? {}), [id]: at } } : d)); // instant
    try {
      await api.markScheduleRowSeen(id);
      window.dispatchEvent(new Event("schedule-seen")); // refresh the sidebar count
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function exportCsv() {
    const blob = new Blob([scheduleCsv(filtered.map((f) => f.row))], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `interview-schedule-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="sc">
      <PageSwitch />
      <header className="sc-head">
        <div>
          <h1>
            <IconCalendar />
            Interview schedule
          </h1>
          <p className="sub">One row per interview, filled in from emails. Times in ET. Click any status or round to change it.</p>
        </div>
        <div className="sc-actions">
          {newCount > 0 && (
            <button className="sc-btn new" type="button" onClick={() => void markSeen()} title="Clear every New marker: nothing before now counts as new any more">
              <span className="sc-newdot" aria-hidden="true" />Mark {newCount} new as seen
            </button>
          )}
          <button className="sc-btn" type="button" onClick={exportCsv}>Export CSV</button>
          {isAdmin && (
            <button className="sc-btn" type="button" onClick={() => setModal("import")}>Import sheet</button>
          )}
          <button className="sc-btn primary" type="button" onClick={() => setModal("add")}>+ Add interview</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="sc-seg sc-people" role="tablist" aria-label="Person">
        <button type="button" role="tab" aria-selected={personKey === "all"} onClick={() => setPerson("all")}>
          All <span className="n">{shownRows.filter((r) => !deriveStatus(r).closed).length}</span>
          {shownRows.some(isNew) && <span className="sc-newcount">{shownRows.filter(isNew).length} new</span>}
        </button>
        {(data?.people ?? []).map((p) => (
          <button key={p.key} type="button" role="tab" aria-selected={personKey === p.key} onClick={() => setPerson(p.key)} title={p.key}>
            {p.label} <span className="n">{shownRows.filter((r) => r.person === p.key && !deriveStatus(r).closed).length}</span>
            {shownRows.some((r) => r.person === p.key && isNew(r)) && (
              <span className="sc-newcount">{shownRows.filter((r) => r.person === p.key && isNew(r)).length} new</span>
            )}
          </button>
        ))}
      </div>

      {calOpen ? (
        <Calendar
          seenFor={seenFor}
          rows={inPerson}
          today={today}
          view={view}
          anchor={anchorIso}
          onView={setView}
          onAnchor={setAnchor}
          onToday={() => setAnchor(defaultAnchor(today))}
          onOpen={setDrawerId}
          onHide={() => setCalOpen(false)}
        />
      ) : (
        <button type="button" className="sc-cal-folded" onClick={() => setCalOpen(true)}>
          <IconCalendar />
          <span>Calendar</span>
          <span className="dim">{inPerson.filter((r) => r.rounds.some((x) => x.state === "sched" && x.date <= isoDay(addDays(parseDay(today), 7)))).length} interviews in the next 7 days</span>
          <b>Show</b>
        </button>
      )}

      <QuickViews
        views={quickViews}
        value={quickKey}
        onChange={setQuick}
        right={
          <>
            {(data?.unplaced ?? 0) > 0 && (
              <Link className="sc-quick-link" to="/interviews?view=attention" title="These scheduling emails name no company, so they couldn’t be placed on a row">
                {data!.unplaced} email{data!.unplaced === 1 ? "" : "s"} not placed →
              </Link>
            )}
            <InfoButton label="Colours">
              <div className="sc-legend">
                <span><i className="sw sched" />Scheduled</span>
                <span><i className="sw ask" />Needs scheduling: they asked you to book or propose a time. Your move.</span>
                <span><i className="sw task" />Assessment to do: a test or take-home they sent. Mark its email done once submitted.</span>
                <span><i className="sw pending" />Waiting on them: nothing asked of you</span>
                <span><i className="sw wait" />Awaiting result: the time is over, nobody has said how it went. Click Pass or Fail.</span>
                <span><b className="ok">✓</b>Passed</span>
                <span><b className="bad">✗</b>Failed</span>
                <span><span className="dim">—›</span>Skipped</span>
                <span><i className="sw edited" />Changed by hand: older emails won’t undo it, newer ones still update it</span>
              </div>
            </InfoButton>
          </>
        }
      />

      <FilterBar
        search={q}
        onSearch={setQ}
        placeholder="Search company, role, contact or note"
        defs={filterDefs}
        values={filters}
        onChange={setFilters}
        right={
          <label className="sc-field">Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="date">By date (grouped)</option>
              <option value="activity">Latest activity</option>
              <option value="company">Company A–Z</option>
            </select>
          </label>
        }
      />

      <SelectionBar count={tickedShown.length} onClear={() => setTicked(new Set())}>
        {quickKey === "removed" ? (
          <button className="sc-btn sm" type="button" disabled={busy} onClick={() => void bulkRemove(tickedShown, false)}>Put back on the schedule</button>
        ) : (
          <button className="sc-btn sm danger" type="button" disabled={busy} onClick={() => setConfirm({ ids: tickedShown, removed: true })}>
            <TrashIcon /> Remove {tickedShown.length} from schedule
          </button>
        )}
      </SelectionBar>

      <div ref={tableRef} className="sc-pager-top">
        <Pager page={curPage} pageSize={size} total={filtered.length} noun="interviews" onPage={goPage} onPageSize={setPageSize} />
      </div>

      <div className="sc-card sc-table-wrap">
        <table className="sc-table">
          <thead>
            <tr>
              <th className="sc-tickcell"><TickBox checked={allTicked} some={tickedShown.length > 0} onChange={tickAll} label="Tick every row on this page" /></th>
              <th>Company · role</th><th>Person</th><th>Status</th><th>Next / last date</th>
              {ROUNDS.map((r) => <th key={r}>{r}</th>)}
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={10} className="sc-empty">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={10} className="sc-empty">No interviews here. Try another quick view, or clear the filters.</td></tr>
            ) : (
              pageItems.map(({ row: r, header: g }) => {
                const st = deriveStatus(r);
                return [
                  g ? <tr key={`g-${g}`} className="sc-group"><td colSpan={10}>{g}</td></tr> : null,
                  <tr key={r.id} className={[st.closed ? "closed" : "", isNew(r) ? "is-new" : "", ticked.has(r.id) ? "is-ticked" : ""].join(" ").trim() || undefined}>
                    <td className="sc-tickcell">
                      <TickBox checked={ticked.has(r.id)} onChange={(on) => tick(r.id, on)} label={`Tick ${r.company}`} />
                      {r.removed ? (
                        <button className="sc-trash put" type="button" disabled={busy} aria-label={`Put ${r.company} back`} title="Put back on the schedule"
                          onClick={() => void bulkRemove([r.id], false)}>↩</button>
                      ) : (
                        <button className="sc-trash" type="button" disabled={busy} aria-label={`Remove ${r.company}`} title="Remove from the schedule (asks first; can be undone)"
                          onClick={() => setConfirm({ ids: [r.id], removed: true })}>
                          <TrashIcon />
                        </button>
                      )}
                    </td>
                    <td>
                      <NewBadge row={r} seenAt={seenFor(r)} onSeen={() => void markRowSeen(r.id)} />
                      <button className="sc-co" type="button" onClick={() => setDrawerId(r.id)}>
                        <span className="co">{r.company}</span>
                        <span className="role">{r.role || "—"}</span>
                      </button>
                      <span className="sc-contact">
                        {r.contact ? `${r.contact.replace(/<[^>]*>?/g, "").trim()} · ` : ""}
                        {r.application_id ? <Link to={`/result/${encodeURIComponent(r.application_id)}`} className="src tv">Tryvera</Link> : <span className="src">Other</span>}
                      </span>
                    </td>
                    <td><span className="sc-person"><Avatar label={r.person_label} />{r.person_label}</span></td>
                    <td>
                      <button className={`sc-pill ${st.kind}`} type="button" data-pop-anchor
                        onClick={(e) => openPop(e.currentTarget, { kind: "status", rowId: r.id })}
                        aria-haspopup="dialog" title={r.auto_closed ? `Closed automatically: no email for more than 20 days` : "Change status"}>
                        {st.label}<Chevron dir="down" />
                      </button>
                    </td>
                    <td><NextDate row={r} today={today} onBooked={(el, i) => openPop(el, { kind: "cell", rowId: r.id, i, draft: { state: "sched", date: "", time: "" } })} /></td>
                    {r.rounds.map((_, i) => (
                      <td key={i}>
                        <RoundCell row={r} i={i} busy={busy} onEdit={(el) => openPop(el, { kind: "cell", rowId: r.id, i, draft: { state: r.rounds[i].state, date: r.rounds[i].date, time: r.rounds[i].time } })} onVerdict={(pass) => void verdict(r, i, pass)}
                          onBooked={(el) => openPop(el, { kind: "cell", rowId: r.id, i, draft: { state: "sched", date: "", time: "" } })} />
                      </td>
                    ))}
                    <td className="sc-note">{r.note}</td>
                  </tr>,
                ];
              })
            )}
          </tbody>
        </table>
      </div>

      <Pager page={curPage} pageSize={size} total={filtered.length} noun="interviews" onPage={goPage} onPageSize={setPageSize} />


      {pop && popRow && (
        <Popover pop={pop} layoutKey={pop.kind === "cell" ? `cell${pop.i}${DATED.includes(pop.draft.state)}` : "status"}>
          {pop.kind === "cell" ? (
            <CellEditor
              row={popRow}
              i={pop.i}
              draft={pop.draft}
              today={today}
              onDraft={(draft) => setPop({ ...pop, draft })}
              onCancel={() => setPop(null)}
              busy={busy}
              onSave={() => void setCell(popRow, pop.i, pop.draft.state, pop.draft.date, pop.draft.time)}
            />
          ) : (
            <StatusMenu
              row={popRow}
              onStage={(k, state) => {
                if (state === "sched" || state === "wait") {
                  const x = popRow.rounds[k];
                  setPop({ kind: "cell", rowId: popRow.id, i: k, x: pop.x, y: pop.y, top: pop.top, draft: { state, date: x.date || today, time: x.time || "10:00" } });
                } else void setCell(popRow, k, state);
              }}
              onOffer={() => {
                const rounds = popRow.rounds.map((x) => (["ask", "pending", "sched", "wait"].includes(x.state) ? { ...x, state: (x.date ? "done" : "skipped") as SchedRoundState } : x));
                const changed = rounds.flatMap((x, k) => (x.state !== popRow.rounds[k].state ? [k] : []));
                void patch(popRow, { offer: true, closed: popRow.closed ? null : undefined, rounds: Object.fromEntries(changed.map((k) => [String(k), { state: rounds[k].state, date: rounds[k].date, time: rounds[k].time }])) }, `${popRow.company}: offer.`);
              }}
              onRejected={() => {
                let k = 3;
                while (k > 0 && popRow.rounds[k].state === "none") k--;
                const x = popRow.rounds[k];
                void patch(popRow, { offer: popRow.offer ? false : undefined, rounds: { [String(k)]: { state: "failed", date: x.date, time: x.time } } }, `${popRow.company}: rejected. Moved to closed.`);
              }}
              onClose={(reason) => void patch(popRow, { closed: reason }, `${popRow.company}: closed (${reason}).`)}
              onTaskDone={() => void taskDone(popRow)}
              onRemove={() => (popRow.removed ? void removeRow(popRow, false) : (setPop(null), setConfirm({ ids: [popRow.id], removed: true })))}
              onReopen={() => {
                const rounds = Object.fromEntries(
                  popRow.rounds.flatMap((x, k) => (x.state === "failed" ? [[String(k), { state: (x.date ? "wait" : "pending") as SchedRoundState, date: x.date, time: x.time }]] : []))
                );
                void patch(popRow, { closed: null, offer: popRow.offer ? false : undefined, rounds }, `${popRow.company}: reopened.`);
              }}
            />
          )}
        </Popover>
      )}

      {drawerRow && (
        <Drawer
          row={drawerRow}
          busy={busy}
          onClose={() => setDrawerId(null)}
          onEdit={(el, i) => openPop(el, { kind: "cell", rowId: drawerRow.id, i, draft: { state: drawerRow.rounds[i].state, date: drawerRow.rounds[i].date, time: drawerRow.rounds[i].time } })}
          onBooked={(el, i) => openPop(el, { kind: "cell", rowId: drawerRow.id, i, draft: { state: "sched", date: "", time: "" } })}
          onVerdict={(i, pass) => void verdict(drawerRow, i, pass)}
          onNote={(note) => note !== drawerRow.note && void patch(drawerRow, { note }, `${drawerRow.company}: note saved.`)}
          onRemove={() => (drawerRow.removed ? void removeRow(drawerRow, false) : setConfirm({ ids: [drawerRow.id], removed: true }))}
        />
      )}

      {modal === "add" && data && (
        <AddDialog people={data.all_people} defaultPerson={personKey === "all" ? data.people[0]?.key ?? data.all_people[0]?.key ?? "" : personKey}
          onClose={() => setModal(null)}
          onDone={async (msg) => { setModal(null); showToast({ msg }); await reload(); }} />
      )}
      {modal === "import" && data && (
        <ImportDialog people={data.all_people} onClose={() => setModal(null)}
          onDone={async (msg) => { setModal(null); showToast({ msg }); await reload(); }} />
      )}

      {confirm && (
        <ConfirmDialog
          title={`Remove ${confirm.ids.length === 1 ? "this interview" : `${confirm.ids.length} interviews`} from the schedule?`}
          names={confirm.ids.map((id) => data?.rows.find((r) => r.id === id)).filter((r) => r !== undefined).map((r) => `${r.company}${r.role ? ` · ${r.role}` : ""} (${r.person_label})`)}
          note="Nothing is deleted. They move to the Removed view, where you can put them back, and Undo works right after. A new email that books an interview brings one back by itself."
          confirmLabel={`Remove ${confirm.ids.length}`}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void bulkRemove(confirm.ids, confirm.removed)}
        />
      )}

      {toast && (
        <div className="sc-toast" role="status">
          <span>{toast.msg}</span>
          {toast.undo && <button type="button" disabled={busy} onClick={() => void toast.undo!()}>Undo</button>}
        </div>
      )}
    </div>
  );
}

/* ---------- small pieces ---------- */

function Avatar({ label }: { label: string }) {
  // A stable hue per person, so the same person reads the same colour everywhere.
  const hues = ["p0", "p1", "p2", "p3", "p4"];
  const h = [...label].reduce((n, c) => n + c.charCodeAt(0), 0) % hues.length;
  return <span className={`sc-avatar ${hues[h]}`} aria-hidden="true">{label[0]?.toUpperCase()}</span>;
}

/** What changed on this row since you last looked, e.g. "● Time changed · 2h ago". */
function NewBadge({ row, seenAt, onSeen }: { row: ScheduleRow; seenAt: string; onSeen?: () => void }) {
  if (!seenAt) return null;
  const c = headlineChange(row, seenAt);
  if (!c) return null;
  const more = newChanges(row, seenAt).length - 1;
  return (
    <span className={`sc-newbadge ${c.what}`} title={newChanges(row, seenAt).map((x) => `${CHANGE_LABEL[x.what]} · ${ago(x.at)}`).join("\n")}>
      <span className="sc-newdot" aria-hidden="true" />
      {CHANGE_LABEL[c.what]}{c.round !== undefined && c.what !== "new" ? ` · ${ROUNDS[c.round]}` : ""}
      <span className="when">{ago(c.at)}{more > 0 ? ` · +${more}` : ""}</span>
      {onSeen && (
        <button
          className="sc-newseen"
          type="button"
          title="Mark this one as seen"
          aria-label="Mark this interview as seen"
          onClick={(e) => { e.stopPropagation(); onSeen(); }}
        >
          ✓
        </button>
      )}
    </span>
  );
}

function NextDate({ row, today, onBooked }: { row: ScheduleRow; today: string; onBooked?: (el: HTMLElement, i: number) => void }) {
  const st = deriveStatus(row);
  const x = st.i !== undefined ? row.rounds[st.i] : null;
  if (st.kind === "task" && row.task) {
    const due = row.task.due;
    return (
      <span className="sc-next task" title={row.task.asked}>
        {due ? `Due ${shortDay(due)}` : "Assessment"}
        <small>{row.task.asked || "to do"}{due ? ` · ${relativeDay(due, today)}` : ` · sent ${shortDay(row.task.at.slice(0, 10))}`}</small>
      </span>
    );
  }
  if (x && x.date && (x.state === "sched" || x.state === "wait")) {
    const days = Math.round((parseDay(x.date).getTime() - parseDay(today).getTime()) / 86400000);
    const quiet = noWordDays(row, today);
    return (
      <span className={`sc-next ${days >= 0 && days <= 2 ? "soon" : ""}`}>
        {shortDay(x.date)}{x.time ? ` · ${time12(x.time)}` : ""}
        <small>{relativeDay(x.date, today)}</small>
        {quiet > 0 && <small className="sc-noword" title="The interview time has passed and no email has come in since. Worth a nudge.">No word for {quiet} days</small>}
      </span>
    );
  }
  if (st.kind === "ask" && x) {
    const what = x.why === "reschedule" ? "pick a new time" : x.why === "confirm" ? "say yes to the time they offered" : "book or propose a time";
    return (
      <span className="sc-next ask">Your move<small>{what}{x.at ? ` · asked ${shortDay(x.at.slice(0, 10))}` : ""}</small>
        {onBooked && st.i !== undefined && (
          <button className="sc-booked-btn" type="button" data-pop-anchor title="You booked it (or said yes to their time). Add the date if you know it."
            onClick={(e) => onBooked(e.currentTarget, st.i!)}>✓ I booked it</button>
        )}
      </span>
    );
  }
  if (st.kind === "sched" && x && !x.date) {
    return <span className="sc-next">Booked<small>time not in the email · click the cell to add it</small></span>;
  }
  return <span className="sc-next dim">{row.last_activity ? shortDay(row.last_activity) : "—"}<small>last activity</small></span>;
}

function RoundCell({ row, i, busy, onEdit, onVerdict, onBooked }: {
  row: ScheduleRow; i: number; busy: boolean; onEdit: (el: HTMLElement) => void; onVerdict: (pass: boolean) => void; onBooked?: (el: HTMLElement) => void;
}) {
  const x = row.rounds[i];
  const pen = x.source === "manual" ? <span className="pen" title="Changed by hand" /> : null;
  const label = `${ROUNDS[i]}: ${STATE_NAME[x.state]}${x.date ? ` ${shortDay(x.date)}` : ""}. Change`;
  const btn = (cls: string, main: ReactNode, sub?: ReactNode) => (
    <button className={`sc-cell ${cls}`} type="button" data-pop-anchor aria-label={label} onClick={(e) => onEdit(e.currentTarget)}>
      {pen}<span className="m">{main}</span>{sub ? <span className="s">{sub}</span> : null}
    </button>
  );
  switch (x.state) {
    case "sched": return x.date ? btn("sched", shortDay(x.date), time12(x.time)) : btn("sched untimed", "Booked", "add the time");
    case "done": return btn("done", `✓ ${shortDay(x.date) || "Passed"}`, time12(x.time));
    case "failed": return btn("failed", `✗ ${shortDay(x.date) || "Failed"}`, time12(x.time));
    case "ask":
      return (
        <div>
          {btn("ask", x.why === "reschedule" ? "Reschedule" : x.why === "confirm" ? "Confirm time" : "Book a time", "your move")}
          <div className="sc-verdict">
            <button className="ok" type="button" disabled={busy} title="You booked it (or confirmed their time): set the date if you know it"
              onClick={(e) => onBooked?.(e.currentTarget)}>✓ I booked it</button>
          </div>
        </div>
      );
    case "pending": return btn("pending", "Waiting", "on them");
    case "skipped": return btn("skipped", "—› Skipped");
    case "wait":
      return (
        <div>
          {btn("wait", "Awaiting", `${shortDay(x.date)}${x.time ? ` · ${time12(x.time)}` : ""}`)}
          <div className="sc-verdict">
            <button className="ok" type="button" disabled={busy} onClick={() => onVerdict(true)}>✓ Pass</button>
            <button className="no" type="button" disabled={busy} onClick={() => onVerdict(false)}>✗ Fail</button>
          </div>
        </div>
      );
    default: return btn("none", "—");
  }
}

function CellEditor({ row, i, draft, today, busy, onDraft, onCancel, onSave }: {
  row: ScheduleRow; i: number; draft: { state: SchedRoundState; date: string; time: string }; today: string; busy: boolean;
  onDraft: (d: { state: SchedRoundState; date: string; time: string }) => void; onCancel: () => void; onSave: () => void;
}) {
  const dated = DATED.includes(draft.state);
  return (
    <>
      <div><h3>{row.company} · {ROUNDS[i]}</h3><div className="sub">Pick the state, then the date and time (ET).{draft.state === "sched" ? " Booked but don’t know the time yet? Leave the date empty." : ""}</div></div>
      <div className="sc-chips">
        {(["ask", "pending", "sched", "wait", "done", "failed", "skipped", "none"] as SchedRoundState[]).map((s) => (
          <button key={s} type="button" className="sc-chip" aria-pressed={draft.state === s}
            onClick={() => onDraft({ ...draft, state: s, date: DATED.includes(s) ? draft.date || today : draft.date })}>
            {STATE_NAME[s]}
          </button>
        ))}
      </div>
      {dated && (
        <div className="sc-two">
          <label>Date<input type="date" value={draft.date} onChange={(e) => onDraft({ ...draft, date: e.target.value })} /></label>
          <label>Time (ET)<input type="time" value={draft.time} onChange={(e) => onDraft({ ...draft, time: e.target.value })} /></label>
        </div>
      )}
      <div className="sc-pop-foot">
        <button className="sc-btn sm" type="button" onClick={onCancel}>Cancel</button>
        <button className="sc-btn sm primary" type="button" disabled={busy || (dated && !draft.date && draft.state !== "sched")} onClick={onSave}>Save</button>
      </div>
    </>
  );
}

function StatusMenu({ row, onStage, onOffer, onRejected, onClose, onReopen, onRemove, onTaskDone }: {
  row: ScheduleRow; onStage: (k: number, s: SchedRoundState) => void; onOffer: () => void; onRejected: () => void;
  onClose: (reason: string) => void; onReopen: () => void; onRemove: () => void; onTaskDone: () => void;
}) {
  const st = deriveStatus(row);
  return (
    <div className="sc-menu">
      <div><h3>{row.company}</h3><div className="sub">Set where this stands. Earlier rounds are marked passed for you.</div></div>
      <div className="sc-stage-grid">
        <span />
        <span className="sec" title="They asked you to book or propose a time">To book</span>
        <span className="sec" title="Nothing asked of you: waiting for them to reply">Waiting</span>
        <span className="sec" title="Booked, with a date and time">Booked</span>
        <span className="sec" title="You had the interview; waiting for the result">Had it</span>
        <span className="sec">Passed</span>
        {ROUNDS.map((name, k) => [
          <span key={`l${k}`} className="rl">{name}</span>,
          ...(["ask", "pending", "sched", "wait", "done"] as SchedRoundState[]).map((s) => (
            <button key={`${k}${s}`} type="button" className="sc-chip" aria-pressed={st.i === k && row.rounds[k].state === s && !st.closed && !row.offer}
              title={`${name}: ${STATE_NAME[s]}`} onClick={() => onStage(k, s)}>
              {s === "sched" ? "Time…" : s === "wait" ? "Date…" : s === "ask" ? "To book" : s === "pending" ? "Waiting" : "✓"}
            </button>
          )),
        ])}
      </div>
      {row.task && (
        <>
          <span className="sec">Assessment</span>
          <div className="sc-task-line">
            <span>{row.task.asked || "Assessment"}</span>
            <button className="sc-btn sm" type="button" onClick={onTaskDone} title="Marks its email done here and on the Slack card">Submitted / done</button>
          </div>
        </>
      )}
      <span className="sec">Outcome</span>
      <div className="sc-chips">
        <button className="sc-chip" type="button" aria-pressed={row.offer} onClick={onOffer}>Offer</button>
        <button className="sc-chip" type="button" aria-pressed={st.kind === "rejected"} onClick={onRejected}>Rejected</button>
      </div>
      <span className="sec">Close without a result</span>
      <div className="sc-chips">
        {CLOSE_REASONS.map((c) => (
          <button key={c} className="sc-chip" type="button" aria-pressed={row.closed === c} onClick={() => onClose(c)}>{c}</button>
        ))}
      </div>
      {(st.closed || row.offer) && <button className="sc-btn sm" type="button" onClick={onReopen}>Reopen</button>}
      <RemoveButton row={row} onRemove={onRemove} />
    </div>
  );
}

/** Not a real interview (a misread email, a duplicate)? Take it off. Put back from the Removed view. */
function RemoveButton({ row, onRemove, busy }: { row: ScheduleRow; onRemove: () => void; busy?: boolean }) {
  return row.removed ? (
    <button className="sc-btn sm" type="button" disabled={busy} onClick={onRemove}>Put back on the schedule</button>
  ) : (
    <button className="sc-btn sm danger" type="button" disabled={busy} onClick={onRemove}
      title="Not a real interview, or a duplicate? Hides it from the schedule. Nothing is deleted: put it back from the Removed view.">
      Remove from schedule
    </button>
  );
}

function Drawer({ row, busy, onClose, onEdit, onBooked, onVerdict, onNote, onRemove }: {
  row: ScheduleRow; busy: boolean; onClose: () => void; onEdit: (el: HTMLElement, i: number) => void; onBooked: (el: HTMLElement, i: number) => void;
  onVerdict: (i: number, pass: boolean) => void; onNote: (note: string) => void; onRemove: () => void;
}) {
  const st = deriveStatus(row);
  const [note, setNote] = useState(row.note);
  useEffect(() => setNote(row.note), [row.id, row.note]);
  // Escape or the scrim close the drawer without a blur: save what was typed on the way out.
  const latest = useRef({ note, saved: row.note, onNote });
  latest.current = { note, saved: row.note, onNote };
  useEffect(() => () => {
    const l = latest.current;
    if (l.note !== l.saved) l.onNote(l.note);
  }, [row.id]);
  return (
    <>
      <div className="sc-scrim" onClick={onClose} />
      <aside className="sc-drawer" aria-label={`${row.company} details`}>
        <div className="sc-drawer-head">
          <div>
            <div className="title">{row.company}</div>
            <div className="sub">{row.role || "—"}</div>
            <div className="dim">{row.person_label}{row.contact ? ` · ${row.contact}` : ""}</div>
          </div>
          <button className="sc-icon-btn" type="button" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <span className={`sc-pill ${st.kind} static`}>{st.label}</span>
        {row.auto_closed && <p className="dim small">Closed automatically: no email or change for more than 20 days. Reopen it from the status menu if it’s still alive.</p>}
        {row.application_id ? (
          <Link to={`/result/${encodeURIComponent(row.application_id)}`}>Open the Tryvera application →</Link>
        ) : (
          <span className="dim">{row.from_sheet ? "From your sheet" : "Found in email"} · applied outside Tryvera{row.applied ? ` (${shortDay(row.applied)})` : ""}</span>
        )}
        <div className="sc-section">
          <span className="label">Rounds <span className="dim">· click to change</span></span>
          <div className="sc-drawer-rounds">
            {ROUNDS.map((name, i) => (
              <div key={name}>
                <span className="dim small">{name}</span>
                <RoundCell row={row} i={i} busy={busy} onEdit={(el) => onEdit(el, i)} onVerdict={(pass) => onVerdict(i, pass)} onBooked={(el) => onBooked(el, i)} />
              </div>
            ))}
          </div>
        </div>
        <label className="sc-section">
          <span className="label">Note</span>
          <input className="sc-input" value={note} placeholder="e.g. Hybrid (negotiable)" onChange={(e) => setNote(e.target.value)} onBlur={() => onNote(note)} />
        </label>
        <div className="sc-section">
          <span className="label">Emails on this row</span>
          {row.emails.length === 0 ? (
            <span className="dim small">None yet: this row came from your sheet or was added by hand.</span>
          ) : row.emails.map((e) => (
            <div key={e.id} className="sc-mail">
              <span className="d">{shortDay(e.received_at.slice(0, 10))}</span>
              <div>
                <span className="k">{e.kind}</span>
                <span className="t">{e.permalink ? <a href={e.permalink} target="_blank" rel="noreferrer">{e.subject}</a> : e.subject}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="dim small">Changes save as you make them. Emails that arrived before your change never undo it; emails that arrive after it still update the row.</p>
        <div className="sc-drawer-foot">
          {row.removed && <span className="dim small">Removed from the schedule. It comes back by itself if a new email books an interview for it.</span>}
          <RemoveButton row={row} onRemove={onRemove} busy={busy} />
        </div>
      </aside>
    </>
  );
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <>
      <div className="sc-scrim" onClick={onClose} />
      <div className="sc-dialog" role="dialog" aria-label={title}>
        <div className="sc-drawer-head"><div className="title">{title}</div><button className="sc-icon-btn" type="button" aria-label="Close" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </>
  );
}

function AddDialog({ people, defaultPerson, onClose, onDone }: { people: { key: string; label: string }[]; defaultPerson: string; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [person, setPerson] = useState(defaultPerson);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [contact, setContact] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Add an interview" onClose={onClose}>
      <p className="dim small">For an interview that never came through the inbox. Set its rounds from the table afterwards.</p>
      <label className="sc-section"><span className="label">Person</span>
        <select value={person} onChange={(e) => setPerson(e.target.value)}>{people.map((p) => <option key={p.key} value={p.key}>{p.label} · {p.key}</option>)}</select>
      </label>
      <label className="sc-section"><span className="label">Company</span><input className="sc-input" value={company} onChange={(e) => setCompany(e.target.value)} autoFocus /></label>
      <label className="sc-section"><span className="label">Role</span><input className="sc-input" value={role} onChange={(e) => setRole(e.target.value)} /></label>
      <label className="sc-section"><span className="label">Contact</span><input className="sc-input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Recruiter name" /></label>
      {err && <p className="error">{err}</p>}
      <div className="sc-pop-foot">
        <button className="sc-btn" type="button" onClick={onClose}>Cancel</button>
        <button className="sc-btn primary" type="button" disabled={busy || !company.trim() || !person}
          onClick={async () => {
            setBusy(true);
            try {
              await api.addScheduleRow({ person, company, role, contact });
              await onDone(`${company} added.`);
            } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
          }}>Add</button>
      </div>
    </Dialog>
  );
}

function ImportDialog({ people, onClose, onDone }: { people: { key: string; label: string }[]; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [person, setPerson] = useState(people[0]?.key ?? "");
  const [tsv, setTsv] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Import from Google Sheets" onClose={onClose}>
      <p className="dim small">In the sheet, select the rows (headers optional), copy, and paste below. Columns: Company, Job Info, Interviewer, Status, Applied, then date and time for Intro, HR, Tech and Final. Importing again replaces this person’s earlier import; changes made here are kept.</p>
      <label className="sc-section"><span className="label">Whose sheet</span>
        <select value={person} onChange={(e) => setPerson(e.target.value)}>{people.map((p) => <option key={p.key} value={p.key}>{p.label} · {p.key}</option>)}</select>
      </label>
      <textarea className="sc-input sc-paste" value={tsv} onChange={(e) => setTsv(e.target.value)} placeholder="Paste here" />
      {err && <p className="error">{err}</p>}
      <div className="sc-pop-foot">
        <button className="sc-btn" type="button" onClick={onClose}>Cancel</button>
        <button className="sc-btn primary" type="button" disabled={!tsv.trim() || !person || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.importSchedule(person, tsv);
              await onDone(`Imported ${r.imported} rows.`);
            } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
          }}>{busy ? "Importing…" : "Import"}</button>
      </div>
    </Dialog>
  );
}

/* ---------- calendar ---------- */

type Ev = { row: ScheduleRow; i: number; date: string; time: string; state: SchedRoundState };

function Calendar({ seenFor, rows, today, view, anchor, onView, onAnchor, onToday, onOpen, onHide }: {
  seenFor: (r: ScheduleRow) => string; rows: ScheduleRow[]; today: string; view: View; anchor: string; onView: (v: View) => void; onAnchor: (iso: string) => void; onToday: () => void; onOpen: (id: string) => void; onHide: () => void;
}) {
  const evs = useMemo<Ev[]>(() => {
    const out: Ev[] = [];
    for (const row of rows) row.rounds.forEach((x, i) => { if (x.date && DATED.includes(x.state)) out.push({ row, i, date: x.date, time: x.time, state: x.state }); });
    return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  }, [rows]);
  const a = parseDay(anchor);
  const todayD = parseDay(today);
  const ws = startOfWeek(a);
  const we = addDays(ws, 6);
  const title = view === "month"
    ? `${MONTH_NAME[a.getMonth()]} ${a.getFullYear()}`
    : ws.getMonth() === we.getMonth()
      ? `${MONTH_NAME[ws.getMonth()].slice(0, 3)} ${ws.getDate()} – ${we.getDate()}, ${we.getFullYear()}`
      : `${MONTH_NAME[ws.getMonth()].slice(0, 3)} ${ws.getDate()} – ${MONTH_NAME[we.getMonth()].slice(0, 3)} ${we.getDate()}, ${we.getFullYear()}`;
  const step = (dir: number) => onAnchor(isoDay(view === "month" ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, 7 * dir)));
  const inRange = view === "month"
    ? evs.filter((e) => parseDay(e.date).getMonth() === a.getMonth() && parseDay(e.date).getFullYear() === a.getFullYear())
    : evs.filter((e) => e.date >= isoDay(ws) && e.date <= isoDay(we));

  return (
    <section className="sc-card sc-cal" aria-label="Calendar">
      <div className="sc-cal-bar">
        <div className="sc-cal-nav">
          <button className="sc-btn sm icon" type="button" aria-label={view === "month" ? "Previous month" : "Previous week"} onClick={() => step(-1)}><Chevron dir="left" /></button>
          <button className="sc-btn sm" type="button" onClick={onToday}>Today</button>
          <button className="sc-btn sm icon" type="button" aria-label={view === "month" ? "Next month" : "Next week"} onClick={() => step(1)}><Chevron dir="right" /></button>
          <h2>{title}</h2>
          <label className="dim small sc-jump">Go to <input type="date" value={anchor} onChange={(e) => e.target.value && onAnchor(e.target.value)} /></label>
        </div>
        <div className="sc-cal-tools">
          <div className="sc-seg" role="group" aria-label="Calendar view">
            {(["week", "month", "hours"] as View[]).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)}>{v === "hours" ? "Hours" : v[0].toUpperCase() + v.slice(1)}</button>
            ))}
          </div>
          <button className="sc-btn sm" type="button" onClick={onHide} title="Fold the calendar away (remembered)">Hide</button>
        </div>
      </div>
      {view === "week" && (
        <div className="sc-tray">
          <div className="sc-week">
            {[0, 1, 2, 3, 4, 5, 6].map((k) => {
              const day = addDays(ws, k);
              const list = evs.filter((e) => e.date === isoDay(day));
              return (
                <div key={k} className={`sc-day ${sameDay(day, todayD) ? "today" : ""} ${k > 4 ? "weekend" : ""}`}>
                  <div className="sc-day-head"><span className="dn">{DOW[day.getDay()]}</span><span className="dd">{day.getDate()}</span></div>
                  <div className="sc-day-body">
                    {list.length === 0 ? <span className="sc-day-empty">—</span> : list.map((e) => (
                      <button key={`${e.row.id}-${e.i}`} type="button" className={`sc-ev ${e.state}`} onClick={() => onOpen(e.row.id)}>
                        <span className="top">
                          <span className="time">
                            {seenFor(e.row) && newChanges(e.row, seenFor(e.row)).some((c) => c.round === undefined || c.round === e.i) && <span className="sc-newdot" title="New since you last looked" />}
                            {time12(e.time) || "Time TBD"}
                          </span>
                          <Avatar label={e.row.person_label} />
                        </span>
                        <span className="co">{e.row.company}</span>
                        <span className="top"><span className="round">{ROUNDS[e.i]}</span><EvTag state={e.state} /></span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {view === "month" && <MonthGrid anchor={a} today={todayD} evs={evs} onOpen={onOpen} />}
      {view === "hours" && <HoursGrid start={ws} today={todayD} evs={evs} onOpen={onOpen} />}
      <div className="sc-cal-legend">
        <span><i className="dot sched" />Scheduled</span><span><i className="dot wait" />Awaiting result</span>
        <span><i className="dot done" />Passed</span><span><i className="dot failed" />Failed</span>
        <span className="count">{inRange.length} interview{inRange.length === 1 ? "" : "s"} this {view === "month" ? "month" : "week"}</span>
      </div>
    </section>
  );
}

function EvTag({ state }: { state: SchedRoundState }) {
  if (state === "done") return <span className="tag ok">Passed</span>;
  if (state === "failed") return <span className="tag bad">Failed</span>;
  if (state === "wait") return <span className="tag wait">Awaiting</span>;
  return null;
}

function MonthGrid({ anchor, today, evs, onOpen }: { anchor: Date; today: Date; evs: Ev[]; onOpen: (id: string) => void }) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const s = startOfWeek(first);
  return (
    <div className="sc-tray">
      <div className="sc-month">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="mh">{d}</div>)}
        {Array.from({ length: 42 }, (_, k) => {
          const day = addDays(s, k);
          const list = evs.filter((e) => e.date === isoDay(day));
          return (
            <div key={k} className={`mc ${day.getMonth() === first.getMonth() ? "" : "out"} ${sameDay(day, today) ? "today" : ""}`}>
              <span className="md">{day.getDate()}</span>
              {list.slice(0, 3).map((e) => (
                <button key={`${e.row.id}-${e.i}`} type="button" className={`chip ${e.state}`} onClick={() => onOpen(e.row.id)} title={`${e.row.company} · ${ROUNDS[e.i]} · ${time12(e.time)}`}>
                  <span className="t">{time12(e.time).replace(":00", "")}</span>{e.row.company}
                </button>
              ))}
              {list.length > 3 && <span className="more">+{list.length - 3} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const HOUR_PX = 48;
const FIRST_HOUR = 8;
const LAST_HOUR = 20;

/** The current hour and minute on the ET clock, wherever the viewer is. */
function etNow(): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { h: get("hour"), m: get("minute") };
}

function HoursGrid({ start, today, evs, onOpen }: { start: Date; today: Date; evs: Ev[]; onOpen: (id: string) => void }) {
  const height = (LAST_HOUR - FIRST_HOUR) * HOUR_PX;
  const now = etNow();
  return (
    <div className="sc-hours">
      <div className="corner" />
      {[0, 1, 2, 3, 4, 5, 6].map((k) => {
        const day = addDays(start, k);
        return <div key={k} className={`dh ${sameDay(day, today) ? "today" : ""}`}><span className="dn">{DOW[day.getDay()]}</span><span className="dd">{day.getDate()}</span></div>;
      })}
      <div className="hours" style={{ height }}>
        {Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, h) => (
          <span key={h} className="hour" style={{ top: h * HOUR_PX }}>{(h + FIRST_HOUR) % 12 || 12}{h + FIRST_HOUR < 12 ? "a" : "p"}</span>
        ))}
      </div>
      {[0, 1, 2, 3, 4, 5, 6].map((k) => {
        const day = addDays(start, k);
        const list = evs.filter((e) => e.date === isoDay(day)).map((e) => {
          const [h, m] = (e.time || "09:00").split(":").map(Number);
          return { ...e, mins: Math.min(Math.max((h - FIRST_HOUR) * 60 + m, 0), (LAST_HOUR - FIRST_HOUR) * 60 - 45), lane: 0 };
        });
        list.forEach((v, idx) => { v.lane = list.slice(0, idx).filter((o) => Math.abs(o.mins - v.mins) < 50).length; });
        const lanes = Math.max(1, ...list.map((v) => v.lane + 1));
        const isToday = sameDay(day, today);
        return (
          <div key={k} className={`col ${isToday ? "today" : ""} ${k > 4 ? "weekend" : ""}`} style={{ height }}>
            {isToday && now.h >= FIRST_HOUR && now.h < LAST_HOUR && (
              <div className="now" style={{ top: ((now.h - FIRST_HOUR) * 60 + now.m) / 60 * HOUR_PX }} />
            )}
            {list.map((v) => (
              <button key={`${v.row.id}-${v.i}`} type="button" className={`ev ${v.state}`} onClick={() => onOpen(v.row.id)}
                title={`${v.row.company} · ${ROUNDS[v.i]} · ${time12(v.time)}`}
                style={{ top: (v.mins / 60) * HOUR_PX + 2, height: HOUR_PX - 6, left: `calc(${(100 / lanes) * v.lane}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` }}>
                <b>{v.row.company}</b><span>{time12(v.time)} · {ROUNDS[v.i]} · {v.row.person_label[0]}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
