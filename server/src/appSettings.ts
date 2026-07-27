import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./paths.js";
import type { AppSettings, LlmModelConfig, LlmProvider } from "./types.js";

const settingsPath = () => path.join(dataDir(), "app_settings.json");

function isValidProvider(p: unknown): p is LlmProvider {
  return p === "openrouter" || p === "openai" || p === "deepseek" || p === "gemini";
}

/** Coerce a raw blob into a valid {provider, model}, falling back to `fallback`. */
function sanitizeModel(raw: unknown, fallback: LlmModelConfig): LlmModelConfig {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const provider = (raw as Record<string, unknown>).provider;
  const model = (raw as Record<string, unknown>).model;
  return {
    provider: isValidProvider(provider) ? provider : fallback.provider,
    model: typeof model === "string" && model.trim() ? model.trim() : fallback.model,
  };
}

const defaults: AppSettings = {
  ui_theme: "dark",
  default_output_path: "./output",
  default_theme: "standard",
  default_theme_by_profile: {},
  llm_light: { provider: "openrouter", model: "deepseek/deepseek-chat" },
  llm_heavy: { provider: "openai", model: "gpt-5" },
};

export async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings> & Record<string, unknown>;
    const ui = parsed.ui_theme;
    const ui_theme: AppSettings["ui_theme"] = ui === "light" || ui === "dark" ? ui : defaults.ui_theme;
    return {
      ...defaults,
      ...parsed,
      ui_theme,
      default_theme_by_profile: {
        ...defaults.default_theme_by_profile,
        ...(parsed.default_theme_by_profile ?? {}),
      },
      llm_light: sanitizeModel(parsed.llm_light, defaults.llm_light),
      llm_heavy: sanitizeModel(parsed.llm_heavy, defaults.llm_heavy),
    };
  } catch {
    return { ...defaults };
  }
}

export async function writeSettings(s: AppSettings): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(s, null, 2), "utf8");
}
