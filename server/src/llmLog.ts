import { readSettings } from "./appSettings.js";
import type { LlmProvider } from "./types.js";

/** Shown in the API response and UI when placeholders were used. */
export const USER_MESSAGE_LLM_FALLBACK =
  "We hit an API key or model error, so your résumé, cover letter, and answers were filled with placeholders (from your profile where possible) instead of AI-tailored text. Set a valid API key in `.env` for the provider you chose in Config (OpenRouter, OpenAI, DeepSeek, or Gemini) and generate again.";

function providerLabel(provider: LlmProvider): { name: string; keyHint: string } {
  switch (provider) {
    case "openrouter":
      return {
        name: "OpenRouter",
        keyHint: "OPENROUTER_API_KEY in .env (https://openrouter.ai/keys)",
      };
    case "openai":
      return {
        name: "OpenAI",
        keyHint: "OPENAI_API_KEY in .env (https://platform.openai.com/account/api-keys)",
      };
    case "deepseek":
      return {
        name: "DeepSeek",
        keyHint: "DEEPSEEK_API_KEY in .env (https://platform.deepseek.com/api_keys)",
      };
    case "gemini":
      return {
        name: "Gemini",
        keyHint: "GEMINI_API_KEY in .env (https://aistudio.google.com/apikey)",
      };
  }
}

/** Shorter log line + stored warning when the LLM API returns 401 or common errors. */
export function formatLlmFailureReason(err: unknown, provider: LlmProvider): string {
  const msg = err instanceof Error ? err.message : String(err);
  const { name, keyHint } = providerLabel(provider);
  if (/401|Incorrect API key|invalid_api_key|User not found/i.test(msg)) {
    return `${name} rejected the API key (401). Set a valid ${keyHint}.`;
  }
  if (/429|rate_limit/i.test(msg)) {
    return `${name} rate limit — try again shortly.`;
  }
  if (/insufficient_quota|billing/i.test(msg)) {
    return `${name} billing/quota issue — check your account.`;
  }
  if (/insufficient balance|402|payment required|no permission/i.test(msg)) {
    return `${name} rejected the request (balance, billing, or permissions). Check your account and API key scope.`;
  }
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}

function warnForProvider(p: string): void {
  if (p === "openrouter") {
    const k = process.env.OPENROUTER_API_KEY?.trim();
    if (!k) {
      console.warn("[enpply] OPENROUTER_API_KEY is unset — LLM calls will fail until you add a key.");
      return;
    }
    if (k.includes("your-key") || k.length < 16) {
      console.warn(
        "[enpply] OPENROUTER_API_KEY still looks like a placeholder — replace it with a real key from https://openrouter.ai/keys"
      );
    }
    return;
  }
  if (p === "openai") {
    const k = process.env.OPENAI_API_KEY?.trim();
    if (!k) {
      console.warn("[enpply] OPENAI_API_KEY is unset — LLM calls will fail until you add a key.");
      return;
    }
    if (k.startsWith("sk-your") || k.includes("1234567890")) {
      console.warn(
        "[enpply] OPENAI_API_KEY still looks like a template placeholder — replace it with a real secret from https://platform.openai.com/account/api-keys"
      );
    }
    return;
  }
  if (p === "deepseek") {
    const k = process.env.DEEPSEEK_API_KEY?.trim();
    if (!k) {
      console.warn("[enpply] DEEPSEEK_API_KEY is unset — LLM calls will fail until you add a key.");
      return;
    }
    if (k.length < 16) {
      console.warn("[enpply] DEEPSEEK_API_KEY looks too short — check https://platform.deepseek.com/api_keys");
    }
    return;
  }
  if (p === "gemini") {
    const k = process.env.GEMINI_API_KEY?.trim();
    if (!k) {
      console.warn("[enpply] GEMINI_API_KEY is unset — LLM calls will fail until you add a key.");
      return;
    }
    if (k.includes("your-key") || k.length < 20) {
      console.warn(
        "[enpply] GEMINI_API_KEY still looks like a placeholder — replace it with a real key from https://aistudio.google.com/apikey"
      );
    }
  }
}

/** One-time hint when .env still has a template value or no API key for either configured tier. */
export async function warnIfLlmKeyLooksInvalid(): Promise<void> {
  let s;
  try {
    s = await readSettings();
  } catch {
    return;
  }
  for (const p of new Set([s.llm_light.provider, s.llm_heavy.provider])) warnForProvider(p);
}

/** @deprecated Use warnIfLlmKeyLooksInvalid */
export const warnIfOpenAiKeyLooksInvalid = warnIfLlmKeyLooksInvalid;

/** One line for console (avoids dumping huge API error objects with headers). */
export function compactLlmErrorForLog(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as Error).message === "string") {
    const e = err as Error & { status?: number; code?: string; type?: string; param?: string };
    const bits = [e.message];
    if (e.status != null) bits.push(`status=${e.status}`);
    if (e.code != null) bits.push(`code=${String(e.code)}`);
    if (e.type != null) bits.push(`type=${e.type}`);
    if (e.param != null) bits.push(`param=${e.param}`);
    return bits.join(" | ");
  }
  return String(err);
}

/** Structured fields from OpenAI SDK `APIError` (and similar) for server logs — no secrets. */
export function extractLlmErrorDetail(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (err == null) {
    out.note = "null/undefined error";
    return out;
  }
  if (typeof err !== "object") {
    out.raw = String(err);
    return out;
  }
  const e = err as Record<string, unknown> & {
    status?: number;
    code?: string;
    type?: string;
    param?: string;
    request_id?: string;
    error?: unknown;
    message?: string;
    cause?: unknown;
    headers?: unknown;
  };
  if (e.name != null) out.name = e.name;
  if (e.message != null) out.message = e.message;
  if (e.status != null) out.status = e.status;
  if (e.code != null) out.code = e.code;
  if (e.type != null) out.type = e.type;
  if (e.param != null) out.param = e.param;
  if (e.request_id != null) out.request_id = e.request_id;
  if (e.error !== undefined) out.error = e.error;
  if (e.cause !== undefined) {
    out.cause =
      e.cause instanceof Error
        ? { message: e.cause.message, name: e.cause.name }
        : String(e.cause);
  }
  return out;
}

/** Full diagnostic block after a failed chat completion (use server terminal output to debug). */
export function logLlmApiErrorDetails(step: string, mode: "json" | "text", err: unknown): void {
  const summary = compactLlmErrorForLog(err);
  console.error(`[enpply] LLM ERROR ▼ ${step} [${mode}] ${summary}`);
  console.error(`[enpply] LLM ERROR ▼ ${step} [${mode}] detail JSON:\n${JSON.stringify(extractLlmErrorDetail(err), null, 2)}`);
  if (err instanceof Error && err.stack) {
    console.error(`[enpply] LLM ERROR ▼ ${step} [${mode}] stack:\n${err.stack}`);
  }
}

/** Log whether the expected env key exists (length only — never log the key). */
export function logLlmKeyPresence(provider: LlmProvider): void {
  switch (provider) {
    case "openrouter": {
      const k = process.env.OPENROUTER_API_KEY?.trim();
      console.log(`[enpply] LLM env: OPENROUTER_API_KEY ${k ? `set (length ${k.length})` : "MISSING"}`);
      break;
    }
    case "openai": {
      const k = process.env.OPENAI_API_KEY?.trim();
      console.log(`[enpply] LLM env: OPENAI_API_KEY ${k ? `set (length ${k.length})` : "MISSING"}`);
      break;
    }
    case "deepseek": {
      const k = process.env.DEEPSEEK_API_KEY?.trim();
      console.log(`[enpply] LLM env: DEEPSEEK_API_KEY ${k ? `set (length ${k.length})` : "MISSING"}`);
      const base = process.env.DEEPSEEK_BASE_URL?.trim();
      if (base) console.log(`[enpply] LLM env: DEEPSEEK_BASE_URL=${base}`);
      break;
    }
    case "gemini": {
      const k = process.env.GEMINI_API_KEY?.trim();
      console.log(`[enpply] LLM env: GEMINI_API_KEY ${k ? `set (length ${k.length})` : "MISSING"}`);
      const base = process.env.GEMINI_BASE_URL?.trim();
      if (base) console.log(`[enpply] LLM env: GEMINI_BASE_URL=${base}`);
      break;
    }
  }
}

/** HTTP-ish status of an LLM error, if it carries one. */
export function llmErrorStatus(err: unknown): number | undefined {
  const s = typeof err === "object" && err && "status" in err ? (err as { status?: unknown }).status : undefined;
  return typeof s === "number" ? s : undefined;
}

/**
 * True for transient LLM errors worth a short retry: rate limits (429, common on
 * free/shared OpenRouter pools) and upstream 5xx hiccups.
 */
export function isTransientLlmError(err: unknown): boolean {
  const s = llmErrorStatus(err);
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
}

/**
 * Parse a model JSON reply tolerantly: strip ```code fences```, else fall back
 * to the outermost {...} / [...] block. Needed when a call runs WITHOUT
 * response_format (the model may wrap the JSON in fences or a sentence).
 */
export function parseJsonLoose<T>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    const start = t.search(/[{[]/);
    const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1)) as T;
    throw new Error("Model reply was not valid JSON");
  }
}

/** If the API rejects `response_format: json_object`, caller may retry without it. */
export function shouldRetryChatJsonWithoutResponseFormat(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = typeof err === "object" && err && "status" in err ? (err as { status?: number }).status : undefined;
  if (status != null && status !== 400 && status !== 422) return false;
  return /response_format|json_object|unsupported|invalid_type|Unknown parameter/i.test(msg);
}
