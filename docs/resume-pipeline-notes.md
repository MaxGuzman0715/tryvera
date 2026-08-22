# Résumé pipeline — working notes

Hard-won mechanics, measured findings, current state. Updated 2026-08-21.
This file exists because these facts are expensive to rediscover.

---

## 0. CURRENT STATE — read first

```
main            93ff396   extension work (dark mode, Copy path, SQLite logs, log filters)
prompt-balance  592e9b2   THE GOOD BRANCH — prompt + anchor work. NOT YET MERGED.
```

`prompt-balance`, oldest first:
1. `da3bbb8` prompt: CREDIBILITY block — keep aggressive tailoring, drop only what reads as fake
2. `d7782e6` anchors: raise grounded specificity for hansal / rowland / andrew
3. `64a2802` prompt: require the employer's own system names in the direct role
4. `592e9b2` profiles: swap andrew/rowland phone numbers (they were reversed)

**Merge to main and deploy to the VPS** when satisfied. VPS is Windows at
38.146.27.14, repo `C:\Users\Administrator\Documents\tryvera`.

Prompt variants in `server/prompt-defaults/resume/`:
- **`more-aggressive.txt`** — ACTIVE per `active.json`. The good one.
- **`default.txt`** — copy of the pre-experiment prompt. Deliberate: every reset path
  and the `getActiveName()` fallback land on `default`, so it must always be safe.
  Doubles as an instant A/B switch in Admin -> Config.
- **`legacy-k2.txt`** — DEAD prompt from an older pipeline. Expects `target`, `K1`,
  `K2`, `role_summary` and pre-built bullets. If selected it tells the model "these
  bullets are near-final, do not rewrite", so the anchor description prints as bullet 1
  and the summary comes out first-person. NEVER select it.
- `more-less-agressive.txt` — untested.

---

## 1. HEADLINE FINDING OF THIS SESSION

**Interview rate tracks GROUNDED SPECIFICITY DENSITY in the payload, not anchor quality.**

Named specifics + metrics available to the model (anchor + top-2 bullets):

| profile | named | metrics | converts? |
|---|---|---|---|
| rhazel | 13 | 3 | yes — and she has NO anchor file at all |
| deepankar | 8 | 0 | yes — 8 named products + TUV SUD external validation |
| andrew | 7 | 0 | yes |
| hansal | 6 | 0 | some |
| rowland | 5 | 0 | few |

The two underperformers were the two sparse profiles. Dense source -> the model
SELECTS. Sparse source -> inventing is the only way to sound concrete.

After `d7782e6`: **hansal 6->17, rowland 5->14, andrew 7->16.**

GPT's refinement, which is right: count **grounded** specificity. 15 specifics of which
10 came from the JD is worse than 6 real ones. Four buckets: grounded nouns / grounded
numbers / external validation / JD-derived. The fourth should approach zero.

---

## 2. PIPELINE MECHANICS

Two LLM calls per generation.

**Extraction** (`extraction/default.txt`): JD in -> `reframed_jd` **A** (direct) and
**B** (consulting), `client_industries`, `domain_scores`, and the finished skills list.

**Generation** (`resume/<active>.txt`) receives ONLY the top 2 companies:

```
companies: last2.map(...)      // generation.ts:634 — TWO companies, that is all
  direct     -> summary_lines: [anchor.description, ...experience[i].bullets]
  consulting -> summary_lines: shared.json engagements + client_industries
```

Facts that matter more than anything else:

1. **Only the top 2 companies reach the LLM.** Index >= 2 -> `projects[].bullets` are
   pushed to `experience_updates` **verbatim** (generation.ts:559-569). The prompt line
   "choose exactly 4 of its existing bullets" is a DEAD instruction — it cannot comply.
2. **`consulting: true` must be on the EXPERIENCE entry in `Experiment/bullets/<id>.json`.**
   `generation.ts:579` reads `exp.consulting`. Putting it only in `projects/` does nothing.
3. **One project object per company.** `findProjectForCompany` uses `.find()` — first
   match wins, extras are dead code. There is NO JD-based anchor selection for direct
   companies; that exists only for consulting, via `shared.json` industry match.
4. **Skills cap at 6-7 categories** and 6-7 programming languages
   (`extraction/default.txt:167`), and the model **only trims, never adds**. A dropped
   category takes its always-keep skills with it — this is how Snowflake vanished on a
   must-have JD, and Python on another. Workaround in place: critical cross-cutting
   skills live in TWO categories (Python/SQL in both Languages and AI&ML).
5. **`spans`, `isRecentTwo`, `bulletsProvided`, `role`, `dateRange` are NEVER read**
   by the server. Documentation only. Valid `spans` if kept: backend, ai_data,
   infrastructure, security_governance, frontend, embedded.
6. **`companies{}` in a bullets file is Zod-stripped.** `profileBodySchema` declares
   only id/basic/experience/skills/education. Reachable only from the admin Playground.
7. **Bolding**: the category regex was `[^,:]{2,40}` so any category name containing a
   comma never bolded. Fixed on main to `[^:]{2,60}`.
8. **Files the code loads**: `Experiment/bullets/<id>.json`, `Experiment/projects/<id>.json`,
   `Experiment/answers/<id>.json`, `Experiment/policies/<id>.json`, `Experiment/projects/shared.json`.

---

## 3. THE PROMPT — what each edit was for

### Bullet-count ratio (critical, learned the hard way twice)
- 10-11 source bullets -> 10-12 output = 1:1 -> **model just rewords**
- **4 source bullets + anchor -> 10-12 output = expansion -> forces synthesis** <- correct
- Lowering the direct company to 7-9 **broke this**: the model split each source bullet
  in half. Measured 34% of the section lifted verbatim, one bullet 82%.
  **Do not reduce the direct quota below 10-12.**

### CREDIBILITY block (`da3bbb8`)
Placed before SUMMARY so it governs all bullet writing. States that tailoring is the
GOAL — aim for **70-80% JD coverage in the direct company**, and "a direct section
stripped of technology is a FAILURE, not a safe choice". Then bans exactly five things:
- the target company's internal team names / programme names / house phrases
- sole ownership of an entire flagship product. "Led a team", "architected the X
  service", "mentored engineers" are explicitly **ALLOWED**
- seniority inflation past `candidate.current_title`
- recasting the hiring company's product as the candidate's past work
- more than 2-3 figures in the direct company, or an absolute ("100%") as a metric

### Naming rule (`64a2802`)
Grounding semantically and carrying PROPER NOUNS through are different things — the
model was doing the first and skipping the second. Two sentences in the
`consulting: false` branch: **NAME THE EMPLOYER'S OWN SYSTEMS** ("a reader should be
able to identify the product with the company name removed... the named system says
WHERE the work happened, the technology says HOW"), and **summary_lines is a MENU,
not a checklist**.

### Metrics
The tail rule used to say "when no source metric exists... use varied plausible units"
— an instruction to fabricate. Now: prefer figures already in summary_lines, then a
concrete scale signal, invention capped and last-resort. `shared.json` keeps its
per-engagement metric mandate because it has 39 real figures.

---

## 4. MEASURED RESULTS (Hansal, same JD)

| | original | balance v1 | balance + naming |
|---|---|---|---|
| company-native names | 1 | **0** | **7 / 7** |
| named technologies | 7 | 17 | 15 |
| metrics | **5 invented** | 1 invented | **1, sourced** |
| invented team | — | — | clean |
| flagship sole-ownership | **yes** | — | clean |
| JD jargon ("0->1") | x2 | — | clean |

The final run named `Flow-to-TypeScript` and `Ruby on Rails monolith decomposition` —
published Wealthsimple facts no generic ML résumé would contain. It used 15 of 17
available technologies and only 1 of 6 available figures: selection, not dumping.

Residual: mild semantic mirroring remains ("accounting automation... transaction
labeling and receipt reconciliation" leaned on the target's product domain).

---

## 5. FAILURE MODES SEEN, WITH CAUSES

- **Anchor description printed as bullet 1 + first-person summary** -> `active.json`
  pointed at the dead `legacy-k2`/`default` prompt from another pipeline.
- **Hiring company's internal team names in his history** ("Eng Core", "pods") ->
  the original prompt licensed `reframed_jd` as a grounding source with no counterweight.
- **14 invented metrics in one company** -> the prompt mandated metrics and permitted
  invention outright.
- **Splitting source bullets in half** -> quota lowered while the source was restricted.
- **Company-native names disappearing** -> nothing told the model to carry proper nouns.
- **Run-to-run variance** -> `reframed_jd` is regenerated EVERY run. Identical inputs
  gave 4/11 vs 8/11 grounded and 2 vs 5 invented metrics. **Nothing is measurable
  without two runs.** Caching `reframed_jd` per (JD, profile) is the highest-value
  unbuilt improvement.
- **Generate returned an old result** -> `index.ts:1719` duplicate-checks the job link
  and returns the existing run. Use **Force regenerate** or a different JD.
- **Eligibility waste** — 4 of ~10 generations went to roles the candidate could not
  hold (GDH clearance, BetMGM x2 US-only, TechniPros W2 + on-site). A pre-filter on
  work auth / clearance / licensing / location is still unbuilt.

---

## 6. PROFILES

| id | title | companies | anchor | consulting |
|---|---|---|---|---|
| deepankar_kalra | Senior SWE | ASSA ABLOY -> Accenture -> Meta | ACaaS + mobile credentials (797 ch, 8 named) | Accenture |
| rowland_sipola | Senior SWE | Trinnex -> Deloitte -> Tellic -> Zillow -> Google | waterCAST digital twin + Capacity Planner (14 named) | Deloitte |
| andrew_ray | Staff Data Scientist, ML Platform | Rackspace -> Avanade -> Synophic -> Globe Life | FAIR + RITA (16 named) | Avanade |
| hansal_maniar | Senior SWE | Wealthsimple -> TEEMA -> Suncore -> Google -> CIBC | Book of Record + FAM + FCP (17 named, 6 figures) | TEEMA |
| rhazel_galura | Senior Fullstack AI Engineer | QTX/Accenture -> Accenture | **NONE** — no projects file, no consulting flag | none |

### Researched anchor content

**Hansal / Wealthsimple** — publicly documented: Book of Record, Financial Activity
Model, ledger, Financial Calculation Platform, Machine Learning Platform (sub-15-minute
model deploys), NVIDIA-backed AI Inference Platform (30+ models, ~247M predictions in
12 months), LLM Gateway (72,000+ requests at launch, ~500 daily users), Flow-to-TypeScript
migration (700,000 lines / 40+ repos), Kafka event backbone, Ruby on Rails monolith
decomposition, Kotlin/Node.js/Python services, JSON-defined workflow engine, products
Trade / Cash / Managed Investing / Tax.
Sources: engineering.wealthsimple.com — inside-the-book-of-record, get-to-know-our-llm-gateway,
wealthsimple-accelerates-machine-learning-model-delivery, a-journey-to-ai-powered-migrations,
migrating-to-typescript-without-migraines; medium.com/wealthsimple/new-kafka-tier-no-kafka-tears

**Rowland / Trinnex** — researched from trinnex.io and esri.com: waterCAST is an
AI-powered **digital twin** platform for water/wastewater, built inside **CDM Smith**.
Modules: **Capacity Planner**, **waterCAST WQ** (water-quality compliance, **PFAS**
tracking), **waterCAST Sewer** (real-time collection-system monitoring, overflow alerts).
**Esri Partner Network** member — integrates **ArcGIS Pro** and **ArcGIS Online** over
the utility's existing GIS. Ships explicit **glass-box** (not black-box) AI so engineers
can defend decisions to regulators. **SOC 2 Type 2** audited. PostGIS / Python services /
containers / event-driven telemetry are architecturally implied, NOT published — marked
as such in the notes field.

**Andrew / Rackspace** — FAIR (Foundry for AI by Rackspace) + RITA are public. The
retrieval and lifecycle stack (Azure OpenAI, Amazon Bedrock, hybrid retrieval with
reranking, MLflow, Triton, ONNX, Kubernetes, Terraform, multi-cloud) is architecturally
implied, not individually cited. No numeric figures are publicly sourced for FAIR/RITA,
so only scale signals are used.

### Anchor structure that works
1. Plain-language "what it is", naming the product(s)
2. Concrete actor journey — "A client places a trade... behind the interface..."
3. Hedged ML sentence ("can support") with **domain-locked inputs**, terminating in a
   real business action and a named actor. Rowland's weather/demand/asset inputs cannot
   be stretched into generic MLOps; abstract inputs can.
4. Explicit layer map — "It touches the frontend layer (X), the backend layer (Y)..."
   This is what lets a JD SELECT a layer instead of inventing one.
5. Named technologies AND 2-3 real figures. Zero numbers means the model invents them.

### shared.json (consulting pool)
13 engagements, 39 figures, **0 bare**. **Rule: weld each figure into the clause that
names its mechanism.** A floating figure lands on an unrelated bullet. This took
consulting metrics from 4-invented to 5/5 sourced and still holds — every recent run's
TEEMA figures traced to source.

---

## 7. LINKEDIN vs RÉSUMÉ (checked 2026-08-21)

Mismatches are NOT automatically fatal — Deepankar and Andrew have several and both
convert. What matters is **vague vs contradictory**.

**deepankar** — ASSA ABLOY: LinkedIn Senior SWE, résumé **Lead**. Meta: LinkedIn
Software Engineer @ **Walnut Creek CA**, résumé Senior SWE @ Mississauga. LinkedIn shows
ONE degree (MSc 2008-2011), résumé shows BSc + MCA. Location matches. Headline "Senior
Software Engineer". His Meta role carries 5 bullets. Cisco cert 2015-2016 not in profile.
**Converts best despite all of this.**

**andrew** — Headline **"MLOps | Data Science | Gen AI | Cloud"** (four searchable
keywords; likely a real advantage). Location "United States" — vague, harmless.
Rackspace is TWO roles on LinkedIn (Sr. Data Science & AI Platform Engineer Mar 2025+,
Senior MLOps Engineer Jun 2023-Feb 2025); the résumé merges them as "Staff Data
Scientist". Avanade "Sr. Data Science/AI Engineer" vs résumé "Senior ML Data Scientist".
Globe Life had a **Data Engineer Intern Jul 2017-Jan 2018** the résumé absorbs into the
full role. Rice BSc 2011-2015 + MS 2015-2017 match.

**hansal** — Google Sep 2013-Jun 2018 Toronto **CONFIRMED on LinkedIn** (the base-info
sheet saying Chartwell was outdated). CIBC "Application Developer" matches. Headline
"Senior Software Engineer | Dad". Location "Canada". **Bachelor of Commerce, University
of Mumbai is on LinkedIn and STILL MISSING from the profile.** The base sheet says every
role is Contract (Wealthsimple, TEEMA, Suncore) except CIBC — not reflected anywhere.

**rowland** — the only one with CONTRADICTIONS rather than vagueness:
- **Headline says "Software Engineer at Google"** — he left in July 2014. Eleven years stale.
- **Location Durham, North Carolina** vs résumé West Islip, NY. Different states.
- **Zillow ends Jul 2016 on LinkedIn, Dec 2017 on the résumé** -> an 18-month gap
  concealed. The one mismatch that reads as dishonesty rather than polish.
- **UPenn BA Economics is not on LinkedIn at all.**
- Summary is four words. **Zero role descriptions anywhere.**
- Top Skills: Software Infrastructure, Django, AWS — **no ML signal**, despite an MS in
  AI and résumés that push ML platform hard.
- Deloitte ends Aug 2024 on LinkedIn, Jul 2024 in the profile.
- LinkedIn shows "Rowland S."; profile says **Rowland Sipola** (CONFIRMED correct — the
  "Siploa" in the base sheet is a typo).

**Conclusion on Rowland:** the low response rate is a **screening** failure, not a
naturalness failure. Unnatural keyword stuffing hurts AFTER a human reads it (interviews
that do not convert), not before. Screening is decided by title, brand position,
location, gaps and LinkedIn completeness — and he loses on four of five. Also: one week
is too short to judge, and **application volume per profile was never measured**. On the VPS:
`sqlite3 data\application_logs.db "SELECT resume_profile, COUNT(*) FROM applications GROUP BY resume_profile ORDER BY 2 DESC;"`

---

## 8. CODE WORK LANDED ON MAIN

**Log store -> SQLite** (`server/src/logStore.ts`). The JSON store rewrote the whole
array per write with `fs.writeFile` (truncate-then-write) and no lock. One generation
does ~6 read-modify-write cycles, so 40 concurrent runs interleaved ~240 of them. Two
failure modes: last-writer-wins dropped entries, and a read landing inside a truncate
window returned an empty array silently, after which the next append persisted the
emptiness. That destroyed ~700 records twice.
Now `node:sqlite` (built into Node 22.5+, no npm dependency, no native build), WAL mode.
Verified: 700 history rows + 40 concurrent runs x 6 writes = zero loss; SIGKILL
mid-write during 12,700 writes = zero loss; auto-imports the legacy
`application_logs.json` once (skipped when the table is non-empty), JSON kept as backup.

**Log page filters** (`client/src/enpply/pages/Logs.tsx`) — Status, Tracking, From/To
date, Clear. 14 predicate tests passed, including timezone-safe inclusive date bounds
and missing `tracking_status` treated as pending. Feeds pagination, selection and CSV.

**Extension** — dark mode (212 hardcoded colours -> 47 tokens plus a dark palette;
Auto/Light/Dark switch inside More and in the popup), stronger panel edge, and Copy path
now reports the folder Chrome ACTUALLY wrote, read back via `downloads.search()` after
waiting for `state === "complete"`. `download()` resolves when the transfer STARTS, so
the filename is frequently empty or a `.crdownload` temp at that moment. Copy path does
NOT trigger a download; it warns when no local copy exists.
`chrome.downloads` can ONLY write inside the browser Downloads directory — absolute
paths are rejected and MV3 workers cannot use the File System Access API. A custom folder
works only if it sits INSIDE Downloads (the root is probed once with a scratch file).
**The admin page is different**: it uses `showDirectoryPicker()` + IndexedDB and CAN
write anywhere — but the browser hides the absolute path, which is why the typed folder
field exists (display only).
Admin Logs "Copy path" returns `output_folder_abs` = the SERVER's path, useless when the
browser is on a different machine from the server. Still unfixed.

---

## 9. OPEN ITEMS

**Merge and deploy**
- [ ] merge `prompt-balance` -> main; on the VPS `git pull`, `npm run build`, `npm start`
- [ ] the VPS runs `npm run dev` (`node --watch`), which restarts on any `node_modules`
      lazy-require and kills in-flight generations. Use `npm start` in production.

**Profiles**
- [ ] Hansal: add the Bachelor of Commerce (University of Mumbai); decide whether to
      reflect Contract employment type
- [ ] Hansal: 8 of 12 older-company bullets (Suncore, CIBC) are INFERRED from public
      research and never confirmed by him. They print verbatim on every submission.
- [ ] Rowland: fix the LinkedIn headline / location / Zillow dates (his side — biggest
      lever); align Deloitte to Aug 2024; drop the UPenn BA unless confirmed
- [ ] Andrew: reconcile his title ("Staff AI Engineer | Senior MLOps Engineer" per the
      base sheet vs "Staff Data Scientist, ML Platform" in the profile)
- [ ] **Test Rowland on a platform/data JD** — his anchor changed most and is untested
- [ ] skills inventories are aspirational (ISO 20022, Db2, CICS, Neptune, Kubeflow).
      Verify with each candidate before live submission.

**System**
- [ ] **cache `reframed_jd` per (JD, profile)** — nothing is measurable without it
- [ ] eligibility pre-filter (work auth / clearance / licensing / location)
- [ ] code-side guards worth building: JD-overlap score on the generated section, a
      metric cap, and stripping skills not present in the inventory
- [ ] `llm_heavy` is `{provider: openrouter, model: "gpt-5-mini"}` — a bare id;
      OpenRouter wants `openai/gpt-5-mini`
- [ ] skills category-cap rescue rule (written once, lost with a deleted branch)

---

## 10. ENVIRONMENT GOTCHAS

- **This shell collapses `\\` to `\` even inside quoted heredocs.** It silently corrupted
  three path helpers into non-functional regexes that still parsed. Build literal
  backslashes with `String.fromCharCode(92)`, or avoid them entirely.
- **Extension files are CRLF.** A `.replace()` whose search string contains `\n` matches
  NOTHING and fails silently. Split on `/\r?\n/`, rejoin with `\r\n`, and **assert every
  replacement**.
- **`node --check file.js` parses as CommonJS.** The extension is `"type": "module"`.
  Use `node --input-type=module --check < file.js` — CJS mode hid a real SyntaxError that
  broke service-worker registration.
- **Never insert CSS immediately before the last selector of a comma-separated list.**
  Doing so hijacked a `display:none` rule and left the main panel visible and crushed
  inside the Easy Fill and Q&A subviews.
- Windows **QuickEdit Mode** freezes the server when you click in the console. Press
  **Esc**, never Ctrl+C (with no selection active Ctrl+C sends SIGINT).
- A generation legitimately takes **~2 minutes**. Silence after "waiting for API" is normal.
- Ports: API 5001 local / 5005 VPS, Vite 5273. `.env` overrides everything.
- Letter-spacing above ~0.05em makes PDF text extract as `H A N S A L`. Fixed in
  `resume-rhazel.html`; **still present in rohit (0.2em), navy-center (0.14em),
  deepankar (0.12em), purple (0.1em)**.
- `gh` installed via winget at `C:\Program Files\GitHub CLI\gh.exe`. Git identity is
  still the placeholder `Your Name <test@test.com>`.
