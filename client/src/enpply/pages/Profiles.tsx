import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Education, Experience, Profile, ProfileBulletsView } from "../types";
import KeyboardTextarea from "../components/KeyboardTextarea";
import { IconIdCard } from "../../ui/icons";

function emptyExperience(): Experience {
  return {
    company: "",
    location: "",
    title: "",
    startDate: "",
    endDate: "",
    bullets: [],
    paragraphs: [],
  };
}

function emptyEducation(): Education {
  return { school: "", degree: "", field: "", startDate: "", endDate: "" };
}

function emptyProfile(id: string): Profile {
  return {
    id,
    basic: {
      fullName: "Your name",
      email: "you@example.com",
      location: "Your location",
      summary: "",
    },
    experience: [],
    skills: [],
    education: [],
  };
}

const PROFILE_ID_PATTERN = /^[a-z0-9_-]+$/i;

export default function Profiles() {
  const [list, setList] = useState<{ id: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createOk, setCreateOk] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState("");

  // Bullet groups view (read-only) for the selected profile.
  const [bullets, setBullets] = useState<ProfileBulletsView | null>(null);
  const [stackFilter, setStackFilter] = useState("");
  const [selectedStackId, setSelectedStackId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const rows = await api.listProfiles();
    setList(rows);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setProfile(null);
      setBullets(null);
      return;
    }
    setLoading(true);
    setError(null);
    setBullets(null);
    setStackFilter("");
    setSelectedStackId(null);
    api
      .getProfile(selectedId)
      .then((p) => {
        setProfile(p);
        setSkillDraft(p.skills.join("\n"));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // Bullet groups load independently; failure is non-fatal (just no bullets card).
    api
      .getProfileBullets(selectedId)
      .then(setBullets)
      .catch(() => setBullets(null));
  }, [selectedId]);

  // Flatten every company×stack into one searchable option list.
  const stackOptions = useMemo(() => {
    if (!bullets?.companies) return [];
    return bullets.companies.flatMap((co) =>
      co.stacks.map((s) => ({
        id: `${co.company}::${s.stack}`,
        company: co.company,
        stack: s.stack,
        domain: s.domain,
        tier: s.tier,
        count: s.count,
        bullets: s.bullets,
      })),
    );
  }, [bullets]);

  const filteredStackOptions = useMemo(() => {
    const q = stackFilter.trim().toLowerCase();
    const opts = q
      ? stackOptions.filter((o) =>
          `${o.stack} ${o.domain} ${o.company}`.toLowerCase().includes(q),
        )
      : stackOptions;
    return [...opts].sort((a, b) => a.domain.localeCompare(b.domain) || a.stack.localeCompare(b.stack));
  }, [stackOptions, stackFilter]);

  const selectedStack = useMemo(
    () => stackOptions.find((o) => o.id === selectedStackId) ?? null,
    [stackOptions, selectedStackId],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
      if (!profile || loading) return;
      e.preventDefault();
      void handleSave();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [profile, loading, skillDraft]);

  async function handleCreate() {
    const id = newId.trim();
    setCreateOk(null);
    if (!id) {
      setError("Enter a new profile id before creating (e.g. ml_staff_profile).");
      return;
    }
    if (!PROFILE_ID_PATTERN.test(id)) {
      setError(
        "Profile id can only use letters, numbers, underscores (_), and hyphens (-). No spaces."
      );
      return;
    }
    setError(null);
    setCreateBusy(true);
    try {
      const p = emptyProfile(id);
      await api.createProfile(p);
      setNewId("");
      await refresh();
      setSelectedId(id);
      setCreateOk(`Profile “${id}” was created. Fill in the sections below, then Save profile.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleSave() {
    if (!profile) return;
    const skills = skillDraft
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Education dates must be either both empty (omit the period) or both
    // filled (render a "(From – To)" line). Catch this client-side to avoid a
    // zod round-trip with a less readable error message.
    for (let i = 0; i < profile.education.length; i++) {
      const ed = profile.education[i];
      const hasStart = ed.startDate.trim().length > 0;
      const hasEnd = ed.endDate.trim().length > 0;
      if (hasStart !== hasEnd) {
        setError(
          `Education row ${i + 1}: fill both From and To, or leave both empty (one date alone isn't allowed).`
        );
        return;
      }
    }
    setError(null);
    setCreateOk(null);
    try {
      await api.saveProfile({ ...profile, skills });
      await refresh();
      setCreateOk("Profile saved.");
      window.setTimeout(() => setCreateOk(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete() {
    if (!profile) return;
    if (!confirm(`Delete profile "${profile.id}"?`)) return;
    setError(null);
    try {
      await api.deleteProfile(profile.id);
      setSelectedId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function updateBasic<K extends keyof Profile["basic"]>(key: K, value: Profile["basic"][K]) {
    if (!profile) return;
    setProfile({ ...profile, basic: { ...profile.basic, [key]: value } });
  }

  function updateExp(i: number, patch: Partial<Experience>) {
    if (!profile) return;
    const next = [...profile.experience];
    next[i] = { ...next[i], ...patch };
    setProfile({ ...profile, experience: next });
  }

  function addExp() {
    if (!profile) return;
    setProfile({ ...profile, experience: [...profile.experience, emptyExperience()] });
  }

  function removeExp(i: number) {
    if (!profile) return;
    setProfile({ ...profile, experience: profile.experience.filter((_, j) => j !== i) });
  }

  function updateEdu(i: number, patch: Partial<Education>) {
    if (!profile) return;
    const next = [...profile.education];
    next[i] = { ...next[i], ...patch };
    setProfile({ ...profile, education: next });
  }

  function addEdu() {
    if (!profile) return;
    setProfile({ ...profile, education: [...profile.education, emptyEducation()] });
  }

  function removeEdu(i: number) {
    if (!profile) return;
    setProfile({ ...profile, education: profile.education.filter((_, j) => j !== i) });
  }

  return (
    <>
      <h1><IconIdCard />Profiles</h1>
      <p className="sub">Manually maintain base profiles used for résumé, cover letter, and answers.</p>

      {error && <p className="error">{error}</p>}
      {createOk && <p className="success-inline">{createOk}</p>}

      <div className="card">
        <h2>Select or create</h2>
        <div className="field-stack">
          <label htmlFor="profile-existing">Existing profile</label>
          <select
            id="profile-existing"
            className="form-control"
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value || null)}
          >
            <option value="">— choose —</option>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>

          <label htmlFor="profile-new-id">New profile id (required to create)</label>
          <input
            id="profile-new-id"
            type="text"
            className="form-control"
            value={newId}
            onChange={(e) => {
              setNewId(e.target.value);
              setError(null);
              setCreateOk(null);
            }}
            placeholder="e.g. ml_staff_profile"
            aria-describedby="new-id-hint"
            autoComplete="off"
            spellCheck={false}
          />
          <p id="new-id-hint" className="hint">
            Only letters, numbers, <code>_</code> and <code>-</code>. Creating adds a starter profile; use{" "}
            <strong>Save profile</strong> after you edit name, email, experience, etc.
          </p>
          <div className="actions">
            <button type="button" className="btn small" onClick={handleCreate} disabled={createBusy}>
              {createBusy ? "Creating…" : "Create empty profile"}
            </button>
          </div>
        </div>
      </div>

      {loading && <p className="sub">Loading…</p>}

      {profile && (
        <>
          <div className="card">
            <h2>Bullet groups</h2>
            {!bullets || !bullets.has_bullets ? (
              <p className="sub" style={{ margin: 0 }}>
                <span style={{ color: "var(--danger, #e06c6c)", fontWeight: 600 }}>No bullet groups.</span>{" "}
                Résumé generation will fall back to the original experience bullets above (untailored). Add a{" "}
                <code>companies</code> block to this profile's file under <code>Experiment/bullets/</code> to enable
                bullets-based tailoring.
              </p>
            ) : (
              <>
                <p className="sub" style={{ marginTop: 0 }}>
                  <span style={{ color: "var(--success, #4caf50)", fontWeight: 600 }}>✓ Valid.</span>{" "}
                  <strong>{bullets.totals.companies}</strong> companies ·{" "}
                  <strong>{bullets.totals.stacks}</strong> stacks ·{" "}
                  <strong>{bullets.totals.bullets}</strong> bullet lines.
                </p>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
                  {bullets.companies.map((co) => (
                    <span
                      key={co.company}
                      style={{
                        fontSize: "0.72rem",
                        padding: "0.1rem 0.5rem",
                        borderRadius: "999px",
                        border: "1px solid var(--border, rgba(127,127,127,0.3))",
                      }}
                    >
                      {co.company}: {co.stacks.length} stacks
                    </span>
                  ))}
                </div>

                <label htmlFor="stack-search">Find a stack / domain</label>
                <input
                  id="stack-search"
                  className="form-control"
                  value={stackFilter}
                  onChange={(e) => setStackFilter(e.target.value)}
                  placeholder="type to filter, e.g. react, AI_ML, kafka…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <div
                  style={{
                    maxHeight: "200px",
                    overflow: "auto",
                    border: "1px solid var(--border, rgba(127,127,127,0.25))",
                    borderRadius: "8px",
                    margin: "0.5rem 0",
                  }}
                >
                  {filteredStackOptions.length === 0 ? (
                    <p className="sub" style={{ padding: "0.6rem" }}>No matching stacks.</p>
                  ) : (
                    filteredStackOptions.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setSelectedStackId(o.id)}
                        style={{
                          display: "flex",
                          width: "100%",
                          gap: "0.5rem",
                          alignItems: "baseline",
                          textAlign: "left",
                          border: "none",
                          borderBottom: "1px solid var(--border, rgba(127,127,127,0.15))",
                          background: o.id === selectedStackId ? "var(--accent-soft, rgba(90,160,255,0.15))" : "transparent",
                          color: "inherit",
                          cursor: "pointer",
                          padding: "0.4rem 0.6rem",
                          fontSize: "0.82rem",
                        }}
                      >
                        <strong style={{ minWidth: "130px" }}>{o.stack}</strong>
                        <span style={{ opacity: 0.7 }}>{o.domain} · T{o.tier} · {o.count} lines</span>
                        <span style={{ opacity: 0.5, marginLeft: "auto" }}>{o.company}</span>
                      </button>
                    ))
                  )}
                </div>

                {selectedStack && (
                  <div style={{ marginTop: "0.4rem" }}>
                    <strong style={{ fontSize: "0.85rem" }}>
                      {selectedStack.stack} — {selectedStack.company}
                    </strong>{" "}
                    <span className="sub" style={{ fontSize: "0.78rem" }}>
                      ({selectedStack.domain} · Tier {selectedStack.tier} · {selectedStack.count} lines)
                    </span>
                    <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                      {selectedStack.bullets.map((b, i) => (
                        <li key={i} style={{ fontSize: "0.85rem", lineHeight: 1.4 }}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="card">
            <h2>Basic info</h2>
            <div className="row">
              <div>
                <label>Profile id</label>
                <input value={profile.id} disabled />
              </div>
              <div>
                <label>Full name</label>
                <input
                  value={profile.basic.fullName}
                  onChange={(e) => updateBasic("fullName", e.target.value)}
                />
              </div>
              <div>
                <label>Title (optional)</label>
                <input
                  value={profile.basic.title ?? ""}
                  onChange={(e) => updateBasic("title", e.target.value || undefined)}
                />
              </div>
            </div>
            <div className="row">
              <div>
                <label>Email</label>
                <input
                  type="email"
                  value={profile.basic.email}
                  onChange={(e) => updateBasic("email", e.target.value)}
                />
              </div>
              <div>
                <label>Phone (optional)</label>
                <input
                  value={profile.basic.phone ?? ""}
                  onChange={(e) => updateBasic("phone", e.target.value || undefined)}
                />
              </div>
              <div>
                <label>Location</label>
                <input
                  value={profile.basic.location}
                  onChange={(e) => updateBasic("location", e.target.value)}
                />
              </div>
            </div>
            <div className="row">
              <div>
                <label>LinkedIn (optional)</label>
                <input
                  value={profile.basic.linkedin ?? ""}
                  onChange={(e) => updateBasic("linkedin", e.target.value || undefined)}
                />
              </div>
              <div>
                <label>GitHub (optional)</label>
                <input
                  value={profile.basic.github ?? ""}
                  onChange={(e) => updateBasic("github", e.target.value || undefined)}
                />
              </div>
              <div>
                <label>Portfolio (optional)</label>
                <input
                  value={profile.basic.portfolio ?? ""}
                  onChange={(e) => updateBasic("portfolio", e.target.value || undefined)}
                />
              </div>
            </div>
            <label>Summary (optional)</label>
            <KeyboardTextarea
              value={profile.basic.summary ?? ""}
              onValueChange={(v) => updateBasic("summary", v || undefined)}
            />
          </div>

          <div className="card">
            <h2>Experience (by company)</h2>
            {profile.experience.map((exp, i) => (
              <div key={i} className="exp-block">
                <h3>Company {i + 1}</h3>
                <div className="row">
                  <div>
                    <label>Company</label>
                    <input
                      value={exp.company}
                      onChange={(e) => updateExp(i, { company: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>Location (optional)</label>
                    <input
                      value={exp.location ?? ""}
                      onChange={(e) => updateExp(i, { location: e.target.value || undefined })}
                    />
                  </div>
                  <div>
                    <label>Title</label>
                    <input value={exp.title} onChange={(e) => updateExp(i, { title: e.target.value })} />
                  </div>
                </div>
                <div className="row">
                  <div>
                    <label>Start date</label>
                    <input
                      value={exp.startDate}
                      onChange={(e) => updateExp(i, { startDate: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>End date</label>
                    <input value={exp.endDate} onChange={(e) => updateExp(i, { endDate: e.target.value })} />
                  </div>
                  <div>
                    <label>Project name (optional)</label>
                    <input
                      value={exp.projectName ?? ""}
                      onChange={(e) => updateExp(i, { projectName: e.target.value || undefined })}
                    />
                  </div>
                </div>
                <label>Bullet lines (one per line)</label>
                <KeyboardTextarea
                  value={(exp.bullets ?? []).join("\n")}
                  onValueChange={(v) =>
                    updateExp(i, {
                      bullets: v.split("\n"),
                    })
                  }
                />
                <label>Paragraphs / notes (one per line)</label>
                <KeyboardTextarea
                  value={(exp.paragraphs ?? []).join("\n")}
                  onValueChange={(v) =>
                    updateExp(i, {
                      paragraphs: v.split("\n"),
                    })
                  }
                />
                <label>Raw resume lines (optional)</label>
                <KeyboardTextarea
                  value={exp.rawLines ?? ""}
                  onValueChange={(v) => updateExp(i, { rawLines: v || undefined })}
                />
                <label>Freeform notes (optional)</label>
                <KeyboardTextarea
                  value={exp.notes ?? ""}
                  onValueChange={(v) => updateExp(i, { notes: v || undefined })}
                />
                <button type="button" className="btn small danger" onClick={() => removeExp(i)}>
                  Remove company
                </button>
              </div>
            ))}
            <button type="button" className="btn small" onClick={addExp}>
              + Add company
            </button>
          </div>

          <div className="card">
            <h2>Skills</h2>
            <label>One skill per line or comma-separated</label>
            <KeyboardTextarea value={skillDraft} onValueChange={setSkillDraft} />
          </div>

          <div className="card">
            <h2>Education</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              For each school, you can enter the period you attended (from / to). Use any format you like
              (e.g. 2018–2022, Sep 2018 – Jun 2022, or Present for ongoing). Dates are optional — leave both
              empty to render just the school, degree, and field. If you fill one, you must fill the other.
            </p>
            {profile.education.map((ed, i) => (
              <div key={i} className="exp-block">
                <div className="row">
                  <div>
                    <label>School</label>
                    <input value={ed.school} onChange={(e) => updateEdu(i, { school: e.target.value })} />
                  </div>
                  <div>
                    <label>Degree</label>
                    <input value={ed.degree} onChange={(e) => updateEdu(i, { degree: e.target.value })} />
                  </div>
                </div>
                <div className="row">
                  <div>
                    <label>Field</label>
                    <input value={ed.field} onChange={(e) => updateEdu(i, { field: e.target.value })} />
                  </div>
                </div>
                <div className="row">
                  <div>
                    <label>From (optional — both or neither)</label>
                    <input
                      value={ed.startDate}
                      onChange={(e) => updateEdu(i, { startDate: e.target.value })}
                      placeholder="e.g. Sep 2018 (or leave empty)"
                    />
                  </div>
                  <div>
                    <label>To (optional — both or neither)</label>
                    <input
                      value={ed.endDate}
                      onChange={(e) => updateEdu(i, { endDate: e.target.value })}
                      placeholder="e.g. Jun 2022 or Present (or leave empty)"
                    />
                  </div>
                </div>
                <button type="button" className="btn small danger" onClick={() => removeEdu(i)}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" className="btn small" onClick={addEdu}>
              + Add education
            </button>
          </div>

          <div className="actions">
            <button type="button" className="btn primary" onClick={handleSave}>
              Save profile
            </button>
            <button type="button" className="btn danger" onClick={handleDelete}>
              Delete profile
            </button>
          </div>
        </>
      )}
    </>
  );
}
