import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "./paths.js";

/**
 * Per-user settings for the Tryvify extension: feature flags and an optional
 * autofill password used on account-creation pages. (Which model fills forms is
 * the user's "answers" tier in My settings — not configured here.)
 *
 * Stored in `data/enpplify_settings.json`, keyed by user id. Kept SEPARATE from
 * the global `app_settings.json` so the extension's per-user prefs never touch
 * the shared Tryvera generation config.
 *
 * SECURITY: `autofill_password` is stored in plaintext on the server's own
 * disk. It is only ever returned to the authenticated owner. Do not log it.
 */

export type EnpplifyFeatureFlags = {
  /** Auto-fill account-creation password fields from `autofill_password`. */
  password_autofill: boolean;
  /** Engage custom dropdown / react-select handling during Fill. */
  combobox_fill: boolean;
  /** Attach the cover-letter PDF when a separate field exists. */
  attach_cover_letter: boolean;
  /**
   * After the instant heuristic pass, automatically run the AI pass on the
   * fields it couldn't fill. When false, the user clicks "Fill remaining with
   * AI" instead (so the slow/costly LLM step is opt-in per page).
   */
  ai_fill_remaining: boolean;
  /** Show a drop target in the panel to upload a dragged file to the page. */
  drop_to_upload: boolean;
  /**
   * Default state of the panel's "Résumé" / "Cover letter" generate checkboxes.
   * Both default OFF. "Use base resume" still wins: when it's on, résumé
   * generation is disabled regardless of `gen_resume_default`.
   */
  gen_resume_default: boolean;
  gen_cover_letter_default: boolean;
  /**
   * Show an "enter company & role manually" toggle in the panel. When the user
   * turns that toggle on and runs a log-only generation (no résumé/CV), the
   * extraction LLM is skipped and the typed company/role are used instead.
   */
  manual_company_role: boolean;
};

export type EnpplifyUserSettings = {
  flags: EnpplifyFeatureFlags;
  /** Optional password for account-creation autofill (empty = feature inert). */
  autofill_password?: string;
  /**
   * Original filename of the uploaded base résumé, PER PROFILE id. Each managed
   * profile can have its own fixed base résumé PDF on disk; the map is
   * profileId → original filename. Absent/empty entry = no base résumé for that
   * profile.
   */
  base_resume_names?: Record<string, string>;
  /**
   * Per-profile default for the extension's "Use base resume" toggle. When a
   * profile's entry is `true`, the extension pre-checks "Use base resume" for
   * that profile (only meaningful when `base_resume_names` has an entry for it).
   * The user can still override the toggle per application.
   */
  base_resume_default?: Record<string, boolean>;
};

export const DEFAULT_FLAGS: EnpplifyFeatureFlags = {
  password_autofill: false,
  combobox_fill: true,
  attach_cover_letter: true,
  ai_fill_remaining: false,
  drop_to_upload: true,
  gen_resume_default: false,
  gen_cover_letter_default: false,
  manual_company_role: false,
};

function defaults(): EnpplifyUserSettings {
  return { flags: { ...DEFAULT_FLAGS } };
}

const FILE = "enpplify_settings.json";
const filePath = () => path.join(dataDir(), FILE);

type Store = { byUser: Record<string, EnpplifyUserSettings> };

const flagsSchema = z
  .object({
    password_autofill: z.boolean().default(false),
    combobox_fill: z.boolean().default(true),
    attach_cover_letter: z.boolean().default(true),
    ai_fill_remaining: z.boolean().default(false),
    drop_to_upload: z.boolean().default(true),
    gen_resume_default: z.boolean().default(false),
    gen_cover_letter_default: z.boolean().default(false),
    manual_company_role: z.boolean().default(false),
  })
  .partial();

const settingsSchema = z.object({
  flags: flagsSchema.optional(),
  autofill_password: z.string().max(256).optional(),
  base_resume_default: z.record(z.boolean()).optional(),
});

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(filePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    return { byUser: parsed.byUser && typeof parsed.byUser === "object" ? parsed.byUser : {} };
  } catch {
    return { byUser: {} };
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(filePath(), JSON.stringify(store, null, 2), "utf8");
}

/** Full settings for a user (merged over defaults). */
export async function getEnpplifySettings(userId: string): Promise<EnpplifyUserSettings> {
  const store = await readStore();
  const saved = store.byUser[userId];
  if (!saved) return defaults();
  return {
    flags: { ...DEFAULT_FLAGS, ...(saved.flags ?? {}) },
    ...(saved.autofill_password ? { autofill_password: saved.autofill_password } : {}),
    base_resume_names: saved.base_resume_names ?? {},
    base_resume_default: saved.base_resume_default ?? {},
  };
}

// --- base résumé (per-user PDF on disk) -------------------------------------

function baseResumeDir(): string {
  return path.join(dataDir(), "enpplify_base_resumes");
}
/** Per-(user, profile) PDF path. Both ids are sanitized against path tricks. */
function baseResumePath(userId: string, profileId: string): string {
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeProfile = String(profileId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(baseResumeDir(), `${safeUser}__${safeProfile}.pdf`);
}

/** Store a user's base résumé PDF for one profile and record its filename. */
export async function saveBaseResume(
  userId: string,
  profileId: string,
  bytes: Buffer,
  filename: string,
): Promise<void> {
  await fs.mkdir(baseResumeDir(), { recursive: true });
  await fs.writeFile(baseResumePath(userId, profileId), bytes);
  const store = await readStore();
  const current = store.byUser[userId] ?? defaults();
  const names = { ...(current.base_resume_names ?? {}), [profileId]: filename || "base_resume.pdf" };
  store.byUser[userId] = { ...current, base_resume_names: names };
  await writeStore(store);
}

/** Read a user's base résumé PDF for one profile, or null if none. */
export async function readBaseResume(userId: string, profileId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(baseResumePath(userId, profileId));
  } catch {
    return null;
  }
}

/** Remove a user's base résumé for one profile (file + recorded name). */
export async function clearBaseResume(userId: string, profileId: string): Promise<void> {
  try {
    await fs.unlink(baseResumePath(userId, profileId));
  } catch {
    /* already gone */
  }
  const store = await readStore();
  const current = store.byUser[userId];
  let changed = false;
  if (current?.base_resume_names && current.base_resume_names[profileId]) {
    delete current.base_resume_names[profileId];
    changed = true;
  }
  // A "use base résumé by default" preference is meaningless once the file is
  // gone — drop it so re-uploading later starts from the off state.
  if (current?.base_resume_default && profileId in current.base_resume_default) {
    delete current.base_resume_default[profileId];
    changed = true;
  }
  if (changed) await writeStore(store);
}

/**
 * Merge a validated patch into a user's settings. `autofill_password` of "" is
 * treated as "clear it"; omitted leaves it unchanged.
 */
export async function updateEnpplifySettings(
  userId: string,
  patch: z.infer<typeof settingsSchema>,
): Promise<EnpplifyUserSettings> {
  const store = await readStore();
  const current = store.byUser[userId] ?? defaults();
  const next: EnpplifyUserSettings = {
    flags: { ...DEFAULT_FLAGS, ...(current.flags ?? {}), ...(patch.flags ?? {}) },
    // base_resume_names is managed by saveBaseResume/clearBaseResume, not this
    // settings PUT — preserve it across an unrelated settings update.
    ...(current.base_resume_names ? { base_resume_names: current.base_resume_names } : {}),
    // base_resume_default IS patchable here (it's a preference, not file state).
    // Merge so a partial patch from one toggle doesn't drop other profiles.
    ...(current.base_resume_default || patch.base_resume_default
      ? { base_resume_default: { ...(current.base_resume_default ?? {}), ...(patch.base_resume_default ?? {}) } }
      : {}),
  };
  if (patch.autofill_password !== undefined) {
    if (patch.autofill_password) next.autofill_password = patch.autofill_password;
    // empty string → leave undefined (cleared)
  } else if (current.autofill_password) {
    next.autofill_password = current.autofill_password;
  }
  store.byUser[userId] = next;
  await writeStore(store);
  return getEnpplifySettings(userId);
}

export { settingsSchema };
