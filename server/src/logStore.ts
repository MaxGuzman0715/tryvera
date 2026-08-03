import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.js";
import type { ApplicationLogEntry } from "./types.js";

const logPath = () => path.join(dataDir(), "application_logs.json");

type LogFile = { applications: ApplicationLogEntry[] };

async function readFile(): Promise<LogFile> {
  try {
    const raw = await fs.readFile(logPath(), "utf8");
    const data = JSON.parse(raw) as LogFile;
    if (!data.applications || !Array.isArray(data.applications)) return { applications: [] };
    return data;
  } catch {
    return { applications: [] };
  }
}

async function writeFile(data: LogFile): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(logPath(), JSON.stringify(data, null, 2), "utf8");
}

export async function listApplications(): Promise<ApplicationLogEntry[]> {
  const { applications } = await readFile();
  return [...applications].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function getApplication(id: string): Promise<ApplicationLogEntry | undefined> {
  const { applications } = await readFile();
  return applications.find((a) => a.id === id);
}

export async function appendApplication(entry: ApplicationLogEntry): Promise<void> {
  const data = await readFile();
  data.applications.push(entry);
  await writeFile(data);
}

export async function updateApplication(
  id: string,
  patch: Partial<ApplicationLogEntry>
): Promise<ApplicationLogEntry | null> {
  const data = await readFile();
  const idx = data.applications.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  data.applications[idx] = { ...data.applications[idx], ...patch };
  await writeFile(data);
  return data.applications[idx];
}

export async function removeApplication(id: string): Promise<ApplicationLogEntry | null> {
  const data = await readFile();
  const idx = data.applications.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const [removed] = data.applications.splice(idx, 1);
  await writeFile(data);
  return removed;
}
