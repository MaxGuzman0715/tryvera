import { useEffect, useMemo, useState } from "react";
import type { ApplicationLogEntry, AuthUser } from "../types";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const RANGE_PRESETS = [7, 14, 30, 60, 90] as const;
type RangeDays = (typeof RANGE_PRESETS)[number];
const DEFAULT_RANGE: RangeDays = 30;

function jstStartOfDayUtcMs(d = new Date()): number {
  const shifted = new Date(d.getTime() + JST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  return Date.UTC(y, m, day) - JST_OFFSET_MS;
}

function jstStartOfMonthUtcMs(d = new Date()): number {
  const shifted = new Date(d.getTime() + JST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  return Date.UTC(y, m, 1) - JST_OFFSET_MS;
}

function jstDateLabel(utcMs: number): string {
  const shifted = new Date(utcMs + JST_OFFSET_MS);
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${m}/${d}`;
}

/** 0 = Sunday, 1 = Monday, ... 6 = Saturday — shifted to JST. */
function jstWeekday(utcMs: number): number {
  return new Date(utcMs + JST_OFFSET_MS).getUTCDay();
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Bucket = { day: number; week: number; month: number; overall: number };

function emptyBucket(): Bucket {
  return { day: 0, week: 0, month: 0, overall: 0 };
}

type StatusCounts = {
  completed: number;
  failed: number;
  generating: number;
  other: number;
};

function emptyStatus(): StatusCounts {
  return { completed: 0, failed: 0, generating: 0, other: 0 };
}

function classifyStatus(s: string): keyof StatusCounts {
  if (s === "completed") return "completed";
  if (s === "failed") return "failed";
  if (s === "generating") return "generating";
  return "other";
}

export default function Analytics() {
  const { user: currentUser, isAdmin } = useAuth();
  const [rows, setRows] = useState<ApplicationLogEntry[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<string>("");
  const [rangeDays, setRangeDays] = useState<RangeDays>(DEFAULT_RANGE);

  useEffect(() => {
    api
      .listApplications()
      .then((r) => setRows(r.applications))
      .catch((e) => setError(String(e)));
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

  const scopedRows = useMemo(() => {
    if (!isAdmin || !scope) return rows;
    return rows.filter((r) => r.user_id === scope);
  }, [rows, scope, isAdmin]);

  const stats = useMemo(() => {
    const now = new Date();
    const todayStart = jstStartOfDayUtcMs(now);
    const weekStart = todayStart - 6 * DAY_MS;
    const monthStart = jstStartOfMonthUtcMs(now);
    const windowStart = todayStart - (rangeDays - 1) * DAY_MS;

    const total = emptyBucket();
    const status = emptyStatus();
    const byProfile = new Map<string, Bucket>();
    const byUser = new Map<string, { label: string; bucket: Bucket }>();
    const dayBuckets = new Map<number, { total: number; completed: number; failed: number }>();
    for (let i = rangeDays - 1; i >= 0; i--) {
      dayBuckets.set(todayStart - i * DAY_MS, { total: 0, completed: 0, failed: 0 });
    }

    // In-window aggregates
    const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
    const companiesInWindow = new Set<string>();
    const rolesInWindow = new Set<string>();
    let totalInWindow = 0;
    let completedInWindow = 0;
    let failedInWindow = 0;
    const recentFailures: ApplicationLogEntry[] = [];

    let trackingPending = 0;
    let trackingInProcess = 0;
    let trackingFailedFollowup = 0;

    for (const r of scopedRows) {
      const t = new Date(r.created_at).getTime();
      if (Number.isNaN(t)) continue;
      total.overall += 1;
      if (t >= todayStart) total.day += 1;
      if (t >= weekStart) total.week += 1;
      if (t >= monthStart) total.month += 1;

      const klass = classifyStatus(r.status);
      status[klass] += 1;

      const tk = r.tracking_status;
      if (tk === "in_process") trackingInProcess += 1;
      else if (tk === "failed") trackingFailedFollowup += 1;
      else trackingPending += 1;

      const profileKey = r.resume_profile || "unknown";
      const pb = byProfile.get(profileKey) ?? emptyBucket();
      pb.overall += 1;
      if (t >= todayStart) pb.day += 1;
      if (t >= weekStart) pb.week += 1;
      if (t >= monthStart) pb.month += 1;
      byProfile.set(profileKey, pb);

      if (r.user_id) {
        const ub = byUser.get(r.user_id) ?? {
          label: r.user_email ?? r.user_id,
          bucket: emptyBucket(),
        };
        ub.bucket.overall += 1;
        if (t >= todayStart) ub.bucket.day += 1;
        if (t >= weekStart) ub.bucket.week += 1;
        if (t >= monthStart) ub.bucket.month += 1;
        if (r.user_email) ub.label = r.user_email;
        byUser.set(r.user_id, ub);
      }

      const dayBucketKey = jstStartOfDayUtcMs(new Date(t));
      const dayCounts = dayBuckets.get(dayBucketKey);
      if (dayCounts) {
        dayCounts.total += 1;
        if (klass === "completed") dayCounts.completed += 1;
        else if (klass === "failed") dayCounts.failed += 1;
      }

      // In-window extras
      if (t >= windowStart) {
        totalInWindow += 1;
        if (klass === "completed") completedInWindow += 1;
        if (klass === "failed") failedInWindow += 1;
        weekdayCounts[jstWeekday(t)] += 1;
        if (r.company_name) companiesInWindow.add(r.company_name.trim().toLowerCase());
        if (r.role_name) rolesInWindow.add(r.role_name.trim().toLowerCase());
        if (klass === "failed") recentFailures.push(r);
      }
    }

    recentFailures.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    const successRate =
      status.completed + status.failed > 0
        ? Math.round((status.completed / (status.completed + status.failed)) * 100)
        : null;

    const sortedDays = Array.from(dayBuckets.entries()).sort((a, b) => a[0] - b[0]);
    let peakDayCount = 0;
    let peakDayKey = 0;
    for (const [k, v] of sortedDays) {
      if (v.total > peakDayCount) {
        peakDayCount = v.total;
        peakDayKey = k;
      }
    }

    const sortedProfiles = Array.from(byProfile.entries()).sort(
      (a, b) => b[1].overall - a[1].overall,
    );
    const sortedUsers = Array.from(byUser.entries()).sort(
      (a, b) => b[1].bucket.overall - a[1].bucket.overall,
    );

    const avgPerDay = rangeDays > 0 ? totalInWindow / rangeDays : 0;

    return {
      total,
      status,
      successRate,
      sortedProfiles,
      sortedUsers,
      sortedDays,
      peakDayCount,
      peakDayKey,
      tracking: {
        pending: trackingPending,
        inProcess: trackingInProcess,
        failedFollowup: trackingFailedFollowup,
      },
      window: {
        totalInWindow,
        completedInWindow,
        failedInWindow,
        avgPerDay,
        uniqueCompanies: companiesInWindow.size,
        uniqueRoles: rolesInWindow.size,
        weekdayCounts,
        recentFailures: recentFailures.slice(0, 5),
      },
    };
  }, [scopedRows, rangeDays]);

  const orphanCount = useMemo(() => rows.filter((r) => !r.user_id).length, [rows]);

  return (
    <>
      <h1>Analytics</h1>
      <p className="sub">
        {isAdmin
          ? "Aggregate metrics across all users. Switch scope to drill into one user."
          : `Your runs only — signed in as ${currentUser?.email ?? ""}.`}
      </p>

      <div className="actions" style={{ marginBottom: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        {isAdmin && (
          <>
            <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
              Scope
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">All users</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email} ({u.role})
                  </option>
                ))}
              </select>
            </label>
            {scope && (
              <button type="button" className="btn small" onClick={() => setScope("")}>
                Reset
              </button>
            )}
          </>
        )}
        <label className="mono" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
          Window
          <select
            value={String(rangeDays)}
            onChange={(e) => setRangeDays(Number(e.target.value) as RangeDays)}
          >
            {RANGE_PRESETS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
        {isAdmin && orphanCount > 0 && !scope && (
          <span className="sub mono" style={{ fontSize: "0.74rem" }}>
            ({orphanCount} legacy rows have no user assigned)
          </span>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {/* --- KPI row --- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(9.5rem, 1fr))",
          gap: "0.6rem",
          marginBottom: "1rem",
        }}
      >
        <KpiCard label="Today" value={stats.total.day} />
        <KpiCard label="Last 7 days" value={stats.total.week} />
        <KpiCard label="This month" value={stats.total.month} />
        <KpiCard label="Overall" value={stats.total.overall} />
        <KpiCard
          label="Success rate"
          value={stats.successRate === null ? "—" : `${stats.successRate}%`}
          subtitle={`${stats.status.completed} ok / ${stats.status.failed} failed`}
        />
      </div>

      {/* --- In-window summary row --- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(9.5rem, 1fr))",
          gap: "0.6rem",
          marginBottom: "1rem",
        }}
      >
        <KpiCard
          label={`In ${rangeDays} days`}
          value={stats.window.totalInWindow}
          subtitle={`${stats.window.completedInWindow} ok / ${stats.window.failedInWindow} failed`}
        />
        <KpiCard
          label="Avg / day"
          value={stats.window.avgPerDay.toFixed(1)}
        />
        <KpiCard
          label="Peak day"
          value={stats.peakDayCount}
          subtitle={stats.peakDayCount > 0 ? `on ${jstDateLabel(stats.peakDayKey)}` : undefined}
        />
        <KpiCard
          label="Unique companies"
          value={stats.window.uniqueCompanies}
        />
        <KpiCard
          label="Unique roles"
          value={stats.window.uniqueRoles}
        />
      </div>

      {/* --- 2-column grid for chart + weekday histogram --- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))",
          gap: "1rem",
          marginBottom: "1rem",
          alignItems: "start",
        }}
      >
        <div className="card">
          <h3>Last {rangeDays} days</h3>
          <DailyBars days={stats.sortedDays} peak={stats.peakDayCount} rangeDays={rangeDays} />
        </div>
        <div className="card">
          <h3>By day of week (in window)</h3>
          <WeekdayBars counts={stats.window.weekdayCounts} />
        </div>
      </div>

      {/* --- Status + tracking breakdown --- */}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <h3>Status breakdown</h3>
        <p className="mono" style={{ margin: "0.25rem 0" }}>
          completed: {stats.status.completed} · failed: {stats.status.failed} · generating:{" "}
          {stats.status.generating}
          {stats.status.other > 0 ? ` · other: ${stats.status.other}` : ""}
        </p>
        <p className="mono" style={{ margin: "0.25rem 0", fontSize: "0.78rem", opacity: 0.85 }}>
          tracking — pending: {stats.tracking.pending} · in process: {stats.tracking.inProcess} ·
          failed follow-up: {stats.tracking.failedFollowup}
        </p>
      </div>

      {/* --- Recent failures --- */}
      {stats.window.recentFailures.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3>Recent failures (last 5 in window)</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th align="left">When</th>
                <th align="left">Company · Role</th>
                <th align="left">Reason</th>
              </tr>
            </thead>
            <tbody>
              {stats.window.recentFailures.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid var(--border, #444)" }}>
                  <td className="mono" style={{ fontSize: "0.74rem" }}>
                    {jstDateLabel(jstStartOfDayUtcMs(new Date(r.created_at)))}
                  </td>
                  <td style={{ fontSize: "0.78rem" }}>
                    {r.company_name} · {r.role_name}
                  </td>
                  <td
                    className="mono sub"
                    style={{
                      fontSize: "0.72rem",
                      maxWidth: "28rem",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={r.generation_error ?? ""}
                  >
                    {r.generation_error ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Per user + per profile tables --- */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))",
          gap: "1rem",
          alignItems: "start",
        }}
      >
        {isAdmin && (
          <div className="card">
            <h3>Per user</h3>
            {stats.sortedUsers.length === 0 ? (
              <p className="sub">No user-attributed runs in this scope.</p>
            ) : (
              <BreakdownTable
                rows={stats.sortedUsers.map(([id, { label, bucket }]) => ({
                  key: id,
                  label,
                  bucket,
                }))}
                overallTotal={stats.total.overall}
                labelHeader="User"
              />
            )}
          </div>
        )}
        <div className="card">
          <h3>Per profile</h3>
          {stats.sortedProfiles.length === 0 ? (
            <p className="sub">No runs in this scope.</p>
          ) : (
            <BreakdownTable
              rows={stats.sortedProfiles.map(([id, bucket]) => ({ key: id, label: id, bucket }))}
              overallTotal={stats.total.overall}
              labelHeader="Profile"
            />
          )}
        </div>
      </div>
    </>
  );
}

function KpiCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: number | string;
  subtitle?: string;
}) {
  return (
    <div className="card" style={{ padding: "0.75rem", textAlign: "center" }}>
      <div className="sub" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      <div style={{ fontSize: "1.5rem", fontWeight: 600, marginTop: "0.2rem" }}>{value}</div>
      {subtitle ? (
        <div className="sub mono" style={{ fontSize: "0.68rem", marginTop: "0.1rem" }}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

function BreakdownTable({
  rows,
  overallTotal,
  labelHeader,
}: {
  rows: { key: string; label: string; bucket: Bucket }[];
  overallTotal: number;
  labelHeader: string;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th align="left">{labelHeader}</th>
          <th align="right">Today</th>
          <th align="right">7d</th>
          <th align="right">Month</th>
          <th align="right">Overall</th>
          <th align="right">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, label, bucket }) => {
          const share = overallTotal > 0 ? Math.round((bucket.overall / overallTotal) * 100) : 0;
          return (
            <tr key={key} style={{ borderTop: "1px solid var(--border, #444)" }}>
              <td>
                <span className="mono">{label}</span>
              </td>
              <td align="right" className="mono">{bucket.day}</td>
              <td align="right" className="mono">{bucket.week}</td>
              <td align="right" className="mono">{bucket.month}</td>
              <td align="right" className="mono">{bucket.overall}</td>
              <td align="right" className="mono sub">{share}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function pickAxisTickIndices(count: number): Set<number> {
  // Show roughly 5–8 tick labels across the window, always including first and last.
  if (count <= 8) return new Set(Array.from({ length: count }, (_, i) => i));
  const target = 6;
  const step = Math.max(1, Math.round((count - 1) / (target - 1)));
  const ticks = new Set<number>();
  for (let i = 0; i < count; i += step) ticks.add(i);
  ticks.add(0);
  ticks.add(count - 1);
  return ticks;
}

function DailyBars({
  days,
  peak,
  rangeDays,
}: {
  days: [number, { total: number; completed: number; failed: number }][];
  peak: number;
  rangeDays: number;
}) {
  if (days.length === 0 || peak === 0) {
    return <p className="sub">No activity in this window.</p>;
  }
  const tickIndices = pickAxisTickIndices(days.length);
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${days.length}, 1fr)`,
          gap: "0.18rem",
          alignItems: "end",
          height: "8rem",
        }}
      >
        {days.map(([ts, v]) => {
          const total = v.total;
          const okHeight = peak > 0 ? (v.completed / peak) * 100 : 0;
          const failHeight = peak > 0 ? (v.failed / peak) * 100 : 0;
          const otherHeight =
            peak > 0 ? Math.max(0, ((total - v.completed - v.failed) / peak) * 100) : 0;
          return (
            <div
              key={ts}
              title={`${jstDateLabel(ts)} — total ${total} (ok ${v.completed} / fail ${v.failed})`}
              style={{
                display: "flex",
                flexDirection: "column-reverse",
                alignItems: "stretch",
                height: "100%",
                borderBottom: "1px solid var(--border, #444)",
              }}
            >
              {okHeight > 0 && (
                <div
                  style={{
                    height: `${okHeight}%`,
                    background: "var(--ok, #5fbf5f)",
                    borderRadius: "1px 1px 0 0",
                  }}
                />
              )}
              {failHeight > 0 && (
                <div
                  style={{
                    height: `${failHeight}%`,
                    background: "var(--danger, #c66)",
                  }}
                />
              )}
              {otherHeight > 0 && (
                <div
                  style={{
                    height: `${otherHeight}%`,
                    background: "var(--sub, #888)",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${days.length}, 1fr)`,
          gap: "0.18rem",
          marginTop: "0.3rem",
          fontSize: "0.65rem",
          fontFamily: "var(--mono, monospace)",
          color: "var(--sub, #888)",
          overflow: "hidden",
        }}
      >
        {days.map(([ts], i) => (
          <div key={ts} style={{ textAlign: "center", whiteSpace: "nowrap" }}>
            {tickIndices.has(i) ? jstDateLabel(ts) : ""}
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          gap: "0.8rem",
          marginTop: "0.5rem",
          fontSize: "0.72rem",
          color: "var(--sub, #888)",
        }}
      >
        <span>
          <span
            style={{
              display: "inline-block",
              width: "0.6rem",
              height: "0.6rem",
              background: "var(--ok, #5fbf5f)",
              marginRight: "0.25rem",
            }}
          />
          completed
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: "0.6rem",
              height: "0.6rem",
              background: "var(--danger, #c66)",
              marginRight: "0.25rem",
            }}
          />
          failed
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: "0.6rem",
              height: "0.6rem",
              background: "var(--sub, #888)",
              marginRight: "0.25rem",
            }}
          />
          other
        </span>
        <span className="sub" style={{ marginLeft: "auto" }}>
          peak {peak} · {rangeDays} days
        </span>
      </div>
    </>
  );
}

function WeekdayBars({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <p className="sub">No activity in this window.</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      {counts.map((c, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "2.6rem 1fr 2rem",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.76rem",
          }}
        >
          <span className="mono sub">{WEEKDAY_SHORT[i]}</span>
          <div
            style={{
              position: "relative",
              background: "rgba(255,255,255,0.05)",
              borderRadius: "2px",
              height: "0.85rem",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(c / max) * 100}%`,
                height: "100%",
                background: "var(--accent, #6aa6ff)",
              }}
            />
          </div>
          <span className="mono" style={{ textAlign: "right" }}>
            {c}
          </span>
        </div>
      ))}
    </div>
  );
}
