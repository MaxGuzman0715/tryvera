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
  /**
   * True when this employer is a consulting / client-services firm. The résumé
   * generator routes cross-industry / off-profile stacks to a consulting company
   * (a plausible home for varied work); at least one of the last 2 companies is
   * expected to be consulting.
   */
  consulting: z.boolean().optional(),
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

/**
 * One de-fingerprinted reframing of the JD. The normalizer emits TWO divergent
 * variations along a specialization axis it derives from the posting; the résumé
 * generator maps variation A onto the candidate's REAL anchor company (tailored
 * truthfully) and variation B onto the CONSULTING company (presented as varied
 * industry-matched client engagements), so the two read as distinct jobs.
 */
export type JdVariation = {
  /** "A" (→ real anchor company) or "B" (→ consulting company). */
  label: string;
  /** The pole of the derived axis this variation foregrounds (for debugging/visibility). */
  angle?: string;
  /** De-fingerprinted rewrite of the JD, foregrounding this variation's pole. */
  reframed_jd: string;
  /** This variation's most important requirements, most-critical first. */
  summary_lines: string[];
};

/** How central one of the candidate's skill categories is to the target role. */
export type DomainScore = {
  /** The skill-category name (e.g. "Frontend", "Backend"), matching a profile skills category. */
  domain: string;
  /** 3 = core to the role, 2 = supporting, 1 = not needed for this role. */
  score: 1 | 2 | 3;
};

export type ExtractionResult = {
  company_name: string;
  role_name: string;
  /** One-line discipline+seniority role descriptor (cover letter / match score / fill-map read this). */
  role_summary: string;
  /** De-duped union of both variations' summary_lines (cover letter / match score / metadata read this). */
  key_requirements: string[];
  /** Two divergent reframings of the JD (A → real anchor company, B → consulting company). */
  variations: JdVariation[];
  /** The 2 client industries (verbatim from shared.json) the consulting company draws its engagements from. */
  industries: string[];
  /** Niche nice-to-haves extracted for visibility only; NOT sent to the generator. */
  rare_nice_to_haves: string[];
  /** Relevance score (1-3) for each of the candidate's skill categories, most-relevant-first. */
  domain_scores: DomainScore[];
  /** The role-tailored résumé skills list (categorized strings) built in extraction — ordered/trimmed by domain_scores, JD keywords floated. */
  skills: string[];
  questions: string[];
  answers: AnswerItem[];
  warnings: string[];
};

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
   * duplicates. Lets clients (e.g. the Tryvify extension) recover by loading
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
  /** The final generated résumé as Markdown — the exact tailored output (fed to the match score). */
  resume_markdown?: string;
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

/** Per-run detail of how the résumé was tailored (shown on the Result page). */
export type TailoringDetail = {
  /** The two divergent JD reframings; `company` is which company each drove (A → anchor, B → consulting). */
  variations: {
    label: string;
    angle?: string;
    reframed_jd: string;
    summary_lines: string[];
    company?: string;
  }[];
  /** The 2 client industries selected for the consulting company's engagements. */
  industries: string[];
  /** Per-domain relevance scores (1-3) that drove the skills section ordering/trim. */
  domain_scores: DomainScore[];
  /** Niche tools dropped from tailoring. */
  rare_nice_to_haves: string[];
  /** Per company: how its bullets were sourced, and the resulting bullet count. */
  companies: {
    company: string;
    /** anchor = tailored live from variation A; consulting = variation B + industry engagements; older = stored flagship bullets. */
    role: "anchor" | "consulting" | "older";
    /** For a consulting company, the industries whose engagements it absorbed. */
    industries?: string[];
    bullet_count: number;
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

/** How obviously the résumé reads as intentionally force-tailored to this JD. */
export type ForceTailoringReport = {
  /** 0-100; HIGHER = looks MORE intentionally/forcibly tailored to the JD (a red flag). Lower = reads naturally. */
  score: number;
  assessment: string;
  /** Concrete tells: JD phrasing echoed verbatim, keyword stuffing, implausibly perfect coverage, etc. */
  signals: string[];
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
  /** How force-tailored to the JD the résumé looks (higher = more obviously tailored). */
  force_tailoring: ForceTailoringReport;
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

/**
 * Account roles.
 * - admin / user: full app access (admin = all profiles + management UI).
 * - logger: a stripped-down extension user for *logging* applications (JD + job
 *   link + profile) — résumé/CV generation is hidden so they never see it.
 * - manual_logger: a logger with NO AI features (no AI extraction, no AI Q&A
 *   fill); company/role are entered by hand and only Easy Fill + logging remain.
 */
export type UserRole = "admin" | "user" | "logger" | "manual_logger";

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
  /**
   * Optional admin overrides that pin a SPECIFIC model to a résumé-pipeline step,
   * winning over the tier system. Unset = fall back to the step's tier.
   */
  llm_extraction?: LlmModelConfig;
  llm_generation?: LlmModelConfig;
};
