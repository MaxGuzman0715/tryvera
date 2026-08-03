import fs from "node:fs/promises";
import path from "node:path";
import { bulletsProfilesDir } from "./paths.js";
import { profileBodySchema, type Profile } from "./types.js";

/**
 * Profiles live under `Experiment/bullets/<id>.json`, the same file that holds
 * the profile's bullet groups (`companies`). Profile reads parse the profile
 * fields and ignore `companies`/`note`/`project`; writes preserve them.
 */
const profilesDir = () => bulletsProfilesDir();

/** Keys that belong to the bullet store, not the profile — preserved on write. */
const BULLET_STORE_KEYS = ["companies", "note", "project", "profileId"];

/** Map legacy `year`-only rows to start/end; strip `year` so Zod accepts the payload. */
function migrateProfileJson(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.education)) return raw;
  p.education = p.education.map((ed) => {
    if (!ed || typeof ed !== "object") return ed;
    const e = ed as Record<string, unknown>;
    let startDate = typeof e.startDate === "string" ? e.startDate : "";
    let endDate = typeof e.endDate === "string" ? e.endDate : "";
    const legacyYear = typeof e.year === "string" ? e.year.trim() : "";
    // Legacy `year`-only rows: map to endDate and fill startDate with "?" so
    // the both-or-neither schema passes. When neither dates nor a legacy year
    // exist, leave both empty — dates are now optional.
    if (legacyYear) {
      if (!endDate.trim()) endDate = legacyYear;
      if (!startDate.trim()) startDate = "?";
    }
    const { year: _y, ...rest } = e;
    return { ...rest, startDate, endDate };
  });
  return p;
}

export async function listProfiles(): Promise<{ id: string }[]> {
  const dir = profilesDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
      .map((e) => ({ id: e.name.replace(/\.json$/i, "") }));
  } catch (err) {
    console.error("[enpply] listProfiles failed for dir:", dir, err);
    throw err;
  }
}

export async function readProfile(id: string): Promise<Profile | null> {
  const file = path.join(profilesDir(), `${id}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const migrated = migrateProfileJson(parsed);
    return profileBodySchema.parse(migrated);
  } catch {
    return null;
  }
}

export async function writeProfile(profile: Profile): Promise<void> {
  await fs.mkdir(profilesDir(), { recursive: true });
  const file = path.join(profilesDir(), `${profile.id}.json`);
  const validated = profileBodySchema.parse(profile);
  // Preserve any existing bullet-store fields (companies/note/project) so editing
  // the profile in the UI doesn't wipe the candidate's pre-built bullet groups.
  let preserved: Record<string, unknown> = {};
  try {
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    for (const k of BULLET_STORE_KEYS) {
      if (existing[k] !== undefined) preserved[k] = existing[k];
    }
  } catch {
    /* new file — nothing to preserve */
  }
  await fs.writeFile(file, JSON.stringify({ ...validated, ...preserved }, null, 2), "utf8");
}

export async function deleteProfile(id: string): Promise<boolean> {
  const file = path.join(profilesDir(), `${id}.json`);
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}
