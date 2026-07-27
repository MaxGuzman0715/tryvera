export type Experience = {
  company: string;
  location?: string;
  title: string;
  startDate: string;
  endDate: string;
  bullets?: string[];
  paragraphs?: string[];
  projectName?: string;
  rawLines?: string;
  notes?: string;
};

export type Education = {
  school: string;
  degree: string;
  field: string;
  /** From date (required; freeform, e.g. Sep 2018). */
  startDate: string;
  /** To date (required; freeform, e.g. Jun 2022 or Present). */
  endDate: string;
};

export type Profile = {
  id: string;
  basic: {
    fullName: string;
    title?: string;
    email: string;
    phone?: string;
    location: string;
    summary?: string;
    linkedin?: string;
    github?: string;
    portfolio?: string;
  };
  experience: Experience[];
  skills: string[];
  education: Education[];
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
  recruiter_name?: string;
  status: string;
  status_step?: string;
  tracking_status?: "pending" | "in_process" | "failed";
  note?: string;
  /** Short failure summary when status is failed (from server). */
  generation_error?: string;
  output_folder: string;
  /**
   * Server-resolved absolute form of `output_folder` (via the project root).
   * Populated by the listing endpoint so the Logs page can offer a Copy-path
   * button without a per-row round-trip. Empty string when no output folder
   * has been assigned yet (still-queued runs).
   */
  output_folder_abs?: string;
  result_file: string;
  /** RBAC: id of the user who created this run. Optional for legacy rows. */
  user_id?: string;
  /** Cached user email at generation time (admin display). */
  user_email?: string;
  /**
   * When this run was rejected as a duplicate, the id of the pre-existing run
   * it duplicates. Such rows are throwaway markers — the clients surface them
   * then delete them, so they don't litter Logs.
   */
  duplicate_of?: string;
};

export type GenerationOptions = {
  gen_resume: boolean;
  gen_cover_letter?: boolean;
  /** Legacy runs only; same meaning as `gen_cover_letter`. */
  gen_cv?: boolean;
  gen_answers: boolean;
  gen_fit_answer: boolean;
  ignore_duplicate_check: boolean;
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
  /** Full JD text captured for this run (optional on older runs). */
  job_description?: string;
  /** Full application/apply-form page text for this run (separate from the JD). */
  apply_form?: string;
  /** Relative persisted path (portable). */
  output_folder: string;
  /** Absolute path computed server-side for local debugging only. */
  output_folder_abs?: string;
  /** Echo of what was requested for this run (optional on older results). */
  generation_options?: GenerationOptions;
  llm_config?: {
    light: LlmModelConfig;
    heavy: LlmModelConfig;
    tiers: Record<LlmFunc, LlmTier>;
  };
  metadata: {
    role_summary: string;
    key_requirements: string[];
    questions: string[];
    warnings: string[];
  };
  artifacts: Record<string, string>;
  artifact_status: Record<string, string>;
  artifact_errors?: Record<string, string>;
  answers: { question: string; answer: string }[];
  quick_reference: {
    what_to_remember: string[];
    top_talking_points: string[];
  };
  status: string;
  error?: string;
  llm_fallback_used?: boolean;
  /** Last computed JD↔résumé match score (from the Result page button). */
  match_score?: MatchScoreSummary;
  /** Follow-up Q&A history from the Result page (oldest first). */
  followups?: FollowupQa[];
  /** Full K-structure from the merged extraction step. */
  extraction_detail?: KExtraction;
  /** Bullets-based résumé tailoring detail. */
  tailoring?: TailoringDetail;
};

export type TailoringDetail = {
  mode: "bullets" | "untailored";
  summary: string;
  skills: string[];
  gaps: { domain: string; stack: string }[];
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

export type KeywordImportance = "required" | "preferred" | "nice_to_have";
export type KeywordMatchStatus = "yes" | "partial" | "no";

export type KeywordMatch = {
  keyword: string;
  importance: KeywordImportance;
  status: KeywordMatchStatus;
  evidence: string;
};

export type CredibilityReport = {
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
  keyword_matches: KeywordMatch[];
  credibility: CredibilityReport;
  strengths: string[];
  gaps: string[];
  summary: string;
  llm: { provider: LlmProvider; model: string };
  computed_at: string;
};

export type UserRole = "admin" | "user";

export type UserPreferences = {
  ui_theme?: AppUiTheme;
  default_resume_theme?: string;
  /** Per-function model tier choices. Unset functions use the default tier. */
  llm_tiers?: Partial<Record<LlmFunc, LlmTier>>;
};

export type AuthUser = {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
  profile_ids: string[];
  preferences?: UserPreferences;
};

export type LlmProvider = "openrouter" | "openai" | "deepseek" | "gemini";

/** Per-user settings for the enpplify browser extension. */
export type EnpplifyFeatureFlags = {
  password_autofill: boolean;
  combobox_fill: boolean;
  attach_cover_letter: boolean;
  ai_fill_remaining: boolean;
  drop_to_upload: boolean;
  gen_resume_default: boolean;
  gen_cover_letter_default: boolean;
};

export type EnpplifyUserSettings = {
  flags: EnpplifyFeatureFlags;
  autofill_password?: string;
  /** Original filename of the uploaded base résumé, per profile id. */
  base_resume_names?: Record<string, string>;
  /** Per-profile default for the extension's "Use base resume" toggle. */
  base_resume_default?: Record<string, boolean>;
};

/** A reusable answer saved for a profile (served Without-AI on every app). */
export type ProfileAnswer = {
  question: string;
  answer: string;
  updated_at: string;
};

/**
 * A free-text answering policy for a profile — a directive the AI applies when
 * filling forms / answering questions (e.g. how to derive a salary figure),
 * rather than a fixed answer. Injected into the fill + Q&A prompts.
 */
export type AnswerPolicy = {
  id: string;
  text: string;
  enabled: boolean;
  updated_at: string;
};

/** A concrete provider + model pair (one of the two admin-defined tiers). */
export type LlmModelConfig = {
  provider: LlmProvider;
  model: string;
};

/** The whole app runs on two models: a cheap `light` and a strong `heavy`. */
export type LlmTier = "light" | "heavy";

/** User-facing LLM functions, each assigned a tier in My settings. */
export type LlmFunc = "resume" | "coverLetter" | "answers" | "matchScore";

export type AppUiTheme = "light" | "dark";

export type AppSettings = {
  ui_theme: AppUiTheme;
  default_output_path: string;
  /**
   * Resolved absolute form of `default_output_path` (server-computed against
   * the server's project root). Read-only for display / Copy-path — never
   * sent back on save, the portable relative value is what persists.
   */
  default_output_path_abs?: string;
  default_theme: string;
  default_theme_by_profile: Record<string, string>;
  /** The two admin-defined models the whole app runs on. */
  llm_light: LlmModelConfig;
  llm_heavy: LlmModelConfig;
};

export type Prompts = {
  extraction: string;
  resume: string;
  coverLetter: string;
  qa: string;
  matchScore: string;
};

export type PromptKey = keyof Prompts;

/** Which named variant is active per field, and all variant names on disk per field. */
export type PromptMeta = {
  activeByKey: Record<PromptKey, string>;
  variantsByKey: Record<PromptKey, string[]>;
};

// ── Bullets-experiment harness (admin Playground) ──────────────────────────

export type KExtraction = {
  signal_quality: "high" | "medium" | "low" | "laundry_list";
  clearance_required: boolean;
  clearance_level: "active" | "ability_to_obtain" | "not_required";
  primary_domain: string;
  domain_breakdown: Record<string, number>;
  K1: { hard: Record<string, string[]>; soft: string[] };
  K2: (string | string[])[];
  competency_signals: { category: string; raw: string }[];
};

export type SelectedStack = {
  stack: string;
  resolvedKey: string;
  aliasUsed: boolean;
  domain: string;
  tier: 1 | 2;
  weight: number;
  linesRequested: number;
  bullets: string[];
};

export type CompanySelection = {
  company: string;
  project?: string;
  stacks: SelectedStack[];
  preInjectionBullets: string[];
  finalBullets: string[];
  k2Placed: string[];
  k2Skipped: string[];
  injectionNote?: string;
};

type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

export type ResumeSection = {
  company: string;
  title: string;
  startDate: string;
  endDate: string;
  tailored: boolean;
  bullets: string[];
  source: "tailored" | "tailored_fallback" | "as_is";
  note?: string;
};

/** A profile's bullet groups, flattened for the Profiles UI (counts + picker). */
export type ProfileBulletsView = {
  has_bullets: boolean;
  totals: { companies: number; stacks: number; bullets: number };
  companies: {
    company: string;
    project?: string;
    stacks: { stack: string; domain: string; tier: 1 | 2; count: number; bullets: string[] }[];
  }[];
};

export type BulletExperimentResult = {
  profileId: string;
  signal_quality: KExtraction["signal_quality"];
  clearance_required: boolean;
  clearance_level: string;
  primary_domain: string;
  domain_breakdown: Record<string, number>;
  extraction: KExtraction;
  companies: CompanySelection[];
  resume: ResumeSection[];
  gaps: { domain: string; stack: string }[];
  warnings: string[];
  timings: { extraction_ms: number; injection_ms: number; total_ms: number };
  usage: { extraction?: TokenUsage; injection_calls: { company: string; usage?: TokenUsage }[] };
  models: { extraction: string; injection: string };
};
