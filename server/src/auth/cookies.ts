import type { Request, Response } from "express";

export const SESSION_COOKIE = "enpply_sid";

/** Parse a raw Cookie header into a plain object. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const piece of header.split(";")) {
    const idx = piece.indexOf("=");
    if (idx < 0) continue;
    const name = piece.slice(0, idx).trim();
    const value = piece.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function getSessionIdFromRequest(req: Request): string {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] ?? "";
}

/**
 * Set the session cookie on the response. `secure` must be true when the
 * app is served over HTTPS; for plain-HTTP localhost dev we leave it off
 * so the cookie actually persists.
 */
export function setSessionCookie(res: Response, sessionId: string, expiresAt: number): void {
  const maxAgeSec = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const secure = process.env.ENPPLY_COOKIE_SECURE === "1";
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res: Response): void {
  const secure = process.env.ENPPLY_COOKIE_SECURE === "1";
  const parts = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
