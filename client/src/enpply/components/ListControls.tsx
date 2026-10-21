import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { IconCalendar, IconInbox } from "../../ui/icons";
import { addDays, isoDay, parseDay, startOfWeek } from "../scheduleLogic";
import { useInterviewCounts } from "../useInterviewCounts";

/**
 * Shared controls for the Schedule and Emails pages, so both look and work
 * the same: a switcher that says which page is which, quick views with
 * counts, and one filter bar (dropdowns with counts, removable chips).
 */

/* ---------- which page is which ---------- */

export function PageSwitch() {
  const { news, attention } = useInterviewCounts();
  return (
    <nav className="sc-switch" aria-label="Interview pages">
      <NavLink to="/schedule" className={({ isActive }) => (isActive ? "active" : "")}>
        <IconCalendar />
        <span><b>Schedule{news > 0 && <i className="sc-switch-n">{news} new</i>}</b><small>Your interviews: one row each, with a calendar</small></span>
      </NavLink>
      <NavLink to="/interviews" className={({ isActive }) => (isActive ? "active" : "")}>
        <IconInbox />
        <span><b>Inbox{attention > 0 && <i className="sc-switch-n soft">{attention} to look at</i>}</b><small>Emails the schedule can’t show you, and every hiring email</small></span>
      </NavLink>
    </nav>
  );
}

/* ---------- quick views ---------- */

export type QuickView = { key: string; label: string; count: number; tone?: "ask" | "task" | "wait" | "sched" | "pending" | "ok" | "muted" };

export function QuickViews({ views, value, onChange, right }: { views: QuickView[]; value: string; onChange: (k: string) => void; right?: ReactNode }) {
  return (
    <div className="sc-quick">
      <div className="sc-quick-tabs" role="tablist" aria-label="Quick views">
        {views.map((v) => (
          <button key={v.key} type="button" role="tab" aria-selected={value === v.key} className={v.tone ?? ""} onClick={() => onChange(v.key)}>
            {v.label}
            <span className="n">{v.count}</span>
          </button>
        ))}
      </div>
      {right && <div className="sc-quick-right">{right}</div>}
    </div>
  );
}

/* ---------- filters ---------- */

export type FilterOption = { value: string; label: string; count?: number };
export type FilterDef =
  | { key: string; label: string; kind: "multi"; options: FilterOption[] }
  | { key: string; label: string; kind: "date"; hint?: string };
export type FilterValues = Record<string, string[]>;

export const DATE_PRESETS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "next7", label: "Next 7 days" },
  { value: "thisweek", label: "This week" },
  { value: "last7", label: "Last 7 days" },
  { value: "thismonth", label: "This month" },
  { value: "upcoming", label: "Today and later" },
  { value: "past", label: "Before today" },
];

/** Does an ET date (YYYY-MM-DD) pass a date filter value ("next7", "range:2026-10-01:2026-10-31")? */
export function dateMatches(date: string, value: string, todayIso: string): boolean {
  if (!date) return false;
  const t = parseDay(todayIso);
  const inRange = (from: string, to: string) => (!from || date >= from) && (!to || date <= to);
  switch (value) {
    case "today": return date === todayIso;
    case "next7": return inRange(todayIso, isoDay(addDays(t, 7)));
    case "last7": return inRange(isoDay(addDays(t, -7)), todayIso);
    case "thisweek": { const s = startOfWeek(t); return inRange(isoDay(s), isoDay(addDays(s, 6))); }
    case "thismonth": return date.slice(0, 7) === todayIso.slice(0, 7);
    case "upcoming": return date >= todayIso;
    case "past": return date < todayIso;
    default: {
      const m = /^range:([\d-]*):([\d-]*)$/.exec(value);
      return m ? inRange(m[1], m[2]) : true;
    }
  }
}

export function dateLabel(value: string): string {
  const p = DATE_PRESETS.find((d) => d.value === value);
  if (p) return p.label;
  const m = /^range:([\d-]*):([\d-]*)$/.exec(value);
  return m ? `${m[1] || "…"} → ${m[2] || "…"}` : value;
}

export const activeFilterCount = (values: FilterValues) => Object.values(values).filter((v) => v && v.length).length;

export function FilterBar({ search, onSearch, placeholder, defs, values, onChange, right }: {
  search: string; onSearch: (q: string) => void; placeholder: string;
  defs: FilterDef[]; values: FilterValues; onChange: (next: FilterValues) => void; right?: ReactNode;
}) {
  const chips = defs.flatMap((d) =>
    (values[d.key] ?? []).map((v) => ({
      key: `${d.key}:${v}`,
      label: `${d.label}: ${d.kind === "date" ? dateLabel(v) : d.options.find((o) => o.value === v)?.label ?? v}`,
      remove: () => onChange({ ...values, [d.key]: (values[d.key] ?? []).filter((x) => x !== v) }),
    }))
  );
  return (
    <div className="sc-fbar-wrap">
      <div className="sc-fbar">
        <label className="sc-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input type="search" placeholder={placeholder} aria-label="Search" value={search} onChange={(e) => onSearch(e.target.value)} />
        </label>
        {defs.map((d) => (
          <FilterPill key={d.key} def={d} selected={values[d.key] ?? []} onSet={(sel) => onChange({ ...values, [d.key]: sel })} />
        ))}
        {right && <div className="sc-fbar-right">{right}</div>}
      </div>
      {(chips.length > 0 || search) && (
        <div className="sc-chipbar">
          {search && <button type="button" className="sc-fchip" onClick={() => onSearch("")}>Search: “{search}” <span aria-hidden="true">×</span></button>}
          {chips.map((c) => (
            <button key={c.key} type="button" className="sc-fchip" onClick={c.remove} aria-label={`Remove ${c.label}`}>
              {c.label} <span aria-hidden="true">×</span>
            </button>
          ))}
          <button type="button" className="sc-clear" onClick={() => { onSearch(""); onChange({}); }}>Clear all</button>
        </div>
      )}
    </div>
  );
}

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, close]);
  return ref;
}

function FilterPill({ def, selected, onSet }: { def: FilterDef; selected: string[]; onSet: (sel: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const shown =
    selected.length === 0 ? "" :
    def.kind === "date" ? dateLabel(selected[0]) :
    selected.length === 1 ? def.options.find((o) => o.value === selected[0])?.label ?? selected[0] :
    `${selected.length} selected`;
  return (
    <div className="sc-fpill-wrap" ref={ref}>
      <button type="button" className={`sc-fpill ${selected.length ? "on" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {def.label}{shown && <b>: {shown}</b>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="sc-fpanel" role="dialog" aria-label={def.label}>
          {def.kind === "multi" ? (
            <>
              {def.options.length === 0 && <span className="dim small">Nothing to filter by yet.</span>}
              {def.options.map((o) => (
                <label key={o.value} className="sc-fopt">
                  <input type="checkbox" checked={selected.includes(o.value)}
                    onChange={(e) => onSet(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))} />
                  <span>{o.label}</span>
                  {o.count !== undefined && <span className="n">{o.count}</span>}
                </label>
              ))}
            </>
          ) : (
            <DatePanel hint={def.hint} value={selected[0] ?? ""} onSet={(v) => { onSet(v ? [v] : []); }} />
          )}
          {selected.length > 0 && <button type="button" className="sc-clear" onClick={() => onSet([])}>Clear</button>}
        </div>
      )}
    </div>
  );
}

function DatePanel({ value, hint, onSet }: { value: string; hint?: string; onSet: (v: string) => void }) {
  const m = /^range:([\d-]*):([\d-]*)$/.exec(value);
  const [from, setFrom] = useState(m?.[1] ?? "");
  const [to, setTo] = useState(m?.[2] ?? "");
  return (
    <>
      {hint && <span className="dim small">{hint}</span>}
      {DATE_PRESETS.map((p) => (
        <label key={p.value} className="sc-fopt">
          <input type="radio" name="date-preset" checked={value === p.value} onChange={() => onSet(p.value)} />
          <span>{p.label}</span>
        </label>
      ))}
      <div className="sc-frange">
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className="sc-btn sm" disabled={!from && !to} onClick={() => onSet(`range:${from}:${to}`)}>Apply range</button>
      </div>
    </>
  );
}

/* ---------- small popovers ---------- */

/** A button that shows a short explanation (the colour legend) on click. */
export function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  return (
    <div className="sc-fpill-wrap" ref={ref}>
      <button type="button" className="sc-info-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">?</span> {label}
      </button>
      {open && <div className="sc-fpanel right" role="dialog" aria-label={label}>{children}</div>}
    </div>
  );
}

/** A panel anchored under (or above, when there's no room) the element that opened it. */
export function Popover({ pop, layoutKey, children }: { pop: { x: number; y: number; top: number }; layoutKey: string; children: ReactNode }) {
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

/** Coordinates for a Popover opened from `el`. */
export function anchorOf(el: HTMLElement) {
  const b = el.getBoundingClientRect();
  return { x: window.scrollX + b.left, y: window.scrollY + b.bottom + 6, top: window.scrollY + b.top };
}

/** Count how many items fall under each option, for the numbers in the dropdowns. */
export function countBy<T>(items: T[], keyOf: (t: T) => string | string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const ks = keyOf(it);
    for (const k of Array.isArray(ks) ? ks : [ks]) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/* ---------- tick boxes, the bar for ticked rows, and "are you sure?" ---------- */

/** A tick box; `some` shows the half-ticked state (part of the list is ticked). */
export function TickBox({ checked, some, onChange, label }: { checked: boolean; some?: boolean; onChange: (on: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(some) && !checked;
  }, [some, checked]);
  return <input ref={ref} className="sc-tick" type="checkbox" aria-label={label} title={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

/** Shown while rows are ticked: how many, what to do with them, and Clear. */
export function SelectionBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="sc-selbar" role="region" aria-label="Ticked rows">
      <b>{count} ticked</b>
      <div className="sc-selbar-actions">{children}</div>
      <button className="sc-btn sm ghost" type="button" onClick={onClear}>Clear</button>
    </div>
  );
}

/** "Are you sure?" before removing: names what goes, and says it can come back. */
export function ConfirmDialog({ title, names, note, confirmLabel, busy, onCancel, onConfirm }: {
  title: string; names: string[]; note: string; confirmLabel: string; busy?: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  // One steady listener: re-subscribing on every render could miss the key press.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const shown = names.slice(0, 8);
  return (
    <>
      <div className="sc-scrim" onClick={onCancel} />
      <div className="sc-dialog sc-confirm" role="alertdialog" aria-label={title}>
        <div className="sc-drawer-head"><div className="title">{title}</div></div>
        <ul className="sc-confirm-list">
          {shown.map((n, i) => <li key={i}>{n}</li>)}
          {names.length > shown.length && <li className="dim">and {names.length - shown.length} more</li>}
        </ul>
        <p className="dim small">{note}</p>
        <div className="sc-confirm-actions">
          <button className="sc-btn" type="button" onClick={onCancel} autoFocus>Cancel</button>
          <button className="sc-btn danger solid" type="button" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </>
  );
}

export const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
  </svg>
);

/* ---------- pages ---------- */

export const PAGE_SIZES = [25, 50, 100];

/** Page numbers with gaps: 1 … 4 5 [6] 7 8 … 20. */
function pageList(page: number, pages: number): (number | "gap")[] {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  const out: (number | "gap")[] = [];
  let last = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - last > 1) out.push("gap");
    out.push(n);
    last = n;
  }
  return out;
}

/** "Showing 26–50 of 97", page buttons, and rows per page (remembered by the page that uses it). */
export function Pager({ page, pageSize, total, noun, onPage, onPageSize }: {
  page: number; pageSize: number; total: number; noun: string; onPage: (p: number) => void; onPageSize: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  if (total === 0) return null;
  const from = (p - 1) * pageSize + 1;
  const to = Math.min(total, p * pageSize);
  return (
    <nav className="sc-pager" aria-label="Pages">
      <span className="dim">Showing {from}–{to} of {total} {noun}</span>
      {pages > 1 && (
        <div className="pages">
          <button type="button" disabled={p <= 1} onClick={() => onPage(p - 1)} aria-label="Previous page">‹</button>
          {pageList(p, pages).map((n, i) =>
            n === "gap" ? <span key={`g${i}`} className="gap">…</span> : (
              <button key={n} type="button" aria-current={n === p ? "page" : undefined} onClick={() => onPage(n)}>{n}</button>
            )
          )}
          <button type="button" disabled={p >= pages} onClick={() => onPage(p + 1)} aria-label="Next page">›</button>
        </div>
      )}
      <label className="sc-field">Per page
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </nav>
  );
}
