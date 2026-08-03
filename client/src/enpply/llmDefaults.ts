import type { LlmProvider } from "./types";

/** Suggested model id when switching provider. */
export const DEFAULT_LLM_MODEL: Record<LlmProvider, string> = {
  openrouter: "qwen/qwen3.6-plus:free",
  openai: "gpt-5-mini",
  deepseek: "deepseek-chat",
  gemini: "gemini-2.5-flash",
};

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI (direct)",
  deepseek: "DeepSeek",
  gemini: "Gemini (Google)",
};

/**
 * Curated model list shown in the Config dropdown for each provider.
 * First entry is the default. Keeping this short on purpose — too many options
 * is noisier than useful, and outdated ids confuse users when vendors retire models.
 */
export const LLM_MODELS_BY_PROVIDER: Record<LlmProvider, { id: string; label: string }[]> = {
  openai: [
    { id: "gpt-5-mini", label: "GPT-5 mini — fast, cheap, recommended for résumés" },
    { id: "gpt-5.5", label: "GPT-5.5 — newest flagship, highest quality" },
    { id: "gpt-5.5-pro", label: "GPT-5.5 Pro — deepest reasoning, most expensive" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini — newest fast/cheap tier" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano — newest, cheapest" },
    { id: "gpt-5.2", label: "GPT-5.2 — strong general model" },
    { id: "gpt-5.1", label: "GPT-5.1 — improved GPT-5" },
    { id: "gpt-5", label: "GPT-5 — flagship (5.0), highest quality, expensive" },
    { id: "gpt-5-nano", label: "GPT-5 nano — cheapest, short bullets only" },
    { id: "gpt-4o", label: "GPT-4o — previous flagship" },
    { id: "gpt-4o-mini", label: "GPT-4o mini — legacy small model" },
    { id: "o4-mini", label: "o4-mini — reasoning model" },
  ],
  gemini: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — moderate, recommended for résumés" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — flagship, highest quality" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite — fastest, cheapest" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash — previous generation" },
  ],
  deepseek: [
    { id: "deepseek-chat", label: "DeepSeek Chat — general purpose" },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner — reasoning model" },
  ],
  openrouter: [
    { id: "qwen/qwen3.6-plus:free", label: "Qwen 3.6 Plus (free)" },
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (via OpenRouter)" },
    { id: "openai/gpt-5-mini", label: "GPT-5 mini (via OpenRouter)" },
    { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (via OpenRouter)" },
    { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B Instruct (free)" },
    { id: "deepseek/deepseek-chat", label: "DeepSeek Chat (via OpenRouter)" },
  ],
};
