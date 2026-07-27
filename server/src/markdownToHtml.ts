import { htmlLineWithInlineBold } from "./inlineMarkdown.js";
import { resumeTemplateHintsEnabled } from "./resumeHints.js";

/**
 * Replace em/en dashes (and spaced/double hyphens) used as punctuation with
 * commas. The model routinely ignores the "no em dash" instruction in the
 * cover-letter prompt, so we enforce plain punctuation deterministically.
 * Numeric ranges (e.g. 2020–2023) keep a hyphen rather than becoming a comma.
 */
export function normalizeDashes(s: string): string {
  return s
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2") // numeric ranges: en/em dash → hyphen
    .replace(/\s*[—–]\s*/g, ", ") // em/en dash joining clauses → comma
    .replace(/\s*--+\s*/g, ", ") // double hyphen as dash → comma
    .replace(/(\S) +- +(\S)/g, "$1, $2"); // spaced hyphen as dash → comma
}

/** Strip optional markdown code fences from model output. */
export function stripMarkdownFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  return t.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type MarkdownToHtmlOptions = {
  /** One muted “Template · …” line under each ## / ### (only when `ENPPLY_RESUME_TEMPLATE_HINTS=1`). */
  sectionHints?: boolean;
};

type ResumeHeaderPhase = "none" | "need_title_or_contact" | "need_contact_after_headline";

type FenceKind = "grid-3" | "grid-2" | "lang-bars";

/** Split fence inner lines into cells (columns) separated by blank lines. */
function fenceLinesToCells(rawLines: string[]): string[][] {
  const cells: string[][] = [];
  let cur: string[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) {
      if (cur.length) {
        cells.push(cur);
        cur = [];
      }
      continue;
    }
    cur.push(raw.trimEnd());
  }
  if (cur.length) cells.push(cur);
  return cells;
}

function emitGridHtml(kind: "grid-3" | "grid-2", rawLines: string[]): string {
  const cells = fenceLinesToCells(rawLines);
  const cls = kind === "grid-3" ? "resume-grid-3" : "resume-grid-2";
  const inner = cells
    .map((lines) => {
      const ps = lines
        .map((ln, i) => {
          const trimmed = ln.trim();
          if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
            const body = trimmed.slice(2).trim();
            return `<p class="bullet">• ${htmlLineWithInlineBold(body)}</p>`;
          }
          const lineCls =
            kind === "grid-3"
              ? i === 0
                ? "edu-years"
                : i === 1
                  ? "edu-school"
                  : "edu-detail"
              : "skill-col-line";
          return `<p class="${lineCls}">${htmlLineWithInlineBold(trimmed)}</p>`;
        })
        .join("\n");
      return `<div class="resume-grid-col">${ps}</div>`;
    })
    .join("\n");
  return `<div class="${cls}">${inner}</div>`;
}

function parseLangPercent(line: string): { name: string; pct: number } | null {
  const t = line.trim();
  if (!t) return null;
  const pipe = t.indexOf("|");
  if (pipe !== -1) {
    const name = t.slice(0, pipe).trim();
    const n = parseInt(t.slice(pipe + 1).trim().replace(/%/g, ""), 10);
    if (name && Number.isFinite(n) && n >= 0 && n <= 100) return { name, pct: n };
  }
  const em = t.match(/^(.+?)\s*[–—-]\s*(\d+)\s*%?\s*$/);
  if (em) {
    const n = parseInt(em[2]!, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return { name: em[1]!.trim(), pct: n };
  }
  return null;
}

function emitLangBarsHtml(rawLines: string[]): string {
  const rows: string[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    const p = parseLangPercent(raw);
    if (!p) continue;
    const w = Math.max(0, Math.min(100, p.pct));
    rows.push(`<div class="resume-lang-row">
    <span class="resume-lang-name">${escapeHtml(p.name)}</span>
    <div class="resume-lang-meter" role="presentation"><span class="resume-lang-fill" style="width:${w}%"></span></div>
  </div>`);
  }
  return `<div class="resume-lang-bars">${rows.join("\n")}</div>`;
}

/**
 * Whether an h3 left segment (before ` | `) is a DATE RANGE — the cue for a
 * timeline row. Requires a 4-digit year AND a range marker (dash / "to" /
 * present/current). So `2024–Present` and `2021–2023` match, but a company
 * name like `Acme` or `Studio 2020` does not (no range marker) — those keep
 * the pipe as a plain company|role separator.
 */
function looksLikeDateRange(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 28) return false;
  const hasYear = /(19|20)\d{2}/.test(t);
  const hasRange = /[–—-]|\bto\b/i.test(t) || /\b(present|current|now)\b/i.test(t);
  return hasYear && hasRange;
}

/**
 * Convert a small subset of Markdown (same family as the PDFKit path) to an HTML fragment for templates.
 * After `# Name`: optional target-role line (no `|`), then contact line (often pipe-separated).
 * If the first line contains `|`, it is treated as contact only (backwards compatible).
 *
 * Optional layout blocks (for themes like **beige-band**):
 * - `### Dates | Role title` — timeline row (dates left, title + following body in the right column).
 *   Only triggers when the left side LOOKS like a date range (see `looksLikeDateRange`), so a normal
 *   role heading such as `### Company | Role (2020 – 2022)` renders as a plain heading with the pipe.
 * - `:::grid-3` … `:::` — up to three columns; cells separated by blank lines (education-style).
 * - `:::grid-2` … `:::` — two columns (e.g. skills); cells separated by blank lines; lines may be bullets.
 * - `:::lang-bars` … `:::` — lines like `English|90` or `English — 90` for language + proficiency bar.
 */
export function markdownToHtmlFragment(markdown: string, options?: MarkdownToHtmlOptions): string {
  const sectionHints = options?.sectionHints ?? resumeTemplateHintsEnabled();
  const text = stripMarkdownFence(markdown);
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let resumeHeaderPhase: ResumeHeaderPhase = "none";
  let roleSplitActive = false;
  let fence: { kind: FenceKind; lines: string[] } | null = null;

  const pushHint = (label: string) => {
    if (!sectionHints) return;
    out.push(`<p class="template-hint" aria-hidden="true">Template · ${escapeHtml(label)}</p>`);
  };

  const flushHeaderForSection = () => {
    resumeHeaderPhase = "none";
  };

  const closeRoleSplit = () => {
    if (!roleSplitActive) return;
    out.push("</div></div>");
    roleSplitActive = false;
  };

  const flushFence = () => {
    if (!fence) return;
    const { kind, lines: fl } = fence;
    fence = null;
    if (kind === "grid-3") out.push(emitGridHtml("grid-3", fl));
    else if (kind === "grid-2") out.push(emitGridHtml("grid-2", fl));
    else out.push(emitLangBarsHtml(fl));
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (fence) {
      if (trimmed === ":::") {
        flushFence();
        continue;
      }
      fence.lines.push(raw);
      continue;
    }

    const fenceStart =
      trimmed === ":::grid-3" ? "grid-3" : trimmed === ":::grid-2" ? "grid-2" : trimmed === ":::lang-bars" ? "lang-bars" : null;
    if (fenceStart) {
      closeRoleSplit();
      flushHeaderForSection();
      fence = { kind: fenceStart, lines: [] };
      continue;
    }

    if (!trimmed) {
      out.push('<p class="spacer">&nbsp;</p>');
      continue;
    }
    if (line.startsWith("# ")) {
      closeRoleSplit();
      flushHeaderForSection();
      out.push(`<h1>${escapeHtml(line.slice(2).trim())}</h1>`);
      resumeHeaderPhase = "need_title_or_contact";
      continue;
    }
    if (line.startsWith("## ")) {
      closeRoleSplit();
      flushHeaderForSection();
      const title = line.slice(3).trim();
      out.push(`<h2>${escapeHtml(title)}</h2>`);
      pushHint(`Section: ${title}`);
      continue;
    }
    if (line.startsWith("### ")) {
      flushHeaderForSection();
      const rest = line.slice(4).trim();
      const pipe = rest.indexOf(" | ");
      if (pipe !== -1) {
        const left = rest.slice(0, pipe).trim();
        const right = rest.slice(pipe + 3).trim();
        // Only a date-range left means a timeline row; otherwise the ` | ` is a
        // plain company|role separator and the whole line is one heading.
        if (left && right && looksLikeDateRange(left)) {
          closeRoleSplit();
          out.push(`<div class="resume-role-row">`);
          out.push(`<p class="resume-role-dates">${htmlLineWithInlineBold(left)}</p>`);
          out.push(`<div class="resume-role-main">`);
          out.push(`<h3>${htmlLineWithInlineBold(right)}</h3>`);
          pushHint(`Role block: ${left} | ${right}`);
          roleSplitActive = true;
          continue;
        }
      }
      closeRoleSplit();
      out.push(`<h3>${htmlLineWithInlineBold(rest)}</h3>`);
      pushHint(`Role block: ${rest}`);
      continue;
    }

    if (resumeHeaderPhase === "need_title_or_contact") {
      if (line.startsWith("- ") || line.startsWith("* ")) {
        resumeHeaderPhase = "none";
        out.push(`<p class="bullet">• ${htmlLineWithInlineBold(line.slice(2).trim())}</p>`);
        continue;
      }
      if (line.includes("|")) {
        out.push(`<p class="contact-line">${htmlLineWithInlineBold(line.trim())}</p>`);
        resumeHeaderPhase = "none";
        continue;
      }
      out.push(`<p class="resume-headline">${htmlLineWithInlineBold(line.trim())}</p>`);
      resumeHeaderPhase = "need_contact_after_headline";
      continue;
    }
    if (resumeHeaderPhase === "need_contact_after_headline") {
      if (line.startsWith("- ") || line.startsWith("* ")) {
        resumeHeaderPhase = "none";
        out.push(`<p class="bullet">• ${htmlLineWithInlineBold(line.slice(2).trim())}</p>`);
        continue;
      }
      out.push(`<p class="contact-line">${htmlLineWithInlineBold(line.trim())}</p>`);
      resumeHeaderPhase = "none";
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      out.push(`<p class="bullet">• ${htmlLineWithInlineBold(line.slice(2).trim())}</p>`);
      continue;
    }
    out.push(`<p>${htmlLineWithInlineBold(line.trim())}</p>`);
  }

  closeRoleSplit();
  if (fence) flushFence();

  return out.join("\n");
}
