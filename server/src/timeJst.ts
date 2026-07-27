const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstDate(d = new Date()): Date {
  return new Date(d.getTime() + JST_OFFSET_MS);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function nowJstIso(): string {
  const j = toJstDate(new Date());
  const y = j.getUTCFullYear();
  const m = pad2(j.getUTCMonth() + 1);
  const d = pad2(j.getUTCDate());
  const hh = pad2(j.getUTCHours());
  const mm = pad2(j.getUTCMinutes());
  const ss = pad2(j.getUTCSeconds());
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+09:00`;
}

export function jstYmdCompact(d = new Date()): string {
  const j = toJstDate(d);
  const y = j.getUTCFullYear();
  const m = pad2(j.getUTCMonth() + 1);
  const day = pad2(j.getUTCDate());
  return `${y}${m}${day}`;
}

export function jstYmdForPath(d = new Date()): { year: string; month: string; day: string } {
  const j = toJstDate(d);
  return {
    year: String(j.getUTCFullYear()),
    month: pad2(j.getUTCMonth() + 1),
    day: pad2(j.getUTCDate()),
  };
}

/** Month and day for folder paths, e.g. `04_08` (JST). */
export function jstMonthDayUnderscore(d = new Date()): string {
  const { month, day } = jstYmdForPath(d);
  return `${month}_${day}`;
}

export function jstHmsCompact(d = new Date()): string {
  const j = toJstDate(d);
  const hh = pad2(j.getUTCHours());
  const mm = pad2(j.getUTCMinutes());
  const ss = pad2(j.getUTCSeconds());
  return `${hh}${mm}${ss}`;
}
