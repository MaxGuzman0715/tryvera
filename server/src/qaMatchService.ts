import type {
  Profile,
  ResultJson,
  KeywordMatch,
  KeywordImportance,
  KeywordMatchStatus,
  CredibilityReport,
  ForceTailoringReport,
} from "./types.js";
import {
  getLlmClientForConfig,
  getLlmModelForConfig,
  type LlmRuntimeConfig,
} from "./llmClient.js";
import {
  compactLlmErrorForLog,
  isTransientLlmError,
  llmErrorStatus,
  logLlmApiErrorDetails,
  parseJsonLoose,
} from "./llmLog.js";
import { readAllPrompts } from "./promptStore.js";
import { policyPromptBlock } from "./answerPolicies.js";

/**
 * GPT-5 and OpenAI reasoning models (o1/o3/o4) reject any `temperature` other
 * than the default 1. Omit the field for those so the API uses its built-in
 * default. Mirrors the behavior in generation.ts.
 */
function temperatureParam(model: string, wanted: number): { temperature?: number } {
  const m = model.toLowerCase();
  if (m.startsWith("gpt-5") || /^o[1-9](-|$)/.test(m) || m.startsWith("openai/gpt-5") || /^openai\/o[1-9](-|$)/.test(m)) {
    return {};
  }
  return { temperature: wanted };
}

async function chatJson<T>(step: string, system: string, user: string, llm: LlmRuntimeConfig): Promise<T> {
  const client = getLlmClientForConfig(llm);
  const model = getLlmModelForConfig(llm);
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  const t0 = performance.now();
  console.log(`[enpply] LLM ▶ ${step} [json] provider=${llm.provider} model=${model} systemChars=${system.length} userChars=${user.length}`);
  const MAX_RETRIES = 2;
  // Start WITHOUT response_format: that constraint narrows OpenRouter to the
  // structured-output provider subset, which is the rate-limited one. Parse
  // defensively and escalate to json_object only on an unparseable reply; retry
  // transient 429/5xx with backoff.
  let useJsonMode = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const base = { model, messages, ...temperatureParam(model, 0.2) };
      const res = await client.chat.completions.create(
        useJsonMode ? { ...base, response_format: { type: "json_object" } } : base,
      );
      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("Empty model response");
      console.log(`[enpply] LLM ✓ ${step} [json] ${Math.round(performance.now() - t0)}ms replyChars=${text.length} jsonMode=${useJsonMode}`);
      try {
        return parseJsonLoose<T>(text);
      } catch (parseErr) {
        if (!useJsonMode && attempt < MAX_RETRIES) {
          console.warn(`[enpply] LLM ${step} [json] reply not JSON — retrying with response_format`);
          useJsonMode = true;
          continue;
        }
        throw parseErr;
      }
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
  console.warn(`[enpply] LLM ✗ ${step} [json] failed after ${Math.round(performance.now() - t0)}ms — ${compactLlmErrorForLog(lastErr)}`);
  logLlmApiErrorDetails(step, "json", lastErr);
  throw lastErr;
}

function buildContextBlock(profile: Profile, result: ResultJson, policies: string[] = []): string {
  const jd = typeof result.job_description === "string" ? result.job_description : "";
  const applyForm = typeof result.apply_form === "string" ? result.apply_form : "";
  const role = result.role_name || "(unknown role)";
  const company = result.company_name || "(unknown company)";
  const policyBlock = policyPromptBlock(policies);
  return [
    `Company: ${company}`,
    `Role: ${role}`,
    `Role summary: ${result.metadata?.role_summary ?? ""}`,
    `Key requirements:\n${(result.metadata?.key_requirements ?? []).map((k) => `- ${k}`).join("\n")}`,
    `\nJob description (full raw posting — authoritative source for requirements/keywords):\n${jd || "(none on file)"}`,
    `\nApplication form / page text:\n${applyForm || "(none on file)"}`,
    ...(policyBlock ? [policyBlock] : []),
    `\nCandidate profile JSON:\n${JSON.stringify(profile, null, 2)}`,
  ].join("\n");
}

export type FollowupAnswer = { question: string; answer: string };

/**
 * Extract any number of questions from the user's input and answer each one
 * separately. Matches the "answer questions" extraction shape used in
 * generation.ts, so a multi-question paste produces the same result as asking
 * each question on its own.
 */
export async function answerFollowupQuestions(params: {
  profile: Profile;
  result: ResultJson;
  /** Raw input from the user — may contain one or several questions. */
  input: string;
  llm: LlmRuntimeConfig;
  /** The profile's enabled answering policies, injected as authoritative rules. */
  policies?: string[];
}): Promise<FollowupAnswer[]> {
  const prompts = await readAllPrompts();
  const user = `${buildContextBlock(params.profile, params.result, params.policies ?? [])}\n\nUser input (may contain one or more questions):\n${params.input}`;
  const raw = await chatJson<Record<string, unknown>>("qa-followup", prompts.qa, user, params.llm);
  const list = Array.isArray(raw.items) ? raw.items : [];
  const out: FollowupAnswer[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const o = it as { question?: unknown; answer?: unknown };
    const q = String(o.question ?? "").trim();
    const a = String(o.answer ?? "").trim();
    if (!q) continue;
    out.push({ question: q, answer: a });
  }
  return out;
}

export type MatchScoreBreakdown = {
  experience_level: number;
  relevant_experience: number;
  core_skills: number;
  industry_experience: number;
};

export type MatchScoreResult = {
  overall: number;
  breakdown: MatchScoreBreakdown;
  keyword_matches: KeywordMatch[];
  credibility: CredibilityReport;
  force_tailoring: ForceTailoringReport;
  strengths: string[];
  gaps: string[];
  summary: string;
};

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean);
}

function importanceOf(v: unknown): KeywordImportance {
  const s = String(v ?? "").toLowerCase();
  if (s.startsWith("req") || s.includes("must")) return "required";
  if (s.startsWith("pref") || s.includes("plus")) return "preferred";
  return "nice_to_have";
}

function matchStatusOf(v: unknown): KeywordMatchStatus {
  const s = String(v ?? "").toLowerCase().trim();
  if (s.startsWith("part")) return "partial";
  if (s === "yes" || s === "true" || s.startsWith("y")) return "yes";
  return "no";
}

/** Parse the model's keyword match table defensively (shape varies by model). */
function parseKeywordMatches(v: unknown): KeywordMatch[] {
  if (!Array.isArray(v)) return [];
  const out: KeywordMatch[] = [];
  for (const it of v) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const keyword = String(o.keyword ?? "").trim();
    if (!keyword) continue;
    const status = matchStatusOf(o.status);
    out.push({
      keyword: keyword.slice(0, 200),
      importance: importanceOf(o.importance),
      status,
      // Evidence only matters when something matched; drop noise on "no".
      evidence: status === "no" ? "" : String(o.evidence ?? "").trim().slice(0, 400),
    });
  }
  return out;
}

function parseCredibility(v: unknown): CredibilityReport {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    score: clampScore(o.score),
    assessment: String(o.assessment ?? "").trim(),
    red_flags: asStringArray(o.red_flags),
  };
}

function parseForceTailoring(v: unknown): ForceTailoringReport {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    score: clampScore(o.score),
    assessment: String(o.assessment ?? "").trim(),
    signals: asStringArray(o.signals),
  };
}

export async function computeMatchScore(params: {
  profile: Profile;
  result: ResultJson;
  llm: LlmRuntimeConfig;
}): Promise<MatchScoreResult> {
  const prompts = await readAllPrompts();
  // Score the FINAL generated résumé against the raw JD — nothing else. (Fall back to
  // the profile JSON only for legacy runs generated before the résumé was persisted.)
  const jd = typeof params.result.job_description === "string" ? params.result.job_description.trim() : "";
  const resume = typeof params.result.resume_markdown === "string" ? params.result.resume_markdown.trim() : "";
  const candidate = resume
    ? `Candidate's final generated résumé (Markdown):\n${resume}`
    : `Candidate profile JSON (no generated résumé on file):\n${JSON.stringify(params.profile, null, 2)}`;
  const user = `Job description (full raw posting — authoritative source for requirements/keywords):\n${jd || "(none on file)"}\n\n${candidate}`;
  const raw = await chatJson<Record<string, unknown>>("match-score", prompts.matchScore, user, params.llm);
  const breakdown = (raw.breakdown ?? {}) as Record<string, unknown>;
  return {
    overall: clampScore(raw.overall),
    breakdown: {
      experience_level: clampScore(breakdown.experience_level),
      relevant_experience: clampScore(breakdown.relevant_experience),
      core_skills: clampScore(breakdown.core_skills),
      industry_experience: clampScore(breakdown.industry_experience),
    },
    keyword_matches: parseKeywordMatches(raw.keyword_matches),
    credibility: parseCredibility(raw.credibility),
    force_tailoring: parseForceTailoring(raw.force_tailoring),
    strengths: asStringArray(raw.strengths),
    gaps: asStringArray(raw.gaps),
    summary: String(raw.summary ?? "").trim(),
  };
}
