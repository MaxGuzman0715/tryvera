import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  countUsers,
  createUser,
  findUserRecordByEmail,
  findUserById,
  updateUser,
  updateUserPreferences,
} from "./userStore.js";
import { createSession, deleteSession } from "./sessionStore.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { clearSessionCookie, getSessionIdFromRequest, setSessionCookie } from "./cookies.js";
import { requireAuth } from "./middleware.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const setupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6),
});

const tierEnum = z.enum(["light", "heavy"]);
const preferencesSchema = z.object({
  ui_theme: z.enum(["light", "dark"]).optional(),
  default_resume_theme: z.string().max(64).optional(),
  /** Per-function model tier choices (résumé / cover letter / answers / match score). */
  llm_tiers: z
    .object({
      resume: tierEnum.optional(),
      coverLetter: tierEnum.optional(),
      answers: tierEnum.optional(),
      matchScore: tierEnum.optional(),
    })
    .partial()
    .optional(),
});

export function registerAuthRoutes(app: Express): void {
  app.get("/api/auth/setup-status", async (_req, res) => {
    try {
      const n = await countUsers();
      res.json({ needsSetup: n === 0 });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/auth/setup", async (req, res) => {
    try {
      const n = await countUsers();
      if (n > 0) {
        return res.status(409).json({ error: "Setup already completed." });
      }
      const parsed = setupSchema.parse(req.body);
      const password_hash = await hashPassword(parsed.password);
      const user = await createUser({
        email: parsed.email,
        role: "admin",
        password_hash,
        profile_ids: [],
      });
      const session = await createSession(user.id);
      setSessionCookie(res, session.id, session.expires_at);
      res.json({ user, token: session.id });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const parsed = loginSchema.parse(req.body);
      const record = await findUserRecordByEmail(parsed.email);
      if (!record) {
        return res.status(401).json({ error: "Invalid email or password." });
      }
      const ok = await verifyPassword(parsed.password, record.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Invalid email or password." });
      }
      const session = await createSession(record.id);
      setSessionCookie(res, session.id, session.expires_at);
      const { password_hash: _omit, ...publicUser } = record;
      void _omit;
      // `token` is the session id, echoed in the body so the enpplify extension
      // can store it and send it as `Authorization: Bearer`. The web client uses
      // the cookie and ignores this field.
      res.json({ user: publicUser, token: session.id });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      const sid = getSessionIdFromRequest(req);
      if (sid) await deleteSession(sid);
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    res.json({ user: req.user });
  });

  app.put("/api/auth/me/preferences", requireAuth, async (req, res) => {
    try {
      const parsed = preferencesSchema.parse(req.body);
      const updated = await updateUserPreferences(req.user!.id, parsed);
      res.json({ user: updated });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/auth/change-password", requireAuth, async (req, res) => {
    try {
      const parsed = changePasswordSchema.parse(req.body);
      const record = await findUserRecordByEmail(req.user!.email);
      if (!record) return res.status(404).json({ error: "User not found." });
      const ok = await verifyPassword(parsed.current_password, record.password_hash);
      if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
      const password_hash = await hashPassword(parsed.new_password);
      await updateUser(record.id, { password_hash });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Suppress unused warning for findUserById re-export import.
  void findUserById;
}
