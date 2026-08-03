import type { Express } from "express";
import { z } from "zod";
import {
  createUser,
  deleteUser,
  findUserById,
  listUsers,
  updateUser,
} from "./userStore.js";
import { deleteAllSessionsForUser } from "./sessionStore.js";
import { hashPassword } from "./passwords.js";
import { requireAdmin, requireAuth } from "./middleware.js";
import { listProfiles } from "../profileStore.js";

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(["admin", "user", "logger", "manual_logger"]),
  profile_ids: z.array(z.string()).optional(),
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(["admin", "user", "logger", "manual_logger"]).optional(),
  password: z.string().min(6).optional(),
  profile_ids: z.array(z.string()).optional(),
});

async function validateProfileIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const all = await listProfiles();
  const valid = new Set(all.map((p) => p.id));
  return ids.filter((id) => valid.has(id));
}

export function registerUserRoutes(app: Express): void {
  app.get("/api/users", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const users = await listUsers();
      res.json({ users });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get<{ id: string }>("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const u = await findUserById(req.params.id);
      if (!u) return res.status(404).json({ error: "User not found." });
      res.json({ user: u });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const parsed = createUserSchema.parse(req.body);
      const profile_ids = parsed.profile_ids ? await validateProfileIds(parsed.profile_ids) : [];
      const password_hash = await hashPassword(parsed.password);
      const user = await createUser({
        email: parsed.email,
        role: parsed.role,
        password_hash,
        profile_ids,
      });
      res.json({ user });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.put<{ id: string }>("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      const parsed = updateUserSchema.parse(req.body);
      const target = await findUserById(req.params.id);
      if (!target) return res.status(404).json({ error: "User not found." });

      // Prevent an admin from demoting themselves and leaving zero admins.
      if (target.id === req.user!.id && parsed.role && parsed.role !== "admin") {
        return res
          .status(400)
          .json({ error: "You cannot demote your own admin account while logged in." });
      }

      const patch: Parameters<typeof updateUser>[1] = {};
      if (parsed.email !== undefined) patch.email = parsed.email;
      if (parsed.role !== undefined) patch.role = parsed.role;
      if (parsed.profile_ids !== undefined)
        patch.profile_ids = await validateProfileIds(parsed.profile_ids);
      if (parsed.password !== undefined) patch.password_hash = await hashPassword(parsed.password);

      const updated = await updateUser(req.params.id, patch);
      // If the password changed, kill any existing sessions so the old cookie stops working.
      if (parsed.password !== undefined) await deleteAllSessionsForUser(updated.id);
      res.json({ user: updated });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete<{ id: string }>("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
      if (req.user!.id === req.params.id) {
        return res.status(400).json({ error: "You cannot delete your own account while logged in." });
      }
      await deleteUser(req.params.id);
      await deleteAllSessionsForUser(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
