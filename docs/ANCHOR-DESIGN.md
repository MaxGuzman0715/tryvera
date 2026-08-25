# Anchor design — what actually makes one portable

Everything in this file was measured, not guessed. It supersedes the anchor guidance in
`profile-authoring-playbook.md` where the two disagree.

`deepankar_kalra` and `rhazel_galura` are the reference profiles and were never modified.
All measurements below compare against them.

---

## 1. The finding that mattered

Five separate theories were tried and discarded before the real one. In order:

| theory | measurement | verdict |
|---|---|---|
| anchors are too LONG | net length change from `main` was ~5% | **wrong** — length was never the variable |
| anchors need more NAMED TECHNOLOGIES | Rhazel has 14, Deepankar has **0**, both convert | **wrong** — Deepankar disproves it |
| anchors need more FIELDS declared | Deepankar declares 7-10 of 30 and converts | **wrong** — more fields cost length and sameness |
| anchors need more UNIQUE NAMES | Deepankar has 10, ours had 4-12, no correlation | **partly** — a floor, not a lever |
| **anchors must use UNIVERSAL CONCEPT NOUNS** | Deepankar 2 domain-bound words, ours had 12-15 | **this was it** |

### The test

> Strip the product name out of the sentence. Does the concept still mean something in
> another industry?

Deepankar passes: *grant or revoke access*, *check permissions*, *usage analytics* mean
something anywhere. His domain — door access — is a costume over universal software ideas.

Ours failed: *balanced accounting entry*, *service-line material*, *fuel discrepancy*,
*reconciliation break*, *hydraulic model*, *tank gauge* transfer nowhere. The domain was
the SUBJECT of the work, not the setting for it.

**This is also the cause of JD-language leakage.** When the grounding offers nothing
reusable outside one vertical, the model either drags the domain along or imports the
posting's vocabulary wholesale. Narrowness and leakage are one defect, not two.

### What replaced what

| out (industry category) | in (universal equivalent) |
|---|---|
| ledger, accounting entry, debit, credit | authoritative record, validated write funnel, derived views |
| service line, hydraulic, SCADA, water, utility | asset inventory, physical models, field readings |
| fuel, retailer, tank, gauge, counterfeit | inventory reconciliation, item authentication |
| EPA, AWWA, Lead and Copper Rule, CIRO | SOC 2, ISO 27001, FedRAMP, GS1 |

Product and brand names STAY — they carry specificity without constraining the field.
`Book of Record`, `LeadCAST`, `waterCAST`, `Esri ArcGIS`, `Bentley ProjectWise`,
`DX Wetstock`, `CoLOS`, `Systech UniSecure`, `RITA`, `FAIR` all remain. Domain-category
words go, because they are not brands.

---

## 2. The shape, copied from Deepankar

Three sentences. Nothing else.

1. **What the product is**, in plain terms, plus one line of market or business context.
2. **The request path** — four or more actors, product names in parentheses.
3. **The layer list** — four layers, SHORT parentheticals, ~300 characters total.

### Sentence 2 must start with a request

Every converting profile opens sentence 2 with a person (or a device) making a real
request and getting an answer back:

| profile | opens |
|---|---|
| deepankar | An admin uses a web portal to grant or revoke access |
| hansal | A customer acts in the app |
| rowland | An engineer opens the web application to test a growth scenario |
| andrew | Someone asks RITA a question |
| mark | A connected unit reports what it did |
| david | A customer request lands on one of those services |
| chris | A user asks a product surface a question |

David and Chris originally opened with *"a practitioner trains a model"* and *"a group
reaches data"* — an internal MLOps lifecycle, not a request. That is why they read wrong
beside the others. Fixed.

### Sentence 3 stays at Deepankar scale

His layer sentence is **298 characters, 4 layers**. An attempt to push field coverage from
~20 to 29 grew layer sentences to half the anchor AND made all six converge on shared
boilerplate — worst anchor overlap hit **26 five-word spans**. Reverted.

Software-engineering profiles lead with the front end. AI/ML profiles lead with the
data/AI side, so machine learning is the first field a reader meets.

---

## 3. Naming invented systems

Real product names fall into four registers:

- **descriptive compounds** — `Book of Record`, `Financial Activity Model`, `Machine
  Learning Platform`, `Capacity Planner`, `Digital Access Solutions`
- **domain + suffix** — `waterCAST`, `LeadCAST`, `ecoLOGIC`, `SMARTair`
- **acronyms** — `FAIR`, `RITA`
- **real vendor products** — `Esri ArcGIS`, `Bentley ProjectWise`, `Confluence`

Single evocative English nouns (`Trellis`, `Quarry`, `Slipway`, `Bellwether`, `Wayfinder`,
`Wellspring`, `Lattice`, `Assay`, `Vantage`, `Waypoint`) are the Borg/Spanner register.
They were tried and rejected: nothing else in the repo uses it, and on a résumé nobody
explains what "Quarry" is, so the name teaches a reader nothing.

**For invented names use descriptive compounds.** They explain themselves:

- David / AWS — `Model Workbench`, `Model Promotion Service`, `Feature Registry`,
  `Model Health Service`
- Chris / Microsoft — `Federated Data Access`, `Model Passport`,
  `Answer Evaluation Service`, `Release Review`

Also avoid **famous** product names. `SageMaker`, `Bedrock`, `Azure Machine Learning`,
`Microsoft Fabric` and `OneLake` were all removed: claiming to have built a household-name
product is a large checkable assertion, whereas an obscure internal name is unverifiable
and signals insider knowledge. That is exactly why `ecoLOGIC`, `iDFace`, `waterCAST`,
`RITA` and Rhazel's `BaptistCare` and `Whiddon` work.

---

## 4. The measurements to re-run

Six checks. Any anchor edit should hold all six.

| check | pass condition | Deepankar |
|---|---|---|
| domain-bound words, product names stripped | **0** | 2 (`firmware`, `credential`) |
| named technologies in anchor + bullets | **0** — the posting supplies the stack | 0 |
| anchor sentences | **3** | 3 |
| layer sentence length | ~300 chars, 4 layers | 298, 4 |
| portability across 8 posting archetypes | **8/8** | 4/8 |
| worst cross-anchor 5-gram overlap | **< 8** | n/a |

Plus the structural ones: 4 bullets at 200-260 chars, zero digits in bullets, one
qualitative scale clause, `consulting: true` on exactly one of `experience[0..1]` **in the
bullets file** (`generation.ts:579` reads it there, not from `projects/`), consulting
company bullets empty, education dates present as strings.

### Current state

| profile | anchor | sent | tech | jargon | portability | names |
|---|---|---|---|---|---|---|
| deepankar (ref) | 797 | 3 | 0 | 2 | 4/8 | 10 |
| rowland | 870 | 3 | 0 | 0 | 8/8 | 9 |
| hansal | 925 | 3 | 0 | 0 | 8/8 | 8 |
| andrew | 937 | 3 | 0 | 0 | 8/8 | 8 |
| mark | 965 | 3 | 0 | 0 | 8/8 | 8 |
| chris | 1004 | 3 | 0 | 0 | 8/8 | 8 |
| david | 1059 | 3 | 0 | 0 | 8/8 | 9 |

Worst cross-anchor overlap 6. Worst rendered-bullet overlap 3. All schema-valid.

---

## 5. Traps hit while doing this

- **A self-mutating review script.** `review.mjs` carried a leftover write block that
  re-applied an old anchor to `chris_perez` on every run, so two rewrites appeared not to
  take. Verification scripts must be read-only.
- **Substring false positives.** `next` in "the next deployment" and `spring` in
  "Wellspring" registered as Next.js and Spring Boot. Use word boundaries.
- **Regex alternation double-counting.** `hundreds of millions of people` matched both
  `hundreds of` and `millions of`, reporting two scale clauses where there is one.
- **Template application.** Writing six profiles in sequence produced one 4-bullet
  template applied six times — `master data management, and Power BI reporting with
  row-level security` appeared in four. Always measure pairwise overlap after a batch.
- **Trimming silently drops content.** Cutting layer sentences back to Deepankar length
  removed `retrieval assistants` from David and `retrieval over service documentation`
  from Mark without either being noticed until a portability re-check.

---

## 6. Open — the plausibility gap

`THE ANCHOR IS THE SETTING, NOT A CEILING` tells the model to carry the posting's core
capability into the direct company. `HARD BOUNDARY` only forbids taking the target's
product, platform, programme or team NAMES. A **capability** is therefore always allowed,
and the rule has no plausibility test.

On a posting whose subject is a job function rather than a technology, that produces
claims that are false on their face. Measured on a Turing "Software Engineering evaluator"
posting, where the subject is evaluating model-generated code:

| profile | code-evaluation concepts grounded anywhere in the profile |
|---|---|
| deepankar | 0/17 |
| rowland | 0/17 |
| hansal | 1/17 |
| chris | 1/17 |
| david | 2/17 |

Output included an "evaluation tier" inside Wealthsimple's **ledger** processing 180,000
model-generated code snippets a week, a "verification pipeline for code solutions used in
model training" at a **water-utility** company, and a "full-stack evaluation platform" for
LLM code examples inside a **lock** company.

Deepankar shows it too, with files that were never modified — so this is prompt behaviour,
not a profile defect.

Proposed clause, **not applied**:

> The capability you carry into this employer must be something that employer could
> credibly have needed. A ledger does not evaluate model-generated code; a lock company
> does not curate training corpora. Where the posting's core subject could not plausibly
> exist at this employer, cover it in the CONSULTING company — that is what the consulting
> company is for — and leave the direct company describing what it actually does.

Two smaller open items from the same run: cost-savings figures have started dominating
(`$120,000`, `$431,000`, `$185,000`, `$420,000`, `$280,000` across four profiles — the
least verifiable figure a résumé can carry), and cross-profile figure collisions recurred
(`180000` in two, `4,200` in two, `22%` in three).
