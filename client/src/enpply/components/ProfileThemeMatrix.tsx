import { useEffect, useMemo, useRef, useState } from "react";

type Theme = { id: string; label: string };
type Profile = { id: string };

/** Registry labels look like "Rhazel - Navy centered — timeline rows". Keep just the leading name. */
function shortThemeName(t: Theme): string {
  const head = t.label.split(/\s[-—]\s/)[0]?.trim();
  return head || t.id;
}

/** profile[i] → theme[i % themes.length] — cycle the theme list when there are more profiles than themes. */
function roundRobinMap(profiles: Profile[], themes: Theme[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!themes.length) return out;
  profiles.forEach((p, i) => {
    out[p.id] = themes[i % themes.length].id;
  });
  return out;
}

/**
 * Visual editor for AppSettings.default_theme_by_profile.
 *
 * Every profile gets a theme: an explicit mapping wins, otherwise it falls back
 * to a 1-by-1 round-robin over the available themes. The round-robin defaults
 * are seeded into the parent settings on mount so they actually persist on Save
 * (an empty map would make the server fall back to the single global default).
 */
export default function ProfileThemeMatrix({
  profiles,
  themes,
  value,
  onChange,
}: {
  profiles: Profile[];
  themes: Theme[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [showPreviews, setShowPreviews] = useState(true);
  const seeded = useRef(false);

  const rr = useMemo(() => roundRobinMap(profiles, themes), [profiles, themes]);
  const themeIds = useMemo(() => themes.map((t) => t.id), [themes]);
  const validThemes = useMemo(() => new Set(themeIds), [themeIds]);

  // Displayed selection per profile: explicit mapping wins, else round-robin default.
  const effective = useMemo(() => {
    const out: Record<string, string> = {};
    profiles.forEach((p) => {
      const chosen = value[p.id] ?? rr[p.id];
      out[p.id] = validThemes.has(chosen) ? chosen : themeIds[0] ?? "";
    });
    return out;
  }, [profiles, value, rr, validThemes, themeIds]);

  // Seed the round-robin defaults for any not-yet-mapped profile so they persist on Save.
  useEffect(() => {
    if (seeded.current) return;
    if (!profiles.length || !themes.length) return;
    seeded.current = true;
    if (profiles.some((p) => !(p.id in value))) onChange(effective);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, themes]);

  if (!themes.length) {
    return <p className="hint">No themes found in server/templates/registry.json.</p>;
  }
  if (!profiles.length) {
    return <p className="hint">No profiles yet — create a profile first, then assign themes here.</p>;
  }

  const setOne = (profileId: string, themeId: string) =>
    onChange({ ...effective, [profileId]: themeId });

  return (
    <div className="ptm">
      <div className="ptm-toolbar">
        <button type="button" className="btn small" onClick={() => onChange(roundRobinMap(profiles, themes))}>
          Reset to 1-by-1
        </button>
        <label className="ptm-toggle">
          <input type="checkbox" checked={showPreviews} onChange={(e) => setShowPreviews(e.target.checked)} />
          Show previews
        </label>
        <span className="hint ptm-count">
          {profiles.length} profile{profiles.length === 1 ? "" : "s"} · {themes.length} themes
        </span>
      </div>
      <div className="ptm-grid">
        {profiles.map((p) => {
          const themeId = effective[p.id];
          return (
            <div key={p.id} className="ptm-card">
              <div className="ptm-card-head">
                <span className="ptm-profile" title={p.id}>
                  {p.id}
                </span>
                <select
                  className="form-control"
                  value={themeId}
                  onChange={(e) => setOne(p.id, e.target.value)}
                  aria-label={`Theme for profile ${p.id}`}
                >
                  {themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {shortThemeName(t)}
                    </option>
                  ))}
                </select>
              </div>
              {showPreviews && (
                <div className="ptm-preview-wrap">
                  <iframe
                    title={`Theme preview for ${p.id}`}
                    className="ptm-preview-frame"
                    src={`/api/preview/resume/${encodeURIComponent(themeId)}`}
                    loading="lazy"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
