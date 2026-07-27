import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { IconMark } from "../../ui/icons";
import "./AuthShell.css";

/**
 * Shared shell for `/login` and `/setup`. These render outside the signed-in
 * layout, so they carry the brand themselves: mark, name, a back-to-home link
 * and a centered card for whatever form the page wants to show.
 *
 * The palette is scoped under `.tb-auth` (see AuthShell.css) and mirrors the
 * app's Tryvera tokens, so signing in is not a jump between two visual worlds.
 * The `tb-` class prefix is kept because Setup.tsx and Login.tsx both target
 * these class names — renaming them would be churn, not design.
 */

type Props = {
  /** Headline at the top of the auth card. */
  title: string;
  /** Sub-copy under the headline. Optional. */
  subtitle?: ReactNode;
  /** The form / body content. */
  children: ReactNode;
  /** Small note below the card (e.g. "First time? …"). Optional. */
  footer?: ReactNode;
};

export default function AuthShell({ title, subtitle, children, footer }: Props) {
  return (
    <div className="tb-auth">
      <header className="tb-auth-nav">
        <Link to="/" className="tb-brand" aria-label="Tryvera home">
          <span className="tb-brand-mark" aria-hidden="true">
            <IconMark />
          </span>
          <span className="tb-brand-name">Tryvera</span>
        </Link>
        <Link to="/" className="tb-auth-back">
          ← Back to home
        </Link>
      </header>
      <main className="tb-auth-main">
        <div className="tb-auth-card">
          <h1 className="tb-auth-title">{title}</h1>
          {subtitle ? <p className="tb-auth-sub">{subtitle}</p> : null}
          <div className="tb-auth-body">{children}</div>
        </div>
        {footer ? <p className="tb-auth-foot">{footer}</p> : null}
      </main>
    </div>
  );
}
