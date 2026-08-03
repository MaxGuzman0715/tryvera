# Tryvify (Chrome extension)

Companion to **Tryvera**. Tryvera (the web app) stays the brain — profiles,
generation, answers, PDFs, auth, LLM keys, all server-side. Tryvify is a thin,
authenticated client that scrapes a job page, calls Tryvera's API, and fills the
application form. **You always review and submit manually.**

Full design + rationale: [`../enpplify_spec.md`](../enpplify_spec.md).

---

## What it does

A floating panel appears on job/application pages (it never runs on LinkedIn).
Two distinct actions:

- **Generate** — makes your tailored documents. Scrapes the page text as the job
  description, runs Tryvera's real pipeline (`POST /api/applications/generate`),
  and produces the résumé / cover-letter PDFs + extracted answers. The run is
  saved in Tryvera **Logs** like any dashboard run. *Does not touch the form.*
  Clicking it again loads the existing run (never silently overwrites). On
  **LinkedIn**, Generate defaults to résumé-only (cover-letter unchecked).
- **Force regenerate** — appears once a run exists. Ignores the existing run and
  always starts a fresh generation, keeping the old one. If that would duplicate
  an earlier run (same company + role + profile), the server appends `-1` (then
  `-2`, …) to the new run's role so it stays distinct in Logs and on disk.
- **Fill all** — one click for the whole application: if this page has no
  completed run yet it Generates first and waits, then fills every field with AI,
  attaches the résumé/CV, and fills sign-up passwords. (The individual Generate /
  Fill buttons below still work on their own.)
- **Fill without AI** — instant fill, no LLM call. Matches standard fields
  (name, email, phone, LinkedIn/GitHub/portfolio, location) from your profile by
  keyword/`autocomplete`, attaches the résumé/CV, and fills every password field
  with your autofill password (when one is set). Fast; covers the predictable
  fields. *Reuses what Generate produced — needs a run first.*
- **Fill with AI** — full fill: the heuristic pass PLUS an LLM pass over the
  remaining open-text / custom fields (mapped from the generated answers +
  profile). Slower and uses the model, but handles questions and oddly-worded
  fields. Both fill buttons are always available — pick per page.
- **Attach résumé & CV** — just attaches the generated résumé (and the cover
  letter when a separate upload field exists), for when you use another
  autofiller (e.g. Simplify) for the rest.
- **Drop a file to upload** — drag any résumé file onto the drop zone to attach
  it to the page's upload field (fallback for stubborn uploaders).

You always review every field and submit manually.

Think of it as: **Generate = create your docs/answers** (server-side) → **Fill =
paste them into this job's form** (page-side).

---

## Panel features

- **Profile + doc toggles** — résumé / cover letter (both on by default).
- **Minimize to a circle** — collapses to a draggable circular button (with a
  green dot when a run exists for the page). Drag the header or the circle to
  move it; position persists. Minimize/expand keep the bottom-right corner fixed
  so the widget doesn't jump.
- **Job-page detection** — on pages that look like a job/application (known ATS
  hosts, apply/job URLs, or form signals) the panel opens expanded; elsewhere it
  starts as the circle. Never fully disabled except on LinkedIn.
- **Copy path** — copies the run's output folder (mirrors Tryvera's priority:
  your custom download dir → server absolute path → relative path). Note this is
  the *server's* path — meaningful only when the backend runs on your machine.
- **Download** — transfers the generated files (résumé + cover-letter PDFs +
  `result.json`) to *this* computer via `chrome.downloads`, into
  `Downloads/<MM_DD>/<profile>/<TS_company_role>/` (same subfolder the Copy-path
  button yields, just rooted at Downloads). Unlike Copy path, this
  works even against a remote/LAN backend (the files are saved on the server, so
  a remote extension user otherwise has no local copy). The web app's
  auto-download only runs when the Tryvera site is open; the extension needs its
  own, hence this button.
- **Compact panel** — everything below "Attach résumé & CV" (sign-up password,
  drop zone, memory card) is tucked behind a **More** toggle so the panel stays
  short; it auto-expands when this page offers sign-up password autofill.
- **Tryvify memory** — shows what's held for this job: run id, whether a résumé
  / cover letter / answers exist, with **View résumé** / **View CV** buttons that
  open the PDF in a new tab.
- **Duplicate recovery** — if generation is rejected as a duplicate of an earlier
  run, the panel transparently loads that existing run's documents/answers so
  you can keep filling instead of dead-ending.
- **Tab + link sessions** — a generation stays bound to its tab across
  Apply/Next navigation, and a new tab opened by Apply inherits the run from the
  tab that spawned it (`openerTabId`).

---

## Install (no build step)

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select this `extension/` folder.
4. Pin **Tryvify**; click the toolbar icon to open the popup.

After editing any file, click the **reload** icon on the Tryvify card. On pages
that were already open, also reload the tab so the content script re-injects.

## Sign in (popup)

1. **API base**:
   - Local dev: `http://localhost:5001` (match `PORT` in `.env`; the bundled
     `server` defaults to 5001 for dev, 3005 for the built copy via
     `npm run start:built -w server`).
   - Production: `https://tealbridge.online`.
2. Enter your Tryvera email + password → **Sign in**.
3. Pick the **profile** to use for applications.
4. Optional: set a **custom download folder** for the Copy-path button.

The token is the Tryvera session id (30-day TTL); on expiry the popup asks you to
sign in again.

---

## Usage

1. Open a job posting / application page.
2. In the panel, click **Generate documents** — wait for "Ready to fill."
3. On the application form, click **Fill without AI** (instant) or **Fill with
   AI** (also answers open-text/custom fields). Use **Attach résumé & CV** alone
   when another autofiller handles the text fields.
4. **Review every field**, then submit manually.

## Settings (in the Tryvera web app → "Tryvify" tab)

Per-user settings the extension reads after sign-in: feature flags
(`combobox_fill`, `attach_cover_letter`, `ai_fill_remaining`, `drop_to_upload`),
an optional fill-model override, and an optional account-creation autofill
password (stored server-side, returned only to you).

**Password autofill** is enabled simply by setting that autofill password — no
separate flag. **Every password field on the page** (password, "password again",
confirm, verify… plus reveal-toggled password inputs) is filled with that one
value by both **Fill without AI** and **Fill with AI**. Passwords are filled
locally and are **never** sent to the server or the LLM. (The legacy
`password_autofill` flag is no longer required.)

---

## Architecture notes

- **No build step**: plain ES modules loaded directly by Chrome.
- **Background worker is the brain-side client**: content scripts can't use ES
  module imports, so all API/storage access is routed through the MV3 service
  worker (`background.js`) via `chrome.runtime.sendMessage`. The content script
  (`content.js`) is UI-only.
- **SPA keep-alive**: frameworks like Greenhouse / Lever / Ashby / Workday
  re-render the document after hydration, which can detach the panel right after
  it mounts ("shows then disappears"). A `MutationObserver` re-appends the panel
  whenever the page removes it (throttled via `requestAnimationFrame`). State and
  listeners live on the persistent mount element, so re-attaching restores
  everything.
- **Embedded application forms (all-frames injection)**: many sites host the
  apply form in a cross-origin iframe the top page can't read or fill — e.g.
  pindrop.com (a WordPress careers page) embeds Greenhouse, and `jobs.gem.com`
  renders the form in its own frame. The content script therefore runs in
  **every frame** (`all_frames`), including JS-created `about:blank` / `srcdoc`
  frames that Greenhouse's `grnhse_app` widget uses (`match_about_blank` +
  `match_origin_as_fallback`). To keep **one panel per tab**: the top frame
  always mounts; a child frame mounts only if it actually contains a form
  (re-checked for ~30s to catch late-rendered embeds); and when the top frame
  detects a form-bearing child it starts minimized so the in-form panel is
  primary. The form and the fill code thus live in the same frame, so the normal
  same-frame harvest/fill works unchanged.
- **Question-label resolution**: modern ATS rarely use a clean `<label for>`.
  `labelFor` tries, in order: `label[for]`, a wrapping `<label>`, `aria-labelledby`,
  `aria-label`, the **group question** (Lever renders the prompt in a separate
  `.application-label .text`; grouped radios put it in a legend/heading beside the
  options), then a **sibling label** (Gem-style forms put a `<span>`/`<div>` label
  just before an attribute-less input). A junk-label guard rejects machine field
  names — Lever's `cards[uuid][fieldN]`, UUIDs, long space-less tokens — at every
  step and stops them being sent as `name`, so the panel **and the LLM** see the
  real question (otherwise the AI answered a meaningless key and replies didn't
  match the questions).
- **Making values stick (controlled inputs)**: React/Vue/Angular inputs ignore a
  bare `value =` assignment. Fills write through the prototype `value` setter
  (bypassing React's instance-setter guard), after focusing and scrolling the
  field into view, then dispatch a real `InputEvent` + `keyup` and blur/focusout
  so validate-on-blur commits. Radios are matched by exact → prefix →
  shortest-substring on the exact option text harvested, and selected via input
  click → label click → manual `checked` + events.
- **File upload** uses the DataTransfer trick (`input.files = dataTransfer.files`)
  — the only browser-allowed way to set a file input from script. ATS dropzones
  keep the real `<input type=file>` hidden behind a styled button, so detection
  does not filter by visibility.
- **Custom dropdowns** (react-select / Lever / Ashby comboboxes) are filled by
  opening the menu and clicking the best-matching option (typing first for
  async/searchable lists). Non-searchable selects — e.g. the EEO/demographic
  Gender/Race pickers — render their `<input>` visually hidden (a 0×0 /
  `opacity:0` "DummyInput") with no combobox ARIA, so harvesting also recognises
  the widget by its styled **control wrapper** and judges visibility by that
  wrapper, not the hidden input. Bootstrap's plain `form-control` inputs are
  excluded (the wrapper must also hold a dropdown indicator/placeholder child).
- **Field identity**: the content script mints an ephemeral `ref` per field and
  keeps the `ref → element` map locally. Only descriptors (text + ref) go to the
  server; **selectors never leave the browser**.

## Permissions

`permissions` includes `downloads` — used by the **Download** button to save the
generated files to the user's Downloads folder.

`host_permissions` covers `http://localhost/*`, `http://127.0.0.1/*`,
`http://*/*` (so the extension can reach a backend on **any LAN IP** — e.g. a
teammate signing in to `http://192.168.x.x:5001` against your machine; Chrome
match patterns ignore the port), and `https://tealbridge.online/*`. The web app
itself loads fine for anyone on the network, but the **extension's own** fetches
(sign-in, settings, generate, fill) are gated by `host_permissions` — without
the host listed they fail with a network error even though the page works. Add
any other API origin you use and reload the extension.

The content script is registered with `all_frames`, `match_about_blank`, and
`match_origin_as_fallback` so it reaches application forms embedded in
cross-origin / JS-created iframes (see *Embedded application forms* above).

## Status

Done: auth + profile picker; Generate-from-page; force-regenerate (suffix `-N`
on duplicate); two-pass Fill (without/with AI); **all-frames injection for
embedded ATS forms** (Greenhouse-in-WordPress, Gem, incl. `about:blank`/`srcdoc`
frames); **question-label resolution** for grouped/Lever (`cards[…][fieldN]`) and
sibling-label (Gem) forms with a junk-name guard; **reliable value-fill on
controlled React inputs**; custom-dropdown / hidden react-select detection (incl.
EEO/demographic Gender/Race); robust radio matching/selection; résumé + CV
attach; per-profile base résumés; copy-path; download-to-client
(chrome.downloads); compact foldable panel; minimize-to-circle + drag; job-page
detection; SPA keep-alive; memory panel with View résumé/CV; duplicate recovery;
tab + opener-tab sessions; per-user settings + feature flags (incl. sign-up
password autofill and drop-to-upload).

Not yet: shadow-DOM form traversal (web-component ATS that don't use an iframe);
multi-page "add this page as context"; per-ATS adapters; manual run-picker;
standalone checkbox handling; desktop notifications. Hardening the fill-map LLM
prompt against prompt-injection planted in field text (some forms hide
instructions to make AI autofillers emit a marker string) is also open.
