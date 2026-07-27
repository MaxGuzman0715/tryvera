# 📜 Changelog

All notable changes to the **Enpply** project — server, web client, and the
**Enpplify** browser extension — newest first. Dates are commit dates (`YYYY-MM-DD`).

> **Convention:** add an entry here for every meaningful change.
> The Enpplify extension additionally carries its own version in
> [`extension/manifest.json`](extension/manifest.json) (shown as a badge in the
> panel header) — bump it **minor** for small changes, **major** for big ones.

---

## 2026-06-24

- **Enpplify v0.2.0** — show the extension version as a badge in the panel header
  (read from the manifest, the single source of truth).
- **Enpplify** — include the captured job description (`job_description.txt`) in the
  downloaded files, alongside the résumé PDF, cover-letter PDF, and `result.json`.
- Add this project-wide changelog.

## 2026-06-23

- **Enpplify** — download the generated files at the end of both the **Fill all**
  and **Attach résumé & CV** flows (same as the ⬇ Download button), only when a
  generated run exists.
- **Enpplify** — show a prominent company / role job header above the status line.
- **enpply** — higher-level résumé summary with guaranteed stack selection; promote
  the top 2–3 K2 stacks to K1-hard when nothing is marked Required.
- **enpply** — make résumé tailoring less detectable (avoid verbatim JD phrases,
  JD concept-ordering, and mirroring the JD preferred-skill list).
- Reverted an experimental "auto-download on run completion" approach.

## 2026-06-18

- **Enpplify** — per-profile answering-policies layer; store reusable answers and
  policies beside profiles; settings UI surfaces the answering policies.

## 2026-06-17

- **Enpplify** — make all generation LLM calls resilient to free-pool 429s.

## 2026-06-16

- **Enpplify fill / Q&A** — run-free fill-map job context with a leaner AI prompt;
  start fill-map in text mode and escalate to JSON only when unparseable;
  Q&A works before a run (answer/save from page context).
- **Enpplify reliability** — retry transient LLM errors (429 / 5xx) with backoff;
  drop `response_format` on 429 to escape the throttled provider pool; longer client
  timeout for the AI fill/Q&A pass.
- **Enpplify filling** — robust dropdown + checkbox-group (multi-select) support;
  stop the model over-omitting answerable fields; fill the autofill password on
  Easy Fill and Q&A too; per-field match-decision logging.
- **Enpplify answers** — feed reusable answers to the fill/Q&A model and seed
  sensible per-profile defaults; track per-profile bullet stores under
  `Experiment/bullets`.
- **Enpplify** — plain-punctuation cover letters + generate-by-default flags.

## 2026-06-15

- **Enpplify** — bullets-based résumé tailoring in production generation; show the
  bullet store on Profiles and extraction/tailoring detail on Result.
- **Enpplify** — two-tier models + Q&A-driven slots + apply-form capture.
- **Enpplify** — tighter PDF margins and per-document PDF title; bullets-based
  tailoring experiment (Playground tab).

## 2026-06-05 – 2026-06-09

- **Enpplify** — request timeout so a hung API base fails clearly; jot follow-up
  ideas in Release notes.

## 2026-04-06 – 2026-04-07 — Initial build

- First Enpply build: manual, company-based **profile builder** with form
  validation and persistence (last profile/selection).
- **Résumé / CV PDF generation** with multiple templates — `pdfkit` and a
  Chromium/Puppeteer path for custom styling; mock LLM output when no API key.
- **Config** — LLM provider/model selector (incl. DeepSeek); prompt versioning.
- Verbose logging via `ENPPLY_VERBOSE=1` (under `data/logs/`).
- Initial commit: 2026-04-06.
