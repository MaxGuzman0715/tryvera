import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.js";

/** When set (1 / true / yes / on), each generation run writes a detailed trace under `data/logs/verbose/<appId>.log`. */
export function isVerboseEnabled(): boolean {
  const v = process.env.ENPPLY_VERBOSE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export class VerboseRunLogger {
  constructor(readonly filePath: string) {}

  async writeSection(title: string, body: string): Promise<void> {
    const stamp = new Date().toISOString();
    const block = `\n\n${"=".repeat(80)}\n${stamp}  ${title}\n${"=".repeat(80)}\n\n${body}\n`;
    await fs.appendFile(this.filePath, block, "utf8");
  }
}

export async function createVerboseLogger(appId: string): Promise<VerboseRunLogger | null> {
  if (!isVerboseEnabled()) return null;
  const dir = path.join(dataDir(), "logs", "verbose");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${appId}.log`);
  const header = [
    "Enpply verbose run log",
    `appId=${appId}`,
    `started=${new Date().toISOString()}`,
    `logFile=${filePath}`,
    "",
  ].join("\n");
  await fs.writeFile(filePath, header, "utf8");
  console.log(`[enpply] verbose trace file → ${filePath}`);
  return new VerboseRunLogger(filePath);
}
