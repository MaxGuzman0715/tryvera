# GPT manual-generation prompts

Reference only. **Not loaded by the app** — prompt variants are discovered by scanning the
per-key subdirectories (`resume/`, `extraction/`, ...) for `.txt` files, so this file is inert.
See `promptStore.ts` -> `listVariantNamesOnly`.

These are the control prompts used when generating résumés by hand in ChatGPT, where none of the
app's system prompt exists. Most of what they say the app already enforces in
`resume/more-aggressive.txt`; only the consulting-variation rules were missing, and those were
folded into `batch-variation.txt`.

Source: Rohit, Sep 2026, after a 3-profile manual run against AI Engineer #26-00067.

---

## 1. Global guardrails

Before writing, enforce profile grounding, metric uniqueness, and ATS-safe output. Do not name any
tool, platform, framework, cloud service, database, or protocol unless it exists in that candidate's
profile or source company context. Do not repeat any metric within one résumé or across the three
candidates for the same JD. Every quantified result must have clear direction such as reduced,
improved, increased, shortened, or lowered. Preserve the candidate's source-resume facts, older-role
bullets, style, and section structure. Tailor the recent roles strongly to the JD, but never invent
unsupported experience. If a JD's top required skill is missing from a candidate profile, do not
fake it; weaken targeting instead.

> App status: covered. `candidate_skills` is declared as the only nameable vocabulary; the app only
> ever writes the two most recent companies, so older roles cannot be touched; "a credible 82% beats
> an invented 98%" covers the missing-skill case.

## 2. Consulting variation

For the three candidates targeting the same JD, use the same relevant consulting industries if
appropriate, but make each consulting section look independently authored. Vary engagement order,
bullet count, bullet order, opening verbs, sentence structure, architecture emphasis, implementation
details, metric type, metric scale, and outcome shape. Do not reuse sentence frames or near-identical
phrases across candidates. Avoid "template metrics" such as similar daily volumes, similar percentage
gains, or similar latency pairs. One candidate may use percentages, another absolute scale, another
before/after time, another counts or reliability outcomes. End consulting work on adoption, production
ownership, operational support, or measurable business use, not generic handoff.

> App status: **the valuable one.** Engagement order, bullet count and metric-KIND variation were all
> missing from `batch-variation.txt`.

## 3. Metric enforcement

Quantified bullets must be plausible, non-repeating, and structurally diverse. Within one résumé,
never reuse the same number or metric shape. Across the three resumes for one JD, never share the same
generated figure. Mix percentages, counts, throughput, latency, duration, cost, quality, reliability,
adoption, and scale. Never write "changed by X%"; always state the direction.

> App status: covered by the FIGURES section (four per company, four different kinds, at most two
> percentages, unit must match the noun, no absolutes) plus the `{{FIGURES}}` carry-forward list.

## 4. Cross-profile anti-fingerprint

Treat the three resumes as if one recruiter will read them side by side. Remove any shared
fingerprints: same bullet skeleton, same phrase sequence, same metrics range, same client-story order,
same opening verbs, same conclusion pattern, or identical sentence fragments. Similar experience is
acceptable; similar writing is not.

> App status: mostly duplicates #2. The two new items — client-story order and conclusion pattern —
> were folded into `batch-variation.txt`.

## 5. Rendering / ATS

Preserve the exact candidate theme and readable font sizing from the source résumé. Keep section
headings and bullet glyphs in true document reading order, not decorative layers. Bold skill-category
labels. Do not force page breaks that create large blank areas or repeat company/title headers across
pages. Maintain a clean 3-page flow close to the original résumé density.

> App status: not applicable. The LLM never controls rendering — themes are HTML templates, the PDF is
> Chromium, the skills section is built outside the résumé prompt, and heading order is governed by
> theme CSS. The app's equivalent rules live in the theme templates.
