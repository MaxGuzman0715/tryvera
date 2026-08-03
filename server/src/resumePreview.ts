import { markdownToHtmlFragment } from "./markdownToHtml.js";
import { fillTemplate, loadTemplate } from "./templatePdf.js";
import { getThemeSummaries } from "./resumeThemes.js";

/**
 * Short fixed résumé body — same Markdown shape as real LLM output (see `markdownToHtml.ts`).
 * Shown in the UI as a visual aid when picking a theme; not user data.
 */
export const SAMPLE_RESUME_PREVIEW_MARKDOWN = `# Jane Q. Sample
Senior Software Engineer

Boston, MA · jane@example.com · (555) 010-2030 · linkedin.com/in/sample

## Experience

### Acme Corp | Senior Software Engineer (2021 – Present)

- Shipped features used by 50k+ weekly active users; cut p95 latency by 35%.
- Partnered with design and product on roadmap and technical design reviews.

### Beta Labs | Software Engineer (2018 – 2021)

- Built REST APIs and internal dashboards; introduced structured logging and alerts.

## Skills

TypeScript, Python, React, PostgreSQL, AWS, system design

## Education

State University — B.S. Computer Science · 2018
`;

/** Richer sample for themes that use timeline rows, grids, and language bars (see \`markdownToHtml.ts\`). */
export const SAMPLE_RESUME_BEIGE_PREVIEW_MARKDOWN = `# Maanvita Sample
Office Marketing

Phone · City, ST · you@example.com

## About Me

Results-driven marketing professional with experience coordinating campaigns, stakeholder communication, and brand materials in fast-paced office environments.

## Education

:::grid-3
(2024 - 2027)
State University North
B.A. Marketing & Communications

(2020 - 2024)
Metro College
Associate Diploma, Business

(2018 - 2020)
Central High School
High School Diploma
:::

## Work Experience

### 2024–Present | Aldenaire & Partners — Office Marketing

Supported client-facing campaigns and internal communications. Owned weekly reporting and asset coordination across teams.

- Coordinated print and digital collateral with vendors and design.
- Maintained CRM hygiene and campaign calendars for two account leads.

### 2021–2023 | Beta Agency — Marketing Assistant

- Assisted with event logistics and social content scheduling.

## Skills

:::grid-2
- Microsoft Office, Google Workspace
- CRM hygiene, reporting
- Email campaigns, basic HTML

- Brand voice, proofreading
- Stakeholder updates, scheduling
- Vendor coordination
:::

## Languages

:::lang-bars
English|95
Spanish|55
Japanese|30
:::
`;

/** HTML document using the same \`resume-<theme>.html\` shell as PDF generation, with sample body. */
export async function buildResumePreviewHtml(themeParam: string): Promise<string | null> {
  const t = themeParam.trim().toLowerCase();
  const allowed = new Set(getThemeSummaries().map((x) => x.id));
  if (!allowed.has(t)) return null;

  const shell = await loadTemplate("resume", t);
  const sample =
    t === "beige-band" ? SAMPLE_RESUME_BEIGE_PREVIEW_MARKDOWN : SAMPLE_RESUME_PREVIEW_MARKDOWN;
  const bodyHtml = markdownToHtmlFragment(sample, { sectionHints: false });
  return fillTemplate(shell, bodyHtml, t);
}
