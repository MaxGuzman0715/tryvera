# Enpplify — handling application "question" fields (radios, custom selects)

*Phase 2 design note. Companion to [`enpplify_spec.md`](./enpplify_spec.md) and
[`extension/README.md`](./extension/README.md).*

## The problem

On some application pages the per-field **Fill with AI** menu lists fields as
bare refs with no human label and no instant value:

```
f0   AI   Click to generate with AI
f1   AI   Click to generate with AI
f2   AI   Click to generate with AI
…
```

…while the page actually asks real, answerable questions:

- *Are you legally authorized to work in the United States?* — Yes / No
- *Will you now or in the future require sponsorship…?* — Yes / No
- *Where is your primary residence? (US)* — 6 radio options
- *Do you have at least 7 years of industry experience…?* — Yes / No
- **Gender** — `Please select` (custom dropdown)
- **Race** — `Please select` (custom dropdown)
- Voluntary Self-Identification of Veteran Status — `Please select`

Two things are wrong:

1. **No label** — the field shows `f0` instead of the question, so the user
   can't tell which field is which, and (worse) the **server/LLM never receives
   the question text**, so it can't answer correctly either.
2. **Everything is "AI-only"** — even questions whose answers we already hold
   (work authorization, sponsorship, years of experience) fall through to the
   AI pass instead of being filled instantly.

This note explains *why* and proposes *how to deal with it*.

---

## How a field becomes fillable today

`content.js → harvestFields()` walks every `input | textarea | select`, mints an
ephemeral `ref` per field, and builds a **descriptor** that is sent to the
server (`enpplify:fillMap`). Selectors never leave the browser — only the
descriptor text + `ref`.

The descriptor for a **radio group**:

```js
{ ref, type: "radio", name, options,
  label: surroundingText(el),          // ← the problem
  surroundingText: surroundingText(el) }
```

…and for a **select / custom dropdown**:

```js
{ ref, type: "select", label: labelFor(el), name, id, placeholder,
  ariaLabel, autocomplete, options /* , surroundingText if no label */ }
```

The menu label the user sees comes from `fieldLabel(d)`:

```js
d.label || d.ariaLabel || d.placeholder || d.name || d.surroundingText || d.ref
```

So a field shows `fN` **only when every one of those is empty** — i.e. we
extracted no usable text for it at all.

### Why the text comes out empty

- `labelFor(el)` finds a label via `<label for=id>`, a wrapping `<label>`, or
  `aria-labelledby`. On modern React ATS boards (Greenhouse's new
  `job-boards.greenhouse.io`, Ashby, Lever) the **question prompt is a heading
  or `<div>` sibling of the option group**, not a `<label for>` tied to the
  control — so `labelFor` returns the *option* text ("Yes") or nothing.
- `surroundingText(el)` reads the innermost `div/section/fieldset/li/p`'s
  `innerText`. When the radio sits in a bare wrapper —
  `<div class="option"><input type="radio"></div>` — that container has **no
  text**, so `surroundingText` returns `""`. The question lives one or two
  levels **up**, which we never climb to.
- For the custom **Gender / Race** dropdowns (`Please select` = a non-searchable
  react-select), the prompt is again a sibling heading, and the widget's real
  `<input>` is the hidden DummyInput we now harvest by its control wrapper (see
  README) — but still **without** an associated question label.

Net: the group *is* harvested (one ref per question — that part works), but its
**question text isn't**, so it degrades to `fN` and the LLM is asked to answer a
question it was never shown.

---

## Strategy

Four independent improvements, roughly in priority order. (1) is the core fix.

### 1. A robust question-label "ladder"

Add `questionLabel(el)` that climbs from the control outward and returns the
first non-empty, *prompt-like* text. Order matters — most specific first:

```js
function cleanText(s) { return (s || "").trim().replace(/\s+/g, " "); }

/** Best-effort QUESTION text for a control whose prompt is a heading/sibling. */
function questionLabel(el) {
  // 1) Standard association (covers well-built forms).
  const direct = labelFor(el);
  if (direct) return direct;

  // 2) An enclosing group that names itself.
  const group = el.closest('fieldset, [role="radiogroup"], [role="group"]');
  if (group) {
    const legend = group.querySelector(":scope > legend");
    if (legend && cleanText(legend.innerText)) return cleanText(legend.innerText);
    const lb = group.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" ");
      if (cleanText(t)) return cleanText(t);
    }
    const al = group.getAttribute("aria-label");
    if (al) return cleanText(al);
  }

  // 3) The nearest preceding prompt element inside the question block: a heading,
  //    a label/legend, or a node whose class hints "label/question/title". Must
  //    NOT be an option (i.e. must not contain the control).
  const block = el.closest('fieldset, li, [class*="field"], [class*="question"], section, div') || el.parentElement;
  if (block) {
    const cands = block.querySelectorAll(
      'legend, label, h1,h2,h3,h4,h5,h6, [class*="label"], [class*="question"], [class*="title"], [class*="prompt"]',
    );
    for (const c of cands) {
      if (c.contains(el)) continue;            // that's an option wrapper, skip
      const t = cleanText(c.innerText);
      if (t && t.length >= 3) return t.slice(0, 160);
    }
  }

  // 4) Last resort: the block text with option labels stripped out.
  return "";  // caller falls back to surroundingText() (today's behaviour)
}
```

Wire it in so labels never regress (final fallback stays `surroundingText`):

- **Radios:** `label: questionLabel(firstRadio) || surroundingText(el)`, and keep
  `surroundingText` as a *separate* field so the server still gets raw context.
- **Selects / comboboxes:** `label: labelFor(el) || questionLabel(el)`.

> **Risk:** step 3 can pick the wrong node (e.g. an option label) on unusual
> DOM. That is strictly better than `fN` for the *user*, but a wrong label can
> mislead the *LLM*. Mitigations: prefer steps 1–2 (semantic, reliable); in step
> 3 reject candidates that exactly equal one of the harvested `options`; cap
> length; and validate against real pages (see Testing) before trusting it for
> AI answers.

### 2. Send clean options + context, not a 300-char blob

Today `label` for a radio is the whole container blob (question **and** all
options, truncated). Instead send:

- `label` = the question only (from the ladder),
- `options` = the option labels (already collected),
- `surroundingText` = the raw block as a fallback/context signal.

This makes the LLM prompt unambiguous ("answer *this question* by picking one of
*these options*") and lets us show the options in the menu.

Also fix option capture for radios whose label is a sibling, not a wrapper:
`labelFor(r) || r.value || cleanText(r.closest('label,li,div')?.innerText)`.

### 3. Instant-fill the common gating questions

Several of these have answers we already hold in the profile / generated answers
and shouldn't cost an LLM call. Add a small **heuristic question map** (server
side, in the heuristic pass) keyed on normalized question text → profile value:

| Question matches…                              | Source                          | Typical answer |
| ---------------------------------------------- | ------------------------------- | -------------- |
| `legally authorized to work`                   | profile work-authorization      | Yes            |
| `require sponsorship` / `visa sponsorship`     | profile sponsorship flag        | No             |
| `\d+\+? years.*experience`                     | derived from résumé / profile   | Yes/No         |
| `gender`, `race`, `hispanic`, `veteran`, `disab` | self-ID → **leave blank / "Decline"** unless the user opted in | — |

Demographic/EEO questions are **voluntary**; default to *not* answering (or an
explicit "Decline to self-identify" option when present) and never invent a
protected-class value. This belongs behind an explicit user setting.

### 4. Surface the question in the per-field menu

`aiItem(d)` / `heuristicItem(d)` should render the resolved question and, for
radios/selects, the option list — so the menu reads:

```
Are you legally authorized to work in the United States?   [AI]
   ○ Yes   ○ No
```

instead of `f0`. Once (1) lands this mostly falls out for free, because
`fieldLabel` will find `d.label`.

---

## Custom (non-`<input>`) widgets

Some boards render radios as `<div role="radio">` / `<button role="radio">` and
selects as `role="combobox"` divs with **no real `<input>` at all**. Those are
invisible to a `querySelectorAll("input,textarea,select")` harvest. If the
target pages use them, extend `harvestFields` with a second pass over
`[role="radiogroup"]`, `[role="radio"]`, and `[role="combobox"]` containers,
mapping the `ref` to the container element and filling by **clicking** the
matching option (we already do option-clicking for react-select in
`fillCombobox`). Gate this behind a flag and validate per ATS — it is the most
DOM-fragile piece.

---

## Implementation plan (phased)

1. **Labels (no behaviour change to filling).** Add `questionLabel`, use it for
   radios + selects, keep `surroundingText` as fallback. Ship; verify the menu
   now shows real questions on Greenhouse/Ashby/Lever. *Low risk.*
2. **Cleaner descriptors.** Split question vs options vs context; improve radio
   option capture. Re-test AI answer quality. *Low risk.*
3. **Heuristic question map** for work-auth / sponsorship / experience, with a
   user setting for self-ID handling (default: skip). *Medium — server side.*
4. **Custom-widget pass** (`role=radio/combobox`) behind a flag, per-ATS. *High
   risk — do last, only if real pages need it.*

## Testing

- Capture `outerHTML` of one failing question block per ATS (Greenhouse new
  boards, Ashby, Lever, Workday) and add them as fixtures.
- Unit-test `questionLabel` against those fixtures — assert it returns the
  prompt, not an option.
- Manual: on a live form, open the AI menu and confirm every row shows the real
  question; run **Fill with AI** and confirm answers land on the right control.
- Guard against regressions on plain forms (a labelled text input must still
  resolve via step 1, unchanged).

## Open questions

- Do the target boards use real `<input type=radio>` (with `name`) or
  `role=radio` divs? Decides whether step 4 is needed. *Grab a DOM sample.*
- Where should the work-auth / sponsorship answers come from — profile fields,
  or the generated answers map? Prefer profile (deterministic).
- Self-ID policy: never answer, or answer only with an explicit user opt-in and
  a fixed "Decline" default?
