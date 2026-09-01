import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AnswerItem,
  ArtifactKey,
  ArtifactStatus,
  DomainScore,
  ExtractionResult,
  GenerationOptions,
  GenerationStatus,
  JdVariation,
  LlmFunc,
  LlmModelConfig,
  LlmTier,
  Profile,
  QuickReference,
  ResultJson,
  TailoringDetail,
} from "./types.js";
import { resolveStepModel, effectiveTiers } from "./llmTiers.js";
import { markdownToPdfBuffer } from "./pdf.js";
import { readAllPrompts } from "./promptStore.js";
import { listApplications } from "./logStore.js";
import { placeholderCoverLetterMarkdown, placeholderExtraction } from "./llmPlaceholders.js";
import { renderTemplatedPdf } from "./templatePdf.js";
import { stripMarkdownFence, normalizeDashes } from "./markdownToHtml.js";
import { projectRoot } from "./paths.js";
import { jstHmsCompact, jstMonthDayUnderscore, nowJstIso } from "./timeJst.js";
import {
  compactLlmErrorForLog,
  formatLlmFailureReason,
  isTransientLlmError,
  llmErrorStatus,
  logLlmApiErrorDetails,
  logLlmKeyPresence,
  parseJsonLoose,
} from "./llmLog.js";
import { getLlmClientForConfig, getLlmModelForConfig, type LlmRuntimeConfig } from "./llmClient.js";
import { normalizeResumeTheme } from "./resumeThemes.js";
import type { VerboseRunLogger } from "./verboseLog.js";
import { getExtractionAnswerPrompt } from "./extractionAnswerPrompt.js";

/** Output of the résumé-generation LLM step (profile-experience rewrite, no bullet store). Skills are built in extraction now, so the generator no longer returns them. */
type GenResumeContent = {
  summary: string;
  companies: { company: string; bullets: string[] }[];
};

/** Exactly what was sent to one LLM step (written to llm_input.json for inspection). */
type LlmStepInput = { model: LlmRuntimeConfig; system_prompt: string; user: string };

type StructuredExperienceUpdate = {
  index: number;
  title?: string;
  bullets?: string[];
};

type StructuredDocUpdates = {
  summary: string;
  skills: string[];
  experience_updates: StructuredExperienceUpdate[];
};

// ── Project stores (Experiment/projects) ───────────────────────────────────
// shared.json  = consulting pool: industry -> anonymized client engagement.
// <profileId>.json = per-profile real flagship per company (older -> stored
// bullets; last-2 real -> anchor description; consulting -> empty marker).

/** One anonymized client engagement in the shared consulting pool. */
type SharedProject = { industry: string; label?: string; aliases?: string[]; client: string; summary: string };

/** One company entry in a per-profile project store. */
type ProfileProject = {
  company: string;
  role?: string;
  dateRange?: string;
  consulting?: boolean;
  flagshipProject?: string | null;
  description?: string;
  isRecentTwo?: boolean;
  bulletsProvided?: boolean;
  bullets?: string[];
};

const projectsDir = () => path.join(projectRoot(), "Experiment", "projects");

async function loadSharedProjects(): Promise<SharedProject[]> {
  try {
    const raw = await fs.readFile(path.join(projectsDir(), "shared.json"), "utf8");
    const parsed = JSON.parse(raw) as { projects?: unknown };
    return Array.isArray(parsed?.projects) ? (parsed.projects as SharedProject[]) : [];
  } catch {
    return [];
  }
}

async function loadProfileProjects(profileId: string): Promise<ProfileProject[]> {
  const safe = profileId.replace(/[^a-zA-Z0-9._-]/g, "_");
  try {
    const raw = await fs.readFile(path.join(projectsDir(), `${safe}.json`), "utf8");
    const parsed = JSON.parse(raw) as { projects?: unknown };
    return Array.isArray(parsed?.projects) ? (parsed.projects as ProfileProject[]) : [];
  } catch {
    return [];
  }
}

/** Find a project-store entry for a company (case/space-insensitive). */
function findProjectForCompany(projects: ProfileProject[], company: string): ProfileProject | undefined {
  const key = normalizedText(company);
  return projects.find((p) => normalizedText(String(p.company ?? "")) === key);
}

const FIT_ANSWER_QUESTION = "Briefly describe why this job is your top choice and why you're a good fit.";

function artifactErrorLabel(key: string): string {
  const labels: Partial<Record<ArtifactKey, string>> = {
    resume_pdf: "Résumé PDF",
    cover_letter_pdf: "Cover letter PDF",
    answers_json: "answers.json",
    answers_md: "answers.md",
    metadata_json: "metadata.json",
    job_description_txt: "job_description.txt",
  };
  return labels[key as ArtifactKey] ?? key;
}

/** Human-readable summary for ResultJson.error and application log (failed runs). */
function summarizeGenerationFailure(params: {
  status: GenerationStatus;
  llmFallbackUsed: boolean;
  artifact_errors?: Partial<Record<ArtifactKey, string>>;
}): string | undefined {
  if (params.status !== "failed") return undefined;
  const parts: string[] = [];
  if (params.llmFallbackUsed) {
    parts.push("Job extraction used placeholder metadata (LLM API error).");
  }
  const ae = params.artifact_errors;
  if (ae && Object.keys(ae).length > 0) {
    for (const [k, msg] of Object.entries(ae)) {
      if (!msg) continue;
      parts.push(`${artifactErrorLabel(k)}: ${msg}`);
    }
  }
  if (parts.length === 0) return "One or more requested artifacts failed to generate.";
  return parts.join(" ");
}

function logLlmStart(
  step: string,
  mode: "json" | "text",
  systemChars: number,
  userChars: number,
  llm: LlmRuntimeConfig
): number {
  const model = getLlmModelForConfig(llm);
  console.log(
    `[enpply] LLM ▶ ${step} [${mode}] provider=${llm.provider} model=${model} systemChars=${systemChars} userChars=${userChars} — waiting for API…`
  );
  return performance.now();
}

function logLlmSuccess(
  step: string,
  mode: "json" | "text",
  t0: number,
  reply: string | null | undefined,
  finish: string | null | undefined,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
): void {
  const ms = Math.round(performance.now() - t0);
  const u = usage
    ? ` tokens in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"} total=${usage.total_tokens ?? "?"}`
    : "";
  console.log(
    `[enpply] LLM ✓ ${step} [${mode}] ${ms}ms finish=${finish ?? "n/a"} replyChars=${reply?.length ?? 0}${u}`
  );
}

function logLlmFail(step: string, mode: "json" | "text", t0: number, err: unknown): void {
  const ms = Math.round(performance.now() - t0);
  console.warn(`[enpply] LLM ✗ ${step} [${mode}] failed after ${ms}ms — ${compactLlmErrorForLog(err)}`);
  logLlmApiErrorDetails(step, mode, err);
}

/**
 * GPT-5 family and OpenAI reasoning models (o1/o3/o4) reject any `temperature`
 * other than the default 1, returning 400. For those we omit the field entirely
 * so the API uses its built-in default.
 */
function temperatureParam(model: string, wanted: number): { temperature?: number } {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-5") || /^o[1-9](-|$)/.test(m) || m.startsWith("openai/gpt-5") || /^openai\/o[1-9](-|$)/.test(m)) {
    return {};
  }
  return { temperature: wanted };
}

async function chatJson<T>(
  step: string,
  system: string,
  user: string,
  llm: LlmRuntimeConfig,
  verbose: VerboseRunLogger | null
): Promise<T> {
  const t0 = logLlmStart(step, "json", system.length, user.length, llm);
  const client = getLlmClientForConfig(llm);
  const model = getLlmModelForConfig(llm);
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];

  if (verbose) {
    await verbose.writeSection(`LLM ${step} [json] — INPUT system`, system);
    await verbose.writeSection(`LLM ${step} [json] — INPUT user`, user);
  }

  const MAX_RETRIES = 2;
  // Start WITHOUT response_format: that constraint narrows OpenRouter to the
  // providers that support structured output — the smaller pool that gets
  // rate-limited first (a json call 429s while the SAME model's plain-text call
  // succeeds). Parse defensively; escalate to the hard json_object constraint
  // only if a reply comes back unparseable. Retry transient 429/5xx with backoff.
  let useJsonMode = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const base = { model, messages, ...temperatureParam(model, 0.2) };
      const res = await client.chat.completions.create(
        useJsonMode ? { ...base, response_format: { type: "json_object" } } : base
      );
      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("Empty model response");
      logLlmSuccess(step, "json", t0, text, res.choices[0]?.finish_reason ?? null, res.usage ?? undefined);
      if (verbose) {
        await verbose.writeSection(`LLM ${step} [json] — OUTPUT raw`, text);
        await verbose.writeSection(`LLM ${step} [json] — usage`, JSON.stringify(res.usage ?? {}, null, 2));
      }
      let parsed: T;
      try {
        parsed = parseJsonLoose<T>(text);
      } catch (parseErr) {
        // Free-form reply wasn't JSON — escalate to forced structured output once.
        if (!useJsonMode && attempt < MAX_RETRIES) {
          console.warn(`[enpply] LLM ${step} [json] reply not JSON — retrying with response_format`);
          if (verbose) {
            await verbose.writeSection(`LLM ${step} [json] — escalate to response_format`, String(parseErr));
          }
          useJsonMode = true;
          continue;
        }
        console.warn(`[enpply] LLM ${step} [json] parse error; first 240 chars of reply:`, text.slice(0, 240));
        if (verbose) {
          await verbose.writeSection(`LLM ${step} [json] — JSON.parse error`, String(parseErr));
        }
        throw parseErr;
      }
      if (verbose) {
        await verbose.writeSection(`LLM ${step} [json] — OUTPUT parsed`, JSON.stringify(parsed, null, 2));
      }
      return parsed;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES && isTransientLlmError(e)) {
        const waitMs = 700 * 2 ** attempt; // 700ms, 1400ms
        console.warn(`[enpply] LLM ${step} [json] transient ${llmErrorStatus(e) ?? "?"} — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }
  logLlmFail(step, "json", t0, lastErr);
  if (verbose) {
    await verbose.writeSection(`LLM ${step} [json] — ERROR`, lastErr instanceof Error ? lastErr.stack ?? lastErr.message : String(lastErr));
  }
  throw lastErr;
}

async function chatText(
  step: string,
  system: string,
  user: string,
  llm: LlmRuntimeConfig,
  verbose: VerboseRunLogger | null
): Promise<string> {
  const t0 = logLlmStart(step, "text", system.length, user.length, llm);
  const client = getLlmClientForConfig(llm);
  const model = getLlmModelForConfig(llm);
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  if (verbose) {
    await verbose.writeSection(`LLM ${step} [text] — INPUT system`, system);
    await verbose.writeSection(`LLM ${step} [text] — INPUT user`, user);
  }
  // Retry transient 429/5xx (free-pool rate limits) with exponential backoff.
  const MAX_RETRIES = 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model,
        messages,
        ...temperatureParam(model, 0.35),
      });
      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("Empty model response");
      logLlmSuccess(step, "text", t0, text, res.choices[0]?.finish_reason ?? null, res.usage ?? undefined);
      if (verbose) {
        await verbose.writeSection(`LLM ${step} [text] — OUTPUT raw`, text);
        await verbose.writeSection(`LLM ${step} [text] — usage`, JSON.stringify(res.usage ?? {}, null, 2));
      }
      return text.trim();
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES && isTransientLlmError(e)) {
        const waitMs = 700 * 2 ** attempt; // 700ms, 1400ms
        console.warn(`[enpply] LLM ${step} [text] transient ${llmErrorStatus(e) ?? "?"} — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }
  logLlmFail(step, "text", t0, lastErr);
  if (verbose) {
    await verbose.writeSection(`LLM ${step} [text] — ERROR`, lastErr instanceof Error ? lastErr.stack ?? lastErr.message : String(lastErr));
  }
  throw lastErr;
}

/**
 * Filename of a run-owned file inside the output folder.
 *
 * A batch run puts several profiles in ONE folder, so files otherwise written under a
 * fixed name (metadata/answers/llm_input/result) must be per-profile or they overwrite
 * each other. Single runs keep the exact historical names.
 *
 * Exported so callers needing the path (such as the log result_file) derive it from the
 * same rule instead of hard-coding "result.json".
 */
/**
 * Numeric claims in a finished résumé, used to stop the next candidate in a batch from
 * repeating them.
 *
 * Deliberately loose: this list is a hint handed to the model, not a gate, so a few extra
 * tokens cost nothing while a miss lets two résumés share "86,000 writes per day". Years
 * are dropped because "2025" is a date, not a claim.
 */
export function extractResumeFigures(markdown: string): string[] {
  const out = new Set<string>();
  const re =
    /\b\d[\d,.]*\s*(?:%|ms\b|s\b|sec\b|seconds\b|min\b|minutes\b|h\b|hrs?\b|hours\b|days\b|weeks\b|months\b|k\b|m\b|million\b|billion\b|x\b)?/gi;
  for (const m of markdown.matchAll(re)) {
    const raw = m[0].trim().replace(/\s+/g, " ");
    const num = Number(raw.replace(/[^\d.]/g, ""));
    // A bare 1900-2100 is a year; a bare single digit is noise (bullet numbering, "1 of 3").
    const bare = /^[\d,.]+$/.test(raw);
    if (bare && ((num >= 1900 && num <= 2100) || num < 10)) continue;
    out.add(raw);
    if (out.size >= 40) break; // keep the appended prompt small
  }
  return [...out];
}

/**
 * Résumé system prompt plus the batch variation block, when this run is part of a batch.
 * Exported so the append can be tested directly: the résumé LLM step is skipped whenever
 * extraction falls back, so an end-to-end run cannot always observe the composed prompt.
 */
export async function withBatchVariation(basePrompt: string, avoidFigures: string[] | undefined): Promise<string> {
  if (!avoidFigures?.length) return basePrompt;
  let block: string;
  try {
    block = await fs.readFile(path.join(projectRoot(), "server", "prompt-defaults", "batch-variation.txt"), "utf8");
  } catch {
    // Missing file must not fail the run - it only costs variation, not correctness.
    console.warn("[enpply] batch-variation.txt missing — generating without the variation prompt.");
    return basePrompt;
  }
  return `${basePrompt.trimEnd()}\n\n${block.replace("{{FIGURES}}", avoidFigures.join(", "))}`;
}

export function ownedArtifactName(profileId: string, name: string, sharedFolder: boolean): string {
  if (!sharedFolder) return name;
  const base = slugPart(profileId).toLowerCase() || "profile";
  return `${base}_${name}`;
}

export function slugPart(s: string): string {
  return s
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 48) || "unknown";
}

/**
 * Relative output folder under `default_output_path`: `MM_DD/profile/TS_company_role` (JST).
 * With optional recruiter prefix: `MM_DD/profile/Recruiter_TS_company_role`.
 */
export function makeOutputFolderName(
  resumeProfileId: string,
  company: string,
  role: string,
  recruiterName?: string
): string {
  const d = new Date();
  const monDay = jstMonthDayUnderscore(d);
  const profileSeg = slugPart(resumeProfileId).toLowerCase() || "profile";
  const ts = jstHmsCompact(d);
  const rec = recruiterName?.trim() ? slugPart(recruiterName.trim()) : "";
  const jobSeg = rec
    ? `${rec}_${ts}_${slugPart(company)}_${slugPart(role)}`
    : `${ts}_${slugPart(company)}_${slugPart(role)}`;
  return `${monDay}/${profileSeg}/${jobSeg}`;
}

function jobRefBlock(job_link: string, recruiter_name: string): string {
  const link = job_link.trim();
  const rec = recruiter_name.trim();
  const lines: string[] = [];
  lines.push(link ? `Job link: ${link}` : "Job link: (none)");
  lines.push(rec ? `Recruiter / contact: ${rec}` : "Recruiter / contact: (none)");
  return lines.join("\n");
}

function normalizedText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeForDupCheck(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

/** Company + role + resume profile (all normalized). Used only when company and role are non-empty. */
function applicationDupKey(company: string, role: string, resumeProfileId: string): string {
  return `${normalizeForDupCheck(company)}|${normalizeForDupCheck(role)}|${normalizeForDupCheck(resumeProfileId)}`;
}

function pickTitle(originalTitle: string, candidateTitle: string | undefined, roleName: string): string {
  const next = (candidateTitle ?? "").trim();
  if (!next) return originalTitle;
  const origNorm = normalizedText(originalTitle);
  const nextNorm = normalizedText(next);
  const roleNorm = normalizedText(roleName);
  if (!nextNorm || nextNorm.length > 80) return originalTitle;
  if (origNorm.includes("software engineer") && !nextNorm.includes("software engineer")) {
    if (!roleNorm.includes(nextNorm) && !nextNorm.includes(roleNorm)) return originalTitle;
  }
  return next;
}

function fallbackBulletsFromProfile(exp: Profile["experience"][number]): string[] {
  if (Array.isArray(exp.bullets) && exp.bullets.length) return exp.bullets;
  if (Array.isArray(exp.paragraphs) && exp.paragraphs.length) return exp.paragraphs;
  if (typeof exp.rawLines === "string" && exp.rawLines.trim()) {
    return exp.rawLines
      .split(/\r?\n/)
      .map((x) => x.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function contactLine(profile: Profile): string {
  const b = profile.basic;
  return [b.location, b.phone, b.email, b.linkedin].filter((x): x is string => Boolean(x && x.trim())).join(" | ");
}

/** Lines after `# Name`: optional profile title (if no `|`), then contact. Parser uses `|` to detect contact-only. */
function resumeNameBlockLines(profile: Profile): string {
  const contact = contactLine(profile);
  const title = profile.basic.title?.trim();
  if (title && !title.includes("|")) {
    return `${title}\n${contact}`;
  }
  return contact;
}

/** The category names ("Frontend", "Backend", …) of a categorized skills list; [] if flat. */
function skillDomainNames(skills: string[]): string[] {
  const out: string[] = [];
  for (const s of skills) {
    const m = /^([^:]{2,60}):\s*/.exec(s.trim());
    if (m) out.push(m[1].replace(/\*/g, "").trim());
  }
  return out;
}

/**
 * Categorized skills ("Frontend: a, b, c") render one bolded category per line
 * (each markdown line becomes its own paragraph); a plain flat list stays
 * comma-joined. The category label is bolded here, not by the model.
 */
function renderSkillsList(skills: string[]): string {
  const cleaned = skills.map((s) => s.trim()).filter(Boolean);
  const categorized = cleaned.some((s) => /^[^:]{2,60}:\s*/.test(s));
  if (!categorized) return cleaned.join(", ");
  return cleaned
    .map((s) => {
      const m = /^([^:]{2,60}):\s*(.*)$/.exec(s);
      if (!m) return s;
      const label = m[1].replace(/\*/g, "").trim();
      return `**${label}:** ${m[2].trim()}`;
    })
    .join("\n");
}

function renderResumeFromStructured(
  profile: Profile,
  extraction: ExtractionResult,
  doc: StructuredDocUpdates,
  theme: string,
): string {
  const updates = new Map<number, StructuredExperienceUpdate>();
  for (const e of doc.experience_updates ?? []) {
    if (Number.isInteger(e.index) && e.index >= 0) updates.set(e.index, e);
  }
  const skills = (doc.skills ?? []).map((s) => s.trim()).filter(Boolean);
  const expBlocks = profile.experience.map((exp, idx) => {
    const u = updates.get(idx);
    const title = pickTitle(exp.title, u?.title, extraction.role_name);
    const bullets = (u?.bullets ?? []).map((b) => b.trim()).filter(Boolean);
    const finalBullets = bullets.length ? bullets : fallbackBulletsFromProfile(exp);
    const lines = finalBullets.map((b) => `- ${b}`).join("\n") || "- ";
    const locationLine = exp.location?.trim() ? `\n${exp.location.trim()}` : "";
    return `### ${exp.company} | ${title} (${exp.startDate} – ${exp.endDate})${locationLine}\n${lines}`;
  });
  const eduBlocks = profile.education.map((e) => {
    const start = (e.startDate ?? "").trim();
    const end = (e.endDate ?? "").trim();
    const period = start && end ? ` (${start} – ${end})` : "";
    return `${e.school} — ${e.degree}, ${e.field}${period}`;
  });

  const header = `# ${profile.basic.fullName}\n${resumeNameBlockLines(profile)}`;
  const summarySection = `## Summary\n${doc.summary?.trim() || profile.basic.summary || ""}`;
  const skillsSection = `## Skills\n${renderSkillsList(skills.length ? skills : profile.skills)}`;
  const experienceSection = `## Experience\n${expBlocks.join("\n\n")}`;
  const educationSection = `## Education\n${eduBlocks.join("\n")}`;

  // Section order is theme-specific:
  //  - "deepankar" places skills between the summary and the experience.
  //  - "rhazel" floats education up, right after the summary and before experience.
  //  - every other theme keeps the default summary → experience → skills → education.
  let body: string[];
  switch (normalizeResumeTheme(theme)) {
    case "deepankar":
      body = [header, summarySection, skillsSection, experienceSection, educationSection];
      break;
    case "rhazel":
      body = [header, summarySection, educationSection, experienceSection, skillsSection];
      break;
    default:
      body = [header, summarySection, experienceSection, skillsSection, educationSection];
  }

  return body.join("\n\n");
}

/** How each résumé company was sourced, for the Result-page tailoring detail. */
type CompanyRole = "anchor" | "consulting" | "older";
export type ResumeCompanyPlan = { company: string; role: CompanyRole; industries?: string[] };

/**
 * Résumé assembly from the candidate's real experience, routed three ways:
 *
 *  - REAL anchor (last-2, not consulting): the LLM tailors it live from variation A,
 *    grounded in the company's real bullets + its flagship project.
 *  - CONSULTING (last-2, consulting:true): the LLM writes industry-matched client
 *    engagements from the 2 shared.json summaries (each opening "did X for a
 *    [industry] client") using variation B, absorbing the JD stacks that don't fit
 *    the anchor.
 *  - OLDER (index ≥ 2): filled in code from the per-profile project store's stored
 *    flagship bullets — no LLM, no JD tailoring.
 *
 * Degrades to the profile's own bullets (+ any older stored bullets) when the LLM
 * fails or there is nothing to tailor. `plan` reports the routing for the Result page.
 */
async function buildResumeDoc(params: {
  profile: Profile;
  variations: JdVariation[];
  industries: string[];
  sharedProjects: SharedProject[];
  /** The role-tailored, ordered/trimmed skills list — now built in the extraction step. */
  skills: string[];
  resumePrompt: string;
  resumeLlm: LlmRuntimeConfig;
  verbose: VerboseRunLogger | null;
  onLlmFallback: () => void;
  warn: (msg: string) => void;
}): Promise<{ doc: StructuredDocUpdates; plan: ResumeCompanyPlan[]; llmInput: LlmStepInput | null }> {
  const { profile, variations, industries, sharedProjects, verbose } = params;
  const skillsOut = params.skills.length ? params.skills : profile.skills;

  // A → real anchor company, B → consulting company. Fall back gracefully if the
  // normalizer returned only one variation (use it for both).
  const varA = variations.find((v) => v.label.toUpperCase() === "A") ?? variations[0];
  const varB = variations.find((v) => v.label.toUpperCase() === "B") ?? variations[1] ?? varA;
  const reframedFor = (consulting: boolean) => (consulting ? varB : varA);

  const profileProjects = await loadProfileProjects(profile.id);

  // Older companies (index ≥ 2): swap in the per-profile store's stored flagship
  // bullets where present; otherwise leave them (renderer falls back to profile).
  const olderUpdates: StructuredExperienceUpdate[] = [];
  const olderPlan: ResumeCompanyPlan[] = [];
  profile.experience.slice(2).forEach((exp, i) => {
    const idx = i + 2;
    const proj = findProjectForCompany(profileProjects, exp.company);
    const stored = Array.isArray(proj?.bullets)
      ? proj!.bullets.map((b) => String(b).trim()).filter(Boolean)
      : [];
    if (stored.length) olderUpdates.push({ index: idx, bullets: stored });
    olderPlan.push({ company: exp.company, role: "older" });
  });

  // Last-2 companies split by the consulting flag: real anchor(s) vs consulting.
  const sharedByIndustry = new Map(sharedProjects.map((p) => [String(p.industry ?? "").toLowerCase(), p]));
  const engagements = industries
    .map((ind) => sharedByIndustry.get(ind.toLowerCase()))
    .filter((p): p is SharedProject => Boolean(p))
    .map((p) => ({ industry: p.industry, label: (p.label || p.industry).trim(), client: p.client, summary: p.summary }));

  const last2 = profile.experience.slice(0, 2).map((exp, idx) => {
    const consulting = exp.consulting === true;
    const proj = findProjectForCompany(profileProjects, exp.company);
    return {
      idx,
      company: exp.company,
      consulting,
      groundTruth: fallbackBulletsFromProfile(exp),
      flagship: String(proj?.description ?? proj?.flagshipProject ?? "").trim(),
    };
  });

  const last2Plan: ResumeCompanyPlan[] = last2.map((t) =>
    t.consulting ? { company: t.company, role: "consulting", industries } : { company: t.company, role: "anchor" }
  );
  const plan = [...last2Plan, ...olderPlan];

  const untailored = (): { doc: StructuredDocUpdates; plan: ResumeCompanyPlan[]; llmInput: LlmStepInput | null } => ({
    doc: {
      summary: profile.basic.summary ?? "",
      skills: skillsOut,
      experience_updates: [
        ...last2.map((t) => ({ index: t.idx, bullets: t.groundTruth })),
        ...olderUpdates,
      ],
    },
    plan,
    llmInput: null,
  });

  if (last2.length === 0) {
    params.warn("Profile has no experience entries — résumé left untailored.");
    if (verbose) await verbose.writeSection("resume — NO EXPERIENCE (untailored)", `profile=${profile.id}`);
    return untailored();
  }
  // Nothing for the LLM to work with (no variations, no consulting engagements):
  // keep the older stored bullets but leave the last-2 as their real profile bullets.
  const hasConsulting = last2.some((t) => t.consulting);
  if (variations.length === 0 && !(hasConsulting && engagements.length)) {
    params.warn("No JD variations or industry engagements — last-2 companies use original profile bullets.");
    if (verbose) await verbose.writeSection("resume — NOTHING TO TAILOR", `profile=${profile.id}`);
    return untailored();
  }

  const input = {
    candidate: {
      full_name: profile.basic.fullName,
      current_title: profile.basic.title ?? "",
    },
    // The exact skills list this résumé will RENDER, built by extraction from the profile's
    // categorized skills. Sent so the bullets and the Skills section describe one engineer:
    // without it the model named technologies the candidate never listed while the Skills
    // block omitted ones the bullets were built on.
    candidate_skills: skillsOut,
    // Per-company shape. An explicit `consulting` flag tells the model which is which:
    //   consulting        — true = consulting/client-services employer, false = the candidate's own role.
    //   reframed_jd       — this company's JD angle (variation A for the anchor, B for consulting).
    //   summary_lines     — the grounding the bullets must stay true to:
    //                         anchor     -> its real flagship + the candidate's true bullets,
    //                         consulting -> the 2 selected industries' project summaries.
    //   client_industries (consulting only) — client_industries[i] pairs with summary_lines[i]; drives the master line.
    companies: last2.map((t) => {
      const reframed_jd = reframedFor(t.consulting)?.reframed_jd ?? "";
      if (t.consulting) {
        return {
          company: t.company,
          consulting: true,
          reframed_jd,
          summary_lines: engagements.map((e) => e.summary),
          client_industries: engagements.map((e) => e.label),
        };
      }
      return {
        company: t.company,
        consulting: false,
        reframed_jd,
        summary_lines: [t.flagship, ...t.groundTruth].filter(Boolean),
      };
    }),
  };

  // The exact user message sent to the generation model. Captured into `llmInput`
  // so the caller can persist it (alongside the extraction input) to llm_input.json.
  const userMessage = `${JSON.stringify(input, null, 2)}\n\nReturn the JSON now. Output only the JSON object.`;
  const llmInput: LlmStepInput = { model: params.resumeLlm, system_prompt: params.resumePrompt, user: userMessage };
  if (verbose) await verbose.writeSection("resume-generation — INPUT payload", JSON.stringify(input, null, 2));

  let content: GenResumeContent;
  try {
    content = await chatJson<GenResumeContent>(
      "resume",
      params.resumePrompt,
      userMessage,
      params.resumeLlm,
      verbose
    );
  } catch (genErr) {
    params.onLlmFallback();
    const reason = formatLlmFailureReason(genErr, params.resumeLlm.provider);
    console.warn("[enpply] resume generation LLM failed, using original experience —", reason);
    params.warn(`Resume generation error: ${reason}`);
    if (verbose) await verbose.writeSection("resume-generation — FALLBACK (original experience)", reason);
    return { ...untailored(), llmInput };
  }
  if (verbose) {
    await verbose.writeSection("resume-generation — parsed", JSON.stringify(content, null, 2));
  }

  // Match each generated block back to its profile index by company name; fall back
  // to input order, then to the company's ground-truth bullets if the block is empty.
  const byCompany = new Map(
    (content.companies ?? []).map((c) => [normalizedText(String(c.company ?? "")), c])
  );
  const last2Updates: StructuredExperienceUpdate[] = last2.map((t, i) => {
    const out = byCompany.get(normalizedText(t.company)) ?? content.companies?.[i];
    const bullets = Array.isArray(out?.bullets)
      ? out!.bullets.map((b) => String(b).trim()).filter(Boolean)
      : [];
    return { index: t.idx, bullets: bullets.length ? bullets : t.groundTruth };
  });

  const summary = (content.summary ?? "").trim() || (profile.basic.summary ?? "");
  // Skills come from the extraction step now (built + tailored there), not the generator.
  return { doc: { summary, skills: skillsOut, experience_updates: [...last2Updates, ...olderUpdates] }, plan, llmInput };
}

function emptyArtifactStatus(): Record<ArtifactKey, ArtifactStatus> {
  return {
    resume_pdf: "failed",
    cover_letter_pdf: "failed",
    answers_json: "failed",
    answers_md: "failed",
    metadata_json: "failed",
    job_description_txt: "failed",
  };
}

/**
 * Default: Chromium + HTML templates (so theme selection applies).
 * Set `ENPPLY_PDF_ENGINE=pdfkit` for fast plain PDFKit output (ignores theme CSS).
 */
function useChromiumTemplatePdf(): boolean {
  const raw = (process.env.ENPPLY_PDF_ENGINE ?? "").trim().toLowerCase();
  if (raw === "pdfkit") return false;
  if (raw === "chromium" || raw === "html" || raw === "puppeteer" || raw === "") return true;
  console.warn(
    `[enpply] Unknown ENPPLY_PDF_ENGINE="${process.env.ENPPLY_PDF_ENGINE}" — using Chromium (HTML). Valid: (unset), chromium, html, puppeteer, pdfkit.`
  );
  return true;
}

/**
 * Which renderer actually produced the file.
 *
 * "pdfkit-fallback" means the themed HTML render FAILED and the reader is holding an
 * UNSTYLED document that still looks finished. That has to reach the caller: reporting
 * it as a clean success is what made the plain-résumé bug look random for so long.
 */
export type PdfEngineUsed = "chromium" | "pdfkit" | "pdfkit-fallback";

/** Transient Chromium failures (cold launch, timeout, VPS contention) usually pass on a retry. */
const CHROMIUM_ATTEMPTS = 2;

async function writePdfFromTemplateOrFallback(
  kind: "resume" | "coverLetter",
  markdown: string,
  theme: string,
  outPath: string,
  verbose: VerboseRunLogger | null,
  docTitle?: string
): Promise<PdfEngineUsed> {
  if (verbose) {
    await verbose.writeSection(
      `PDF ${kind} — input`,
      `ENPPLY_PDF_ENGINE=${process.env.ENPPLY_PDF_ENGINE ?? "(unset)"}\ntheme=${theme}\noutPath=${outPath}\nmarkdownChars=${markdown.length}\n\n--- markdown ---\n\n${markdown}`
    );
  }

  // Cover letters always use the simple PDFKit path — no theme/template, just
  // plain prose rendered to PDF. The Chromium HTML-template branch is reserved
  // for the résumé, where the theme actually matters.
  if (kind === "coverLetter") {
    console.log(`[enpply] Building ${kind} PDF (PDFKit — cover letters always use the simple path).`);
    const buf = await markdownToPdfBuffer(markdown);
    await fs.writeFile(outPath, buf);
    console.log(`[enpply] Wrote ${kind} PDF (PDFKit) →`, outPath);
    if (verbose) {
      const st = await fs.stat(outPath);
      await verbose.writeSection(`PDF ${kind} — wrote (PDFKit, cover-letter forced)`, `bytes=${st.size}\npath=${outPath}`);
    }
    return "pdfkit";
  }

  if (!useChromiumTemplatePdf()) {
    console.log(
      `[enpply] Building ${kind} PDF (PDFKit — theme ignored). Set ENPPLY_PDF_ENGINE=chromium (or unset) for HTML templates.`
    );
    const buf = await markdownToPdfBuffer(markdown);
    await fs.writeFile(outPath, buf);
    console.log(`[enpply] Wrote ${kind} PDF (PDFKit) →`, outPath);
    if (verbose) {
      const st = await fs.stat(outPath);
      await verbose.writeSection(`PDF ${kind} — wrote (PDFKit)`, `bytes=${st.size}\npath=${outPath}`);
    }
    return "pdfkit";
  }

  console.log(`[enpply] Building ${kind} PDF (HTML template + Chromium, ENPPLY_PDF_ENGINE=chromium)…`);
  const failures: string[] = [];
  for (let attempt = 1; attempt <= CHROMIUM_ATTEMPTS; attempt++) {
    try {
      const buf = await renderTemplatedPdf(kind, markdown, theme, docTitle);
      await fs.writeFile(outPath, buf);
      console.log(`[enpply] Wrote ${kind} PDF (Chromium, attempt ${attempt}/${CHROMIUM_ATTEMPTS}) →`, outPath);
      if (verbose) {
        const st = await fs.stat(outPath);
        await verbose.writeSection(
          `PDF ${kind} — wrote (Chromium HTML template)`,
          `bytes=${st.size}` +
            `\npath=${outPath}` +
            `\nattempt=${attempt}/${CHROMIUM_ATTEMPTS}` +
            (failures.length ? `\n\n--- earlier attempt(s) failed ---\n${failures.join("\n\n")}` : "")
        );
      }
      return "chromium";
    } catch (err) {
      const detail = err instanceof Error ? err.stack ?? err.message : String(err);
      failures.push(`attempt ${attempt}: ${detail}`);
      console.warn(
        `[enpply] ${kind} Chromium PDF attempt ${attempt}/${CHROMIUM_ATTEMPTS} failed` +
          (attempt < CHROMIUM_ATTEMPTS ? " — retrying…" : " — no attempts left."),
        err
      );
    }
  }

  // Every themed attempt failed. Still produce a document — a plain résumé beats none —
  // but say so loudly and tell the caller, because an UNSTYLED file that looks finished
  // is exactly what made this bug look random.
  console.error(
    `[enpply] ${kind} THEME NOT APPLIED — all ${CHROMIUM_ATTEMPTS} Chromium attempts failed; ` +
      `writing an UNSTYLED PDFKit PDF for theme="${theme}". Check Chromium availability and ` +
      `the timeouts in templatePdf.ts (PDF_TOTAL_MS/STEP_MS).`
  );
  if (verbose) {
    await verbose.writeSection(
      `PDF ${kind} — Chromium failed on ALL attempts (UNSTYLED PDFKit fallback)`,
      failures.join("\n\n")
    );
  }
  const buf = await markdownToPdfBuffer(markdown);
  await fs.writeFile(outPath, buf);
  console.log(`[enpply] Wrote ${kind} PDF (UNSTYLED PDFKit fallback) →`, outPath);
  if (verbose) {
    const st = await fs.stat(outPath);
    await verbose.writeSection(
      `PDF ${kind} — wrote (UNSTYLED PDFKit fallback)`,
      `bytes=${st.size}` + `\npath=${outPath}`
    );
  }
  return "pdfkit-fallback";
}

function artifactLineOk(wanted: boolean, st: ArtifactStatus): boolean {
  if (!wanted) return st === "skipped";
  return st === "completed";
}

export async function runGeneration(params: {
  profile: Profile;
  job_link: string;
  /** Plain-text recruiter name when there is no posting URL — used in folder name and prompts. */
  recruiter_name?: string;
  job_description: string;
  apply_form: string | null;
  theme: string;
  appId: string;
  outputRootAbs: string;
  /** The two admin-defined models. Every step resolves to one of these. */
  llmLight: LlmModelConfig;
  llmHeavy: LlmModelConfig;
  /** Optional admin per-step overrides: pin a specific model to extraction / generation. */
  llmExtraction?: LlmModelConfig;
  llmGeneration?: LlmModelConfig;
  /** This user's function→tier choices; unset functions use the default tier. */
  llmTiers?: Partial<Record<LlmFunc, LlmTier>>;
  /**
   * Which extraction step runs. Defaults to `extraction` (résumé/heavy function)
   * when a résumé is generated, else `extractionLite` (answers/light function).
   * The Q&A-only "create a slot" path passes `extractionLite` explicitly.
   */
  extractionStepKey?: "extraction" | "extractionLite";
  /**
   * Skip the extraction LLM entirely and use these manually-entered values.
   * Used by log-only runs (no résumé/CV) from the "manual logger" role or the
   * "enter company & role manually" toggle. company/role drive the log entry,
   * output folder, and duplicate check; no JD parsing happens.
   */
  extractionOverride?: { company_name: string; role_name: string };
  /** All default true — unchecked in UI sends false. */
  gen_resume?: boolean;
  /** Cover letter PDF. `gen_cv` is accepted as a legacy alias (same meaning). */
  gen_cover_letter?: boolean;
  gen_cv?: boolean;
  gen_answers?: boolean;
  gen_fit_answer?: boolean;
  ignore_duplicate_check?: boolean;
  /**
   * On a duplicate (same normalized company+role+profile), DON'T throw — instead
   * append "-1" (then -2, …) to the role name until it's unique, so a new,
   * visibly-distinct run is created alongside the old one. Used by the
   * extension's "Force regenerate". Ignored when ignore_duplicate_check is true.
   */
  suffix_on_duplicate?: boolean;
  run_uuid?: string;
  onStage?: (stage: string, info?: { company_name?: string; role_name?: string }) => Promise<void> | void;
  shouldCancel?: () => boolean;
  /** When set (ENPPLY_VERBOSE), full step I/O is appended to this file. */
  verbose?: VerboseRunLogger | null;
  /**
   * Rerun mode: reuse the existing output folder instead of computing a new
   * one, skip the duplicate check, and preserve prior artifact state for
   * items whose `gen_*` flag is false (so an unchecked item keeps its
   * previous "completed"/"skipped" status instead of being marked "skipped"
   * again). Used by POST /api/applications/:id/rerun.
   */
  /**
   * Replaces the profile id in the output folder path. Batch runs pass a constant
   * (e.g. "_batch") so several profiles answering ONE job description land in one
   * folder instead of one folder per profile.
   */
  /**
   * Figures already used by earlier profiles in the same batch. When present, the batch
   * variation prompt is appended to the résumé system prompt so this candidate does not
   * repeat them. Empty or absent = ordinary single run, prompt untouched.
   */
  avoidFigures?: string[];
  folderProfileSegment?: string;
  /**
   * True when this run shares its output folder with other profiles. Six files are
   * written under fixed names (metadata/answers/llm_input/result); in a shared folder
   * they would overwrite each other, so they get the profile prefix the PDFs already use.
   */
  sharedFolder?: boolean;
  reuseFolder?: {
    outputFolderAbs: string;
    outputFolderRel: string;
    priorArtifactStatus: Record<ArtifactKey, ArtifactStatus>;
    priorArtifacts: Record<ArtifactKey, string>;
    priorAnswers: AnswerItem[];
    priorCompanyName?: string;
    priorRoleName?: string;
    priorCreatedAt?: string;
    priorQuickReference?: QuickReference;
    priorApplyForm?: string;
  };
}): Promise<ResultJson> {
  const { profile, job_link, job_description, apply_form, appId, outputRootAbs } = params;
  // The two-tier model config + this user's function→tier choices. Every LLM
  // step resolves through resolveStepModel(step, tierSettings, llmTiers).
  const tierSettings = {
    llm_light: params.llmLight,
    llm_heavy: params.llmHeavy,
    llm_extraction: params.llmExtraction,
    llm_generation: params.llmGeneration,
  };
  const llmTiers = params.llmTiers;
  const recruiter_name = String(params.recruiter_name ?? "").trim();
  const verbose = params.verbose ?? null;
  const emitStage = async (s: string, info?: { company_name?: string; role_name?: string }) => {
    if (params.onStage) await params.onStage(s, info);
  };
  const ensureNotCancelled = () => {
    if (params.shouldCancel?.()) throw new Error("Run cancelled by user.");
  };
  const wantResume = params.gen_resume !== false;
  const wantCoverLetter = (params.gen_cover_letter ?? params.gen_cv) !== false;
  const wantExplicitAnswers = params.gen_answers !== false;
  const wantFitAnswer = params.gen_fit_answer === true;
  const wantAnyAnswers = wantExplicitAnswers || wantFitAnswer;
  const ignoreDuplicateCheck = params.ignore_duplicate_check === true;
  const suffixOnDuplicate = params.suffix_on_duplicate === true;
  const generation_options: GenerationOptions = {
    gen_resume: wantResume,
    gen_cover_letter: wantCoverLetter,
    gen_answers: wantExplicitAnswers,
    gen_fit_answer: wantFitAnswer,
    ignore_duplicate_check: ignoreDuplicateCheck,
  };

  const theme = normalizeResumeTheme(params.theme);
  console.log(
    `[enpply] generate start appId=${appId} profile=${profile.id} light=${params.llmLight.provider}/${params.llmLight.model} heavy=${params.llmHeavy.provider}/${params.llmHeavy.model} theme=${theme} jdChars=${job_description.length} options=${JSON.stringify(generation_options)}`
  );
  logLlmKeyPresence(params.llmLight.provider);
  if (params.llmHeavy.provider !== params.llmLight.provider) logLlmKeyPresence(params.llmHeavy.provider);
  const prompts = await readAllPrompts();

  if (verbose) {
    await verbose.writeSection(
      "runGeneration — parameters",
      JSON.stringify(
        {
          profile,
          job_link,
          recruiter_name,
          job_description,
          apply_form,
          theme,
          appId,
          outputRootAbs,
          generation_options,
          llm_light: params.llmLight,
          llm_heavy: params.llmHeavy,
          llm_tiers: effectiveTiers(llmTiers),
        },
        null,
        2
      )
    );
    await verbose.writeSection("Resolved prompts (full)", JSON.stringify(prompts, null, 2));
  }

  const profileJson = JSON.stringify(profile, null, 2);
  const extractionPrompt = getExtractionAnswerPrompt(prompts.extraction, wantExplicitAnswers, wantFitAnswer);
  const skillDomains = skillDomainNames(profile.skills);
  // Send the FULL categorized skills (not just domain names): extraction both scores
  // each domain 1-3 AND builds the tailored résumé skills list from these.
  const domainBlock = profile.skills.length
    ? `\n\nCandidate skills (each line is one category "Category: a, b, c") — score each category 1-3 for this role AND build the role-tailored skills list from these:\n${profile.skills.join("\n")}`
    : "";
  // Consulting pool: give the extractor the exact industry names so it can pick
  // the 2 most relevant; code then pulls those entries' project summaries.
  const sharedProjects = await loadSharedProjects();
  const industryNames = sharedProjects.map((p) => String(p.industry ?? "").trim()).filter(Boolean);
  const industriesBlock = industryNames.length
    ? `\n\nClient-industry options (pick the 2 most relevant to this role, by exact name):\n${industryNames.join("\n")}`
    : "";
  /** Full JD + link + apply form + skill domains + industry options — used only for the extraction step. */
  const jdBlock =
    (wantAnyAnswers
      ? `${jobRefBlock(job_link, recruiter_name)}\n\nJob description:\n${job_description}\n\nApply form (optional):\n${apply_form ?? "(none)"}\n\nCandidate profile JSON:\n${profileJson}`
      : `${jobRefBlock(job_link, recruiter_name)}\n\nJob description:\n${job_description}\n\nApply form (optional):\n${apply_form ?? "(none)"}`) +
    domainBlock +
    industriesBlock;

  let llmFallbackUsed = false;

  let extraction: ExtractionResult;
  ensureNotCancelled();
  await emitStage("extracting_keywords");
  // Extraction tier: the strong `extraction` model is only needed when we tailor
  // a résumé (deep K-structure drives the bullet rewrites). A cover-letter-only
  // or Q&A/answers-only run uses the cheap `extractionLite` model — company/role
  // + answers don't need the heavy extraction. An explicit `extractionStepKey`
  // (e.g. the Q&A-slot path) still wins. Both fall back to the global default.
  const extractionStepKey = params.extractionStepKey ?? (wantResume ? "extraction" : "extractionLite");
  const extractionLlm = resolveStepModel(extractionStepKey, tierSettings, llmTiers);
  if (params.extractionOverride) {
    // Manual company/role (log-only): skip the LLM entirely. Build a minimal
    // extraction so the folder name, duplicate check, log entry, and result.json
    // all have company/role to work with. No JD parsing, no questions/answers.
    extraction = placeholderExtraction(profile);
    extraction.company_name = params.extractionOverride.company_name;
    extraction.role_name = params.extractionOverride.role_name;
    extraction.warnings = [];
    if (verbose) {
      await verbose.writeSection("extraction — MANUAL OVERRIDE (no LLM)", JSON.stringify(extraction, null, 2));
    }
  } else {
    try {
      extraction = await chatJson<ExtractionResult>("extraction", extractionPrompt, jdBlock, extractionLlm, verbose);
    } catch (e) {
      llmFallbackUsed = true;
      const reason = formatLlmFailureReason(e, extractionLlm.provider);
      console.warn("[enpply] extraction LLM failed, using placeholder metadata —", reason);
      extraction = placeholderExtraction(profile);
      extraction.warnings = [...extraction.warnings, `Extraction error: ${reason}`];
      if (verbose) {
        await verbose.writeSection("extraction — FALLBACK (placeholder)", JSON.stringify(extraction, null, 2));
      }
    }
  }
  // The merged extraction prompt no longer emits a `warnings` array, so the model
  // may omit it. Default to [] so the degradation-note appends below (and metadata)
  // never spread `undefined`. Code-level warnings (degraded paths) still accumulate.
  extraction.warnings = Array.isArray(extraction.warnings) ? extraction.warnings : [];
  // Normalize the JD-normalizer output: clean the two variations, validate the 2
  // selected industries against the shared pool, and derive key_requirements as the
  // de-duped UNION of both variations' summary_lines for legacy consumers (cover
  // letter, match score, fill-map, metadata.json).
  {
    extraction.role_summary = typeof extraction.role_summary === "string" ? extraction.role_summary.trim() : "";
    extraction.variations = (Array.isArray(extraction.variations) ? extraction.variations : [])
      .filter((v): v is JdVariation => Boolean(v && typeof v === "object"))
      .map((v) => ({
        label: String(v.label ?? "").trim(),
        angle: typeof v.angle === "string" ? v.angle.trim() : undefined,
        reframed_jd: String(v.reframed_jd ?? "").trim(),
        summary_lines: Array.isArray(v.summary_lines)
          ? v.summary_lines.map((s) => String(s).trim()).filter(Boolean)
          : [],
      }))
      .filter((v) => v.reframed_jd.length > 0);
    // Keep only industries that exactly match a shared-pool name (case-insensitive),
    // de-duped, capped at 2. Guarantees every selected industry resolves to a summary.
    {
      const byLower = new Map(industryNames.map((n) => [n.toLowerCase(), n]));
      const picked: string[] = [];
      for (const raw of Array.isArray(extraction.industries) ? extraction.industries : []) {
        const match = byLower.get(String(raw ?? "").trim().toLowerCase());
        if (match && !picked.includes(match)) picked.push(match);
        if (picked.length === 2) break;
      }
      extraction.industries = picked;
    }
    extraction.rare_nice_to_haves = Array.isArray(extraction.rare_nice_to_haves)
      ? extraction.rare_nice_to_haves.map((s) => String(s).trim()).filter(Boolean)
      : [];
    // Score every skill domain (missing → neutral 2), keyed to the profile's exact
    // category names, ordered most-relevant-first. Stable sort keeps profile order
    // within the same score.
    {
      const scoreByDomain = new Map<string, 1 | 2 | 3>();
      for (const d of Array.isArray(extraction.domain_scores) ? extraction.domain_scores : []) {
        const name = String(d?.domain ?? "").trim();
        if (!name) continue;
        const raw = Math.round(Number(d?.score));
        const score = (raw >= 1 && raw <= 3 ? raw : 2) as 1 | 2 | 3;
        const match = skillDomains.find((v) => v.toLowerCase() === name.toLowerCase());
        if (match && !scoreByDomain.has(match)) scoreByDomain.set(match, score);
      }
      extraction.domain_scores = skillDomains
        .map((domain) => ({ domain, score: scoreByDomain.get(domain) ?? (2 as const) }))
        .sort((a, b) => b.score - a.score);
    }
    // Skills: the role-tailored, ordered/trimmed skills list the extractor built from
    // profile_skills (JD keywords floated). Fall back to the raw profile skills if omitted.
    extraction.skills =
      Array.isArray(extraction.skills) && extraction.skills.length
        ? extraction.skills.map((s) => String(s).trim()).filter(Boolean)
        : profile.skills;
    const seenReq = new Set<string>();
    const unionReqs: string[] = [];
    for (const v of extraction.variations) {
      for (const line of v.summary_lines) {
        const key = line.toLowerCase();
        if (!seenReq.has(key)) {
          seenReq.add(key);
          unionReqs.push(line);
        }
      }
    }
    extraction.key_requirements = unionReqs.length
      ? unionReqs
      : Array.isArray(extraction.key_requirements)
        ? extraction.key_requirements.map((r) => String(r).trim()).filter(Boolean)
        : [];
    if (verbose) {
      await verbose.writeSection(
        "extraction — variations + industries + domain_scores",
        JSON.stringify(
          {
            role_summary: extraction.role_summary,
            variations: extraction.variations,
            industries: extraction.industries,
            rare_nice_to_haves: extraction.rare_nice_to_haves,
            domain_scores: extraction.domain_scores,
            skills: extraction.skills,
            key_requirements: extraction.key_requirements,
          },
          null,
          2
        )
      );
    }
  }
  if (!wantAnyAnswers) {
    extraction.questions = [];
    extraction.answers = [];
  }
  const extractedQuestions = Array.isArray(extraction.questions) ? extraction.questions.map((q) => String(q).trim()).filter(Boolean) : [];
  const extractedAnswerItems = Array.isArray(extraction.answers)
    ? extraction.answers
        .filter((a): a is { question: string; answer: string } => Boolean(a && typeof a === "object"))
        .map((a) => ({ question: String(a.question ?? "").trim(), answer: String(a.answer ?? "").trim() }))
        .filter((a) => a.question.length > 0)
    : [];

  let finalQuestions: string[] = [];
  if (!wantAnyAnswers) {
    finalQuestions = [];
  } else if (!wantExplicitAnswers && wantFitAnswer) {
    finalQuestions = [FIT_ANSWER_QUESTION];
  } else if (wantExplicitAnswers && wantFitAnswer) {
    finalQuestions = [...extractedQuestions];
    if (!finalQuestions.includes(FIT_ANSWER_QUESTION)) finalQuestions.push(FIT_ANSWER_QUESTION);
  } else {
    finalQuestions = extractedQuestions;
  }

  const answerByQuestion = new Map<string, string>();
  for (const a of extractedAnswerItems) {
    if (!answerByQuestion.has(a.question)) answerByQuestion.set(a.question, a.answer);
  }
  const finalAnswers = finalQuestions.map((q) => ({
    question: q,
    answer:
      answerByQuestion.get(q) ??
      (q === FIT_ANSWER_QUESTION
        ? "This role is my top choice because the product scope matches what I ship best: practical AI features tied to user impact. I am a good fit because I have delivered similar work end to end across backend, AI logic, and production operations."
        : ""),
  }));
  extraction.questions = finalQuestions;
  extraction.answers = finalAnswers;
  ensureNotCancelled();
  await emitStage("extracting_keywords", {
    company_name: extraction.company_name,
    role_name: extraction.role_name,
  });

  // Skip duplicate runs after extraction: same normalized company + role + resume_profile as another run.
  // Rerun mode (reuseFolder) always skips this check: the user is intentionally filling in
  // missing artifacts for an existing run.
  if (!ignoreDuplicateCheck && !params.reuseFolder) {
    const co = normalizeForDupCheck(extraction.company_name);
    const ro = normalizeForDupCheck(extraction.role_name);
    if (co && ro) {
      const currentKey = applicationDupKey(extraction.company_name, extraction.role_name, profile.id);
      const apps = await listApplications();
      // Scope the duplicate check to THIS run's owner. Applications are
      // owner-accessible only, so a cross-user "duplicate" (same shared profile,
      // different user) would dead-end the client — it can neither list nor load
      // that run. Only the same user's prior run counts as a duplicate (and the
      // extension can then recover by loading it); other users generate fresh.
      const ownerId = apps.find((a) => a.id === appId)?.user_id;
      const mine = apps.filter((a) => a.id !== appId && (!ownerId || a.user_id === ownerId));
      const dup = mine.find(
        (a) => applicationDupKey(a.company_name, a.role_name, a.resume_profile) === currentKey,
      );
      if (dup) {
        if (suffixOnDuplicate) {
          // Force regenerate: keep the old run, make this one distinct by
          // appending "-1" (then -2, …) to the role until the key is unique.
          const baseRole = extraction.role_name;
          const taken = (role: string) => {
            const key = applicationDupKey(extraction.company_name, role, profile.id);
            return mine.some((a) => applicationDupKey(a.company_name, a.role_name, a.resume_profile) === key);
          };
          let n = 1;
          while (taken(`${baseRole}-${n}`)) n += 1;
          extraction.role_name = `${baseRole}-${n}`;
          if (verbose) {
            await verbose.writeSection(
              "duplicate-check — SUFFIXED",
              `existing run: ${dup.id}\nrole renamed: ${baseRole} → ${extraction.role_name}`,
            );
          }
        } else {
          const reason = `Duplicate application for this profile (company+role+profile): ${extraction.company_name} — ${extraction.role_name} (${profile.id})`;
          if (verbose) {
            await verbose.writeSection("duplicate-check — SKIPPED", `${reason}\nexisting run: ${dup.id}`);
          }
          // Tag the error with the existing run's id so the HTTP layer records
          // duplicate_of and the Tryvify extension can recover from it.
          const err = new Error(reason) as Error & { duplicateOf?: string };
          err.duplicateOf = dup.id;
          throw err;
        }
      }
    }
  } else if (verbose) {
    await verbose.writeSection("duplicate-check — IGNORED", "ignore_duplicate_check=true");
  }

  const outputFolderAbs = params.reuseFolder
    ? params.reuseFolder.outputFolderAbs
    : path.join(
        outputRootAbs,
        makeOutputFolderName(
          params.folderProfileSegment ?? profile.id,
          extraction.company_name,
          extraction.role_name,
          recruiter_name
        )
      );
  const outputFolderRel = params.reuseFolder
    ? params.reuseFolder.outputFolderRel
    : path.relative(projectRoot(), outputFolderAbs).split(path.sep).join("/");
  if (verbose) {
    await verbose.writeSection("Resolved output folder", `relative=${outputFolderRel}\nabsolute=${outputFolderAbs}`);
  }

  const profilePdfBase = slugPart(profile.id).toLowerCase() || "profile";
  const resumePdfFilename = `${profilePdfBase}.pdf`;
  const coverLetterPdfFilename = `${profilePdfBase}_cover_letter.pdf`;
  /**
   * Per-profile name for a file that would otherwise be written under a fixed name.
   * Only batch (shared-folder) runs are renamed, so single runs keep the exact
   * filenames the client, the extension and every existing run already expect.
   */
  const owned = (name: string) => ownedArtifactName(profile.id, name, params.sharedFolder === true);
  const metadataJsonFilename = owned("metadata.json");
  const answersJsonFilename = owned("answers.json");
  const answersMdFilename = owned("answers.md");
  const llmInputJsonFilename = owned("llm_input.json");
  const resultJsonFilename = owned("result.json");

  const meta = {
    role_summary: extraction.role_summary,
    key_requirements: extraction.key_requirements,
    questions: extraction.questions,
    warnings: extraction.warnings,
  };

  await fs.mkdir(outputFolderAbs, { recursive: true });
  await fs.writeFile(path.join(outputFolderAbs, metadataJsonFilename), JSON.stringify(meta, null, 2), "utf8");
  await fs.writeFile(path.join(outputFolderAbs, "job_description.txt"), job_description, "utf8");
  if (verbose) {
    await verbose.writeSection("metadata.json — written", JSON.stringify(meta, null, 2));
    await verbose.writeSection("job_description.txt — written", job_description);
  }

  const artifact_status = params.reuseFolder
    ? { ...params.reuseFolder.priorArtifactStatus }
    : emptyArtifactStatus();
  const artifact_errors: Partial<Record<ArtifactKey, string>> = {};
  artifact_status.metadata_json = "completed";
  artifact_status.job_description_txt = "completed";

  let resumeMd = "";
  let tailoringDetail: TailoringDetail | undefined;
  let extractedAnswers = extraction.answers;
  /** The exact input sent to the generation model (for llm_input.json); null if generation didn't run. */
  let genLlmInput: LlmStepInput | null = null;

  /** Targeting metadata for the cover letter (company/role + derived summary/requirements). */
  const resumeTailoringMeta = {
    company_name: extraction.company_name,
    role_name: extraction.role_name,
    role_summary: extraction.role_summary,
    key_requirements: extraction.key_requirements,
  };

  /** Cover letter: full JD + link + apply form + profile + metadata (per cover letter prompt). */
  const coverLetterUserBlock = `${jobRefBlock(job_link, recruiter_name)}

Job description:
${job_description}

Apply form (optional):
${apply_form ?? "(none)"}

Candidate profile JSON:
${profileJson}

Job targeting metadata JSON:
${JSON.stringify(resumeTailoringMeta, null, 2)}`;

  if (wantResume) {
    ensureNotCancelled();
    await emitStage("generating_resume");
    try {
      const { doc, plan, llmInput } = await buildResumeDoc({
        profile,
        variations: extraction.variations,
        industries: extraction.industries,
        sharedProjects,
        skills: extraction.skills,
        resumePrompt: await withBatchVariation(prompts.resume, params.avoidFigures),
        resumeLlm: resolveStepModel("resume", tierSettings, llmTiers),
        verbose,
        onLlmFallback: () => {
          llmFallbackUsed = true;
        },
        warn: (m) => {
          extraction.warnings = [...extraction.warnings, m];
        },
      });
      genLlmInput = llmInput;
      // Capture how the résumé was divided, for the Result page: variation A drove
      // the real anchor company, variation B the consulting company (via its
      // shared.json industry engagements), older companies used stored bullets;
      // domain_scores drove the skills ordering/trim; rare_nice_to_haves were dropped.
      const bulletsByIndex = new Map(doc.experience_updates.map((u) => [u.index, u.bullets?.length ?? 0]));
      const anchorCompany = plan.find((p) => p.role === "anchor")?.company;
      const consultingCompany = plan.find((p) => p.role === "consulting")?.company;
      tailoringDetail = {
        variations: extraction.variations.map((v) => ({
          label: v.label,
          angle: v.angle,
          reframed_jd: v.reframed_jd,
          summary_lines: v.summary_lines,
          company: v.label.toUpperCase() === "B" ? consultingCompany : anchorCompany,
        })),
        industries: extraction.industries,
        domain_scores: extraction.domain_scores,
        rare_nice_to_haves: extraction.rare_nice_to_haves,
        companies: plan.map((p, i) => ({
          company: p.company,
          role: p.role,
          industries: p.industries,
          bullet_count: bulletsByIndex.get(i) ?? 0,
        })),
      };
      ensureNotCancelled();
      if (verbose) {
        await verbose.writeSection("resume-doc — assembled", JSON.stringify({ doc, plan }, null, 2));
      }
      resumeMd = renderResumeFromStructured(profile, extraction, doc, theme);
      // The model often ignores the "no em dash" rule. Strip em dashes (—) from the
      // final résumé: numeric ranges become hyphens, clause-joining em dashes become
      // commas. En dashes (–) are left alone — the renderer uses them for date ranges.
      resumeMd = resumeMd.replace(/(\d)\s*—\s*(\d)/g, "$1-$2").replace(/\s*—\s*/g, ", ");
      const resumeEngine = await writePdfFromTemplateOrFallback(
        "resume",
        resumeMd,
        theme,
        path.join(outputFolderAbs, resumePdfFilename),
        verbose,
        `${profile.basic.fullName.trim() || profile.id} — Resume`,
      );
      artifact_status.resume_pdf = "completed";
      // The file exists, so the artifact is "completed" — but if the themed render failed
      // the reader gets an unstyled document. Surface that instead of calling it a clean win.
      if (resumeEngine === "pdfkit-fallback") {
        artifact_errors.resume_pdf =
          `Theme "${theme}" was NOT applied: the HTML/Chromium renderer failed on every attempt, ` +
          `so this PDF is the plain unstyled fallback. Re-run to try again; if it keeps happening, ` +
          `check the server log for "THEME NOT APPLIED".`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      artifact_errors.resume_pdf = msg;
      if (verbose) {
        await verbose.writeSection("resume — PDF or pipeline ERROR", msg);
      }
    }
  } else if (params.reuseFolder) {
    console.log(
      `[enpply] resume: preserving prior state (rerun) status=${params.reuseFolder.priorArtifactStatus.resume_pdf}`
    );
    if (verbose) {
      await verbose.writeSection(
        "resume — PRESERVED (rerun)",
        `Rerun did not request gen_resume; prior status=${params.reuseFolder.priorArtifactStatus.resume_pdf} kept.`
      );
    }
  } else {
    artifact_status.resume_pdf = "skipped";
    console.log("[enpply] resume: skipped (user option)");
    if (verbose) {
      await verbose.writeSection("resume — SKIPPED", "User unchecked Generate résumé (gen_resume=false).");
    }
  }

  if (wantCoverLetter) {
    ensureNotCancelled();
    await emitStage("generating_cover_letter");
    // Cover letter uses the user's coverLetter-function tier (default light).
    const coverLetterLlm = resolveStepModel("coverLetter", tierSettings, llmTiers);
    try {
      let letterMd: string;
      try {
        letterMd = stripMarkdownFence(
          await chatText("cover-letter", prompts.coverLetter, coverLetterUserBlock, coverLetterLlm, verbose)
        );
      } catch (e) {
        llmFallbackUsed = true;
        const reason = formatLlmFailureReason(e, coverLetterLlm.provider);
        console.warn("[enpply] cover letter LLM failed, using placeholder —", reason);
        letterMd = placeholderCoverLetterMarkdown(profile);
        if (verbose) {
          await verbose.writeSection("cover-letter — FALLBACK (placeholder)", letterMd);
        }
      }
      ensureNotCancelled();
      // The model often ignores the "no em dash" rule; enforce plain punctuation.
      letterMd = normalizeDashes(letterMd);
      await writePdfFromTemplateOrFallback(
        "coverLetter",
        letterMd,
        theme,
        path.join(outputFolderAbs, coverLetterPdfFilename),
        verbose,
      );
      artifact_status.cover_letter_pdf = "completed";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      artifact_errors.cover_letter_pdf = msg;
      if (verbose) {
        await verbose.writeSection("cover letter — PDF or pipeline ERROR", msg);
      }
    }
  } else if (params.reuseFolder) {
    console.log(
      `[enpply] cover letter: preserving prior state (rerun) status=${params.reuseFolder.priorArtifactStatus.cover_letter_pdf}`
    );
    if (verbose) {
      await verbose.writeSection(
        "cover letter — PRESERVED (rerun)",
        `Rerun did not request gen_cover_letter; prior status=${params.reuseFolder.priorArtifactStatus.cover_letter_pdf} kept.`
      );
    }
  } else {
    artifact_status.cover_letter_pdf = "skipped";
    console.log("[enpply] cover letter: skipped (user option)");
    if (verbose) {
      await verbose.writeSection("cover letter — SKIPPED", "User unchecked Generate cover letter (gen_cover_letter=false).");
    }
  }

  if (wantAnyAnswers) {
    ensureNotCancelled();
    await emitStage("generating_answers");
    try {
      if (extraction.questions.length === 0) {
        console.log("[enpply] answers: no questions extracted from JD/apply form");
        extractedAnswers = [];
      } else if (extractedAnswers.length === 0) {
        extractedAnswers = extraction.questions.map((q) => ({ question: q, answer: "" }));
      }
      if (verbose) {
        await verbose.writeSection("answers — extracted payload before write", JSON.stringify(extractedAnswers, null, 2));
      }
      await fs.writeFile(
        path.join(outputFolderAbs, answersJsonFilename),
        JSON.stringify({ answers: extractedAnswers }, null, 2),
        "utf8",
      );
      const mdOut = extractedAnswers.length
        ? extractedAnswers.map((a) => `## ${a.question}\n\n${a.answer}\n`).join("\n")
        : "# Answers\n\n_No application/interview questions were found in the job description or apply form._\n";
      await fs.writeFile(path.join(outputFolderAbs, answersMdFilename), mdOut, "utf8");
      if (verbose) {
        await verbose.writeSection("answers.md — written", mdOut);
      }
      artifact_status.answers_json = "completed";
      artifact_status.answers_md = "completed";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      artifact_errors.answers_json = msg;
      artifact_errors.answers_md = msg;
      if (verbose) {
        await verbose.writeSection("answers — write pipeline ERROR", msg);
      }
    }
  } else if (params.reuseFolder) {
    extractedAnswers = params.reuseFolder.priorAnswers ?? [];
    console.log(
      `[enpply] answers: preserving prior state (rerun) json=${params.reuseFolder.priorArtifactStatus.answers_json} md=${params.reuseFolder.priorArtifactStatus.answers_md}`
    );
    if (verbose) {
      await verbose.writeSection(
        "answers — PRESERVED (rerun)",
        `Rerun did not request gen_answers/gen_fit_answer; prior answers (${extractedAnswers.length} items) kept.`
      );
    }
  } else {
    extractedAnswers = [];
    artifact_status.answers_json = "skipped";
    artifact_status.answers_md = "skipped";
    console.log("[enpply] answers: skipped (user option)");
    if (verbose) {
      await verbose.writeSection("answers — SKIPPED", "User unchecked Generate answers (gen_answers=false).");
    }
  }

  const artifacts: Record<ArtifactKey, string> = {
    resume_pdf: resumePdfFilename,
    cover_letter_pdf: coverLetterPdfFilename,
    answers_json: answersJsonFilename,
    answers_md: answersMdFilename,
    metadata_json: metadataJsonFilename,
    job_description_txt: "job_description.txt",
  };

  // In rerun mode we preserve prior status for unchecked items, so "wanted=false
  // requires skipped" is the wrong rule — the prior state could be "completed".
  // Accept completed OR skipped as success for every artifact regardless of this
  // run's intent; a freshly-failed regenerate still fails the run as usual.
  const isOkArtifact = (wanted: boolean, st: ArtifactStatus) =>
    params.reuseFolder ? st === "completed" || st === "skipped" : artifactLineOk(wanted, st);
  const status: GenerationStatus =
    artifact_status.metadata_json === "completed" &&
    artifact_status.job_description_txt === "completed" &&
    isOkArtifact(wantResume, artifact_status.resume_pdf) &&
    isOkArtifact(wantCoverLetter, artifact_status.cover_letter_pdf) &&
    isOkArtifact(wantAnyAnswers, artifact_status.answers_json) &&
    isOkArtifact(wantAnyAnswers, artifact_status.answers_md)
      ? "completed"
      : "failed";

  const failureSummary = summarizeGenerationFailure({
    status,
    llmFallbackUsed,
    artifact_errors: Object.keys(artifact_errors).length ? artifact_errors : undefined,
  });

  // Prefer prior company/role/created_at on a rerun so the existing log entry
  // and folder naming stay stable even if a re-extraction of the same JD now
  // produces a slightly different string.
  const resolvedCompanyName = params.reuseFolder?.priorCompanyName?.trim()
    ? params.reuseFolder.priorCompanyName.trim()
    : extraction.company_name;
  const resolvedRoleName = params.reuseFolder?.priorRoleName?.trim()
    ? params.reuseFolder.priorRoleName.trim()
    : extraction.role_name;
  const resolvedCreatedAt = params.reuseFolder?.priorCreatedAt ?? nowJstIso();
  const quickReference =
    params.reuseFolder?.priorQuickReference ?? { what_to_remember: [], top_talking_points: [] };

  const result: ResultJson = {
    id: appId,
    ...(params.run_uuid ? { run_uuid: params.run_uuid } : {}),
    created_at: resolvedCreatedAt,
    company_name: resolvedCompanyName,
    role_name: resolvedRoleName,
    job_link,
    recruiter_name,
    resume_profile: profile.id,
    theme,
    job_description,
    ...(resumeMd.trim() ? { resume_markdown: resumeMd } : {}),
    // Persist the application-form text (extension page text / dashboard "Apply
    // form" field). Preserve the prior value on a rerun that doesn't pass one.
    ...(() => {
      const af = (apply_form ?? "").trim() || (params.reuseFolder?.priorApplyForm ?? "").trim();
      return af ? { apply_form: af } : {};
    })(),
    output_folder: outputFolderRel,
    metadata: meta,
    generation_options,
    llm_config: {
      light: params.llmLight,
      heavy: params.llmHeavy,
      tiers: effectiveTiers(llmTiers),
    },
    artifacts,
    artifact_status,
    ...(Object.keys(artifact_errors).length ? { artifact_errors } : {}),
    answers: extractedAnswers,
    quick_reference: quickReference,
    status,
    ...(failureSummary ? { error: failureSummary } : {}),
    ...(llmFallbackUsed ? { llm_fallback_used: true } : {}),
    ...(tailoringDetail ? { tailoring: tailoringDetail } : {}),
  };

  // Persist EXACTLY what was sent to each LLM step (extraction + generation) so every
  // run is inspectable even when ENPPLY_VERBOSE is off. Each is { model, system_prompt, user }.
  try {
    const llmInputPayload = {
      extraction: params.extractionOverride
        ? null
        : { model: extractionLlm, system_prompt: extractionPrompt, user: jdBlock },
      generation: genLlmInput,
    };
    await fs.writeFile(path.join(outputFolderAbs, llmInputJsonFilename), JSON.stringify(llmInputPayload, null, 2), "utf8");
  } catch (e) {
    console.warn("[enpply] could not write llm_input.json:", e instanceof Error ? e.message : String(e));
  }

  await fs.writeFile(path.join(outputFolderAbs, resultJsonFilename), JSON.stringify(result, null, 2), "utf8");
  if (verbose) {
    await verbose.writeSection("runGeneration — result.json (full)", JSON.stringify(result, null, 2));
    await verbose.writeSection(
      "runGeneration — done",
      `status=${status}\noutput_folder_rel=${outputFolderRel}\noutput_folder_abs=${outputFolderAbs}\nllm_fallback_used=${llmFallbackUsed}`
    );
  }
  console.log(
    `[enpply] generate done appId=${appId} status=${status} folder=${outputFolderAbs} fallback=${llmFallbackUsed ? "yes" : "no"}`
  );
  return result;
}

export function newAppId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
  return `app_${stamp}_${randomUUID().slice(0, 8)}`;
}
