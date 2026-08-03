import "./LoadingScreen.css";

/**
 * Full-viewport loading state used while the auth context is hydrating
 * (initial `/api/auth/me` call) and during route-level guards. Matches
 * the Tryvera marketing theme so it doesn't flash a bare white/black
 * "Loading…" string before the first authenticated render.
 *
 * Best-practice notes:
 *   - Indeterminate progress bar communicates "still working" without
 *     promising a percentage we don't have.
 *   - Brand mark + wordmark gives the user something to anchor on; reduces
 *     the perceived wait versus a bare spinner.
 *   - `role="status"` + `aria-live="polite"` lets screen readers announce
 *     the wait without stealing focus.
 *   - `prefers-reduced-motion` is respected — the bar shows a static fill
 *     instead of the shuttle animation when motion is disabled.
 */

type Props = {
  /** Sub-line under the wordmark. Defaults to a generic message. */
  label?: string;
};

export default function LoadingScreen({ label = "Getting things ready…" }: Props) {
  return (
    <div className="tb-loading">
      <div className="tb-loading-card" role="status" aria-live="polite">
        <span className="tb-loading-mark" aria-hidden="true" />
        <span className="tb-loading-name">Tryvera</span>
        <span className="tb-loading-bar" aria-hidden="true">
          <span className="tb-loading-bar-fill" />
        </span>
        <span className="tb-loading-label">{label}</span>
      </div>
    </div>
  );
}
