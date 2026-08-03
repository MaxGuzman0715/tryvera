import type { AppSettings, LlmFunc, LlmModelConfig, LlmTier } from "./types.js";

/**
 * Single source of truth for the two-tier model system. The app runs on exactly
 * two admin-defined models (`llm_light`, `llm_heavy`). Each internal pipeline
 * step belongs to a user-facing function; the user assigns every function a
 * tier; a step resolves step → function → tier → model.
 */

/** Internal LLM call sites. */
export type LlmStep =
  | "extraction" // deep résumé extraction (K-structure)
  | "extractionLite" // lightweight extraction (cover-letter-only / Q&A slot)
  | "resume" // résumé tailoring
  | "coverLetter"
  | "fill" // application form fill (extension)
  | "qa" // follow-up Q&A
  | "matchScore";

/** Which user-facing function each internal step belongs to. */
export const STEP_FUNC: Record<LlmStep, LlmFunc> = {
  extraction: "resume",
  extractionLite: "answers",
  resume: "resume",
  coverLetter: "coverLetter",
  fill: "answers",
  qa: "answers",
  matchScore: "matchScore",
};

/** Default tier per function when the user hasn't chosen: résumé heavy, rest light. */
export const DEFAULT_TIER: Record<LlmFunc, LlmTier> = {
  resume: "heavy",
  coverLetter: "light",
  answers: "light",
  matchScore: "light",
};

/** The user-facing functions, in display order. */
export const LLM_FUNCS: LlmFunc[] = ["resume", "coverLetter", "answers", "matchScore"];

type TierMap = Partial<Record<LlmFunc, LlmTier>> | undefined;
type TierSettings = Pick<AppSettings, "llm_light" | "llm_heavy" | "llm_extraction" | "llm_generation">;

/** Effective tier for a function (user choice, else default). */
export function tierForFunc(func: LlmFunc, tiers: TierMap): LlmTier {
  return tiers?.[func] ?? DEFAULT_TIER[func];
}

/** The model for a tier. */
export function modelForTier(tier: LlmTier, settings: TierSettings): LlmModelConfig {
  return tier === "heavy" ? settings.llm_heavy : settings.llm_light;
}

/** Resolve the concrete {provider, model} for an internal step.
 * An admin per-step override (llm_extraction / llm_generation) wins over the tier. */
export function resolveStepModel(step: LlmStep, settings: TierSettings, tiers: TierMap): LlmModelConfig {
  if (step === "extraction" && settings.llm_extraction) return settings.llm_extraction;
  if (step === "resume" && settings.llm_generation) return settings.llm_generation;
  return modelForTier(tierForFunc(STEP_FUNC[step], tiers), settings);
}

/** The effective function→tier map (fills defaults), for auditing in result.json. */
export function effectiveTiers(tiers: TierMap): Record<LlmFunc, LlmTier> {
  return {
    resume: tierForFunc("resume", tiers),
    coverLetter: tierForFunc("coverLetter", tiers),
    answers: tierForFunc("answers", tiers),
    matchScore: tierForFunc("matchScore", tiers),
  };
}
