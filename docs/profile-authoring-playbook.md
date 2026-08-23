# Profile Authoring Playbook

How to build a complete Tryvera profile from nothing but a LinkedIn export and a base-info
sheet. Every rule here was paid for by a failure in a real generated résumé; the evidence is
attached to each one so none of it gets re-litigated.

Read this **before** touching any profile file.

---

## 1. What actually reaches the model

Three files feed a résumé. Only some of their fields are alive.

| file | field | reaches the LLM? |
| --- | --- | --- |
| `Experiment/bullets/<id>.json` | `basic` | header + summary seed |
| | `experience[0..1].bullets` | **yes** — part of `summary_lines` |
| | `experience[2+].bullets` | **no** — the model never sees them; they render verbatim |
| | `skills` | goes to the *extraction* call, not the generation call |
| | `education` | rendered directly, never rewritten |
| `Experiment/projects/<id>.json` | `description` | **yes** — this is the anchor |
| | `flagshipProject` | only as a fallback when `description` is empty |
| | `bullets` (index 2+) | replaces the bullets file's for older companies |
| | `spans`, `notes` | **dead** — documentation only, nothing reads them |
| `Experiment/projects/shared.json` | `projects[].summary` | **yes**, for consulting employers |

The generation payload is assembled at `server/src/generation.ts:622`:

```
direct company     summary_lines = [anchor.description, ...experience[i].bullets]
consulting company summary_lines = the 2 JD-matched shared.json engagement summaries
```

`companies{}` in a bullets file is stripped by Zod and unreachable except from the admin
Playground. Don't put anything load-bearing there.

Older companies (index ≥ 2) get **exactly 4 of their existing bullets chosen for relevance,
never rewritten**. So bullets for index ≥ 2 must be written as finished lines.

---

## 2. Step 0 — reconcile against LinkedIn FIRST

Do this before writing a single bullet. A résumé that contradicts the LinkedIn beside it dies
in screening no matter how good the bullets are, and no prompt change can rescue it.

Build this table for every profile and resolve every row:

| check | why it kills |
| --- | --- |
| every **company** present, same order | a missing employer reads as concealment |
| every **start/end date** to the month | date gaps are the first thing a screener diffs |
| every **job title**, exactly | inflation is checkable in ten seconds |
| every **location** per role | a role in the wrong city is unexplainable |
| **city/region** on the header | résumé says one metro, LinkedIn another → instant doubt |
| every **degree and school** | an extra degree is the worst possible finding |
| the LinkedIn **headline** | a stale headline ("Software Engineer at Google", 11 years on) undoes the résumé |

**Trust LinkedIn over the base-info sheet.** Measured: Hansal's sheet said Chartwell
Retirement Residences; LinkedIn showed Google, Sep 2013 – Jun 2018, Toronto. The sheet was
stale. Anything the sheet asserts and LinkedIn contradicts gets confirmed with the candidate
before it ships.

Where they can't be reconciled, the fix belongs on **the candidate's side** (update LinkedIn),
not by quietly diverging in the résumé.

### Current state of the five live profiles

| profile | outstanding contradiction |
| --- | --- |
| `hansal_maniar` | clean. Bachelor of Commerce (University of Mumbai) added 2026-08-22 from LinkedIn |
| `rowland_sipola` | Zillow ends Dec 2017 vs LinkedIn Jul 2016 (18-month gap concealed); header West Islip NY vs LinkedIn Durham NC; UPenn BA Economics not on LinkedIn; Deloitte off by one month; stale "Software Engineer at Google" headline |
| `andrew_ray` | title "Staff Data Scientist, ML Platform" vs LinkedIn "Sr. Data Science & AI Platform Engineer" / "Senior MLOps Engineer" — "Staff" is invented; Globe Life merges a 7-month Data Engineer *internship* into "Data Scientist, Jul 2017 –" |
| `deepankar_kalra` | ASSA ABLOY "Lead Software Engineer" vs LinkedIn "Senior"; Meta "Senior Software Engineer" vs LinkedIn "Software Engineer"; Meta location Mississauga ON vs LinkedIn **Walnut Creek, CA**; education BS+MCA vs LinkedIn a single MS; LinkedIn Cisco certification absent from the profile |
| `rohit_kumar` | `projects` names RBC as the direct company but `bullets` most-recent is Accenture — the anchor never binds |

---

## 3. Step 1 — the bullets file

```jsonc
{
  "id": "<snake_case>",
  "basic": { "fullName", "title", "email", "phone", "location", "summary", "linkedin" },
  "experience": [
    { "company", "location", "title", "startDate": "Mon YYYY", "endDate": "Mon YYYY | Present",
      "bullets": [], "paragraphs": [], "consulting": true, "notes": "" }
  ],
  "skills": ["Category: a, b, c"],
  "education": [{ "school", "degree", "field" }],
  "note": ""
}
```

- `consulting: true` marks a staffing/contract-placement or client-services employer. It is
  what routes that company to `shared.json` instead of an anchor. Set it on the employer, not
  the client.
- `basic.title` is the seniority ceiling for the whole document — the prompt refuses to write
  above it. Set it to the real current title.
- Index 0 and 1 bullets are **raw material**, rewritten per JD. Index 2+ bullets are **final
  copy** and print as written.

**Mark inferred bullets in `notes`.** Where the public record supports a project but the
candidate never confirmed the specifics, say so: `"Bullets are INFERRED from that public
record — confirm before any live submission."` Hansal currently has 8 of 12 older-company
bullets in this state.

---

## 4. Step 2 — the anchor

One entry per real (non-consulting) company. The `description` is the only field that matters.

### What an anchor is

The **project universe** of that company: what the product is, who uses it, what happens when
they do, and which layers the work spans. It is *not* the candidate's personal contribution
and *not* a fixed technology stack.

### Length and density — copy Deepankar, not my mistake

| profile | anchor chars | named technologies | hard figures |
| --- | --- | --- | --- |
| **`deepankar_kalra`** | **797** | **0** | **0** |
| `andrew_ray` | 2282 | 19 | 0 |
| `rowland_sipola` | 2501 | 7 | 0 |
| `hansal_maniar` | 2361 | 12 | 4 (all publicly sourced) |

Deepankar's is the thinnest anchor in the repo and belongs to the best-converting profile. Its
entire AI surface is one clause:

> *"and increasingly the data/AI side (usage analytics and features like energy-optimization
> and vision-based entry)."*

**Measured failure (2026-08-22):** I extended all three big anchors to 15/15 modern-field
coverage — rowland 2216→3641 chars and 7→13 technologies, hansal 2361→3709 and 12→16, andrew
1996→3160 and 19→21. All three were reverted. Naming a vector store, reranker, model registry
and lakehouse in the anchor surfaces them for **every** JD regardless of fit, and because the
prompt prefers figures already in `summary_lines`, a fatter anchor repeats the same numbers
across every application.

**Target: 800–2500 chars. Prefer the low end. Ideas and real product names, not stacks.**

**REQUIRED: one scale clause.** Name the order of magnitude the employer operates at —
"millions of client accounts", "tens of thousands of service lines per utility",
"thousands of employees over tens of thousands of documents". This is a company fact, not
an achievement, and the prompt's vague-quantifier rule stops it being claimed as a
result. Without it the model has no per-employer numeric basis and falls back to a
generic default: three profiles independently produced "190 ms" on one JD when the
anchors carried no scale at all. It costs one sentence and it is the only per-profile
work needed to keep invented figures distinct.

### Why the shortest anchor outperforms the longest ones

Measured on one JD, per profile, anchor size against direct-company coverage:

| anchor | coverage | technologies used | from the JD | from the anchor |
| --- | --- | --- | --- | --- |
| **797** deepankar | 67% | 16 | **15** | **1** |
| 2282 andrew | **81%** | **24** | 13 | 11 |
| 2422 hansal | 80% | 15 | 7 | 8 |
| **3432** rowland | **56%** | **11** | 6 | 5 |

Two mechanisms, and the second matters more.

**The bullet budget is fixed at 10–12.** Anchor material and JD material compete for the same
slots. Every bullet spent restating the anchor is a bullet not spent on what the JD asked
for. Deepankar's thin anchor doesn't compete, so 15 of his 16 technologies came straight
from the reframed_jd.

**A short anchor pre-commits nothing.** Deepankar's whole architecture is one causal chain:
"An admin uses a web portal to grant or revoke access; a user opens a door with the mobile
app (SMARTair / Openow, HID mobile access); the request travels to cloud services that check
permissions; and the lock firmware acts on the decision." That gives the model named products
for identity, a chain of steps to attach work to, and **zero stack commitments**. Any
technology the JD names can be hung on any step without contradiction.

A long anchor naming ArcGIS Pro, PostGIS, SCADA, glass-box models and SOC 2 Type 2 does the
opposite: it has already chosen the stack. When the JD wants Go, gRPC and Kafka the model must
either ignore the anchor or blend awkwardly, and coverage drops — which is exactly what
rowland's 56% is.

**An anchor should be a stage, not a set.** Deepankar's is a stage with named props. The long
ones were sets already dressed for a different play.

### What to put in

1. **The company's own product, platform and module names.** These are what prove the section
   is really about this employer. Sourced, never invented: waterCAST, Capacity Planner,
   waterCAST WQ, waterCAST Sewer, Book of Record, Financial Activity Model, FAIR, RITA,
   ecoLOGIC, Digital Access Solutions, SMARTair/Openow, iDFace.
2. **The user journey.** "An admin uses a web portal to grant access; a user opens a door with
   the mobile app; the request travels to cloud services; the lock firmware acts on it."
3. **The hard problems.** What made it difficult.
4. **A closing layer sweep** — frontend / backend / data-AI / infrastructure / security so any
   JD can find a foothold.
5. **One clause per major modern surface the project genuinely has**, in idea form. Rowland's
   platform had no document surface at all, so an LLM-centric JD had nothing to attach to; the
   fix was one clause, not a stack list:

   > *"Increasingly there is a natural-language side too: asking questions of the utility's own
   > written record (inspection reports, condition assessments, work orders, as-built drawings,
   > regulatory submissions), and drafting the narratives that go with a capital plan or a
   > compliance filing."*

### What to keep out

- Named frameworks and libraries you're only guessing at. The JD supplies those per-run.
- Invented figures. Publicly sourced company figures are fine (Hansal's 4 all trace to
  Wealthsimple engineering posts) — but label them in `notes` as **company** figures, never
  the candidate's.
- The candidate's personal contribution. That's the bullets' job.

### Record provenance in `notes`

Split every anchor's content into sourced vs. invented, explicitly. Example from
`rowland_sipola.json`:

> *"BREADTH (2026-08-22): the natural-language/document side is one clause of
> PLAUSIBLE-BUT-UNSOURCED scope … Trinnex does not publicly document a GenAI assistant.
> Deliberately kept as an IDEA, not a stack."*

Without this, a future pass mistakes invention for research.

---

## 5. Step 3 — consulting

A `consulting: true` employer needs **no anchor and no bullets**. At generation the JD's
extracted industry selects two engagements from `shared.json` (13 industries available).

**`shared.json` summaries must carry no hard figures.** Measured failure: four résumés
generated for one JD all contained *"cut cross-tenant latency incidents by 64%"*, plus
`1.5M+ users`, `1M+ questions across 12 languages`, `~3,100 enterprise tenants` and Pinecone.
Four different people, four different consulting firms, one story. Two of them in front of one
recruiter is an instant fingerprint. All 34 figures were stripped 2026-08-22 and replaced with
qualitative equivalents that keep the shape of the claim.

**Known residual:** invented figures still cluster. After the strip, Rowland's Deloitte said
*"cutting median tail latency … by 27 percent"* and Deepankar's Accenture said *"reducing tail
response time by 27%"* — same engagement, same metric, same number. A prompt rule cannot fix
this; the model only sees one résumé. The real fix is **2–3 engagement variants per industry
selected by a profile-derived index** at `server/src/generation.ts:573`. Not yet built.

---

## 6. The skills section

Format: one string per category, `"Category: a, b, c"`. The extraction call scores each
category 1–3 against the JD, orders by score, trims by score, and keeps **6–7 categories max**
with a rescue rule that moves a JD-required skill into a surviving category rather than
dropping it (`prompt-defaults/extraction/default.txt:167-171`).

### A skill is something you install, import, or log into

| real skill | not a skill |
| --- | --- |
| PyTorch, Kubernetes, FAISS, Terraform, MLflow, Kafka, PostGIS | architecture reviews, technical design, stakeholder communication, production readiness, incident leadership, engineering standards, system design, domain-driven design, idempotency, scalability |

Measured, share of entries that are not tools:

| profile | categories | terms | non-skill |
| --- | --- | --- | --- |
| **`deepankar_kalra`** | 6 | 65 | **5%** |
| `hansal_maniar` | 14 | 230 | 8% |
| `rowland_sipola` | 14 | 180 | **19%** |
| `andrew_ray` | 12 | 173 | **20%** |

Higher is worse. Rowland has a whole category where 7 of 7 entries are not tools.

**But keep abstractions that are genuinely JD keywords** — `prompt engineering`, `RAG`,
`fine-tuning`, `embeddings`, `model serving`, `model evaluation`, `reranking`, `drift
monitoring`. AI job descriptions list these by name, so they earn keyword matches.
`architecture reviews` and `cross-functional delivery` never appear in a requirements list.

Rule: **cut the management and process abstractions, keep the technical practices that JDs
name.** Category breadth is fine and intentional; padding is not.

---

## 7. Principles that predict outcomes

**Grounded specificity density is the predictor, not anchor quality.** `rhazel_galura`
converts with **no anchor file at all** — 13 named specifics and 3 metrics inside 1,628
characters of bullets. Hansal had 6 named specifics and Rowland 5 when both were
underperforming. Named systems and real figures per unit of text is the metric that matters.

**The last company is read first.** Whatever the target role is built around must appear
there. Measured: on an LLM-centric JD, Rowland's Trinnex section covered 22/27 of its
requirements (81%) but named **zero** LLM technology — all of it sat in Deloitte, which ended
Jul 2024. A reader saw the JD's core skill in the *previous* job.

**The anchor is a setting, not a ceiling.** It fixes *where* the work happened, not the limit
of *what* it involved. A capability the role is built around goes in the direct company even
when the anchor never names that stack.

**…but capability, never identity.** That rule over-fired immediately: on a JD titled
*"Engineering Manager & Product Lead — Float Intelligence"*, two of four runs wrote **"Float
Intelligence"** into the candidate's own employer, and Deepankar's door-lock company became an
accounting company (invoice parsing, bookkeeping outputs, chargeback investigations). Carrying
the target's **product name** is the single worst tell in the document. Per-bullet test: strip
the employer's name; if what remains describes the target company's product, the bullet is
wrong however well it matches the JD.

**Both companies at 70–80%, with complementary gaps.** Whatever one cannot host, the other
carries. A requirement missing from both is the failure. Ties go to the direct company.

**SUPERSEDED 2026-08-23 — see `SESSION-STATE.md` §4.** The whole counting apparatus was
removed. Metrics are now governed by one test, "realistic for this employer and this
project", with no count, ceiling or placement rule. The history below is kept because it
records what was tried and why each attempt failed.

**A global metric count does not bind; a per-bullet rule does.** Two attempts failed here.
Giving the direct company two ceilings and no floor produced sections with **zero** figures
where the anchor had none. Adding a floor then produced **1 figure for one profile and 9 for
another on the same prompt and the same JD** — the rule had no effect in either direction,
because "2–3 across the whole company" asks the model to hold a running count across eleven
independently generated bullets, which it will not do. The working form is positional and
decided up front: **exactly three bullets in the direct company carry a figure and every other
bullet carries no measured number; exactly one per consulting engagement.** Standard names
(SOC 2 Type 2, ISO 20022, OAuth2), percentile labels (p95, p99) and version numbers are
explicitly not metrics, or the rule bans legitimate text.

**Uniformity across profiles is the goal, so the outlier conforms to the group.** When one
profile's output diverges — 9 metrics against 1, 2 and 3; accounting nouns in a lock company
when the other three are clean — fix the rule so it produces the same shape everywhere rather
than tuning that profile.

**Bullet-count expansion drives paraphrase.** Lowering the direct-company quota to 7–9 made
the model split each source bullet in half — measured 34% verbatim lift, one bullet at 82%.
**Keep it at 10–12.** A high ratio of requested bullets to source bullets forces synthesis; a
low one invites restatement.

**Anti-metric: modern-field coverage.** I built a 15-field scan (LLM, RAG, MLOps, streaming,
observability, …) and optimised the anchors against it. It rewards keyword stuffing and
punishes the best profile in the repo — Deepankar scores 7/15. Don't optimise against it. It
was useful once, to find that Rowland's anchor had no document surface at all.

---

## 8. Verification before shipping

1. **LinkedIn diff** — section 2's table, every row resolved.
2. **Native-name presence** — are the employer's own product names in the direct section?
   Rowland's best run hit 4/4 waterCAST module names.
3. **Foreign-name absence** — grep the direct section for every product/platform name in the
   JD. Any hit is fatal.
4. **Metric count and placement** — exactly three bullets in the direct company carry a figure,
   spread through the section, never pooled in a closing line; exactly one per consulting
   engagement. Compare the count across all profiles generated for the same JD: they should
   match. A profile that diverges means the rule is not binding, not that the profile is odd.
5. **Verbatim lift** — n-gram overlap between generated bullets and their source
   `summary_lines`. Above ~30% means the model paraphrased instead of synthesising.
6. **Cross-profile collision** — diff the consulting sections of any two profiles applying to
   the same JD. Shared numbers or shared phrasing is a detection risk.
7. **Bullet shape** — every bullet opens with a past-tense verb and ends with a period. A line
   that only describes platform scale is not a bullet.
8. **Summary shape** — starts with the title, no candidate name, no third-person pronouns, no
   years-of-experience count, no company count, no em dash.

**Force regenerate when testing prompt changes.** The duplicate check at
`server/src/index.ts:1719` returns the existing run for a repeated job link, so a normal
regenerate silently tests nothing.

---

## 9. Order of work for a new profile

1. Read the LinkedIn export. Build the fact table: companies, titles, dates, locations,
   degrees, headline.
2. Diff the base-info sheet against it. Resolve or flag every conflict. LinkedIn wins.
3. Write `bullets/<id>.json`: `basic`, `experience` skeleton with real titles/dates/locations,
   `education`, `consulting` flags.
4. Write finished bullets for index ≥ 2 — they print verbatim. 4 per company survive.
5. Write raw-material bullets for index 0–1.
6. Write `skills` by category. Real tools plus JD-named technical practices. No management
   abstractions.
7. Research the direct companies' real products. Write one anchor each in
   `projects/<id>.json`: 800–2500 chars, product names and ideas, no invented stacks, no
   invented figures, layer sweep at the end, provenance in `notes`.
8. Leave consulting employers with no anchor and no bullets.
9. Generate against 2–3 real JDs with Force regenerate. Run section 8's checks.
10. Diff the consulting section against another profile's on the same JD.
