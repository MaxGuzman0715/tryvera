import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import "./AuthShell.css";

/**
 * Shared shell for `/login` and `/setup` so the auth surfaces match the
 * TealBridge marketing landing instead of being framed by the signed-in
 * Enpply nav. Renders the brand, a back-to-home link, and a centered card
 * for whatever form the page wants to show.
 *
 * Tokens are duplicated from Landing.css on purpose — both files own their
 * scoped palette (`.tb-landing` / `.tb-auth`) and the duplication is small
 * (one block, see AuthShell.css). Extract into a shared tb-theme.css if a
 * third TealBridge surface ever shows up.
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
        <Link to="/" className="tb-brand" aria-label="TealBridge home">
          <span className="tb-brand-mark" aria-hidden="true" />
          <span className="tb-brand-name">TealBridge</span>
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
