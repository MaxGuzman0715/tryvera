import type { NextFunction, Request, Response } from "express";
import { findSession } from "./sessionStore.js";
import { findUserById } from "./userStore.js";
import { getSessionIdFromRequest } from "./cookies.js";
import type { User } from "../types.js";

/**
 * Bearer token from the `Authorization` header. The Tryvify extension cannot
 * rely on the `enpply_sid` cookie (cross-origin, no credentials), so it sends
 * the session id as `Authorization: Bearer <session-id>` instead. The token is
 * just the session id, so resolution below is identical to the cookie path.
 */
function getBearerToken(req: Request): string {
  const h = req.headers.authorization;
  if (!h) return "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : "";
}

declare module "express-serve-static-core" {
  interface Request {
    /** Authenticated user, set by `resolveUser` when a valid session exists. */
    user?: User;
  }
}

/**
 * Populates `req.user` if a valid session is present (Authorization: Bearer
 * token preferred, then the `enpply_sid` cookie). Does not
 * reject unauthenticated requests — `requireAuth` handles that. This
 * runs early so downstream middleware can branch on presence of user.
 */
export async function resolveUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sid = getBearerToken(req) || getSessionIdFromRequest(req);
    if (!sid) return next();
    const session = await findSession(sid);
    if (!session) return next();
    const user = await findUserById(session.user_id);
    if (!user) return next();
    req.user = user;
  } catch {
    /* fall through — treat as unauthenticated */
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin privileges required." });
    return;
  }
  next();
}

/**
 * Admins see everything; regular users see only the resources belonging
 * to profile ids in their `profile_ids` list. Returns true if the user is
 * allowed to access the given profile id.
 */
export function canAccessProfile(user: User, profileId: string): boolean {
  if (user.role === "admin") return true;
  return (user.profile_ids ?? []).includes(profileId);
}

/**
 * Application ownership: admins see every row; regular users see only
 * applications they personally created. Legacy rows without `user_id`
 * (written before RBAC was added) are admin-only.
 */
export function canAccessApplication(
  user: User,
  entry: { user_id?: string },
): boolean {
  if (user.role === "admin") return true;
  if (!entry.user_id) return false;
  return entry.user_id === user.id;
}
