import { useEffect, useState } from "react";
import { api } from "./api";

/** Fire after anything that changes the counts (Mark all seen, Mark done). */
export const COUNTS_EVENT = "schedule-seen";
export const refreshInterviewCounts = () => window.dispatchEvent(new Event(COUNTS_EVENT));

/**
 * The two interview badges: rows with news on the Schedule, and emails that
 * need your attention in the Inbox. Checked on load, every two minutes, and
 * right after a change. Quiet, in-app only.
 */
export function useInterviewCounts(enabled = true): { news: number; attention: number } {
  const [counts, setCounts] = useState({ news: 0, attention: 0 });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      void api
        .scheduleNewCount()
        .then((r) => live && setCounts({ news: r.count, attention: r.attention ?? 0 }))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 120_000);
    window.addEventListener(COUNTS_EVENT, load);
    return () => {
      live = false;
      window.clearInterval(t);
      window.removeEventListener(COUNTS_EVENT, load);
    };
  }, [enabled]);
  return counts;
}
