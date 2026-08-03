import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { api } from "../api";
import type { ApplicationLogEntry, AuthUser } from "../types";
import { formatDateTimeJst } from "../timeJst";
import { dismissGenerationToastById } from "../generationToasts";
import { getAutoDownloadRecord } from "../autoDownload";
import { useAuth } from "../auth/AuthContext";
import CopyButton from "../components/CopyButton";
import { downloadApplicationsCsv, filterForCsv } from "../resultsCsv";
import { IconList } from "../../ui/icons";

const DEFAULT_PAGE_SIZE = 10;
const LOGS_COLUMNS_VIS_KEY = "enpply:logs:columnVisibility";
const TRACKING_ORDER: Array<"pending" | "in_process" | "failed"> = ["pending", "in_process", "failed"];

/**
 * Columns the user is unlikely to need at a glance. On a first visit
 * (no stored preference) these are hidden so the essential columns get
 * full width. The Columns toggle still lets the user turn them back on;
 * once they do, their preference is persisted in localStorage.
 */
const DEFAULT_HIDDEN_COLUMNS: Record<string, boolean> = {
  run_uuid: false,
  resume_profile: false,
  output_folder: false,
};

function readStoredColumnVisibility(): VisibilityState {
  try {
    const raw = localStorage.getItem(LOGS_COLUMNS_VIS_KEY);
    if (!raw) return { ...DEFAULT_HIDDEN_COLUMNS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_HIDDEN_COLUMNS };
    const out: VisibilityState = { ...DEFAULT_HIDDEN_COLUMNS };
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_HIDDEN_COLUMNS };
  }
}

export default function Logs() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<ApplicationLogEntry[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [q, setQ] = useState("");
  const [userFilter, setUserFilter] = useState<string>("");
  const [profileFilter, setProfileFilter] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => readStoredColumnVisibility());
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvProfile, setCsvProfile] = useState("");
  const [csvFrom, setCsvFrom] = useState("");
  const [csvTo, setCsvTo] = useState("");

  async function reload() {
    const r = await api.listApplications();
    setRows(r.applications);
  }

  useEffect(() => {
    reload().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setUsers([]);
      return;
    }
    api
      .listUsers()
      .then((r) => setUsers(r.users))
      .catch(() => setUsers([]));
  }, [isAdmin]);

  const profileOptions = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.resume_profile).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b)
      ),
    [rows]
  );

  const visibleRows = useMemo(() => {
    // Rejected-duplicate marker rows are noise — never show them (they get
    // deleted in the background by the toast poller; hide instantly meanwhile).
    let out = rows.filter((r) => !(r.status === "failed" && r.duplicate_of));
    if (isAdmin && userFilter) out = out.filter((r) => r.user_id === userFilter);
    if (profileFilter.size > 0) out = out.filter((r) => profileFilter.has(r.resume_profile));
    return out;
  }, [rows, userFilter, isAdmin, profileFilter]);

  // Drop any selected profiles that no longer appear in the data.
  useEffect(() => {
    setProfileFilter((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(profileOptions);
      const next = new Set<string>();
      for (const p of prev) if (valid.has(p)) next.add(p);
      return next.size === prev.size ? prev : next;
    });
  }, [profileOptions]);

  useEffect(() => {
    setPage(1);
  }, [q, pageSize, userFilter, profileFilter]);

  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const idSet = new Set(rows.map((r) => r.id));
      const next = new Set<string>();
      for (const id of prev) {
        if (idSet.has(id)) next.add(id);
      }
      return next;
    });
  }, [rows]);

  useEffect(() => {
    try {
      localStorage.setItem(LOGS_COLUMNS_VIS_KEY, JSON.stringify(columnVisibility));
    } catch {
      // ignore storage errors
    }
  }, [columnVisibility]);

  async function handleMetaPatch(id: string, patch: Partial<Pick<ApplicationLogEntry, "note" | "tracking_status">>) {
    setUpdatingId(id);
    setError(null);
    try {
      await api.updateApplicationMeta(id, patch);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdatingId(null);
    }
  }

  const columns = useMemo<ColumnDef<ApplicationLogEntry>[]>(
    () => [
      {
        id: "select",
        header: () => "Select",
        cell: ({ row }) => (
          <input
            type="checkbox"
            className="logs-checkbox"
            checked={selectedIds.has(row.original.id)}
            onChange={() => toggleOne(row.original.id)}
            aria-label={`Select ${row.original.id}`}
          />
        ),
      },
      {
        id: "open",
        header: () => "Open",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.result_file ? (
            <Link className="btn small" to={`/result/${encodeURIComponent(row.original.id)}`}>
              Open
            </Link>
          ) : (
            <span className="sub">—</span>
          ),
      },
      {
        id: "auto_download",
        header: "Auto-download",
        accessorFn: (r) => getAutoDownloadRecord(r.id)?.displayPath ?? "",
        cell: ({ row }) => {
          const rec = getAutoDownloadRecord(row.original.id);
          if (!rec) return <span className="sub">—</span>;
          const count = rec.files.length;
          const when = new Date(rec.writtenAt).toLocaleString();
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
              <span
                className="mono"
                style={{ fontSize: "0.76rem", maxWidth: "min(38vw, 26rem)" }}
                title={`${rec.displayPath}\n${count} file${count === 1 ? "" : "s"} · ${when}`}
              >
                {rec.displayPath.length > 60 ? `…${rec.displayPath.slice(-59)}` : rec.displayPath}
              </span>
              <div style={{ display: "flex", gap: "0.3rem", fontSize: "0.7rem", alignItems: "center" }}>
                <span className="sub">
                  {count} file{count === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => void navigator.clipboard?.writeText(rec.displayPath)}
                  title="Copy auto-download path"
                >
                  Copy
                </button>
              </div>
            </div>
          );
        },
      },
      {
        id: "copy_path",
        header: () => "Path",
        enableSorting: false,
        cell: ({ row }) => {
          const toShow = row.original.output_folder_abs || row.original.output_folder || "";
          if (!toShow) return <span className="sub">—</span>;
          return <CopyButton text={toShow} label="Copy path" title={`Copy ${toShow}`} />;
        },
      },
      { accessorKey: "created_at", header: "Created", cell: (ctx) => <span className="mono">{formatDateTimeJst(String(ctx.getValue()))}</span> },
      ...(isAdmin
        ? [
            {
              id: "user",
              header: "User",
              accessorFn: (r: ApplicationLogEntry) => r.user_email ?? r.user_id ?? "",
              cell: ({ row }: { row: { original: ApplicationLogEntry } }) => {
                const r = row.original;
                if (r.user_email) {
                  return <span className="mono" style={{ fontSize: "0.78rem" }}>{r.user_email}</span>;
                }
                if (r.user_id) {
                  return <span className="mono sub" style={{ fontSize: "0.78rem" }}>{r.user_id}</span>;
                }
                return <span className="sub">—</span>;
              },
            } as ColumnDef<ApplicationLogEntry>,
          ]
        : []),
      {
        accessorKey: "company_name",
        header: "Company",
        cell: (ctx) => {
          const v = String(ctx.getValue() ?? "");
          return (
            <span className="logs-cell-clamp" title={v}>
              {v}
            </span>
          );
        },
      },
      {
        accessorKey: "role_name",
        header: "Role",
        cell: (ctx) => {
          const v = String(ctx.getValue() ?? "");
          return (
            <span className="logs-cell-clamp" title={v}>
              {v}
            </span>
          );
        },
      },
      {
        id: "job_ref",
        header: "Job URL / recruiter",
        accessorFn: (r) => [r.job_link, r.recruiter_name ?? ""].filter(Boolean).join(" "),
        cell: ({ row }) => {
          const r = row.original;
          if (r.job_link && r.recruiter_name) {
            return (
              <span className="mono" style={{ fontSize: "0.78rem" }} title={`${r.job_link}\n${r.recruiter_name}`}>
                <a href={r.job_link} target="_blank" rel="noreferrer">
                  link
                </a>
                {" · "}
                {r.recruiter_name}
              </span>
            );
          }
          if (r.job_link) {
            return (
              <a className="mono" style={{ fontSize: "0.78rem" }} href={r.job_link} target="_blank" rel="noreferrer">
                {r.job_link.length > 48 ? `${r.job_link.slice(0, 48)}…` : r.job_link}
              </a>
            );
          }
          if (r.recruiter_name) return <span className="mono">{r.recruiter_name}</span>;
          return <span className="sub">—</span>;
        },
      },
      { accessorKey: "resume_profile", header: "Profile", cell: (ctx) => <span className="mono">{String(ctx.getValue())}</span> },
      { accessorKey: "run_uuid", header: "Run id", cell: (ctx) => <span className="mono">{String(ctx.getValue() ?? "—")}</span> },
      {
        id: "status",
        header: "Generation status",
        accessorFn: (r) => r.status_step || r.status,
        cell: ({ row }) => <span className={`badge ${badgeClass(row.original.status)}`}>{row.original.status_step || row.original.status}</span>,
      },
      {
        id: "generation_error",
        header: "Error / detail",
        accessorFn: (r) => r.generation_error ?? "",
        cell: ({ row }) => {
          const err = row.original.generation_error?.trim();
          if (!err) return <span className="sub">—</span>;
          return (
            <span className="logs-cell-clamp mono" style={{ fontSize: "0.76rem" }} title={err}>
              {err}
            </span>
          );
        },
      },
      {
        accessorKey: "tracking_status",
        header: "Tracking status",
        cell: ({ row }) => {
          const current = trackingClass(row.original.tracking_status);
          const next = TRACKING_ORDER[(TRACKING_ORDER.indexOf(current) + 1) % TRACKING_ORDER.length];
          return (
            <button
              type="button"
              className={`tracking-pill ${current}`}
              disabled={updatingId === row.original.id}
              onClick={() => void handleMetaPatch(row.original.id, { tracking_status: next })}
              title={`Tracking status: ${current}. Click to switch to ${next}.`}
              aria-label={`Tracking status ${current}. Click to switch to ${next}.`}
            >
              {trackingLabel(current)}
            </button>
          );
        },
      },
      {
        accessorKey: "note",
        header: "Note",
        cell: ({ row }) => (
          <input
            className="form-control"
            style={{ minWidth: "220px", marginBottom: 0 }}
            defaultValue={row.original.note ?? ""}
            placeholder="progress note..."
            onBlur={(e) => void handleMetaPatch(row.original.id, { note: e.target.value })}
          />
        ),
      },
      {
        accessorKey: "output_folder",
        header: "Output",
        cell: ({ row }) => {
          const rel = row.original.output_folder || "";
          const abs = row.original.output_folder_abs || "";
          // Show the absolute path the server resolved (what the user pastes
          // into Explorer / Finder). Fall back to the stored relative path
          // only when the server hasn't populated abs yet — legacy rows or a
          // still-queued run with no folder assigned.
          const toShow = abs || rel;
          if (!toShow) return <span className="mono">—</span>;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
              <span className="mono">{toShow}</span>
              <CopyButton text={toShow} label="Copy path" title={`Copy ${toShow}`} />
            </div>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="logs-actions-cell">
              {r.status === "generating" ? (
                <button type="button" className="btn small danger" onClick={() => void handleCancel(r)}>
                  Cancel
                </button>
              ) : null}
              {r.status !== "generating" ? (
                <button
                  type="button"
                  className="btn small danger logs-trash-btn"
                  onClick={() => void handleRemove(r)}
                  disabled={Boolean(removingId)}
                  aria-label={`Remove ${r.id}`}
                  title="Remove"
                >
                  {removingId === r.id ? "..." : "🗑"}
                </button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [selectedIds, removingId, updatingId, isAdmin]
  );

  const table = useReactTable({
    data: visibleRows,
    columns,
    state: {
      sorting,
      globalFilter: q,
      columnVisibility,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setQ,
    onColumnVisibilityChange: setColumnVisibility,
    globalFilterFn: (row, _columnId, filterValue) => {
      const s = String(filterValue ?? "").toLowerCase().trim();
      if (!s) return true;
      const r = row.original;
      return (
        r.company_name.toLowerCase().includes(s) ||
        r.role_name.toLowerCase().includes(s) ||
        String(r.note ?? "").toLowerCase().includes(s) ||
        String(r.job_link ?? "").toLowerCase().includes(s) ||
        String(r.recruiter_name ?? "").toLowerCase().includes(s) ||
        String(r.user_email ?? "").toLowerCase().includes(s)
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const filteredRows = table.getRowModel().rows;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize);
  const singlePage = totalPages <= 1;
  const filteredIds = useMemo(() => filteredRows.map((r) => r.original.id), [filteredRows]);
  const pageIds = useMemo(() => pageRows.map((r) => r.original.id), [pageRows]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));

  function badgeClass(st: string) {
    if (st === "completed") return "ok";
    if (st === "failed") return "fail";
    return "gen";
  }

  function trackingClass(s: ApplicationLogEntry["tracking_status"]): "pending" | "in_process" | "failed" {
    if (s === "in_process" || s === "failed") return s;
    return "pending";
  }

  function trackingLabel(s: ApplicationLogEntry["tracking_status"]): "P" | "I" | "F" {
    const t = trackingClass(s);
    if (t === "in_process") return "I";
    if (t === "failed") return "F";
    return "P";
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectMany(ids: string[]) {
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleRemove(row: ApplicationLogEntry) {
    if (removingId) return;
    const ok = confirm(
      `Remove this application and all generated files?\n\n${row.company_name} — ${row.role_name}\n${row.id}`
    );
    if (!ok) return;
    setError(null);
    setRemovingId(row.id);
    try {
      await api.deleteApplication(row.id);
      dismissGenerationToastById(`genapp-${row.id}`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRemoveSelected() {
    if (removingId || selectedIds.size === 0) return;
    const ok = confirm(`Remove ${selectedIds.size} selected applications and all generated files?`);
    if (!ok) return;
    setError(null);
    setRemovingId("__bulk__");
    try {
      for (const id of selectedIds) {
        await api.deleteApplication(id);
        dismissGenerationToastById(`genapp-${id}`);
      }
      setSelectedIds(new Set());
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingId(null);
    }
  }

  async function handleCancel(row: ApplicationLogEntry) {
    if (removingId) return;
    setError(null);
    try {
      await api.cancelApplication(row.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleExportCsv() {
    // Export the rows matching the current page filters (user/profile/search),
    // then narrow by the CSV dialog's profile + date range.
    const base = filteredRows.map((r) => r.original);
    const out = filterForCsv(base, { profile: csvProfile, fromDate: csvFrom, toDate: csvTo });
    if (out.length === 0) {
      setError("No applications match the selected export filters.");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadApplicationsCsv(out, stamp);
  }

  return (
    <>
      <h1><IconList />Application Logs</h1>
      <p className="sub">Newest first. Search by company or role.</p>
      <p className="hint">
        Tracking: <span className="tracking-pill pending">P</span> pending ·{" "}
        <span className="tracking-pill in_process">I</span> in process ·{" "}
        <span className="tracking-pill failed">F</span> failed
      </p>
      <p>
        <Link to="/apply">Job Apply</Link>
      </p>

      {error && <p className="error">{error}</p>}

      <input
        className="search search-lg"
        placeholder="Search by company, role, or user..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="actions" style={{ marginTop: "0.4rem", marginBottom: "0.4rem", alignItems: "center" }}>
        <button type="button" className="btn small" onClick={() => setCsvOpen((v) => !v)}>
          {csvOpen ? "Close export" : "Export CSV"}
        </button>
        {csvOpen && (
          <>
            <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
              Profile
              <select value={csvProfile} onChange={(e) => setCsvProfile(e.target.value)}>
                <option value="">All</option>
                {profileOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
              From
              <input type="date" value={csvFrom} onChange={(e) => setCsvFrom(e.target.value)} />
            </label>
            <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
              To
              <input type="date" value={csvTo} onChange={(e) => setCsvTo(e.target.value)} />
            </label>
            <button type="button" className="btn small primary" onClick={handleExportCsv}>
              Download CSV
            </button>
            {(csvProfile || csvFrom || csvTo) && (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  setCsvProfile("");
                  setCsvFrom("");
                  setCsvTo("");
                }}
              >
                Clear
              </button>
            )}
            <span className="sub" style={{ fontSize: "0.74rem" }}>
              Exports rows matching current filters + the range above.
            </span>
          </>
        )}
      </div>
      {isAdmin && (
        <div
          className="actions"
          style={{ marginTop: "0.4rem", marginBottom: "0.4rem", alignItems: "center" }}
        >
          <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            User filter
            <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email} ({u.role})
                </option>
              ))}
              <option value="__legacy__" disabled>
                ─────────────
              </option>
            </select>
          </label>
          {userFilter && (
            <button type="button" className="btn small" onClick={() => setUserFilter("")}>
              Clear
            </button>
          )}
          <span className="sub mono" style={{ fontSize: "0.74rem" }}>
            {visibleRows.length} of {rows.length} shown
          </span>
        </div>
      )}
      {profileOptions.length > 0 && (
        <div
          className="actions"
          style={{ marginTop: "0.4rem", marginBottom: "0.4rem", alignItems: "center", flexWrap: "wrap" }}
        >
          <span className="mono">Profile filter</span>
          {profileOptions.map((p) => (
            <label
              key={p}
              className="mono"
              style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
            >
              <input
                type="checkbox"
                checked={profileFilter.has(p)}
                onChange={(e) =>
                  setProfileFilter((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(p);
                    else next.delete(p);
                    return next;
                  })
                }
              />
              {p}
            </label>
          ))}
          {profileFilter.size > 0 && (
            <button type="button" className="btn small" onClick={() => setProfileFilter(new Set())}>
              Clear
            </button>
          )}
        </div>
      )}
      <details className="card" style={{ padding: "0.7rem 0.9rem" }}>
        <summary className="mono">Columns</summary>
        <div className="actions" style={{ marginTop: "0.45rem" }}>
          {table
            .getAllLeafColumns()
            .filter((c) => !["select", "actions"].includes(c.id))
            .map((column) => (
              <label key={column.id} className="checkbox-row" style={{ marginBottom: 0 }}>
                <input type="checkbox" checked={column.getIsVisible()} onChange={column.getToggleVisibilityHandler()} />
                <span>{column.id}</span>
              </label>
            ))}
        </div>
      </details>
      <div className="actions" style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
        <span className="sub">Selected: {selectedIds.size}</span>
        <button
          type="button"
          className="btn small"
          onClick={() => selectMany(pageIds)}
          disabled={pageIds.length === 0 || allPageSelected}
          title="Select all rows on the current page"
        >
          Select page
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => selectMany(filteredIds)}
          disabled={filteredIds.length === 0 || allFilteredSelected}
          title="Select all rows matching the current filters/search"
        >
          Select all
        </button>
        <button type="button" className="btn small" onClick={clearSelection} disabled={selectedIds.size === 0}>
          Clear
        </button>
        <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
          Page size
          <select value={String(pageSize)} onChange={(e) => setPageSize(Math.max(1, Number(e.target.value) || 10))}>
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>
        <button
          type="button"
          className="btn small danger"
          onClick={() => void handleRemoveSelected()}
          disabled={selectedIds.size === 0 || Boolean(removingId)}
        >
          {removingId === "__bulk__" ? "Removing selected…" : "Remove selected"}
        </button>
      </div>

      <div className="card logs-table-wrap">
        <table>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getCanSort() ? header.column.getToggleSortingHandler() : undefined}
                    style={{ cursor: header.column.getCanSort() ? "pointer" : undefined }}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{ asc: " ▲", desc: " ▼" }[header.column.getIsSorted() as string] ?? ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {pageRows.map((r) => (
              <tr key={r.id}>
                {r.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions" style={{ marginTop: "0.65rem" }}>
        <button
          type="button"
          className="btn small"
          disabled={singlePage || safePage <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </button>
        <span className="mono">
          Page {safePage} / {totalPages}
        </span>
        <button
          type="button"
          className="btn small"
          disabled={singlePage || safePage >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          Next
        </button>
      </div>
    </>
  );
}
