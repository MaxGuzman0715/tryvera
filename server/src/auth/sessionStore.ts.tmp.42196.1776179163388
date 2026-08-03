import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dataDir } from "../paths.js";
import type { Session } from "../types.js";

type SessionsFile = { sessions: Session[] };

const sessionsPath = () => path.join(dataDir(), "sessions.json");

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function readFile(): Promise<SessionsFile> {
  try {
    const raw = await fs.readFile(sessionsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionsFile>;
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    return { sessions };
  } catch {
    return { sessions: [] };
  }
}

async function writeFile(data: SessionsFile): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(sessionsPath(), JSON.stringify(data, null, 2), "utf8");
}

function newSessionId(): string {
  // base64url with no padding — safe for cookies, 256 bits of entropy.
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function purgeExpired(data: SessionsFile): Promise<boolean> {
  const now = Date.now();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.expires_at > now);
  return data.sessions.length !== before;
}

export async function createSession(userId: string, ttlMs: number = DEFAULT_TTL_MS): Promise<Session> {
  const data = await readFile();
  await purgeExpired(data);
  const now = Date.now();
  const session: Session = {
    id: newSessionId(),
    user_id: userId,
    created_at: now,
    expires_at: now + ttlMs,
  };
  data.sessions.push(session);
  await writeFile(data);
  return session;
}

export async function findSession(id: string): Promise<Session | null> {
  if (!id) return null;
  const data = await readFile();
  const now = Date.now();
  const found = data.sessions.find((s) => s.id === id);
  if (!found) return null;
  if (found.expires_at <= now) {
    data.sessions = data.sessions.filter((s) => s.id !== id);
    await writeFile(data);
    return null;
  }
  return found;
}

export async function deleteSession(id: string): Promise<void> {
  if (!id) return;
  const data = await readFile();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.id !== id);
  if (data.sessions.length !== before) await writeFile(data);
}

export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  const data = await readFile();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.user_id !== userId);
  if (data.sessions.length !== before) await writeFile(data);
}
