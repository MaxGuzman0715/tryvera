import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { promptDefaultsDir } from "./paths.js";
import { DEFAULT_PROMPTS, type PromptKey } from "./defaultPrompts.js";

const PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS) as PromptKey[];

const promptsRoot = () => promptDefaultsDir();
const activePath = () => path.join(promptsRoot(), "active.json");
const legacyFile = (key: PromptKey) => path.join(promptsRoot(), `${key}.txt`);
const keyDir = (key: PromptKey) => path.join(promptsRoot(), key);
const variantPath = (key: PromptKey, name: string) => path.join(keyDir(key), `${name}.txt`);

let diskReady: Promise<void> | null = null;

/** Safe filename segment for variant names. */
export function normalizeVariantName(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return t.slice(0, 48) || "variant";
}

/** Renames legacy `cv` → `coverLetter` in the prompt store and migrates `active.json` keys. */
async function migrateCvToCoverLetter(): Promise<void> {
  const root = promptsRoot();
  const cvDir = path.join(root, "cv");
  const clDir = path.join(root, "coverLetter");
  if (existsSync(cvDir) && !existsSync(clDir)) {
    await fs.rename(cvDir, clDir);
    console.log("[enpply] Migrated prompt store cv → coverLetter");
  }
  const ap = activePath();
  if (!existsSync(ap)) return;
  try {
    const raw = JSON.parse(await fs.readFile(ap, "utf8")) as Record<string, unknown>;
    if (typeof raw.cv === "string" && typeof raw.coverLetter !== "string") {
      raw.coverLetter = raw.cv;
      delete raw.cv;
      await fs.writeFile(ap, JSON.stringify(raw, null, 2), "utf8");
    }
  } catch {
    /* ignore */
  }
}

async function ensureDiskLayout(): Promise<void> {
  if (!diskReady) {
    diskReady = (async () => {
      const root = promptsRoot();
      await fs.mkdir(root, { recursive: true });
      await migrateCvToCoverLetter();
      for (const key of PROMPT_KEYS) {
        const leg = legacyFile(key);
        const dir = keyDir(key);
        await fs.mkdir(dir, { recursive: true });
        if (existsSync(leg)) {
          const text = await fs.readFile(leg, "utf8");
          await fs.writeFile(variantPath(key, "default"), text, "utf8");
          try {
            await fs.rename(leg, `${leg}.migrated`);
          } catch {
            /* already migrated */
          }
        }
        if (!existsSync(variantPath(key, "default"))) {
          await fs.writeFile(variantPath(key, "default"), DEFAULT_PROMPTS[key], "utf8");
        }
      }
      const defaults: Record<PromptKey, string> = {
        extraction: "default",
        resume: "default",
        coverLetter: "default",
        qa: "default",
        matchScore: "default",
      };
      if (!existsSync(activePath())) {
        await fs.writeFile(activePath(), JSON.stringify(defaults, null, 2), "utf8");
      } else {
        let parsed: Partial<Record<PromptKey, string>> = {};
        try {
          parsed = JSON.parse(await fs.readFile(activePath(), "utf8")) as Record<PromptKey, string>;
        } catch {
          parsed = {};
        }
        const merged = { ...defaults, ...parsed };
        for (const key of PROMPT_KEYS) {
          const names = await listVariantNamesOnly(key);
          if (!names.includes(merged[key]!)) merged[key] = "default";
        }
        await fs.writeFile(activePath(), JSON.stringify(merged, null, 2), "utf8");
      }
    })();
  }
  await diskReady;
}

async function listVariantNamesOnly(key: PromptKey): Promise<string[]> {
  const dir = keyDir(key);
  if (!existsSync(dir)) return ["default"];
  const names: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith(".txt")) {
      names.push(ent.name.replace(/\.txt$/i, ""));
    }
  }
  if (!names.includes("default")) names.push("default");
  return names;
}

async function readActiveMap(): Promise<Record<PromptKey, string>> {
  await ensureDiskLayout();
  const parsed = JSON.parse(await fs.readFile(activePath(), "utf8")) as Record<string, string>;
  const out = {} as Record<PromptKey, string>;
  for (const key of PROMPT_KEYS) {
    out[key] = typeof parsed[key] === "string" ? parsed[key] : "default";
  }
  return out;
}

async function writeActiveMap(m: Record<PromptKey, string>): Promise<void> {
  await ensureDiskLayout();
  await fs.writeFile(activePath(), JSON.stringify(m, null, 2), "utf8");
}

export async function listVariants(key: PromptKey): Promise<string[]> {
  await ensureDiskLayout();
  const names = await listVariantNamesOnly(key);
  return names.sort((a, b) => a.localeCompare(b));
}

export async function getActiveName(key: PromptKey): Promise<string> {
  const m = await readActiveMap();
  const n = m[key];
  const variants = await listVariants(key);
  if (n && variants.includes(n)) return n;
  return "default";
}

export async function setActiveName(key: PromptKey, name: string): Promise<void> {
  const variants = await listVariants(key);
  if (!variants.includes(name)) throw new Error(`Unknown variant "${name}" for ${key}`);
  const m = await readActiveMap();
  m[key] = name;
  await writeActiveMap(m);
}

export async function readVariant(key: PromptKey, name: string): Promise<string> {
  await ensureDiskLayout();
  const file = variantPath(key, name);
  if (existsSync(file)) {
    return fs.readFile(file, "utf8");
  }

  console.warn(
    `[enpply] Prompt file missing: ${key}/${name}.txt — recovering (server keeps running; check ${promptsRoot()})`
  );

  if (name === "default") {
    const text = DEFAULT_PROMPTS[key];
    await writeVariant(key, "default", text);
    return text;
  }

  return readVariant(key, "default");
}

export async function writeVariant(key: PromptKey, name: string, content: string): Promise<void> {
  await ensureDiskLayout();
  await fs.mkdir(keyDir(key), { recursive: true });
  await fs.writeFile(variantPath(key, name), content, "utf8");
}

export async function deleteVariant(key: PromptKey, name: string): Promise<void> {
  if (name === "default") throw new Error('Cannot delete the "default" variant');
  const variants = await listVariants(key);
  if (variants.length <= 1) throw new Error("Cannot delete the only variant");
  const active = await getActiveName(key);
  if (active === name) throw new Error("Switch the active variant before deleting this one");
  await fs.unlink(variantPath(key, name));
}

export async function getPromptState(): Promise<{
  activeByKey: Record<PromptKey, string>;
  variantsByKey: Record<PromptKey, string[]>;
}> {
  await ensureDiskLayout();
  const activeByKey = await readActiveMap();
  const variantsByKey = {} as Record<PromptKey, string[]>;
  for (const key of PROMPT_KEYS) {
    variantsByKey[key] = await listVariants(key);
  }
  return { activeByKey, variantsByKey };
}

export async function readAllPrompts(): Promise<Record<PromptKey, string>> {
  await ensureDiskLayout();
  const out = {} as Record<PromptKey, string>;
  for (const key of PROMPT_KEYS) {
    try {
      const name = await getActiveName(key);
      out[key] = await readVariant(key, name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[enpply] readAllPrompts: ${key} failed (${msg}) — using embedded default from prompt-defaults`);
      out[key] = DEFAULT_PROMPTS[key];
    }
  }
  return out;
}

export async function writePrompts(
  partial: Partial<Record<PromptKey, string>>
): Promise<Record<PromptKey, string>> {
  await ensureDiskLayout();
  for (const key of PROMPT_KEYS) {
    if (partial[key] !== undefined) {
      const active = await getActiveName(key);
      await writeVariant(key, active, partial[key]!);
    }
  }
  return readAllPrompts();
}

export async function resetPrompt(key: PromptKey): Promise<string> {
  const text = DEFAULT_PROMPTS[key];
  await writeVariant(key, "default", text);
  await setActiveName(key, "default");
  return text;
}
