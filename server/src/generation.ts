import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AnswerItem,
  ArtifactKey,
  ArtifactStatus,
  ExtractionResult,
  GenerationOptions,
  GenerationStatus,
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
import {
  loadBulletStore,
  selectStacks,
  generateResumeContent,
  normalizeKExtraction,
  cleanProfileBullets,
  type ResumeContent,
} from "./bulletsTailoring.js";

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

/** Flatten K2 (which may contain OR-group arrays) into a plain string list. */
function flattenK2(k2: ExtractionResult["K2"]): string[] {
  const out: string[] = [];
  for (const item of k2 ?? []) {
    if (Array.isArray(item)) out.push(item.filter(Boolean).join(" / "));
    else if (item) out.push(String(item));
  }
  return out;
}

/**
 * The merged extraction prompt no longer emits `role_summary`/`key_requirements`.
 * Derive both from the K-structure so legacy consumers (cover letter, match
 * score, fill-map, Result page) keep working. `role_summary` is a one-line
 * targeting blurb; `key_requirements` is a flattened gate-skill list.
 */
function deriveTargeting(extraction: ExtractionResult): { role_summary: string; key_requirements: string[] } {
  const k = normalizeKExtraction(extraction);
  const hardStacks = Object.values(k.K1.hard).flat();
  const domains = Object.entries(k.domain_breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([d, w]) => `${d} ${w}%`)
    .join(", ");
  const summaryParts: string[] = [];
  if (k.primary_domain) summaryParts.push(`Primary domain: ${k.primary_domain}.`);
  if (domains) summaryParts.push(`Domain weights: ${domains}.`);
  if (hardStacks.length) summaryParts.push(`Gate stacks: ${hardStacks.join(", ")}.`);
  if (k.clearance_required) summaryParts.push(`Clearance: ${k.clearance_level}.`);
  const key_requirements = [...hardStacks, ...k.K1.soft, ...flattenK2(k.K2)];
  return { role_summary: summaryParts.join(" "), key_requirements };
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

function renderResumeFromStructured(profile: Profile, extraction: ExtractionResult, doc: StructuredDocUpdates): string {
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
  return `# ${profile.basic.fullName}
${resumeNameBlockLines(profile)}

## Summary
${doc.summary?.trim() || profile.basic.summary || ""}

## Experience
${expBlocks.join("\n\n")}

## Skills
${skills.length ? skills.join(", ") : profile.skills.join(", ")}

## Education
${eduBlocks.join("\n")}`;
}

/**
 * Bullets-based résumé assembly (replaces the freeform résumé step).
 *
 * Deterministic stack→company selection over the profile's pre-built bullet
 * store, then one "resume generation" LLM pass (weave K2 + summary + skills).
 * Degrades to the original profile bullets (untailored) when there is no store
 * or no stacks land, and falls back to the selected bullets if the LLM fails —
 * the run never hard-fails on tailoring. Returns the StructuredDocUpdates that
 * `renderResumeFromStructured` already consumes, so older companies (index ≥ 2)
 * stay as-is automatically.
 */
async function buildBulletsResumeDoc(params: {
  profile: Profile;
  extraction: ExtractionResult;
  resumePrompt: string;
  resumeLlm: LlmRuntimeConfig;
  verbose: VerboseRunLogger | null;
  onLlmFallback: () => void;
}): Promise<{ doc: StructuredDocUpdates; detail: TailoringDetail }> {
  const { profile, extraction, verbose } = params;
  const untailored = (): { doc: StructuredDocUpdates; detail: TailoringDetail } => ({
    doc: { summary: profile.basic.summary ?? "", skills: profile.skills, experience_updates: [] },
    detail: {
      mode: "untailored",
      summary: profile.basic.summary ?? "",
      skills: profile.skills,
      gaps: [],
      companies: [],
    },
  });

  const store = await loadBulletStore(profile.id);
  if (!store) {
    extraction.warnings = [
      ...extraction.warnings,
      `No bullet store for profile "${profile.id}" — résumé uses original profile bullets (untailored).`,
    ];
    if (verbose) await verbose.writeSection("resume — NO BULLET STORE (degraded)", `profile=${profile.id}`);
    return untailored();
  }

  const kext = normalizeKExtraction(extraction);
  const selection = selectStacks(profile, kext, store);
  if (verbose) await verbose.writeSection("resume — stack selection", JSON.stringify(selection, null, 2));

  // Fully untailored only when nothing applies: no K1 stacks AND no shared groups.
  if (selection.companies.length === 0 && selection.shared.length === 0) {
    extraction.warnings = [
      ...extraction.warnings,
      "No K1 stacks matched the bullet store — résumé uses original profile bullets (untailored).",
    ];
    const u = untailored();
    u.detail.gaps = selection.gaps;
    return u;
  }
  if (selection.companies.length === 0) {
    extraction.warnings = [
      ...extraction.warnings,
      "No K1 stacks matched the bullet store — experience kept as original bullets; shared collaboration/mentorship lines still appended.",
    ];
  }

  // Resume-generation LLM writes the summary + skills (and weaves K2 into any stack
  // companies). Run it whenever anything matched — including the shared-only path
  // (companies === []) — so the summary/skills are never left blank just because no
  // K1 stack landed. With no stack companies it still produces a high-level summary
  // from the candidate profile + role_summary; the (ignored) experience_updates don't
  // matter since only summary/skills/companies are read back. The earlier guard
  // already returned for the both-empty case, so reaching here means there's work.
  let content: ResumeContent = { summary: "", skills: [], companies: [] };
  if (selection.companies.length > 0 || selection.shared.length > 0) {
    try {
      const gen = await generateResumeContent({
        promptTemplate: params.resumePrompt,
        llm: params.resumeLlm,
        profile,
        kext,
        companyName: extraction.company_name,
        roleName: extraction.role_name,
        roleSummary: extraction.role_summary,
        companies: selection.companies,
      });
      content = gen.content;
      if (verbose) {
        await verbose.writeSection("resume-generation — parsed", JSON.stringify(gen.content, null, 2));
        await verbose.writeSection("resume-generation — usage", JSON.stringify({ usage: gen.usage, elapsed_ms: gen.elapsed_ms }, null, 2));
      }
    } catch (genErr) {
      params.onLlmFallback();
      const reason = formatLlmFailureReason(genErr, params.resumeLlm.provider);
      console.warn("[enpply] resume generation LLM failed, using selected bullets —", reason);
      extraction.warnings = [...extraction.warnings, `Resume generation error: ${reason}`];
      if (verbose) await verbose.writeSection("resume-generation — FALLBACK (selected bullets)", reason);
      content = {
        summary: profile.basic.summary ?? "",
        skills: profile.skills,
        companies: selection.companies.map((c) => ({ company: c.company, bullets: c.bullets, placed: [], skipped: [] })),
      };
    }
  }

  const wovenByCompany = new Map(content.companies.map((c) => [c.company, c.bullets]));
  const k2ByCompany = new Map(content.companies.map((c) => [c.company, { placed: c.placed, skipped: c.skipped }]));
  const sharedByCompany = new Map(selection.shared.map((s) => [s.company, s]));
  const summary = content.summary || (profile.basic.summary ?? "");
  const skills = content.skills.length ? content.skills : profile.skills;

  // Append shared (collaboration + mentorship) lines to every last-2 company,
  // regardless of stacks: stack companies get woven bullets + shared; companies
  // with no stack match keep their original bullets + shared.
  const tailoredIdx = new Set(selection.companies.map((c) => c.profileIndex));
  const sharedRow = (lines: number) => ({
    stack: "shared",
    resolved_key: "shared",
    domain: "Shared",
    tier: 2 as const,
    weight: 0,
    lines,
  });

  const experience_updates = selection.companies.map((c) => {
    const woven = wovenByCompany.get(c.company) ?? c.bullets;
    const sharedLines = sharedByCompany.get(c.company)?.lines ?? [];
    return { index: c.profileIndex, bullets: [...woven, ...sharedLines] };
  });
  for (const s of selection.shared) {
    if (tailoredIdx.has(s.profileIndex)) continue;
    const original = cleanProfileBullets(profile.experience[s.profileIndex]);
    experience_updates.push({ index: s.profileIndex, bullets: [...original, ...s.lines] });
  }

  const detailCompanies: TailoringDetail["companies"] = selection.companies.map((c) => ({
    company: c.company,
    project: c.project,
    stacks: [
      ...c.stacks.map((s) => ({
        stack: s.stack,
        resolved_key: s.resolvedKey,
        domain: s.domain,
        tier: s.tier,
        weight: s.weight,
        lines: s.bullets.length,
      })),
      ...(sharedByCompany.has(c.company) ? [sharedRow(sharedByCompany.get(c.company)!.lines.length)] : []),
    ],
    k2_placed: k2ByCompany.get(c.company)?.placed ?? [],
    k2_skipped: k2ByCompany.get(c.company)?.skipped ?? [],
  }));
  for (const s of selection.shared) {
    if (tailoredIdx.has(s.profileIndex)) continue;
    detailCompanies.push({
      company: s.company,
      project: s.project,
      stacks: [sharedRow(s.lines.length)],
      k2_placed: [],
      k2_skipped: [],
    });
  }

  const detail: TailoringDetail = {
    mode: selection.companies.length > 0 || selection.shared.length > 0 ? "bullets" : "untailored",
    summary,
    skills,
    gaps: selection.gaps,
    companies: detailCompanies,
  };
  return { doc: { summary, skills, experience_updates }, detail };
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

async function writePdfFromTemplateOrFallback(
  kind: "resume" | "coverLetter",
  markdown: string,
  theme: string,
  outPath: string,
  verbose: VerboseRunLogger | null,
  docTitle?: string
): Promise<void> {
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
    return;
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
    return;
  }

  console.log(`[enpply] Building ${kind} PDF (HTML template + Chromium, ENPPLY_PDF_ENGINE=chromium)…`);
  try {
    const buf = await renderTemplatedPdf(kind, markdown, theme, docTitle);
    await fs.writeFile(outPath, buf);
    console.log(`[enpply] Wrote ${kind} PDF (Chromium) →`, outPath);
    if (verbose) {
      const st = await fs.stat(outPath);
      await verbose.writeSection(`PDF ${kind} — wrote (Chromium HTML template)`, `bytes=${st.size}\npath=${outPath}`);
    }
  } catch (err) {
    console.warn(`[enpply] ${kind} HTML template PDF failed; using PDFKit fallback.`, err);
    if (verbose) {
      await verbose.writeSection(
        `PDF ${kind} — Chromium failed (PDFKit fallback)`,
        err instanceof Error ? err.stack ?? err.message : String(err)
      );
    }
    const buf = await markdownToPdfBuffer(markdown);
    await fs.writeFile(outPath, buf);
    console.log(`[enpply] Wrote ${kind} PDF (PDFKit fallback) →`, outPath);
    if (verbose) {
      const st = await fs.stat(outPath);
      await verbose.writeSection(`PDF ${kind} — wrote (PDFKit fallback)`, `bytes=${st.size}\npath=${outPath}`);
    }
  }
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
  /** This user's function→tier choices; unset functions use the default tier. */
  llmTiers?: Partial<Record<LlmFunc, LlmTier>>;
  /**
   * Which extraction step runs. Defaults to `extraction` (résumé/heavy function)
   * when a résumé is generated, else `extractionLite` (answers/light function).
   * The Q&A-only "create a slot" path passes `extractionLite` explicitly.
   */
  extractionStepKey?: "extraction" | "extractionLite";
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
  const tierSettings = { llm_light: params.llmLight, llm_heavy: params.llmHeavy };
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
  /** Full JD + link + apply form — used only for the extraction step. */
  const jdBlock = wantAnyAnswers
    ? `${jobRefBlock(job_link, recruiter_name)}\n\nJob description:\n${job_description}\n\nApply form (optional):\n${apply_form ?? "(none)"}\n\nCandidate profile JSON:\n${profileJson}`
    : `${jobRefBlock(job_link, recruiter_name)}\n\nJob description:\n${job_description}\n\nApply form (optional):\n${apply_form ?? "(none)"}`;

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
  // The extraction prompt now emits role_summary/key_requirements directly. Prefer
  // the model's values; fall back to deriving them from the K-structure only when the
  // model omitted them, so cover letter, match score, fill-map, the Result page, and
  // the résumé summary always have something to work with.
  {
    const t = deriveTargeting(extraction);
    const extractedSummary = typeof extraction.role_summary === "string" ? extraction.role_summary.trim() : "";
    const extractedReqs = Array.isArray(extraction.key_requirements)
      ? extraction.key_requirements.map((r) => String(r).trim()).filter(Boolean)
      : [];
    extraction.role_summary = extractedSummary || t.role_summary;
    extraction.key_requirements = extractedReqs.length ? extractedReqs : t.key_requirements;
    if (verbose) {
      await verbose.writeSection(
        "extraction — targeting (extracted preferred, derived fallback)",
        JSON.stringify(
          {
            extracted: { role_summary: extractedSummary, key_requirements: extractedReqs },
            derived: t,
            final: { role_summary: extraction.role_summary, key_requirements: extraction.key_requirements },
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
        makeOutputFolderName(profile.id, extraction.company_name, extraction.role_name, recruiter_name)
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

  const meta = {
    role_summary: extraction.role_summary,
    key_requirements: extraction.key_requirements,
    questions: extraction.questions,
    warnings: extraction.warnings,
  };

  await fs.mkdir(outputFolderAbs, { recursive: true });
  await fs.writeFile(path.join(outputFolderAbs, "metadata.json"), JSON.stringify(meta, null, 2), "utf8");
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
      const built = await buildBulletsResumeDoc({
        profile,
        extraction,
        resumePrompt: prompts.resume,
        resumeLlm: resolveStepModel("resume", tierSettings, llmTiers),
        verbose,
        onLlmFallback: () => {
          llmFallbackUsed = true;
        },
      });
      const doc = built.doc;
      tailoringDetail = built.detail;
      ensureNotCancelled();
      if (verbose) {
        await verbose.writeSection("resume-doc — assembled", JSON.stringify(doc, null, 2));
      }
      resumeMd = renderResumeFromStructured(profile, extraction, doc);
      await writePdfFromTemplateOrFallback(
        "resume",
        resumeMd,
        theme,
        path.join(outputFolderAbs, resumePdfFilename),
        verbose,
        `${profile.basic.fullName.trim() || profile.id} — Resume`,
      );
      artifact_status.resume_pdf = "completed";
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
        path.join(outputFolderAbs, "answers.json"),
        JSON.stringify({ answers: extractedAnswers }, null, 2),
        "utf8",
      );
      const mdOut = extractedAnswers.length
        ? extractedAnswers.map((a) => `## ${a.question}\n\n${a.answer}\n`).join("\n")
        : "# Answers\n\n_No application/interview questions were found in the job description or apply form._\n";
      await fs.writeFile(path.join(outputFolderAbs, "answers.md"), mdOut, "utf8");
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
    answers_json: "answers.json",
    answers_md: "answers.md",
    metadata_json: "metadata.json",
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
    extraction_detail: normalizeKExtraction(extraction),
    ...(tailoringDetail ? { tailoring: tailoringDetail } : {}),
  };

  await fs.writeFile(path.join(outputFolderAbs, "result.json"), JSON.stringify(result, null, 2), "utf8");
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
