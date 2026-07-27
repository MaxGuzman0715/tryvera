# Resume & CV HTML templates

By default, résumé/CV PDFs use **Chromium** and load **shell HTML** from this folder. Which file pair is used for each **theme id** is defined in **`registry.json`** — not in TypeScript.

If you set **`ENPPLY_PDF_ENGINE=pdfkit`** in `.env`, PDFs use a plain PDFKit layout instead and **theme selection has no effect** (no HTML/CSS from here).

## Quick start: add a new theme

1. **Copy** an existing pair (e.g. `resume.html` + `cv.html`) to new files, e.g. `resume-mine.html` and `cv-mine.html`.
2. **Edit** the HTML/CSS inside those files (colors, typography, header). Keep the placeholders described below.
3. **Register** the theme in **`registry.json`**: add an object to the `themes` array with:
   - **`id`** — short slug used in the app and API (`a-z`, `0-9`, `_`, `-` only). Example: `mine`.
   - **`label`** — human-readable label shown in the UI dropdown.
   - **`resume`** — filename of the résumé shell (under this directory).
   - **`cv`** — filename of the CV shell.
4. **Restart** the Enpply server so it reloads `registry.json` (or rely on the next process start).

Invalid or missing `registry.json` falls back to a small built-in list so the server still starts.

## Required placeholders (do not remove)

The renderer replaces these **before** Chromium prints the PDF:

| Placeholder        | Meaning |
|--------------------|---------|
| `{{BODY}}`         | Generated Markdown turned into HTML (headings, paragraphs, bullets). |
| `{{THEME}}`        | Raw theme id (e.g. `purple`) — safe for `<title>`. |
| `{{THEME_CLASS}}`  | Sanitized class suffix; use on `<body>` as `theme-{{THEME_CLASS}}` for CSS scoped to this theme. |

Example:

```html
<body class="doc theme-{{THEME_CLASS}}">
  <main class="content">{{BODY}}</main>
</body>
```

## Markdown → HTML mapping (for styling)

The generator emits a small, predictable structure you can target with CSS:

- `# Name` → `<h1>`
- Next line (contact) → `<p class="contact-line">`
- `## Section` → `<h2>`
- `### Subsection` → `<h3>`
- Bullets → `<p class="bullet">…`
- Spacing → `<p class="spacer">`
- Optional hints → `<p class="template-hint">…`

## Constraints

- **No remote fonts or CSS** — Puppeteer can hang on external resources. Use system fonts and embedded `<style>` only.
- **One résumé file + one CV file per theme** — both must exist and be listed in `registry.json`.

After `# Name`, you may add one **target-role line** (no `|`) before the contact line; it renders as `resume-headline` for centered themes like **navy-center** or **beige-band**.

### Optional layout blocks (HTML/Chromium PDFs)

These render structured HTML for themes such as **beige-band**; PDFKit output prints a simplified linear layout.

| Syntax | Meaning |
|--------|---------|
| `### Dates \| Title` | Timeline row: dates in the left column, title and following bullets in the right column (use a space-pipe-space ` \| ` delimiter). |
| `:::grid-3` … `:::` | Up to three columns; **cells** are separated by **blank lines** (education-style: years, school, degree per cell). |
| `:::grid-2` … `:::` | Two columns; cells separated by blank lines; lines may be bullets. |
| `:::lang-bars` … `:::` | Language rows: `English\|90` or `English — 90` (0–100) for bar width. |

## See also

- `registry.json` — source of truth for theme ids and filenames.
