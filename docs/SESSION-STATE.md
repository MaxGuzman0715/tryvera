# Session state — 2026-08-23

Authoritative record of where the résumé pipeline stands. Read this first; it
supersedes the "current state" sections of the other docs where they disagree.

Companion docs:
- `profile-authoring-playbook.md` — how to build a new profile from a LinkedIn export
- `CHANGES-SINCE-VPS.md` — the change list against the VPS build
- `resume-pipeline-notes.md` — earlier architecture handoff

---

## 1. Branches

| branch | commit | what it is |
| --- | --- | --- |
| `main` | `93ff396` | **what the VPS runs.** Untouched all session. |
| `prompt-balance` | `d0da4ff` | all the work. 36 commits ahead of `main`, 26 files, +1427/−227 |
| `baseline-initial` | `dbd2354` | comparison baseline: original prompts + original profiles, everything else current |

`baseline-initial` deliberately keeps SQLite logging, the extension fixes and the
template letter-spacing cap, so only the tailoring differs. It has no
`Experiment/projects/rowland_sipola.json` because he had no anchor at the initial
commit — so it shows what the anchor system itself adds. hansal and andrew are
current there (they didn't exist at the initial commit).

On the VPS: `git fetch && git checkout baseline-initial` / `git checkout prompt-balance`.
`server/prompt-defaults/active.json` gets rewritten by the running server and
blocks checkouts; `git update-index --skip-worktree server/prompt-defaults/active.json`
fixes it permanently (content is identical on all three branches).

**Testing:** always use Force regenerate. The duplicate check at
`server/src/index.ts:1719` returns the cached run for a repeated job link.

---

## 2. Current sizes

```
resume prompt (more-aggressive.txt)   20,736 chars   [the ACTIVE prompt]
extraction prompt (default.txt)       21,619 chars

anchors:  deepankar   797   (untouched all session — the reference)
          andrew     1,839
          hansal     1,985
          rowland    2,303
```

---

## 3. The prompt rules that exist, and why

Every one was paid for by an observed failure. Do not remove without reading the reason.

### Grounding
- **NAME THE EMPLOYER'S OWN SYSTEMS** — the company's real product names must appear
  in the bullets. Generic phrasing is a failure.
- **summary_lines is a MENU** — select what serves this JD, don't empty the anchor.
- **THE ANCHOR IS THE SETTING, NOT A CEILING** — the JD's core capability goes in the
  direct company even when the anchor never names that stack. *Why:* on an LLM-centric
  JD, rowland's Trinnex section had zero LLM content; all of it sat in Deloitte.
- **HARD BOUNDARY on that rule** — extends CAPABILITY, never IDENTITY. No JD-named
  product may attach to the employer; the employer's business is never restated as the
  target's. Per-bullet test: strip the employer name; if what remains describes the
  target's product, the bullet is wrong. *Why:* two profiles wrote **"Float
  Intelligence"** — the target's own product — into their employers, and deepankar's
  door-lock company became an accounting company.

### Coverage
- **70–80% per company, complementary gaps**, and the explicit procedure: write the
  direct company first, then list every reframed_jd requirement it did NOT use and
  cover those first in consulting. *Why:* hansal's consulting introduced zero
  technologies his direct company hadn't already used.
- **THE MUST-HAVE CHECKLIST COMES FIRST** — enumerate the reframed_jd's Required list
  before writing, walk it again after both companies are written, rewrite a bullet if
  one is missing. Capability requirements need a bullet that *demonstrates* them, not a
  skills line. *Why:* rowland shipped with no AI/LLM content on a JD that requires it.
- **WEIGHT THE COVERAGE THE WAY THE JD DOES** — a missing non-technical requirement
  costs as much as a missing framework. Leadership gets real bullets when the JD leans
  that way, with a floor: **at least two leadership/ownership bullets and one
  collaboration bullet** in the direct company. *Why:* leadership varied 4/3/2/2 across
  profiles when it was an adjective instead of a floor.

### Credibility (the five off-limits things)
- **COMPANY-UNIQUE JARGON** — their names only, never a limit on technology.
- **IMPLAUSIBLE OWNERSHIP** — no sole ownership of a flagship product.
- **SENIORITY INFLATION** — an IC title carries no direct reports, headcount, budget,
  hiring decisions or performance reviews. It DOES carry leading a team or workstream,
  tech lead, owning design, setting technical direction, mentoring, architecture
  reviews, **interviewing**, standards, incident response. *Why:* rowland claimed
  "people-management … hiring" as a Senior SWE; my first fix over-banned interviewing,
  which senior ICs routinely do.
- **THE TARGET COMPANY'S PRODUCT** — plus don't import its DOMAIN vocabulary. Test
  every domain noun: would it appear in the EMPLOYER's marketing?
- **METRICS MUST BE REALISTIC FOR THIS EMPLOYER AND THIS PROJECT** — see §4.

### Coherence
- **TECHNICAL COHERENCE** — no cross-ecosystem pairings (Django REST + Alembic, MySQL +
  WAL tuning, Django ORM inside FastAPI) and no two competing tools for one job in a
  single bullet (FastAPI + Django REST, Postgres + MySQL for the same service).
- **THE FIGURE MUST MEASURE WHAT ITS OWN BULLET DID** — a recommendation service moves
  relevance, not valuation error.
- **The UNIT must match the noun** — steps are counted, time is measured in minutes.
- Every bullet opens with a past-tense verb and ends with a period. A line describing
  only platform scale is not a bullet.

### Summary
- No candidate name, no third-person pronouns. Verb phrases about the role.

---

## 4. Metrics — the history matters

This was rewritten six times. The final state is **deliberately loose**.

**Now:** quantify wherever the work produced a result worth measuring. No count, no
ceiling, no placement rule. The only test is **realistic for this employer and this
project** — sized to the scale summary_lines describes. Consulting figures size to that
client's work. Varied units, avoid clean multiples of 5 and 10, no invented decimal
precision.

**Kept as guards** (about believability, not quantity): a vague quantifier is not a
metric; the figure measures what its own bullet did; units match the noun; no
absolutes; no pooling separate claims into one bullet; standard names (SOC 2 Type 2,
ISO 20022) and percentile labels (p95) are never counted as metrics.

**Removed, and why it was wrong:**

| removed | why it failed |
| --- | --- |
| "at most 2-3" with no floor | rowland shipped **zero** figures; hansal stacked four into one bullet |
| "2-3 as a floor AND ceiling" | produced **1 vs 9** across profiles on the same prompt — a global count across 11 independently written bullets does not bind |
| "exactly THREE / THREE per engagement" | worked, but rationing is not what a résumé needs |
| "at most TWO significant figures" | killed `1,637ms` but collapsed the numeric range |
| seven metric KINDS, no two alike | over-engineering |
| "a percentage is the laziest of the seven" | over-engineering |

**The clustering finding, which is still open.** With the tight rules, 4 profiles on one
JD shared 15 of 37 figures (41%) — `190 ms` in three, `37%` in three, `43%` in three.
Cause: **70% of all figures were percentages** (rowland was 9 for 9), so the pool was
~51 values × ONE type. Birthday maths on 26 draws from 51 predicts ~5.5 repeats; 7 were
observed. Loosening the rules should widen this; unverified.

**Anchors now carry a scale clause** so invented magnitudes anchor to different bases:
Wealthsimple *millions of client accounts*, Trinnex *tens of thousands of service lines
per utility*, Rackspace *thousands of employees over tens of thousands of documents*.
These are company facts, not achievements, and the vague-quantifier rule stops them
being claimed as results. **Every new anchor needs one.**

---

## 5. The skills section

Built by the **extraction** call, not generation. Rules, in the order they run:

1. Order categories by `domain_scores` (3 → 2 → 1)
2. Trim by score, always keeping any skill the JD calls for. **Always-keep matches on
   what the requirement ASKS FOR, not string equality** — "exposure to LLM tooling"
   makes LangChain/RAG/embeddings always-keep even with no tool named.
3. Float always-keeps toward the front
4. **WHICH SKILLS MAY APPEAR — two sources, nothing else:**
   (a) what the candidate lists;
   (b) **same-family adjacent, for REQUIRED items only** — React/Angular/Svelte → Vue,
   Java/Kotlin → C#, Postgres ↔ MySQL, Terraform → Pulumi, Hibernate → EF. Marked
   always-keep so the trim can't delete it. Max 2-3. Never a neighbouring discipline;
   with no same-family evidence, **leave the requirement uncovered.**
5. 6-7 programming languages max per language category
6. **EXACTLY 7 categories** — a target to fill, not a ceiling. Tie-break: the category
   answering a stated qualification wins.
7. Never discard an always-keep on a cut — move it to a surviving category
8. Never cut the candidate's own discipline category; a generative-AI line does not
   substitute for the ML stack
9. **FINAL CHECK, last:** enumerate the Required section's technologies, confirm each is
   present or has no same-family evidence, put back anything missing

**Why each exists:** Vue was in 4 of 5 résumés' bullets and 1 of 5 skills sections
because the rule was a hard binary with no adjacency tier. Andrew — a Staff Data
Scientist — shipped with no PyTorch/TensorFlow/MLflow because the cap cut his own
discipline. The model returned 6 categories with a 7th slot free because "6-7, never
more than 7" reads as a ceiling.

**Verified working:** hansal, deepankar and rowland gained Vue on a Vue/.NET JD;
andrew correctly gained nothing (no frontend framework anywhere in his profile).

**Known over-fire:** andrew also gained 6 backend skills against the 2-3 cap
(`EF Core`, `Dapper`, `Npgsql`, `LINQ`, `ASP.NET Web API`) off one signal, plus hedge
words (`serverless basics`, `Azure familiarity`). **Not yet fixed.**

---

## 6. Anchors — the single most transferable lesson

**An anchor is a stage, not a set.**

Deepankar's is 797 chars, zero named technologies, zero figures, and belongs to the
best-converting profile. Its shape is three moves:
1. what the product category is and why it matters
2. **the causal flow** — actor, action, named system, outcome, with product names inline
3. a layer sweep where each layer is named by **function**

Measured, anchor size against direct-company JD coverage:

| anchor | coverage | technologies used | from the JD | from the anchor |
| --- | --- | --- | --- | --- |
| **797** deepankar | 67% | 16 | **15** | **1** |
| 2282 andrew | **81%** | **24** | 13 | 11 |
| 2422 hansal | 80% | 15 | 7 | 8 |
| **3432** rowland | **56%** | **11** | 6 | 5 |

Two mechanisms: the bullet budget is fixed at 10-12 so anchor material crowds out JD
material; and a named stack in the anchor **pre-commits the choice** and then fights the
JD. All three big anchors were reshaped — stack inventories deleted, situations kept
("an event-driven estate", "a legacy monolith behind anti-corruption layers"), layer
sweeps renamed to functions. Generic technology count went 14/4/18 → **0/0/1**, with
every product name preserved (53/53 verified).

Proof it worked: on a Vue + .NET + EF Core JD — a stack no anchor mentions — hansal
produced *"C#/.NET Core services on the **Financial Activity Model**, authoring EF Core
transactional models"*. Product names intact, stack entirely from the JD.

---

## 7. shared.json (consulting)

13 industries. The JD's extracted industry picks the engagements, so **the same JD gives
every profile the same pair.**

**All 34 hard figures were stripped.** Four résumés on one JD had contained
*"cut cross-tenant latency incidents by 64%"* verbatim, plus `1.5M+ users`,
`1M+ questions across 12 languages`, `~3,100 enterprise tenants` and Pinecone —
identical in all four. Traced to commit `4da29cb "Consulting Profile Number"`, which
**added** them; at the initial commit only fintech and media had figures (10 of 13 had
none). So stripping them restored the original design.

Consulting metric rule now: every engagement carries quantified impact of its own,
sized to that client's work, never repeating a figure between engagements.

**Still open:** the engagement NARRATIVES are identical across profiles. Four résumés
describing the same mainframe personalization migration and the same monolith
decomposition are recognisable without any numbers. Real fix is 2-3 engagement variants
per industry selected by a profile-derived index at `generation.ts:573`.

---

## 8. Code changes this session

| file | change |
| --- | --- |
| `server/src/index.ts` | `PUT /applications/:id/answers` returned `ok:true` while discarding the answer mid-generation. Now 409. |
| `server/src/profileStore.ts` | `readProfile` swallowed everything in a bare `catch`, so a schema violation and a missing file both showed as "Profile not found". Now logs file + reason. |
| `server/src/fillMapService.ts` | Added `jobTitle`/`company` canonical keys from `experience[0]` so Experience fields stop falling to the LLM and getting `COMPANY \| TITLE` in one box. Added `sanitizeFillValues()` on all three return paths: collapses whitespace, splits `Company \| Title` to the right half, title-cases ALL-CAPS names and job titles. Company names keep their caps. |
| `extension/content.js` | The status line was `display:none` in the Easy Fill / Q&A drill-in view, so every error and confirmation was invisible — a failed "Add to Q&A" looked like a dead button. Now visible, ordered last. Busy states. Added a **`＋ Q&A + Profile`** button: "Add to Q&A" is app-scoped and could never reappear next time; only the profile store is served across applications. |
| `server/templates/*.html` | Capped the name `h1` letter-spacing at **0.04em** in 6 templates. At 0.18em Ashby's PDF parser read `HA NSA L MA NIA R` — wide inter-character spacing makes the PDF text layer insert word breaks. No extension fix could prevent that. |

---

## 9. Profile data state

| profile | notes |
| --- | --- |
| `hansal_maniar` | anchor 1985, 0 tech, 0 figures, scale clause. BCom (University of Mumbai) added from LinkedIn. Phone `(289)`. LinkedIn-clean. |
| `rowland_sipola` | anchor 2303 with **LeadCAST** + confirmed real work (Bentley ProjectWise connector, Esri→LeadCAST templates, pipeline-completion problem). Phone `(631)`. Location `West Islip, NY \| Remote`. **Open:** Zillow ends Dec 2017 vs LinkedIn Jul 2016; UPenn BA not on LinkedIn. |
| `andrew_ray` | anchor 1839, scale clause. Phone `(650)`. **Open:** title "Staff Data Scientist, ML Platform" vs LinkedIn "Sr. Data Science & AI Platform Engineer" — "Staff" is invented. Globe Life merges a 7-month internship. **No frontend framework in skills**, so Vue-requiring JDs leave his bullets unsupported. |
| `deepankar_kalra` | **untouched all session** — the reference anchor. LinkedIn differences (ASSA ABLOY Senior vs Lead, Meta title and Walnut Creek CA, degree type) accepted as explainable. |
| `rhazel_galura` | **no anchor file** and **no consulting company** — both her recent roles are direct, so she never touches shared.json. Skills are an uncategorized flat list, which is why hers render as one comma run. |
| `rohit_kumar` | **broken:** `projects` names RBC as the direct company but `bullets`' most-recent is Accenture, so the anchor never binds. |

Skills pruned of non-technical entries: rowland 180→153 terms (whole
`Technical Leadership` category deleted — 7 of 7 were process nouns), andrew 173→158,
hansal 230→224.

---

## 10. Base résumés

New: `Experiment/base-resumes/`. Rhazel's is there as `.html` + `.pdf`, rendered through
the same puppeteer path the app uses for generated PDFs.

Built from **stored profile data**, in her existing document's layout. Two roles: QTX /
Accenture (Oct 2025 – Jun 2026) expanded from 4 stored bullets to 14 across two
groupings, and Accenture (Jan 2020 – **Oct 2025**, ending where QTX starts) with all 25
of her original bullets across the three original groupings — verified by checking 28
distinctive phrases, none missing. Seven skill categories, 41 lines.

**Deliberately excluded:** the `.NET Core` / payroll-platform material that appeared in
JD-tailored generations. Her stored profile has no C#, .NET or EF, so that exists only
because a .NET JD asked for it. A base résumé is the honest superset.

Re-render: `node <script>` against the `.html`, or edit the HTML and re-run.

---

## 11. Open items

**Code, in priority order**
1. **Pass the candidate's skill inventory into the generation payload** (`generation.ts:622`).
   Generation currently receives only `candidate{full_name, current_title}` and
   `companies[]`, so it names technologies the skills step then cannot list. This is why
   andrew has 4 Vue bullets and no Vue in skills, and why rhazel claimed EF Core.
   **Last known architectural gap.**
2. **Engagement variants in `shared.json`** — 2-3 per industry, selected by a
   profile-derived index at `generation.ts:573`. Fixes the identical client narratives.
3. **Eligibility pre-filter** — parse residency / work authorisation / years-of-experience
   from the JD and warn before generating. A US-only posting consumed 5 generations for
   3 profiles that can't legally apply.

**Prompt**
4. **Tighten the adjacency cap** — over-fires (6 additions vs a 2-3 cap) and produces
   hedge words. Small and clearly wrong.

**Data**
5. `rohit_kumar`'s anchor doesn't bind (§9)
6. rowland's Zillow dates and UPenn BA; andrew's title and Globe Life internship
7. rhazel's skills are uncategorized; her Accenture has no `consulting: true` flag while
   deepankar's does — same employer, opposite handling

**Unverified**
8. The loosened metric rules (§4) have not been generated against yet
9. Whether clustering falls now that percentages aren't forced

---

## 12. Things learned the hard way

- **An adjective drifts; a number binds.** Every rule that held became countable
  (leadership floor, 7 categories). Every rule left as an adjective drifted (coverage at
  "roughly 70-80%", leadership at "several"). But **over-counting is its own failure** —
  the metric apparatus had to be torn out.
- **An absolute placed before an exception wins.** "NEVER add a skill…" followed by "ONE
  NARROW EXCEPTION" never fires. Fold the exception into the rule.
- **A ceiling reads as a target to stay under.** "6-7, never more than 7" returned 6.
  "EXACTLY 7, a target to fill" returned 7.
- **Tightening one axis narrows another.** Precision rules collapsed the numeric range
  and caused cross-profile collisions.
- **Verify which prompt produced a run** before diagnosing: `llm_input.json` carries the
  exact `system_prompt`.
- **This shell collapses `\\` even inside quoted heredocs.** Use `String.fromCharCode(92)`
  or write scripts with the Write tool.
- **`node --check` parses as CommonJS** and hides ESM syntax errors. Use
  `node --input-type=module --check`.
- **CRLF:** most repo files are CRLF. Match line endings when patching or nothing matches.
