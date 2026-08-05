# Enpplify — Chrome extension for semi-automated job applications

Companion extension to **enpply** (the existing doc-generation web app). enpply stays the
brain (profiles, generation, answers, PDFs, storage, auth); **enpplify** is a thin,
authenticated client that scrapes the job page, calls enpply's API, and fills the form.
The user always reviews and **submits manually**.

> Naming: **enpply** = current web app (generates docs). **enpplify** = the new extension.

---

## Locked design decisions

| Topic | Decision |
| --- | --- |
| Generation logic | Stays **server-side** in enpply. Extension never embeds the pipeline or LLM keys. |
| Profile selection | **Picker in the extension popup** (profiles pulled from enpply via `GET /api/profiles`). |
| Run creation | **Lightweight session = client-side state** in `chrome.storage` until the user hits Generate; then `POST /api/applications/generate` creates the real logged run. |
| Auth | **Token in popup** — extension signs in, gets the existing session token, stores it in `chrome.storage`, sends it as `Authorization: Bearer`. |
| JD source (MVP) | **Auto-scrape** the page's visible text as the JD. |
| Build order | **Vertical slice** — one endpoint + its matching extension call end-to-end, grow outward. |
| LinkedIn | Hard-disabled (host `linkedin.com` → buttons greyed out). |
| Submit | Always manual. |
| Résumé upload | Automated via DataTransfer; manual fallback for drag-drop / native pickers. |

---

## What already exists (do NOT rebuild)

Grounded in the current server (`server/src/index.ts`, `server/src/auth/`):

- **Token auth.** `createSession(userId)` (`auth/sessionStore.ts`) already mints a 256-bit
  base64url session id (30-day TTL, stored in `data/sessions.json`). That session id IS the
  bearer token — no new token type needed. `resolveUser` (`auth/middleware.ts`) reads it from
  the `enpply_sid` cookie and attaches `req.user`. RBAC helpers `requireAuth`, `requireAdmin`,
  `canAccessProfile`, `canAccessApplication` all key off `req.user`.
- **Generation.** `POST /api/applications/generate` (`index.ts:968`) accepts
  `{ resume_profile, job_link, recruiter_name?, job_description, apply_form?, theme?,
  gen_resume?, gen_cover_letter?, gen_answers?, gen_fit_answer?, ignore_duplicate_check? }`,
  creates a logged run (`appendApplication`), runs `runGeneration` async, returns immediately
  with `{ id, run_uuid, status: "generating" }`. Client polls `GET /api/applications/:id`
  (returns `result.json`: metadata, `answers[]`, `artifacts`, `artifact_status`, …).
- **PDF blob.** `GET /api/applications/:id/artifacts/:name` (`index.ts:510`, `requireAuth`)
  serves a generated file. Résumé artifact is named `<profile_id>.pdf`, cover letter
  `<profile_id>_cv.pdf`. Path-traversal guarded, RBAC-checked.
- **Profiles list.** `GET /api/profiles` (`requireAuth`) returns the caller's profiles
  (RBAC-filtered).

### New server work (small)
1. **Bearer-token support** — extend `resolveUser` to also read `Authorization: Bearer <token>`
   (fall back to cookie). The token is just the session id, so lookup is identical. ~4 lines.
2. **Token in login response** — `/api/auth/login` (and `/api/auth/setup`) also return
   `token: session.id` in the body so the popup can store it. The web client keeps using the
   cookie and ignores the field. (No separate endpoint needed.)
3. **Field-mapping endpoint** — `POST /api/applications/:id/fill-map` (the only substantial new
   piece). Takes harvested field descriptors + refs; returns `ref → value`. Reuses the run's
   `answers[]` + profile basics; sends leftovers to the LLM. Reuses `qaMatchService`-style
   plumbing where possible.

---

## File upload: how it actually works (corrected)

Extensions **can** fill `<input type=file>` from a content script via DataTransfer — the
browser only blocks setting `.value` to a *path string*, not assigning a real `File`:

```js
const blob = await (await fetch(resumePdfUrl, {
  headers: { Authorization: `Bearer ${token}` },
})).blob();
const dt = new DataTransfer();
dt.items.add(new File([blob], "resume.pdf", { type: "application/pdf" }));
fileInput.files = dt.files;
fileInput.dispatchEvent(new Event("change", { bubbles: true }));
```

Blob source = `GET /api/applications/:id/artifacts/<profile>.pdf`. Manual edge cases:
drag-and-drop dropzones (synthesize `dragenter`/`drop`) and rare OS-native pickers (manual).

---

## Field identification (the core technique)

Forms have no stable per-field UUID, so enpplify **mints an ephemeral ref per field at scrape
time** and matches descriptors to data. Three layers, cheapest first:

1. **Known-ATS adapter (deterministic).** Hardcoded selector maps per platform. Instant, exact.
2. **Heuristic matcher (generic fallback).** Keyword/regex + `autocomplete` over a harvested
   descriptor (label / name / id / placeholder / aria-* / surrounding text / type / options).
3. **AI matcher (hard / custom / open-text).** Send the **batch of leftover** descriptors +
   profile + run `answers[]` to `POST /api/applications/:id/fill-map`. Each field carries a
   self-minted ref so the model never invents selectors:

   ```json
   [
     { "ref": "f0", "label": "Why do you want to work here?", "type": "textarea" },
     { "ref": "f1", "label": "Years of React experience", "type": "input" },
     { "ref": "f2", "label": "Authorized to work in the US?", "type": "select",
       "options": ["Yes", "No"] }
   ]
   ```
   Server returns `{ "f0": "...", "f1": "5", "f2": "Yes" }`; extension maps `ref → element`
   from a local table. **Selectors never leave the browser; the LLM only sees text + refs.**
   Selects/radios: model must pick from `options`.

Order 1 → 2 → 3, only leftovers to AI. enpplify targets **hard sites Simplify can't do**, so
it leans on layer 3 more than Simplify — that's the differentiator. Prioritize ATSes Simplify
is weakest on (iCIMS, Taleo, Avature, custom corporate portals) for any future adapters.

---

## User flows (end-user's own model)

1. **JD-only / LinkedIn (no usable URL):** use the current enpply dashboard. Nothing new.
2. **Has a job link, opens it in Chrome** (application bound to that tab; may auto-redirect or
   switch description/apply tabs). enpplify operates here.
   - (a) **Simplify available** → Simplify for fields; enpplify or manual for résumé upload.
   - (b) **Simplify absent, manual** (Chrome autofill / typing); résumé upload optional.
   - (c) **Simplify absent, rely on enpplify**: upload résumé, fetch fields/options (not
     necessarily one shot), fill, user reviews + submits.

`Generate docs` and `Generate answers` are **separate**: docs (résumé/CV) depend only on the
JD; answers depend on the form's questions.

### Buttons (always visible on a job page)
- **Generate** (docs from JD) → becomes **Regenerate** once done (maps to enpply rerun with
  résumé/CV checked).
- **Fill** = generate answers internally + fill text fields + attach résumé blob.
  Auto-runs Generate first if no docs exist yet.
- **Attach résumé only** (when Simplify handles other fields).

---

## Architecture

```
┌─────────────────┐         ┌──────────────────────────┐
│  enpplify ext   │  HTTPS  │   enpply server (brain)  │
│  popup +        │◄───────►│   tealbridge.online      │
│  content script │  Bearer │                          │
│  + bg worker    │  token  │  POST /api/auth/token        (new) issue token
│                 │         │  GET  /api/profiles          (exists) picker
│  - scrape JD    │         │  POST /api/applications/generate  (exists) run pipeline
│  - scrape fields│         │  GET  /api/applications/:id       (exists) poll result
│  - DataTransfer │         │  GET  /api/applications/:id/artifacts/<p>.pdf (exists) blob
│    fill + edit  │         │  POST /api/applications/:id/fill-map  (new) ref->value
└─────────────────┘         └──────────────────────────┘
```

- **Auth bridge:** `resolveUser` also accepts `Authorization: Bearer`; popup gets the token from
  `POST /api/auth/token`, stores in `chrome.storage`. `host_permissions` + CORS for the enpply
  origin. CORS already `origin: true, credentials: true` (`index.ts:78`).
- **Session identity:** an **application session** in `chrome.storage` (survives MV3
  service-worker death), anchored to `job_link + profile` — NOT to "which tab opened it."
  Lightweight (client-only) until Generate, then it owns the returned `appId`/`run_uuid`.

---

## Build plan (vertical slices)

Each slice = one endpoint + its matching extension call, working end-to-end.

**Slice 1 — Auth.**
- Server: `Authorization: Bearer` in `resolveUser`; `POST /api/auth/token`.
- Extension: MV3 scaffold, popup sign-in, token in `chrome.storage`; profile picker via
  `GET /api/profiles`. LinkedIn host disable.

**Slice 2 — Generate.**
- Reuse `POST /api/applications/generate` (auto-scraped JD → résumé/CV) + poll
  `GET /api/applications/:id`. Extension **Generate/Regenerate** button + in-page status.
  Session in `chrome.storage` owns the returned `appId`.

**Slice 3 — Fill.**
- Server: `POST /api/applications/:id/fill-map` (descriptors+refs → heuristic->AI value map,
  reusing `answers[]`). Extension: content-script DataTransfer fill + résumé attach (blob from
  the existing artifacts endpoint) + in-page editable review. **Fill** and **Attach résumé
  only** buttons.

### Deferred past MVP
- Multi-page **"add this page as context"** accumulation (MVP assumes JD on current page).
- Per-ATS adapters beyond the generic heuristic.
- Desktop/Chrome notifications for the async generate step.
- Drag-drop dropzone synthesis for résumé upload.

---

## Open items to confirm during build
- Token expiry/rotation (sessions have a 30-day TTL; extension must handle a 401 by re-prompting
  sign-in).
- Whether `fill-map` lives under `/api/applications/:id/` (ties answers to a run) or standalone.
  Leaning on the per-run form for MVP.
- Extension build tooling (plain JS vs Vite+TS to match the client). Recommend Vite+TS.
- CORS origin allowlist for dev (`localhost:5273`/`:80`) vs prod (`tealbridge.online`).
```