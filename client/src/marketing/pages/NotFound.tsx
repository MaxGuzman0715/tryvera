import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../enpply/auth/AuthContext";
import "./NotFound.css";

/**
 * 404 surface. Rendered for any route the React Router can't match — both
 * for unauthenticated visitors and signed-in users — so the visual stays
 * the public marketing theme rather than the Tryvera app shell. Wired in
 * App.tsx via a known-route check that short-circuits before the Layout
 * wrapper.
 *
 * Best-practice notes baked in:
 *   - Surfaces the attempted path so typos are obvious.
 *   - Contextual CTAs (signed-in vs. anonymous) so the next step actually
 *     leads somewhere useful.
 *   - Sets `<meta name="robots" content="noindex">` while mounted — a pure
 *     SPA can't return HTTP 404 (index.html always 200s) so we noindex
 *     on the client to keep search engines out of mistakenly-typed URLs.
 *   - No auto-redirect: silent redirects hide stale links and confuse
 *     browser history; a one-click manual escape is friendlier.
 */

export default function NotFound() {
  const location = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    // Tag this view as noindex while it's mounted; restore on unmount so
    // the directive doesn't leak onto subsequent route-changes back into
    // legitimate pages.
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow";
    document.head.appendChild(meta);
    const prevTitle = document.title;
    document.title = "Page not found · Tryvera";
    return () => {
      meta.remove();
      document.title = prevTitle;
    };
  }, []);

  const attempted = `${location.pathname}${location.search}${location.hash}`;
  const homeHref = user ? "/apply" : "/";
  const homeLabel = user ? "Back to your dashboard" : "Back to home";

  return (
    <div className="tb-notfound">
      <header className="tb-notfound-nav">
        <Link to="/" className="tb-brand" aria-label="Tryvera home">
          <span className="tb-brand-mark" aria-hidden="true" />
          <span className="tb-brand-name">Tryvera</span>
        </Link>
        <Link to="/" className="tb-notfound-back">
          ← Back to home
        </Link>
      </header>

      <main className="tb-notfound-main">
        <p className="tb-notfound-eyebrow">Page not found</p>
        <h1 className="tb-notfound-title">
          We can't find that page.
        </h1>
        <p className="tb-notfound-sub">
          The page may have moved, the link may be stale, or the URL might have a typo.
          Here's what you tried to open:
        </p>
        <p className="tb-notfound-path mono" aria-label="Attempted path">
          {attempted}
        </p>

        <div className="tb-notfound-actions">
          <Link to={homeHref} className="tb-btn tb-btn-primary tb-btn-lg">
            {homeLabel}
          </Link>
          {!user ? (
            <Link to="/login" className="tb-btn tb-btn-ghost tb-btn-lg">
              Sign in
            </Link>
          ) : null}
          <a href="mailto:hr@tryvera.com" className="tb-btn tb-btn-ghost tb-btn-lg">
            Report a broken link
          </a>
        </div>

        <ul className="tb-notfound-suggest" aria-label="Popular destinations">
          <li>
            <Link to="/">
              <strong>Home</strong>
              <span>What Tryvera does, the platform, and the team.</span>
            </Link>
          </li>
          <li>
            <Link to="/login">
              <strong>Sign in</strong>
              <span>Already a member? Pick up where you left off.</span>
            </Link>
          </li>
          <li>
            <a href="/#contact">
              <strong>Contact</strong>
              <span>Email, phone, and offices in SF and Manila.</span>
            </a>
          </li>
        </ul>
      </main>
    </div>
  );
}
