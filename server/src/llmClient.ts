import OpenAI from "openai";
import type { LlmProvider } from "./types.js";

const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";
const DEEPSEEK_DEFAULT_BASE = "https://api.deepseek.com/v1";
const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Runtime LLM selection (from `app_settings.json` + `.env` keys). */
export type LlmRuntimeConfig = {
  provider: LlmProvider;
  model: string;
};

const DEFAULT_MODEL_BY_PROVIDER: Record<LlmProvider, string> = {
  openrouter: "qwen/qwen3.6-plus:free",
  openai: "gpt-5-mini",
  deepseek: "deepseek-chat",
  gemini: "gemini-2.5-flash",
};

export function defaultModelForProvider(provider: LlmProvider): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

/** How much of a reasoning model's budget goes to hidden thinking, cheapest first. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
const REASONING_EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

/** Reasoning models only. Sending the parameter to anything else is at best ignored. */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return /(^|\/)gpt-5/.test(m) || /(^|\/)o[1-9](-|$)/.test(m);
}

/**
 * Reasoning-effort parameter for the request body.
 *
 * Reasoning tokens are billed as OUTPUT — $2.00/M on gpt-5-mini, eight times the input
 * rate — and left unset the model defaults to medium, which spends about half its budget
 * thinking. Measured on this account: 430K reasoning tokens against 141K of actual
 * completion in one day, so 67% of the bill bought text nobody ever sees.
 *
 * The default is MEDIUM - the model's own default, and what every good résumé this project
 * has produced was written with. Turning it down looked like free money and is not.
 *
 * Measured, same prompts and profiles, only the thinking changed:
 *   thinking on   distinct figures, real company detail, nothing invented
 *   thinking off  no figures at all, both companies given IDENTICAL bullets, ten
 *                 fabricated technologies, and the JD's role title leaking raw into
 *                 every bullet as "senior ai engineer"
 *
 * The résumé prompt holds many constraints at once - coverage, figure kinds and counts,
 * never invent, keep companies distinct - and the hidden reasoning is where they are
 * juggled. Lower it to save money only after comparing output on a real posting.
 *
 * The shape differs by provider: OpenRouter takes a `reasoning` object, OpenAI direct
 * takes `reasoning_effort`, and OpenAI has no "none" level so that maps to "minimal".
 */
export function reasoningParam(
  model: string,
  provider: LlmProvider
): { reasoning?: { effort: ReasoningEffort } } | { reasoning_effort?: string } {
  if (!isReasoningModel(model)) return {};
  const raw = (process.env.ENPPLY_REASONING_EFFORT ?? "").trim().toLowerCase();
  const effort = (REASONING_EFFORTS as string[]).includes(raw) ? (raw as ReasoningEffort) : "medium";
  if (provider === "openrouter") return { reasoning: { effort } };
  if (provider === "openai") return { reasoning_effort: effort === "none" ? "minimal" : effort };
  return {};
}

export function getLlmModelForConfig(config: LlmRuntimeConfig): string {
  const m = config.model.trim();
  if (m) return m;
  return DEFAULT_MODEL_BY_PROVIDER[config.provider];
}

export function getLlmClientForConfig(config: LlmRuntimeConfig): OpenAI {
  switch (config.provider) {
    case "openrouter": {
      const apiKey = process.env.OPENROUTER_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is not set in .env (required when provider is OpenRouter)");
      }
      const baseURL = (process.env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE).replace(/\/$/, "");
      const defaultHeaders: Record<string, string> = {
        "X-Title": process.env.OPENROUTER_APP_TITLE?.trim() || "Enpply",
      };
      const referer = process.env.OPENROUTER_HTTP_REFERER?.trim();
      if (referer) defaultHeaders["HTTP-Referer"] = referer;
      return new OpenAI({ apiKey, baseURL, defaultHeaders });
    }
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not set in .env (required when provider is OpenAI direct)");
      }
      return new OpenAI({ apiKey });
    }
    case "deepseek": {
      const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("DEEPSEEK_API_KEY is not set in .env (required when provider is DeepSeek)");
      }
      const baseURL = (process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE).replace(/\/$/, "");
      return new OpenAI({ apiKey, baseURL });
    }
    case "gemini": {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set in .env (required when provider is Gemini)");
      }
      const baseURL = (process.env.GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE).replace(/\/$/, "");
      return new OpenAI({ apiKey, baseURL });
    }
  }
}

/** Logs active provider/model from settings (call after `readSettings()`). */
export function logLlmConfig(config: LlmRuntimeConfig): void {
  const model = getLlmModelForConfig(config);
  switch (config.provider) {
    case "openrouter": {
      const base = (process.env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE).replace(/\/$/, "");
      console.log(`[enpply] LLM: OpenRouter — base ${base}, model ${model}`);
      break;
    }
    case "openai":
      console.log(`[enpply] LLM: OpenAI direct — model ${model}`);
      break;
    case "deepseek": {
      const base = (process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE).replace(/\/$/, "");
      console.log(`[enpply] LLM: DeepSeek — base ${base}, model ${model}`);
      break;
    }
    case "gemini": {
      const base = (process.env.GEMINI_BASE_URL ?? GEMINI_DEFAULT_BASE).replace(/\/$/, "");
      console.log(`[enpply] LLM: Gemini (OpenAI-compatible) — base ${base}, model ${model}`);
      break;
    }
  }
}
