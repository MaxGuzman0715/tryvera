import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findRootWithMarkers(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    const hasServerPkg = fs.existsSync(path.join(dir, "server", "package.json"));
    const hasData = fs.existsSync(path.join(dir, "data"));
    if (hasServerPkg && hasData) return path.normalize(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Monorepo root (folder that contains `server/` and `data/`).
 * Resolves reliably whether the process runs from repo root, `server/`, or via tsx vs `node dist`.
 */
export function projectRoot(): string {
  const fromThisFile = path.resolve(__dirname, "..", "..");
  return (
    findRootWithMarkers(fromThisFile) ??
    findRootWithMarkers(process.cwd()) ??
    findRootWithMarkers(path.resolve(process.cwd(), "..")) ??
    path.normalize(fromThisFile)
  );
}

export function dataDir(): string {
  const fromEnv = process.env.DATA_DIR;
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(projectRoot(), fromEnv);
  return path.join(projectRoot(), "data");
}

/**
 * Profiles + bullet stores live together under `Experiment/bullets/<id>.json`
 * (one JSON per profile holding profile fields AND the bullet groups). This is
 * the single source of truth for profiles, replacing `data/profiles`.
 * Override with `BULLETS_DIR` for read-only deploys that store them elsewhere.
 */
export function bulletsProfilesDir(): string {
  const fromEnv = process.env.BULLETS_DIR;
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(projectRoot(), fromEnv);
  return path.join(projectRoot(), "Experiment", "bullets");
}

/**
 * Per-profile reusable answers + answering policies live BESIDE the profiles
 * (`Experiment/answers/<id>.json`, `Experiment/policies/<id>.json`) — not under
 * the gitignored `data/` — so they're version-controlled with the profiles they
 * belong to. Resolved as siblings of the bullets dir, so they follow a
 * `BULLETS_DIR` override; overridable directly via `ANSWERS_DIR`/`POLICIES_DIR`.
 */
export function profileAnswersDir(): string {
  const fromEnv = process.env.ANSWERS_DIR;
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(projectRoot(), fromEnv);
  return path.join(bulletsProfilesDir(), "..", "answers");
}
export function answerPoliciesDir(): string {
  const fromEnv = process.env.POLICIES_DIR;
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(projectRoot(), fromEnv);
  return path.join(bulletsProfilesDir(), "..", "policies");
}

export function outputRoot(): string {
  const fromEnv = process.env.OUTPUT_ROOT;
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(projectRoot(), fromEnv);
  return path.join(projectRoot(), "output");
}

/**
 * Prompt store root — the single, git-tracked home for every prompt variant and
 * `active.json`. Lives at `server/prompt-defaults/` (resolved relative to this
 * compiled/source file, so it's stable regardless of cwd or tsx-vs-`node dist`).
 * Editing a prompt in the UI writes here, so prompt changes show up in `git diff`.
 * Override with `PROMPTS_DIR` for read-only deploys that store prompts elsewhere.
 */
export function promptDefaultsDir(): string {
  const fromEnv = process.env.PROMPTS_DIR;
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(projectRoot(), fromEnv);
  return path.resolve(__dirname, "..", "prompt-defaults");
}

export function ensureDirs(): void {
  const dirs = [
    dataDir(),
    bulletsProfilesDir(),
    promptDefaultsDir(),
    outputRoot(),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}
