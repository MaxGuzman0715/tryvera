import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dataDir } from "../paths.js";
import type { User, UserPreferences, UserRecord, UserRole } from "../types.js";

type UsersFile = { users: UserRecord[] };

const usersPath = () => path.join(dataDir(), "users.json");

async function readFile(): Promise<UsersFile> {
  try {
    const raw = await fs.readFile(usersPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<UsersFile>;
    const users = Array.isArray(parsed.users) ? parsed.users : [];
    return { users: users.filter((u): u is UserRecord => Boolean(u && u.id && u.email)) };
  } catch {
    return { users: [] };
  }
}

async function writeFile(data: UsersFile): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(usersPath(), JSON.stringify(data, null, 2), "utf8");
}

function toPublic(r: UserRecord): User {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    created_at: r.created_at,
    profile_ids: r.profile_ids ?? [],
    ...(r.preferences ? { preferences: r.preferences } : {}),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function newUserId(): string {
  return `u_${randomBytes(8).toString("hex")}`;
}

export async function countUsers(): Promise<number> {
  const { users } = await readFile();
  return users.length;
}

export async function listUsers(): Promise<User[]> {
  const { users } = await readFile();
  return users.map(toPublic);
}

export async function findUserById(id: string): Promise<User | null> {
  const { users } = await readFile();
  const u = users.find((x) => x.id === id);
  return u ? toPublic(u) : null;
}

export async function findUserRecordByEmail(email: string): Promise<UserRecord | null> {
  const { users } = await readFile();
  const target = normalizeEmail(email);
  return users.find((u) => normalizeEmail(u.email) === target) ?? null;
}

export async function findUserRecordById(id: string): Promise<UserRecord | null> {
  const { users } = await readFile();
  return users.find((u) => u.id === id) ?? null;
}

export type CreateUserInput = {
  email: string;
  role: UserRole;
  password_hash: string;
  profile_ids?: string[];
};

export async function createUser(input: CreateUserInput): Promise<User> {
  const data = await readFile();
  const target = normalizeEmail(input.email);
  if (data.users.some((u) => normalizeEmail(u.email) === target)) {
    throw new Error("A user with that email already exists.");
  }
  const record: UserRecord = {
    id: newUserId(),
    email: input.email.trim(),
    role: input.role,
    password_hash: input.password_hash,
    profile_ids: input.profile_ids ?? [],
    created_at: new Date().toISOString(),
  };
  data.users.push(record);
  await writeFile(data);
  return toPublic(record);
}

export type UpdateUserInput = {
  email?: string;
  role?: UserRole;
  password_hash?: string;
  profile_ids?: string[];
};

export async function updateUser(id: string, patch: UpdateUserInput): Promise<User> {
  const data = await readFile();
  const idx = data.users.findIndex((u) => u.id === id);
  if (idx < 0) throw new Error("User not found.");
  const prev = data.users[idx];
  if (patch.email && normalizeEmail(patch.email) !== normalizeEmail(prev.email)) {
    const target = normalizeEmail(patch.email);
    if (data.users.some((u) => u.id !== id && normalizeEmail(u.email) === target)) {
      throw new Error("A user with that email already exists.");
    }
  }
  const next: UserRecord = {
    ...prev,
    ...(patch.email !== undefined ? { email: patch.email.trim() } : {}),
    ...(patch.role !== undefined ? { role: patch.role } : {}),
    ...(patch.password_hash !== undefined ? { password_hash: patch.password_hash } : {}),
    ...(patch.profile_ids !== undefined ? { profile_ids: patch.profile_ids } : {}),
  };
  data.users[idx] = next;
  await writeFile(data);
  return toPublic(next);
}

export async function updateUserPreferences(
  id: string,
  next: UserPreferences,
): Promise<User> {
  const data = await readFile();
  const idx = data.users.findIndex((u) => u.id === id);
  if (idx < 0) throw new Error("User not found.");
  const prev = data.users[idx];
  const merged: UserPreferences = { ...(prev.preferences ?? {}), ...next };
  // Strip undefined/null keys so the stored shape stays clean.
  const cleaned: UserPreferences = {};
  if (merged.ui_theme === "light" || merged.ui_theme === "dark") {
    cleaned.ui_theme = merged.ui_theme;
  }
  if (typeof merged.default_resume_theme === "string" && merged.default_resume_theme.trim()) {
    cleaned.default_resume_theme = merged.default_resume_theme.trim();
  }
  if (merged.llm_tiers && typeof merged.llm_tiers === "object") {
    const validTier = (v: unknown): v is "light" | "heavy" => v === "light" || v === "heavy";
    const tiers: NonNullable<UserPreferences["llm_tiers"]> = {};
    for (const func of ["resume", "coverLetter", "answers", "matchScore"] as const) {
      const v = merged.llm_tiers[func];
      if (validTier(v)) tiers[func] = v;
    }
    if (Object.keys(tiers).length) cleaned.llm_tiers = tiers;
  }
  const updated: UserRecord = { ...prev, preferences: cleaned };
  data.users[idx] = updated;
  await writeFile(data);
  return toPublic(updated);
}

export async function deleteUser(id: string): Promise<void> {
  const data = await readFile();
  const before = data.users.length;
  data.users = data.users.filter((u) => u.id !== id);
  if (data.users.length === before) throw new Error("User not found.");
  await writeFile(data);
}

/**
 * Remove a deleted profile id from every user's assigned profile list.
 * Called when a profile is deleted so we don't leave dangling references.
 */
export async function unassignProfileFromAllUsers(profileId: string): Promise<void> {
  const data = await readFile();
  let changed = false;
  for (const u of data.users) {
    const next = (u.profile_ids ?? []).filter((p) => p !== profileId);
    if (next.length !== (u.profile_ids ?? []).length) {
      u.profile_ids = next;
      changed = true;
    }
  }
  if (changed) await writeFile(data);
}
