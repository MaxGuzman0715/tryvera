import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { SchedRoundState, ScheduleResponse, ScheduleRow } from "../types";
import { useAuth } from "../auth/AuthContext";
import { usePersistentState, useScrollRestore } from "../viewState";
import { IconCalendar } from "../../ui/icons";
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

  // Remembered for this tab: leave the page, come back, same view.
  const [person, setPerson] = usePersistentState("schedule:person", "all");
  const [viewRaw, setView] = usePersistentState<View>("schedule:view", "week");
  const [anchorRaw, setAnchor] = usePersistentState("schedule:anchor", "");
  // Remembered values from an older version of the page may not be valid any more.
  const view: View = (["week", "month", "hours"] as const).includes(viewRaw) ? viewRaw : "week";
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(anchorRaw) ? anchorRaw : "";
  const [q, setQ] = usePersistentState("schedule:q", "");
  const [statusFilter, setStatusFilter] = usePersistentState("schedule:status", "");
  const [sort, setSort] = usePersistentState("schedule:sort", "date");
  const [showClosed, setShowClosed] = usePersistentState("schedule:showClosed", false);

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

  const today = data?.today ?? isoDay(new Date());
  const anchorIso = anchor || defaultAnchor(today);

  // A remembered person who no longer has rows falls back to everyone.
  const personKey = person !== "all" && data && !data.people.some((p) => p.key === person) ? "all" : person;
  const inPerson = useMemo(
    () => (data?.rows ?? []).filter((r) => personKey === "all" || r.person === personKey),
    [data, personKey]
  );

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

  function openPop(el: HTMLElement, p: DistOmit<Pop, "x" | "y" | "top">) {
    const b = el.getBoundingClientRect();
    setPop({ ...p, x: window.scrollX + b.left, y: window.scrollY + b.bottom + 6, top: window.scrollY + b.top } as Pop);
  }

  // Close popovers on Escape or a click elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pop) setPop(null);
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
  }, [pop, modal]);

  /* ---------- table rows ---------- */
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = inPerson
      .filter((r) => showClosed || !deriveStatus(r).closed)
      .filter((r) => !statusFilter || deriveStatus(r).kind === statusFilter)
      .filter((r) => !s || `${r.company} ${r.role} ${r.contact}`.toLowerCase().includes(s));
    if (sort === "company") out.sort((a, b) => a.company.localeCompare(b.company));
    else if (sort === "activity") out.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
    else
      out.sort(
        (a, b) =>
          GROUP_ORDER.indexOf(groupOf(a, today)) - GROUP_ORDER.indexOf(groupOf(b, today)) ||
          keyDate(a).localeCompare(keyDate(b))
      );
    // A group header goes before the first row of each group (date sort only).
    let last = "";
    return out.map((row) => {
      const g = sort === "date" ? groupOf(row, today) : "";
      const header = g && g !== last ? g : null;
      if (g) last = g;
      return { row, header };
    });
  }, [inPerson, q, statusFilter, sort, showClosed, today]);

  const waiting = inPerson.filter((r) => deriveStatus(r).kind === "wait").length;
  const closedCount = inPerson.filter((r) => deriveStatus(r).closed).length;
  const drawerRow = data?.rows.find((r) => r.id === drawerId) ?? null;
  const popRow = pop ? data?.rows.find((r) => r.id === pop.rowId) ?? null : null;

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
      <header className="sc-head">
        <div>
          <h1>
            <IconCalendar />
            Interview schedule
          </h1>
          <p className="sub">Filled in automatically from interview emails. Times in ET. Click any status or round to change it.</p>
        </div>
        <div className="sc-actions">
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
          All <span className="n">{(data?.rows ?? []).filter((r) => !deriveStatus(r).closed).length}</span>
        </button>
        {(data?.people ?? []).map((p) => (
          <button key={p.key} type="button" role="tab" aria-selected={personKey === p.key} onClick={() => setPerson(p.key)} title={p.key}>
            {p.label} <span className="n">{(data?.rows ?? []).filter((r) => r.person === p.key && !deriveStatus(r).closed).length}</span>
          </button>
        ))}
      </div>

      <Calendar
        rows={inPerson}
        today={today}
        view={view}
        anchor={anchorIso}
        onView={setView}
        onAnchor={setAnchor}
        onToday={() => setAnchor(defaultAnchor(today))}
        onOpen={setDrawerId}
      />

      {(waiting > 0 || (data?.unplaced ?? 0) > 0) && (
        <div className="sc-notices">
          {waiting > 0 && (
            <button className="sc-alert wait" type="button" onClick={() => { setStatusFilter("wait"); setShowClosed(false); }}>
              <span><b>{waiting} interview{waiting === 1 ? "" : "s"}</b> already happened and need{waiting === 1 ? "s" : ""} a result: one click each.</span>
              <b>Show →</b>
            </button>
          )}
          {(data?.unplaced ?? 0) > 0 && (
            <Link className="sc-alert inbox" to="/interviews">
              <span><b>{data!.unplaced} scheduling email{data!.unplaced === 1 ? "" : "s"}</b> name no company, so they couldn’t be placed on a row. See them in Interviews.</span>
              <b>Open →</b>
            </Link>
          )}
        </div>
      )}

      <div className="sc-filters">
        <label className="sc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input type="search" placeholder="Search company, role or contact" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="sc-field">Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            <option value="wait">Result needed</option>
            <option value="sched">Scheduled</option>
            <option value="pending">Pending (waiting on reply)</option>
            <option value="offer">Offer</option>
          </select>
        </label>
        <label className="sc-field">Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="date">By date (grouped)</option>
            <option value="activity">Latest activity</option>
            <option value="company">Company A–Z</option>
          </select>
        </label>
        <label className="sc-check">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed &amp; rejected <span className="dim">({closedCount})</span>
        </label>
        {statusFilter && (
          <button className="sc-btn sm" type="button" onClick={() => setStatusFilter("")}>Clear filter</button>
        )}
      </div>

      <div className="sc-card sc-table-wrap">
        <table className="sc-table">
          <thead>
            <tr>
              <th>Company · role</th><th>Person</th><th>Status</th><th>Next / last date</th>
              {ROUNDS.map((r) => <th key={r}>{r}</th>)}
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {data === null ? (
              <tr><td colSpan={9} className="sc-empty">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="sc-empty">No interviews match these filters.</td></tr>
            ) : (
              filtered.map(({ row: r, header: g }) => {
                const st = deriveStatus(r);
                return [
                  g ? <tr key={`g-${g}`} className="sc-group"><td colSpan={9}>{g}</td></tr> : null,
                  <tr key={r.id} className={st.closed ? "closed" : undefined}>
                    <td>
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
                    <td><NextDate row={r} today={today} /></td>
                    {r.rounds.map((_, i) => (
                      <td key={i}>
                        <RoundCell row={r} i={i} busy={busy} onEdit={(el) => openPop(el, { kind: "cell", rowId: r.id, i, draft: { state: r.rounds[i].state, date: r.rounds[i].date, time: r.rounds[i].time } })} onVerdict={(pass) => void verdict(r, i, pass)} />
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

      <div className="sc-legend">
        <span><i className="sw sched" />Scheduled</span>
        <span><i className="sw pending" />Pending (waiting on reply)</span>
        <span><i className="sw wait" />Result needed</span>
        <span><b className="ok">✓</b>Passed</span>
        <span><b className="bad">✗</b>Failed</span>
        <span><span className="dim">—›</span>Skipped</span>
        <span><i className="sw edited" />Changed by hand (older emails won’t undo it; newer ones still update it)</span>
      </div>

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
                if (state === "sched") {
                  const x = popRow.rounds[k];
                  setPop({ kind: "cell", rowId: popRow.id, i: k, x: pop.x, y: pop.y, top: pop.top, draft: { state: "sched", date: x.date || today, time: x.time || "10:00" } });
                } else void setCell(popRow, k, state);
              }}
              onOffer={() => {
                const rounds = popRow.rounds.map((x) => (["pending", "sched", "wait"].includes(x.state) ? { ...x, state: (x.date ? "done" : "skipped") as SchedRoundState } : x));
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
          onVerdict={(i, pass) => void verdict(drawerRow, i, pass)}
          onNote={(note) => note !== drawerRow.note && void patch(drawerRow, { note }, `${drawerRow.company}: note saved.`)}
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

function NextDate({ row, today }: { row: ScheduleRow; today: string }) {
  const st = deriveStatus(row);
  const x = st.i !== undefined ? row.rounds[st.i] : null;
  if (x && x.date && (x.state === "sched" || x.state === "wait")) {
    const days = Math.round((parseDay(x.date).getTime() - parseDay(today).getTime()) / 86400000);
    return (
      <span className={`sc-next ${days >= 0 && days <= 2 ? "soon" : ""}`}>
        {shortDay(x.date)}{x.time ? ` · ${time12(x.time)}` : ""}
        <small>{relativeDay(x.date, today)}</small>
      </span>
    );
  }
  return <span className="sc-next dim">{row.last_activity ? shortDay(row.last_activity) : "—"}<small>last activity</small></span>;
}

function RoundCell({ row, i, busy, onEdit, onVerdict }: { row: ScheduleRow; i: number; busy: boolean; onEdit: (el: HTMLElement) => void; onVerdict: (pass: boolean) => void }) {
  const x = row.rounds[i];
  const pen = x.source === "manual" ? <span className="pen" title="Changed by hand" /> : null;
  const label = `${ROUNDS[i]}: ${STATE_NAME[x.state]}${x.date ? ` ${shortDay(x.date)}` : ""}. Change`;
  const btn = (cls: string, main: ReactNode, sub?: ReactNode) => (
    <button className={`sc-cell ${cls}`} type="button" data-pop-anchor aria-label={label} onClick={(e) => onEdit(e.currentTarget)}>
      {pen}<span className="m">{main}</span>{sub ? <span className="s">{sub}</span> : null}
    </button>
  );
  switch (x.state) {
    case "sched": return btn("sched", shortDay(x.date) || "Scheduled", time12(x.time));
    case "done": return btn("done", `✓ ${shortDay(x.date) || "Passed"}`, time12(x.time));
    case "failed": return btn("failed", `✗ ${shortDay(x.date) || "Failed"}`, time12(x.time));
    case "pending": return btn("pending", "Pending", "waiting on reply");
    case "skipped": return btn("skipped", "—› Skipped");
    case "wait":
      return (
        <div>
          {btn("wait", "Result?", `${shortDay(x.date)}${x.time ? ` · ${time12(x.time)}` : ""}`)}
          <div className="sc-verdict">
            <button className="ok" type="button" disabled={busy} onClick={() => onVerdict(true)}>✓ Pass</button>
            <button className="no" type="button" disabled={busy} onClick={() => onVerdict(false)}>✗ Fail</button>
          </div>
        </div>
      );
    default: return btn("none", "—");
  }
}

function Popover({ pop, layoutKey, children }: { pop: { x: number; y: number; top: number }; layoutKey: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: pop.x, top: pop.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = pop.x;
    let top = pop.y;
    if (pop.x - window.scrollX + r.width > window.innerWidth - 12) left = window.scrollX + window.innerWidth - r.width - 12;
    // Not enough room below (the toast lives there too): open above the anchor.
    if (pop.y - window.scrollY + r.height > window.innerHeight - 90 && pop.top - r.height - 6 > window.scrollY + 8) top = pop.top - r.height - 6;
    setPos({ left: Math.max(window.scrollX + 8, left), top });
  }, [pop.x, pop.y, pop.top, layoutKey]);
  return <div ref={ref} className="sc-pop" role="dialog" style={{ left: pos.left, top: pos.top }}>{children}</div>;
}

function CellEditor({ row, i, draft, today, busy, onDraft, onCancel, onSave }: {
  row: ScheduleRow; i: number; draft: { state: SchedRoundState; date: string; time: string }; today: string; busy: boolean;
  onDraft: (d: { state: SchedRoundState; date: string; time: string }) => void; onCancel: () => void; onSave: () => void;
}) {
  const dated = DATED.includes(draft.state);
  return (
    <>
      <div><h3>{row.company} · {ROUNDS[i]}</h3><div className="sub">Pick the state, then the date and time (ET).</div></div>
      <div className="sc-chips">
        {(["pending", "sched", "wait", "done", "failed", "skipped", "none"] as SchedRoundState[]).map((s) => (
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
        <button className="sc-btn sm primary" type="button" disabled={busy || (dated && !draft.date)} onClick={onSave}>Save</button>
      </div>
    </>
  );
}

function StatusMenu({ row, onStage, onOffer, onRejected, onClose, onReopen }: {
  row: ScheduleRow; onStage: (k: number, s: SchedRoundState) => void; onOffer: () => void; onRejected: () => void;
  onClose: (reason: string) => void; onReopen: () => void;
}) {
  const st = deriveStatus(row);
  return (
    <div className="sc-menu">
      <div><h3>{row.company}</h3><div className="sub">Set where this stands. Earlier rounds are marked passed for you.</div></div>
      <div className="sc-stage-grid">
        <span /><span className="sec">Pending</span><span className="sec">Scheduled</span><span className="sec">Passed</span>
        {ROUNDS.map((name, k) => [
          <span key={`l${k}`} className="rl">{name}</span>,
          ...(["pending", "sched", "done"] as SchedRoundState[]).map((s) => (
            <button key={`${k}${s}`} type="button" className="sc-chip" aria-pressed={st.i === k && row.rounds[k].state === s && !st.closed && !row.offer} onClick={() => onStage(k, s)}>
              {s === "sched" ? "Set time…" : s === "pending" ? "Pending" : "✓"}
            </button>
          )),
        ])}
      </div>
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
    </div>
  );
}

function Drawer({ row, busy, onClose, onEdit, onVerdict, onNote }: {
  row: ScheduleRow; busy: boolean; onClose: () => void; onEdit: (el: HTMLElement, i: number) => void;
  onVerdict: (i: number, pass: boolean) => void; onNote: (note: string) => void;
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
                <RoundCell row={row} i={i} busy={busy} onEdit={(el) => onEdit(el, i)} onVerdict={(pass) => onVerdict(i, pass)} />
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

function Calendar({ rows, today, view, anchor, onView, onAnchor, onToday, onOpen }: {
  rows: ScheduleRow[]; today: string; view: View; anchor: string; onView: (v: View) => void; onAnchor: (iso: string) => void; onToday: () => void; onOpen: (id: string) => void;
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
        <div className="sc-seg" role="group" aria-label="Calendar view">
          {(["week", "month", "hours"] as View[]).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => onView(v)}>{v === "hours" ? "Hours" : v[0].toUpperCase() + v.slice(1)}</button>
          ))}
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
                        <span className="top"><span className="time">{time12(e.time) || "Time TBD"}</span><Avatar label={e.row.person_label} /></span>
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
        <span><i className="dot sched" />Scheduled</span><span><i className="dot wait" />Result needed</span>
        <span><i className="dot done" />Passed</span><span><i className="dot failed" />Failed</span>
        <span className="count">{inRange.length} interview{inRange.length === 1 ? "" : "s"} this {view === "month" ? "month" : "week"}</span>
      </div>
    </section>
  );
}

function EvTag({ state }: { state: SchedRoundState }) {
  if (state === "done") return <span className="tag ok">Passed</span>;
  if (state === "failed") return <span className="tag bad">Failed</span>;
  if (state === "wait") return <span className="tag wait">Result?</span>;
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
