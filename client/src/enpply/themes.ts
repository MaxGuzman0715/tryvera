/**
 * Fallback list when `GET /api/config/themes` fails (offline / old server).
 * Prefer loading themes from the API — they mirror `server/templates/registry.json`.
 */
export const FALLBACK_THEME_OPTIONS: { id: string; label: string }[] = [
  { id: "rhazel", label: "Rhazel - Navy centered — centered navy header, thick rule, timeline rows" },
  { id: "rohit", label: "Rohit - Grey & gold — grey header band, gold rule, wide caps sections" },
  { id: "standard", label: "Tryvera - Standard — branded header band, navy accents" },
  { id: "classic", label: "Serif - Classic serif — minimal, all-caps sections (print-style)" },
  { id: "purple", label: "Lavender - Purple — soft lavender sheet, plum accents" },
  { id: "navy-center", label: "Glenn - Navy center — white sheet, centered name & headline, thick rule" },
  { id: "beige-band", label: "Puyang - Beige band — centered header, tan section bands, timeline & grids" },
];

/** Map stored theme id to a valid id. Pass `allowedIds` from `api.getThemes()` when available. */
export function normalizeThemeId(raw: string, allowedIds?: string[]): string {
  const t = raw.trim().toLowerCase();
  const allowed =
    allowedIds?.length ? allowedIds : FALLBACK_THEME_OPTIONS.map((o) => o.id);
  if (t && allowed.includes(t)) return t;
  return allowed[0] ?? "standard";
}
