import { z } from "zod";

export const experienceSchema = z.object({
  company: z.string().min(1),
  location: z.string().optional(),
  title: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  bullets: z.array(z.string()).optional(),
  paragraphs: z.array(z.string()).optional(),
  projectName: z.string().optional(),
  rawLines: z.string().optional(),
  notes: z.string().optional(),
});

export const educationSchema = z
  .object({
    school: z.string().min(1),
    degree: z.string().min(1),
    field: z.string().min(1),
    /**
     * Inclusive period the user attended (freeform, e.g. Sep 2018 – Jun 2022).
     * Both fields are optional — leave them empty to render just the school,
     * degree, and field with no parenthetical date range. Partial (one filled,
     * one empty) is rejected by the refine below to avoid "(Sep 2018 – )" style
     * output.
     */
    startDate: z.string(),
    endDate: z.string(),
  })
  .refine(
    (e) => {
      const hasStart = e.startDate.trim().length > 0;
      const hasEnd = e.endDate.trim().length > 0;
      return hasStart === hasEnd;
    },
    {
      message: "Education dates must be either both empty or both filled.",
      path: ["startDate"],
    }
  );

export const basicInfoSchema = z.object({
  fullName: z.string().min(1),
  title: z.string().optional(),
  email: z.string().min(1),
  phone: z.string().optional(),
  location: z.string().min(1),
  summary: z.string().optional(),
  linkedin: z.string().optional(),
  github: z.string().optional(),
  portfolio: z.string().optional(),
});

export const profileBodySchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i),
  basic: basicInfoSchema,
  experience: z.array(experienceSchema),
  skills: z.array(z.string()),
  education: z.array(educationSchema),
});

export type Profile = z.infer<typeof profileBodySchema>;

/**
 * K-structure produced by the merged extraction prompt and consumed by the
 * bullets-based résumé pipeline. See Experiment/enpply_tailoring_system.md.
 */
export type KExtraction = {
  signal_quality: "high" | "medium" | "low" | "laundry_list";
  clearance_required: boolean;
  clearance_level: "active" | "ability_to_obtain" | "not_required";
  primary_domain: string;
  domain_breakdown: Record<string, number>;
  K1: { hard: Record<string, string[]>; soft: string[] };
  /** Flat strings or grouped OR-arrays. */
  K2: (string | string[])[];
  competency_signals: { category: string; raw: string }[];
};

export type ExtractionResult = {
  company_name: string;
  role_name: string;
  /**
   * `role_summary` and `key_requirements` are no longer emitted by the merged
   * extraction prompt; they are derived in code from the K-structure so legacy
   * consumers (cover letter, match score, fill-map, Result page) keep working.
   */
  role_summary: string;
  key_requirements: string[];
  questions: string[];
  answers: AnswerItem[];
  warnings: string[];
} & Partial<KExtraction>;

export type AnswerItem = { question: string; answer: string };

export type QuickReference = {
  what_to_remember: string[];
  top_talking_points: string[];
};

export type AnswersPayload = {
  answers: AnswerItem[];
  quick_reference: QuickReference;
};

export type GenerationStatus = "generating" | "completed" | "failed";

export type ArtifactKey =
  | "resume_pdf"
  | "cover_letter_pdf"
  | "answers_json"
  | "answers_md"
  | "metadata_json"
  | "job_description_txt";

export type ArtifactStatus = "completed" | "failed" | "skipped";

/** Per-run toggles from the Apply form (which artifacts to generate). */
export type GenerationOptions = {
  gen_resume: boolean;
  /** Cover letter PDF (replaces legacy CV). */
  gen_cover_letter: boolean;
  gen_answers: boolean;
  gen_fit_answer: boolean;
  ignore_duplicate_check: boolean;
};

export type ApplicationLogEntry = {
  id: string;
  run_uuid?: string;
  created_at: string;
  company_name: string;
  role_name: string;
  resume_profile: string;
  theme: string;
  job_link: string;
  /** Plain-text recruiter when there is no job posting URL. */
  recruiter_name?: string;
  status: GenerationStatus;
  status_step?: string;
  tracking_status?: "pending" | "in_process" | "failed";
  note?: string;
  /** Short LLM / pipeline failure summary for failed runs (shown in logs and toasts). */
  generation_error?: string;
  /**
   * When a run is rejected as a duplicate, the id of the pre-existing run it
   * duplicates. Lets clients (e.g. the enpplify extension) recover by loading
   * that existing run instead of treating the duplicate as a hard failure.
   */
  duplicate_of?: string;
  output_folder: string;
  result_file: string;
  /**
   * User who initiated this generation. Optional only because rows written
   * before RBAC existed don't carry it; new rows always set it. Admins can
   * see all rows; regular users see only their own.
   */
  user_id?: string;
  /** Cached user email at generation time for admin display in logs. */
  user_email?: string;
};

export type ResultJson = {
  id: string;
  run_uuid?: string;
  created_at: string;
  company_name: string;
  role_name: string;
  job_link: string;
  recruiter_name?: string;
  resume_profile: string;
  theme: string;
  /** Full JD text captured for this run (stored in result and as job_description.txt artifact). */
  job_description?: string;
  /**
   * Full text of the application/apply-form page this run is tied to — separate
   * from the JD. Captured by the extension's Q&A (the page the questions are
   * extracted from) or pasted into the dashboard's "Apply form" field. Used as
   * extra context for answering, and refreshed each time Q&A runs on the page.
   */
  apply_form?: string;
  /** Relative persisted path (portable across machines), e.g. output/Company_Role_... */
  output_folder: string;
  /** Computed absolute path for local debugging UI; not required in persisted files. */
  output_folder_abs?: string;
  metadata: {
    role_summary: string;
    key_requirements: string[];
    questions: string[];
    warnings: string[];
  };
  /** Echo of what was requested for this run (for UI/debug). */
  generation_options?: GenerationOptions;
  /** Runtime LLM configuration used for this run: the two tier models + the
   * effective function→tier mapping applied. */
  llm_config?: {
    light: LlmModelConfig;
    heavy: LlmModelConfig;
    tiers: Record<LlmFunc, LlmTier>;
  };
  artifacts: Record<ArtifactKey, string>;
  artifact_status: Record<ArtifactKey, ArtifactStatus>;
  artifact_errors?: Partial<Record<ArtifactKey, string>>;
  answers: AnswerItem[];
  quick_reference: QuickReference;
  status: GenerationStatus;
  error?: string;
  /** True if any step used placeholder content because the model request failed. */
  llm_fallback_used?: boolean;
  /** Last computed JD↔résumé match score (from the Result page button). User-triggered, not part of generation. */
  match_score?: MatchScoreSummary;
  /** Follow-up Q&A history from the Result page (oldest first). User-triggered, not part of generation. */
  followups?: FollowupQa[];
  /** Full K-structure from the merged extraction step (signal, domains, K1/K2, clearance). */
  extraction_detail?: KExtraction;
  /** Bullets-based résumé tailoring detail (stack distribution, gaps, generated summary/skills). */
  tailoring?: TailoringDetail;
};

/** Per-run detail of the bullets-based résumé tailoring (for the Result page). */
export type TailoringDetail = {
  /** "bullets" when a store tailored the last-2 companies; "untailored" when degraded to original profile bullets. */
  mode: "bullets" | "untailored";
  /** Generated summary used in the résumé. */
  summary: string;
  /** Generated (expanded) skills list used in the résumé. */
  skills: string[];
  /** K1 hard stacks with no pre-built bullet group at either tailored company. */
  gaps: { domain: string; stack: string }[];
  /** Per tailored company: which stacks landed, their line counts, and K2 placement. */
  companies: {
    company: string;
    project?: string;
    stacks: { stack: string; resolved_key: string; domain: string; tier: 1 | 2; weight: number; lines: number }[];
    k2_placed: string[];
    k2_skipped: string[];
  }[];
};

export type FollowupQa = {
  question: string;
  answer: string;
  llm: { provider: LlmProvider; model: string };
  asked_at: string;
};

/** How the JD frames a requirement. */
export type KeywordImportance = "required" | "preferred" | "nice_to_have";
/** Whether the candidate genuinely demonstrates a JD keyword. */
export type KeywordMatchStatus = "yes" | "partial" | "no";

/** One row of the keyword match table (JD term ↔ candidate evidence). */
export type KeywordMatch = {
  keyword: string;
  importance: KeywordImportance;
  status: KeywordMatchStatus;
  /** Where in the profile it's shown; "" when status is "no". */
  evidence: string;
};

/** Credibility of the résumé/profile itself, independent of JD fit. */
export type CredibilityReport = {
  /** 0-100; high = concrete/quantified/consistent, low = vague/inflated. */
  score: number;
  assessment: string;
  red_flags: string[];
};

export type MatchScoreSummary = {
  overall: number;
  breakdown: {
    experience_level: number;
    relevant_experience: number;
    core_skills: number;
    industry_experience: number;
  };
  /** Per-keyword match table built from the raw JD. */
  keyword_matches: KeywordMatch[];
  /** Assessment of the résumé's own credibility. */
  credibility: CredibilityReport;
  strengths: string[];
  gaps: string[];
  summary: string;
  llm: { provider: LlmProvider; model: string };
  computed_at: string;
};

/** Which API to call; keys still come from `.env` (never stored in settings JSON). */
export type LlmProvider = "openrouter" | "openai" | "deepseek" | "gemini";

/** A concrete provider + model pair (one of the two admin-defined tiers). */
export type LlmModelConfig = {
  provider: LlmProvider;
  model: string;
};

/**
 * The whole app runs on exactly TWO models, defined by an admin:
 *   - `light`  — cheap/fast model.
 *   - `heavy`  — strong model.
 */
export type LlmTier = "light" | "heavy";

/**
 * User-facing LLM functions. Each user assigns every function a tier
 * (light/heavy) in their settings; unset functions use the default tier
 * (résumé → heavy, everything else → light). The functions group the internal
 * pipeline steps:
 *   - `resume`     — résumé deep extraction + tailoring.
 *   - `coverLetter`— cover letter prose.
 *   - `answers`    — application answers / Q&A / form fill / lightweight
 *                    extraction (the Q&A-only and cover-letter-only paths).
 *   - `matchScore` — résumé/JD match score.
 */
export type LlmFunc = "resume" | "coverLetter" | "answers" | "matchScore";

export type AppUiTheme = "light" | "dark";

export type UserRole = "admin" | "user";

/**
 * Per-user preferences. Fields are optional and null-safe: a missing or
 * undefined value falls back to the global `AppSettings` default. Stored
 * server-side inside the user record so they follow the user across devices
 * (unlike auto-download folder handles, which live in IndexedDB per browser).
 */
export type UserPreferences = {
  /** Light or dark UI. Missing = use AppSettings.ui_theme. */
  ui_theme?: AppUiTheme;
  /** Resume theme id picked by default on the Apply page. Missing = AppSettings.default_theme. */
  default_resume_theme?: string;
  /**
   * Which tier (light/heavy) each LLM function uses for this user. A missing
   * function falls back to its default tier (résumé → heavy, rest → light).
   */
  llm_tiers?: Partial<Record<LlmFunc, LlmTier>>;
};

export type User = {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
  /** Profile ids this user is allowed to access. Admins ignore this. */
  profile_ids: string[];
  preferences?: UserPreferences;
};

/** Internal — never returned to the client. */
export type UserRecord = User & {
  password_hash: string;
};

export type Session = {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
};

export type AppSettings = {
  /** Client UI: light (white) or dark. */
  ui_theme: AppUiTheme;
  default_output_path: string;
  default_theme: string;
  default_theme_by_profile: Record<string, string>;
  /**
   * The two models the whole app runs on, set by an admin. Every LLM call uses
   * one of these, chosen by the per-user function→tier mapping. Provider keys
   * still live in `.env`.
   */
  llm_light: LlmModelConfig;
  llm_heavy: LlmModelConfig;
};
