import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "./paths.js";

/** One visual theme = one résumé shell + one cover letter shell, listed in `server/templates/registry.json`. */
export type ThemeRegistryEntry = {
  id: string;
  label: string;
  resume: string;
  /** HTML shell for the cover letter PDF (often shared, e.g. `cover-letter.html`). */
  coverLetter: string;
};

export type ThemeRegistry = { themes: ThemeRegistryEntry[] };

const FALLBACK_REGISTRY: ThemeRegistry = {
  themes: [
    {
      id: "rhazel",
      label: "Rhazel - Navy centered — centered navy header, thick rule, timeline rows",
      resume: "resume-rhazel.html",
      coverLetter: "cv-rhazel.html",
    },
    {
      id: "rohit",
      label: "Rohit - Grey & gold — grey header band, gold rule, wide caps sections",
      resume: "resume-rohit.html",
      coverLetter: "cv-rohit.html",
    },
    {
      id: "standard",
      label: "Tryvera - Standard — Tryvera header band, navy accents",
      resume: "resume-standard.html",
      coverLetter: "cv-standard.html",
    },
    {
      id: "classic",
      label: "Serif - Classic serif — minimal, all-caps sections (print-style)",
      resume: "resume-classic.html",
      coverLetter: "cv-classic.html",
    },
    {
      id: "purple",
      label: "Lavender - Purple — soft lavender sheet, plum accents",
      resume: "resume-purple.html",
      coverLetter: "cv-purple.html",
    },
    {
      id: "navy-center",
      label: "Glenn - Navy center — white sheet, centered name & headline, thick rule",
      resume: "resume-navy-center.html",
      coverLetter: "cv-navy-center.html",
    },
    {
      id: "beige-band",
      label: "Puyang - Beige band — centered header, tan section bands, timeline & grids",
      resume: "resume-beige-band.html",
      coverLetter: "cv-beige-band.html",
    },
    {
      id: "deepankar",
      label: "Deepankar - Steel blue — centered name & headline, skills above experience, underlined sections",
      resume: "resume-deepankar.html",
      coverLetter: "cv-deepankar.html",
    },
  ],
};

const ID_RE = /^[a-z0-9_-]{1,48}$/;
/** Basename only, HTML in templates dir — no path segments. */
const FILE_RE = /^[a-zA-Z0-9._-]+\.html$/;

function registryPath(): string {
  return path.join(projectRoot(), "server", "templates", "registry.json");
}

function isValidEntry(x: unknown): x is ThemeRegistryEntry {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    ID_RE.test(o.id) &&
    typeof o.label === "string" &&
    o.label.trim().length > 0 &&
    typeof o.resume === "string" &&
    FILE_RE.test(o.resume) &&
    typeof o.coverLetter === "string" &&
    FILE_RE.test(o.coverLetter)
  );
}

function validateRegistry(data: unknown): ThemeRegistry | null {
  if (!data || typeof data !== "object") return null;
  const themes = (data as { themes?: unknown }).themes;
  if (!Array.isArray(themes) || themes.length === 0) return null;
  const out: ThemeRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const t of themes) {
    if (!isValidEntry(t)) return null;
    if (seen.has(t.id)) return null;
    seen.add(t.id);
    out.push(t);
  }
  return { themes: out };
}

/**
 * A theme whose HTML shell is missing on disk is WORSE than a theme that does not exist:
 * `loadTemplate` throws ENOENT, `writePdfFromTemplateOrFallback` catches it, and the run
 * silently produces an UNTHEMED PDFKit PDF. The user sees a plain document at random and
 * nothing in the API says why.
 *
 * This shipped: `classic` was listed in registry.json but resume-classic.html/cv-classic.html
 * had never existed, so every run on that theme rendered plain.
 *
 * So entries are checked against disk and dropped if either shell is absent. A dropped id
 * then falls through `normalizeResumeTheme` to the default, which is a REAL theme.
 */
function dropEntriesMissingTemplates(reg: ThemeRegistry, dir: string): ThemeRegistry {
  const kept: ThemeRegistryEntry[] = [];
  for (const t of reg.themes) {
    const missing = (["resume", "coverLetter"] as const).filter(
      (k) => !existsSync(path.join(dir, t[k]))
    );
    if (missing.length === 0) {
      kept.push(t);
      continue;
    }
    console.error(
      `[enpply] theme "${t.id}" DISABLED — missing template file(s): ` +
        missing.map((k) => `${k}=${t[k]}`).join(", ") +
        `. Add the file(s) under server/templates/ or remove the entry from registry.json. ` +
        `Requests for "${t.id}" will render with the default theme instead.`
    );
  }
  // Never return an empty list: a registry with no usable theme is worse than the built-in one.
  if (kept.length === 0) {
    console.error("[enpply] no theme in registry.json has usable templates — using built-in theme list");
    return FALLBACK_REGISTRY;
  }
  return { themes: kept };
}

let cached: ThemeRegistry | null = null;

function loadRegistry(): ThemeRegistry {
  if (cached) return cached;
  const p = registryPath();
  if (!existsSync(p)) {
    console.warn("[enpply] templates/registry.json missing — using built-in theme list");
    cached = FALLBACK_REGISTRY;
    return cached;
  }
  try {
    const raw = readFileSync(p, "utf8");
    const parsed = validateRegistry(JSON.parse(raw) as unknown);
    if (!parsed) {
      console.warn("[enpply] templates/registry.json invalid — using built-in theme list");
      cached = FALLBACK_REGISTRY;
    } else {
      cached = dropEntriesMissingTemplates(parsed, path.dirname(p));
    }
  } catch (e) {
    console.warn("[enpply] templates/registry.json could not be loaded — using built-in theme list:", e);
    cached = FALLBACK_REGISTRY;
  }
  return cached!;
}

/** For API and UI. */
export function getThemeSummaries(): { id: string; label: string }[] {
  return loadRegistry().themes.map(({ id, label }) => ({ id, label }));
}

export function getDefaultThemeId(): string {
  return loadRegistry().themes[0]!.id;
}

/** Ids already warned about, so one bad request does not spam the log on every call. */
const warnedUnknownThemes = new Set<string>();

/**
 * Unknown or empty theme ids map to the default (first entry in the registry).
 *
 * An EMPTY id means the caller did not choose, which is fine and silent. A NON-EMPTY id
 * that is not in the registry means the caller asked for something real and got a
 * different document back, so it is logged: that failure mode is invisible otherwise, and
 * it shipped once already. The client offered a "standard" theme the registry did not
 * have, so every request carrying it silently rendered as the default instead.
 */
export function normalizeResumeTheme(raw: string | undefined): string {
  const t = (raw ?? "").trim().toLowerCase();
  const ids = new Set(loadRegistry().themes.map((x) => x.id));
  if (t && ids.has(t)) return t;
  const fallback = getDefaultThemeId();
  if (t && !warnedUnknownThemes.has(t)) {
    warnedUnknownThemes.add(t);
    console.warn(
      `[enpply] unknown résumé theme "${t}" — falling back to "${fallback}". ` +
        `Known: ${[...ids].join(", ")}. Check server/templates/registry.json against ` +
        `FALLBACK_THEME_OPTIONS in client/src/enpply/themes.ts.`
    );
  }
  return fallback;
}

export function resumeTemplateFile(kind: "resume" | "coverLetter", theme: string): string {
  const t = normalizeResumeTheme(theme);
  const entry = loadRegistry().themes.find((x) => x.id === t);
  if (!entry) return kind === "resume" ? "resume.html" : "cover-letter.html";
  return kind === "resume" ? entry.resume : entry.coverLetter;
}
