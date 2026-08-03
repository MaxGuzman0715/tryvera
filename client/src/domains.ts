/**
 * Hostname helpers for the marketing-vs-app subdomain split.
 *
 * Layout:
 *   - `tealbridge.online`        → marketing landing for everyone
 *   - `app.tealbridge.online`    → Tryvera app (Login at `/`, app pages once signed in)
 *   - anything else (localhost,
 *     Vite preview, IPs, …)      → "dev host"; landing for unauth, app for auth
 *
 * Both subdomains are served by the same Express + Vite build behind Caddy
 * (see root README "Serving over HTTPS on a Windows VPS"). The split is
 * purely client-side routing inside `App.tsx`.
 *
 * To repoint at staging/preview hostnames without rebuilding the JS, set
 * the Vite env vars below at build time:
 *   - `VITE_MARKETING_DOMAIN`  (default: `tealbridge.online`)
 *   - `VITE_APP_DOMAIN`        (default: `app.tealbridge.online`)
 */

const MARKETING_DOMAIN =
  (import.meta.env.VITE_MARKETING_DOMAIN as string | undefined)?.trim() ||
  "tealbridge.online";
const APP_DOMAIN =
  (import.meta.env.VITE_APP_DOMAIN as string | undefined)?.trim() ||
  "app.tealbridge.online";

function currentHost(): string {
  if (typeof window === "undefined") return "";
  return window.location.hostname.toLowerCase();
}

export function isMarketingHost(): boolean {
  const h = currentHost();
  return h === MARKETING_DOMAIN || h === `www.${MARKETING_DOMAIN}`;
}

export function isAppHost(): boolean {
  return currentHost() === APP_DOMAIN;
}

/**
 * Anything that isn't the marketing or app production hostname — localhost,
 * IP literals, Vite preview deploys, etc. Used to keep `npm run dev` showing
 * the marketing landing for unauth users without faking a hostname.
 */
export function isDevHost(): boolean {
  return !isMarketingHost() && !isAppHost();
}

function withPath(domain: string, path: string): string {
  const cleaned = path.startsWith("/") ? path : `/${path}`;
  return `https://${domain}${cleaned}`;
}

export function appUrl(path = "/"): string {
  return withPath(APP_DOMAIN, path);
}

export function marketingUrl(path = "/"): string {
  return withPath(MARKETING_DOMAIN, path);
}

/**
 * Best `href` for navigating into the app. On the app host or a dev host we
 * keep it relative (no full reload, React Router handles it). On the
 * marketing host we cross over with an absolute URL.
 */
export function appHref(path = "/"): string {
  if (isMarketingHost()) return appUrl(path);
  return path;
}

/**
 * Mirror of `appHref` for the marketing site — relative when we're already
 * on the marketing host (or a dev host), absolute when we're inside the
 * app subdomain.
 */
export function marketingHref(path = "/"): string {
  if (isAppHost()) return marketingUrl(path);
  return path;
}
