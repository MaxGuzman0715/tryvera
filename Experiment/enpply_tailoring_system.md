# Enpply Resume Tailoring System — Design Document

---

## 1. Goal

Most candidates now tailor resumes to JDs using AI, so an un-tailored resume is at a structural disadvantage. The two failure modes in current tools are:

- **Over-tailored**: resume reads like a copy of the JD, immediately visible to recruiters
- **Under-tailored**: keywords are missing or forced in awkwardly

Our approach avoids both by separating two concerns:
- **What to say** (determined by JD extraction at apply time)
- **How to say it** (determined by pre-built, authentic bullet groups offline)

The JD only controls which pre-built bullets surface. It never influences how those bullets are written. This keeps the candidate's voice intact while maximizing keyword match.

---

## 2. System Overview

Three phases, each with distinct compute and timing:

```
OFFLINE (once per candidate, or when profile updates)
  └── Phase 1: Pre-compute bullet groups per [company, stack]

AT JOB ADD TIME (once per JD)
  └── Phase 2: Extract K1 / K2 / K3 from JD

AT APPLY TIME (per application)
  └── Phase 3: Select bullets, distribute across companies, run K2 injection
```

---

## 3. Phase 1 — Offline Pre-computation

### 3.1 Scope

Only the last 2 companies in the candidate's work history are tailored.
Everything before that stays as-is.

### 3.2 Stack Taxonomy

Stacks are organized into domains. Each domain has a tier:

- **Tier 1** (5-line bullet groups): BE, FE, Mobile, AI_ML, Data_Eng, MLOps
- **Tier 2** (2-line bullet groups): DevOps, Cloud, Database, Analytics_BI

Full approved stack list per domain:

```
BE:           python_django | python_flask | python_fastapi | python |
              java_springboot | java | typescript | nodejs | nestjs |
              go | rust | dotnet_csharp | ruby_on_rails | php_laravel |
              c_cpp | scripting

FE:           react | nextjs | vue | angular | svelte

Mobile:       swift | objc | kotlin | flutter | react_native

AI_ML:        agentic_ai_rag | llm_finetuning | classical_ml |
              recommendation_sys | computer_vision | nlp |
              robotics_planning | ai_safety

Data_Eng:     spark | kafka | databricks | airflow | dbt | flink |
              snowflake | etl_pipelines

MLOps:        model_serving | experiment_tracking | model_monitoring

DevOps:       kubernetes | cicd | docker | terraform | observability

Cloud:        aws | gcp | azure

Database:     postgresql | mysql | mongodb | dynamodb | redis |
              elasticsearch | cassandra | sql_server | snowflake |
              neo4j | vector_db

Analytics_BI: tableau | looker | powerbi | sql_analytics
```

### 3.3 Project Selection

Per company:
- Identify which stacks the candidate actually used at that company
- For each stack, assign the project that best showcases that specific stack
- **Same domain, multiple stacks at one company**: assign different modules
  or features of the same project to each stack (not the same project node)
  to avoid bullet duplication
- If no distinct module exists, allow a second project for that domain

### 3.4 Bullet Group Structure

Each bullet group = N lines anchored to one [company, project, stack].

**Line 0 (coreline):**
- Must name the stack explicitly
- Outlines the overall scope and scale of the work
- Must include one concrete metric (latency, throughput, %, count, time saved)

**Lines 1–N (supporting lines):**
- Each line demonstrates a specific, hands-on technical concept from that stack
- Uses actual APIs, patterns, tools, and terminology practitioners know
- Does NOT need to repeat the stack name
- Each line stands alone — no dependency on reading the others first

**Examples of technical depth expected per stack:**
- React: react-window, useReducer state machines, React.lazy/Suspense, ErrorBoundary
- Go: goroutine pools, context.Context deadlines, pprof profiling, sync.Pool
- Python: asyncio generators, typing.Protocol, mypy, multiprocessing.Pool
- Node.js: clinic.js, Transform streams, AsyncLocalStorage, worker threads
- PostgreSQL: partial indexes, CTEs with json_agg, EXPLAIN ANALYZE
- Elasticsearch: custom analyzers, search_after, relevance tuning

### 3.5 Coreline Metric Guide

Use this to anchor corelines to the right type of number:

| Domain     | Target metrics                                                    |
|------------|-------------------------------------------------------------------|
| BE         | p99 latency, throughput (req/s), availability %, features shipped |
| FE         | LCP, bundle size, load time, app start time, conversion rate      |
| Mobile     | Crash rate, app store rating, load time, DAU/retention            |
| AI_ML      | Accuracy, inference latency, eval score, cost per inference       |
| Data_Eng   | Pipeline throughput, data freshness, query cost, processing time  |
| MLOps      | Deployment frequency, serving latency, model drift SLA            |
| DevOps     | Build time, deployment frequency, incident count, rollback time   |
| Cloud      | Cost reduction, uptime %, provisioning time                       |
| Database   | Query p99, index size, round trips per request                    |

### 3.6 Storage Schema

Pre-computed bullets stored as JSON, keyed by company and stack:

```json
{
  "company": "Warner Bros. Discovery",
  "stack": "react",
  "domain": "FE",
  "tier": 1,
  "project": "Max Streaming Platform",
  "bullets": [
    "Built React features across the Max platform, contributing to a 20-30%
     improvement in app start times and video start times for 90M+ subscribers.",
    "Virtualized browse carousels with react-window, cutting DOM node count
     by 80% and eliminating scroll jank on memory-constrained TV devices.",
    ...
  ]
}
```

Bullet groups are pre-built at all possible line counts (2, 3, 4, 5) so
generation time only needs to slice, not regenerate.

---

## 4. Phase 2 — JD Extraction

### 4.1 When It Runs

Once, when the user adds a job. Result cached. Uses a mid-size model.

### 4.2 Signal Quality

Before any extraction, classify the JD:

| Quality        | Description                                                        |
|----------------|--------------------------------------------------------------------|
| `high`         | Clear Required/Preferred split with specific named stacks          |
| `medium`       | Some specific stacks, structure loose or incomplete                |
| `low`          | No tech specifics — only generic competency language               |
| `laundry_list` | 8+ stacks across domains at roughly equal weight                   |

Low-signal path: infer domain from title + company + industry, pick 1 stack,
rely on competency_signals for tone. Surface warning to user.

Laundry list path: same as OR handling — pick any 2 per domain.

### 4.3 K1 — Gate Keywords

**K1 Hard**: stacks from the approved list whose absence would immediately
disqualify a candidate. Must come from the approved stack list in Section 1.

Rules:
- Required/Must Have section → K1 candidates
- Preferred/Nice to Have section → K2 only, never K1
- Stack in both sections → treat as K1
- Stack in Responsibilities with a specific named tech → treat as K1
- If required but not on the approved list → goes to K2 as plain string
- Primary domain (highest %): max 3 stacks
- All other domains: max 2 stacks
- OR handling: JD lists multiple stacks with OR logic → pick any 2 if in
  Required section; put all as a group array in K2 if in Preferred section

**K1 Soft**: non-technical gate requirements only.
- Years of experience, degree requirements, mandatory leadership experience
- Max 3. Only if explicitly required.
- Security clearance goes to its own field, not K1 soft.

### 4.4 K2 — Contextual Keywords

Keywords a strong candidate would be expected to have, even if not a gate.
Used in the K2 injection pass at apply time.

Always K2 (never K1):
- Protocols: REST API, GraphQL, gRPC, WebSocket, OAuth, JWT
- Architecture patterns: microservices, event-driven, serverless, MVC
- Process: agile / scrum, code reviews, CI/CD (if not K1)
- Soft skills: cross-functional collaboration, stakeholder management,
  technical mentorship

OR groups from Preferred sections → grouped arrays:
`["AWS", "GCP", "Azure"]` means any one satisfies the requirement.

### 4.5 K3 — Truly Dropped

Audit trail of what was seen and thrown away. Never used in tailoring.

Only goes here:
- Leftover OR list items not selected as the 2 picks
- Very niche tools in under 5% of similar JDs (Ada, Wagtail, COBOL)
- Company-internal framework names (PNC Enterprise Risk Framework)
- Meaningless filler ("fast-paced environment", "team player")

Common mistake to avoid: "agile", "code reviews", "Docker", "REST API",
"cross-functional" all belong in K2, not K3.

### 4.6 Competency Signals

Used only for low-signal JDs. Maps generic competency language to tone
guidance for bullet generation. Not used as keywords.

| Category       | Triggered by                                          |
|----------------|-------------------------------------------------------|
| `architecture` | System design, application architecture, scalability  |
| `leadership`   | Team lead, mentoring, tech lead                       |
| `process`      | SDLC, release management, agile/scrum                 |
| `user_impact`  | Customer solutions, UX, end-user focus                |
| `testing`      | QA, test planning, application testing                |
| `documentation`| Technical writing, documentation                      |

Max 4 signals. Empty array for high/medium signal JDs.

### 4.7 Security Clearance

Extracted as independent fields, used as a pre-filter before tailoring:

```json
{
  "clearance_required": true,
  "clearance_level": "active | ability_to_obtain | not_required"
}
```

If `clearance_required: true`, surface a warning to the user before
any generation runs. Can be configured to auto-skip these jobs.

### 4.8 Full Extraction Output Schema

```json
{
  "signal_quality": "high",
  "clearance_required": false,
  "clearance_level": "not_required",
  "primary_domain": "BE",
  "domain_breakdown": {
    "BE": 40,
    "FE": 20,
    "Database": 20,
    "AI_ML": 10,
    "Cloud": 10
  },
  "K1": {
    "hard": {
      "BE": ["typescript", "nodejs"],
      "FE": ["react"],
      "Database": ["postgresql", "elasticsearch"],
      "Cloud": ["aws"]
    },
    "soft": [
      "5+ years professional software development experience",
      "prior experience in a user-facing product role"
    ]
  },
  "K2": [
    "REST API",
    "GraphQL",
    "search indexing / ranking / query parsing / tokenization",
    "Tailwind CSS",
    "agentic AI systems",
    "graph-shaped data",
    "OpenSearch"
  ],
  "K3": [
    "AI-native product development (vague, not stack-specific)"
  ],
  "competency_signals": []
}
```

---

## 5. Phase 3 — Generation (Apply Time)

### 5.1 Stack Distribution Across Companies

Given the K1 hard output, distribute stacks between last company (C1)
and second-to-last company (C2):

- Within each domain, the first K1 stack → C1, second → C2
- The primary domain's top stack always goes to C1
- If a stack only exists at one of the two companies in the candidate's
  history → assign to that company regardless of ordering

Example:
```
K1 hard: { BE: [typescript, nodejs], FE: [react], Database: [postgresql, elasticsearch] }

C1 (last company):      typescript, react, postgresql
C2 (second-to-last):    nodejs, elasticsearch
```

### 5.2 Line Count Per Stack

Domain weight → number of lines to pull from the pre-built bullet group:

| JD domain weight | Lines selected |
|------------------|----------------|
| > 35%            | 5 lines        |
| 20 – 35%         | 4 lines        |
| 10 – 20%         | 3 lines        |
| < 10%            | 2 lines        |

Tier 2 stacks (DevOps, Cloud, Database) cap at 2 lines regardless of weight.
Coreline (index 0) is always included regardless of line count.

### 5.3 Bullet Selection

For each assigned [company, stack]:
- Retrieve the pre-built bullet group from Phase 1 storage
- Take the first N lines per the line count calculation above
- Because groups are pre-built at all sizes (2–5), this is a slice, not a
  regeneration

### 5.4 K2 Injection Pass

After bullet selection, run a lightweight injection pass:

- Input: selected bullets for one company + K2 keyword list
- For each K2 keyword, find the most natural existing bullet to mention it
- Modify minimally — one phrase added or one clause extended
- If no natural fit exists for a keyword, skip it entirely
- K2 group arrays → pick whichever option fits the bullet's existing context
- Hard rule: never add a K2 keyword if it makes the bullet read forced

Output: same bullets with K2 keywords naturally woven in where they fit.
Remaining K2 keywords that found no home → surface to skills/tech section.

### 5.5 Final Assembly Per Company

Combine selected bullet sets in order of domain weight (highest weight first):

```
C1 (last company) bullets:
  [typescript bullets — 4 lines]   ← BE, 40% weight
  [react bullets — 3 lines]        ← FE, 20% weight
  [postgresql bullets — 2 lines]   ← Database, 20% weight
  Total: ~9–12 lines

C2 (second-to-last company) bullets:
  [nodejs bullets — 4 lines]
  [elasticsearch bullets — 2 lines]
  Total: ~6–8 lines
```

---

## 6. Prompts

### 6.1 JD Extraction Prompt
**Status: Done**
File: `jd_extraction_prompt.txt`
Model: mid-size (GPT-4o-mini equivalent)
Runs: once per JD at job-add time

### 6.2 Bullet Group Generation Prompt
**Status: To be built**
Model: large (Claude Opus / GPT-4 equivalent)
Runs: offline, once per [company, stack] combo when profile is created or updated

Inputs to the prompt:
- Company name and industry
- Project name and description
- Stack key (e.g. `react`)
- Domain (e.g. `FE`)
- Tier (1 or 2)
- Coreline metric type (from the metric guide in Section 3.5)
- Any existing "common" bullets for context (to avoid duplication)

Output: bullet group JSON (array of N strings, index 0 = coreline)

### 6.3 K2 Injection Pass Prompt
**Status: To be built**
Model: small-to-mid (fast, cheap)
Runs: at apply time, once per company

Inputs: selected bullets for one company + K2 list
Output: same bullets with K2 naturally woven in, unchanged where no fit

---

## 7. Edge Cases

| Situation                              | Handling                                                          |
|----------------------------------------|-------------------------------------------------------------------|
| Low-signal JD                          | Infer 1 stack from title/company/industry, use competency_signals |
| Laundry-list JD                        | Pick any 2 stacks per domain                                      |
| Clearance required                     | Surface warning before generation, can auto-skip                  |
| Stack in K1 but candidate never used it| Skip pre-generation for that stack, flag to user                  |
| Same domain, 2 stacks, 1 company       | Assign to different project modules; allow 2nd project if needed  |
| Stack only exists at one company       | Assign to that company regardless of K1 ordering                  |
| K2 keyword finds no natural bullet fit | Skip injection, surface to skills/tech section                    |
| Empty JD                               | signal_quality: low, return defaults                              |

---

## 8. What's Built vs Remaining

| Component                        | Status      |
|----------------------------------|-------------|
| JD extraction prompt             | Done        |
| Approved stack taxonomy          | Done        |
| Bullet group format + examples   | Done        |
| Coreline metric guide            | Done        |
| K1 / K2 / K3 definitions        | Done        |
| Signal quality classification    | Done        |
| Stack distribution logic         | Designed    |
| Line count calculation           | Designed    |
| Bullet group generation prompt   | To build    |
| K2 injection pass prompt         | To build    |
| Storage schema / DB design       | To build    |
| Candidate profile ingestion      | To build    |
