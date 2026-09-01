import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import type { Browser } from "puppeteer";
import { projectRoot } from "./paths.js";
import { markdownToHtmlFragment } from "./markdownToHtml.js";
import { getDefaultThemeId, normalizeResumeTheme, resumeTemplateFile } from "./resumeThemes.js";

/**
 * Chromium `page.pdf` margins — applied to EVERY page, so this is what governs
 * the top of an overflow page (page 2+), not just page 1. The template's
 * `.sheet` vertical padding is zeroed at render time (see renderHtmlToPdf), so
 * these margins are the single source of top/bottom spacing on all pages.
 */
function pdfMarginsForTheme(theme: string | undefined): { top: string; bottom: string; left: string; right: string } {
  const t = theme ? normalizeResumeTheme(theme) : getDefaultThemeId();
  if (t === "classic") {
    // "classic" is the compact theme — tighter margins to fit more per page.
    return { top: "0.45in", bottom: "0.45in", left: "0.325in", right: "0.325in" };
  }
  return { top: "0.55in", bottom: "0.55in", left: "0.65in", right: "0.65in" };
}

const templatesDir = () => path.join(projectRoot(), "server", "templates");

export type TemplateKind = "resume" | "coverLetter";

export async function loadTemplate(kind: TemplateKind, theme: string): Promise<string> {
  const t = normalizeResumeTheme(theme);
  const file = resumeTemplateFile(kind, t);
  return fs.readFile(path.join(templatesDir(), file), "utf8");
}

function slugTheme(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || getDefaultThemeId();
}

/** Inject generated body HTML into the shell; theme drives a CSS class for future styling. */
export function fillTemplate(shell: string, bodyHtml: string, theme: string): string {
  return shell
    .replace(/\{\{BODY\}\}/g, bodyHtml)
    .replace(/\{\{THEME\}\}/g, escapeAttr(theme))
    .replace(/\{\{THEME_CLASS\}\}/g, slugTheme(theme));
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/** Wall-clock cap for the whole Chromium path (launch + setContent + pdf + close). */
const PDF_TOTAL_MS = 75_000;
const STEP_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function closeBrowserHard(browser: { close: () => Promise<void>; process?: () => { pid?: number } | null }): Promise<void> {
  const proc = browser.process?.();
  const pid = proc?.pid;
  try {
    await Promise.race([
      browser.close(),
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("browser.close slow")), 12_000)),
    ]);
  } catch {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
];

function logPuppeteerEnv(): void {
  const keys = [
    "PUPPETEER_SKIP_DOWNLOAD",
    "PUPPETEER_CACHE_DIR",
    "PUPPETEER_EXECUTABLE_PATH",
    "npm_config_puppeteer_skip_download",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== "") parts.push(`${k}=${v.length > 80 ? v.slice(0, 80) + "…" : v}`);
  }
  if (parts.length) console.log("[enpply] PDF: env (puppeteer-related):", parts.join("; "));
  else console.log("[enpply] PDF: no PUPPETEER_* overrides in env (bundled Chromium path is default).");
}

/**
 * Replace the document `<title>` (what a PDF viewer shows in its tab and what
 * "Save as" suggests). The templates hard-code `<title>Resume</title>`, so
 * without this every generated PDF would be titled "Resume" regardless of whom
 * it belongs to. Falls back to injecting a `<title>` if the shell lacks one.
 */
function setDocTitle(html: string, docTitle: string | undefined): string {
  const t = docTitle?.trim();
  if (!t) return html;
  const esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc}</title>`);
  }
  if (html.includes("</head>")) return html.replace("</head>", `<title>${esc}</title></head>`);
  return html;
}

/**
 * Serialises Chromium renders across the whole process.
 *
 * Every PDF launches its OWN browser. Firing several generations within a few seconds
 * therefore starts several full Chromium processes at once, they fight for RAM and CPU,
 * the launch blows past PDF_TOTAL_MS, and the run silently falls back to an unstyled PDF.
 *
 * That is not hypothetical: of 1,880 production runs, the 6 unstyled ones arrived in
 * clusters seconds apart - three of them inside the SAME SECOND - across three different
 * themes. Retrying does not help, because the second attempt meets the same contention.
 *
 * So renders queue: the app still accepts any number of concurrent generations, and only
 * the browser step is one-at-a-time. Everything before it (LLM calls, extraction) stays
 * parallel. Concurrency is configurable via ENPPLY_PDF_CONCURRENCY for a bigger box, but
 * 1 is the safe default that removes the failure entirely.
 */
function pdfConcurrency(): number {
  const raw = Number((process.env.ENPPLY_PDF_CONCURRENCY ?? "").trim());
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(Math.floor(raw), 8);
}

let activeRenders = 0;
const renderWaiters: (() => void)[] = [];

async function acquireRenderSlot(): Promise<() => void> {
  const limit = pdfConcurrency();
  if (activeRenders >= limit) {
    const queuedAt = Date.now();
    const position = renderWaiters.length + 1;
    console.log(`[enpply] PDF: ${activeRenders} render(s) in flight (limit ${limit}) — queued at position ${position}.`);
    await new Promise<void>((resolve) => renderWaiters.push(resolve));
    console.log(`[enpply] PDF: slot acquired after ${Date.now() - queuedAt}ms in queue.`);
  }
  activeRenders++;
  let released = false;
  return () => {
    // Guard against a double release leaking slots and stalling every later render.
    if (released) return;
    released = true;
    activeRenders--;
    const next = renderWaiters.shift();
    if (next) next();
  };
}

export async function renderHtmlToPdf(html: string, theme?: string, docTitle?: string): Promise<Buffer> {
  const release = await acquireRenderSlot();
  try {
    return await renderHtmlToPdfUnqueued(html, theme, docTitle);
  } finally {
    release();
  }
}

async function renderHtmlToPdfUnqueued(html: string, theme?: string, docTitle?: string): Promise<Buffer> {
  console.log(
    `[enpply] PDF: starting Chromium pipeline — platform=${process.platform} node=${process.version} pid=${process.pid} (cap ${PDF_TOTAL_MS}ms)`
  );
  logPuppeteerEnv();
  let browser: Browser | undefined;

  try {
    return await withTimeout(
      (async () => {
        try {
          const exe = puppeteer.executablePath();
          console.log("[enpply] PDF: Chromium executable:", exe);
        } catch (e) {
          console.warn("[enpply] PDF: puppeteer.executablePath() failed — browser may download on first launch:", e);
        }
        console.log("[enpply] PDF: launching Chromium (this can take 30–90s on first run while the browser binary is ready)…");
        const tLaunch0 = performance.now();
        browser = await puppeteer.launch({
          headless: true,
          timeout: 60_000,
          args: CHROME_ARGS,
        });
        console.log(`[enpply] PDF: Chromium launched in ${Math.round(performance.now() - tLaunch0)}ms`);
        console.log("[enpply] PDF: Chromium launched, creating page…");
        const page = await browser.newPage();
        page.setDefaultTimeout(STEP_MS);
        page.setDefaultNavigationTimeout(STEP_MS);
        // Avoid `networkidle0` with any external resource — it can hang indefinitely.
        console.log("[enpply] PDF: rendering HTML…");
        const margin = pdfMarginsForTheme(theme);
        // The templates declare `@page { margin: 0 }`, and in Chromium a CSS
        // `@page` margin OVERRIDES the `page.pdf({ margin })` option — so the
        // print margins below were being ignored and overflow pages came out
        // with ~0 top margin. Inject a later `@page` rule (same specificity, so
        // document order wins) so the intended margins actually apply to EVERY
        // page, including page 2+.
        //
        // The templates' `.sheet` also adds its own top/bottom padding, which
        // only takes effect at the very start/end of the document — so page 1
        // would get `@page` top margin PLUS `.sheet` top padding and look
        // oversized vs. continuation pages. Zero out the `.sheet` vertical
        // padding (keeping left/right, which some themes use) so the `@page`
        // margin is the single source of top/bottom spacing on every page.
        // `!important` beats the per-theme `body.doc.theme-X .sheet` selectors.
        const pageMarginCss = `<style id="enpply-page-margin">@page{margin:${margin.top} ${margin.right} ${margin.bottom} ${margin.left};}.sheet{padding-top:0!important;padding-bottom:0!important;}</style>`;
        // Pagination: never orphan a HEADING from the start of its body. A section
        // heading (h2: Experience/Education/Skills) or a company heading (h3) plus its
        // location line (h3 + p) must stay with the first bullet — if that cluster does
        // not fit at the page bottom, the whole cluster drops to the next page. The rest
        // of a company's bullets may still flow across pages; a single bullet never
        // splits mid-item. Applies to every résumé theme (body HTML is theme-agnostic).
        // Body HTML: section=<h2>, company=<h3>, location=the <p> right after an <h3>,
        // bullets=<p class="bullet">. Keeping h3 + its location <p> from breaking pulls
        // the first bullet up with the heading; p.bullet keeps a single bullet whole.
        const paginationCss =
          `<style id="enpply-pagination">` +
          `h2,h3{break-after:avoid;page-break-after:avoid;}` +
          `h3+p{break-after:avoid;page-break-after:avoid;}` +
          `p.bullet{break-inside:avoid;page-break-inside:avoid;}` +
          `.keep-together{break-inside:avoid;page-break-inside:avoid;}` +
          `</style>`;
        const injectedCss = `${pageMarginCss}${paginationCss}`;
        const titledHtml = setDocTitle(html, docTitle);
        const htmlWithMargins = titledHtml.includes("</head>")
          ? titledHtml.replace("</head>", `${injectedCss}</head>`)
          : `${injectedCss}${titledHtml}`;
        await page.setContent(htmlWithMargins, {
          waitUntil: "domcontentloaded",
          timeout: STEP_MS,
        });
        console.log("[enpply] PDF: printing to PDF buffer…");
        const pdf = await page.pdf({
          format: "Letter",
          printBackground: true,
          margin,
          timeout: STEP_MS,
        });
        console.log("[enpply] PDF: Chromium PDF buffer ready");
        return Buffer.from(pdf);
      })(),
      PDF_TOTAL_MS,
      "Chromium PDF pipeline"
    );
  } finally {
    if (browser) {
      await closeBrowserHard(browser);
    }
  }
}

export async function renderTemplatedPdf(
  kind: TemplateKind,
  bodyMarkdown: string,
  theme: string,
  docTitle?: string
): Promise<Buffer> {
  const bodyHtml = markdownToHtmlFragment(bodyMarkdown);
  const shell = await loadTemplate(kind, theme);
  const html = fillTemplate(shell, bodyHtml, theme);
  return renderHtmlToPdf(html, theme, docTitle);
}
