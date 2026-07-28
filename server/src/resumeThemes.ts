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
      resume: "resume.html",
      coverLetter: "cv.html",
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
      cached = parsed;
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

/** Unknown or empty theme ids map to the default (first entry in the registry). */
export function normalizeResumeTheme(raw: string | undefined): string {
  const t = (raw ?? "").trim().toLowerCase();
  const ids = new Set(loadRegistry().themes.map((x) => x.id));
  if (t && ids.has(t)) return t;
  return getDefaultThemeId();
}

export function resumeTemplateFile(kind: "resume" | "coverLetter", theme: string): string {
  const t = normalizeResumeTheme(theme);
  const entry = loadRegistry().themes.find((x) => x.id === t);
  if (!entry) return kind === "resume" ? "resume.html" : "cover-letter.html";
  return kind === "resume" ? entry.resume : entry.coverLetter;
}
