import { beginGlobalWrite, endGlobalWrite } from "./globalLoading";
const base = "";

/** Turn API + Zod `flatten()` payloads into readable text. */
function humanizeApiError(data: unknown): string {
  if (!data || typeof data !== "object") return "Request failed";
  const err = (data as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const fe = err as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };
    const lines: string[] = [];
    if (fe.formErrors?.length) lines.push(...fe.formErrors);
    for (const [key, msgs] of Object.entries(fe.fieldErrors ?? {})) {
      if (msgs?.length) lines.push(`${key}: ${msgs.join(", ")}`);
    }
    if (lines.length) return lines.join(" · ");
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "Request failed";
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isWrite = method !== "GET";
  if (isWrite) beginGlobalWrite();
  try {
    const res = await fetch(`${base}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith("/api/auth/") && onUnauthorized) {
        onUnauthorized();
      }
      throw new Error(humanizeApiError(data) || res.statusText || `HTTP ${res.status}`);
    }
    return data as T;
  } finally {
    if (isWrite) endGlobalWrite();
  }
}

export const api = {
  health: () => req<{ ok: boolean }>("/api/health"),
  listProfiles: () => req<{ id: string }[]>("/api/profiles"),
  getProfile: (id: string) => req<import("./types").Profile>(`/api/profiles/${encodeURIComponent(id)}`),
  createProfile: (body: import("./types").Profile) =>
    req<import("./types").Profile>("/api/profiles", { method: "POST", body: JSON.stringify(body) }),
  saveProfile: (body: import("./types").Profile) =>
    req<import("./types").Profile>(`/api/profiles/${encodeURIComponent(body.id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteProfile: (id: string) =>
    req<{ ok?: boolean }>(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => {}),
  /** Bullet groups for a profile (summary counts + bullets for the picker). */
  getProfileBullets: (id: string) =>
    req<import("./types").ProfileBulletsView>(`/api/profiles/${encodeURIComponent(id)}/bullets`),
  getSettings: () => req<import("./types").AppSettings>("/api/config/settings"),
  /** Theme ids and labels from `server/templates/registry.json`. */
  getThemes: () => req<{ themes: { id: string; label: string }[] }>("/api/config/themes"),
  saveSettings: (body: import("./types").AppSettings) =>
    req<import("./types").AppSettings>("/api/config/settings", { method: "PUT", body: JSON.stringify(body) }),
  getPrompts: () => req<import("./types").Prompts>("/api/config/prompts"),
  savePrompts: (body: Partial<import("./types").Prompts>) =>
    req<import("./types").Prompts>("/api/config/prompts", { method: "PUT", body: JSON.stringify(body) }),
  /** Active prompt text per key plus variant registry (for UI). */
  getPromptsFull: () =>
    req<{ prompts: import("./types").Prompts; meta: import("./types").PromptMeta }>(
      "/api/config/prompts/full",
    ),
  getPromptVariant: (key: import("./types").PromptKey, name: string) =>
    req<{ content: string }>(
      `/api/config/prompts/${encodeURIComponent(key)}/variants/${encodeURIComponent(name)}`,
    ),
  savePromptVariant: (key: import("./types").PromptKey, name: string, content: string) =>
    req<{ ok: boolean; content: string }>(
      `/api/config/prompts/${encodeURIComponent(key)}/variants/${encodeURIComponent(name)}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),
  setActivePromptVariant: (key: import("./types").PromptKey, name: string) =>
    req<import("./types").PromptMeta & { ok: boolean }>(
      `/api/config/prompts/${encodeURIComponent(key)}/active`,
      { method: "PUT", body: JSON.stringify({ name }) },
    ),
  createPromptVariant: (key: import("./types").PromptKey, name: string, content?: string) =>
    req<import("./types").PromptMeta & { ok: boolean; name: string }>(
      `/api/config/prompts/${encodeURIComponent(key)}/variants`,
      { method: "POST", body: JSON.stringify({ name, content }) },
    ),
  deletePromptVariant: (key: import("./types").PromptKey, name: string) =>
    req<import("./types").PromptMeta & { ok: boolean }>(
      `/api/config/prompts/${encodeURIComponent(key)}/variants/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  getPromptDefaults: () => req<import("./types").Prompts>("/api/config/prompt-defaults"),
  /** Admin Playground — one-shot chat against a chosen provider/model. */
  playgroundChat: (body: {
    system: string;
    user: string;
    provider: import("./types").LlmProvider;
    model: string;
    temperature?: number;
  }) =>
    req<{
      text: string;
      provider: import("./types").LlmProvider;
      model: string;
      finish_reason: string | null;
      usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
      elapsed_ms: number;
    }>("/api/playground/chat", { method: "POST", body: JSON.stringify(body) }),
  /** Bullets-experiment harness — list profile ids that have a pre-built bullet store. */
  bulletsProfiles: () =>
    req<{ profiles: string[] }>("/api/playground/bullets/profiles"),
  /** Bullets-experiment harness — run JD → K-extraction → selection → K2 injection. */
  bulletsRun: (body: {
    profileId: string;
    jd_text: string;
    provider: import("./types").LlmProvider;
    model: string;
    inject_provider?: import("./types").LlmProvider;
    inject_model?: string;
    run_injection?: boolean;
  }) =>
    req<import("./types").BulletExperimentResult>("/api/playground/bullets/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resetPrompt: (key: string) =>
    req<import("./types").Prompts>(`/api/config/prompts/${encodeURIComponent(key)}/reset`, {
      method: "POST",
    }),
  listApplications: () => req<{ applications: import("./types").ApplicationLogEntry[] }>("/api/applications"),
  updateApplicationMeta: (
    id: string,
    patch: Partial<
      Pick<
        import("./types").ApplicationLogEntry,
        "note" | "tracking_status" | "company_name" | "role_name" | "job_link" | "recruiter_name"
      >
    >
  ) =>
    req<{ ok: boolean; application: import("./types").ApplicationLogEntry }>(
      `/api/applications/${encodeURIComponent(id)}/meta`,
      { method: "PUT", body: JSON.stringify(patch) }
    ),
  cancelApplication: (id: string) =>
    req<{ ok: boolean }>(`/api/applications/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  rerunApplication: (
    id: string,
    body: {
      gen_resume?: boolean;
      gen_cover_letter?: boolean;
      gen_answers?: boolean;
      gen_fit_answer?: boolean;
      /** Edited/replacement JD; empty = reuse the one stored on disk. */
      job_description?: string;
      /** Extra context / apply-form text; empty = don't pass any. */
      apply_form?: string | null;
    },
  ) =>
    req<{
      id: string;
      run_uuid?: string;
      status: string;
      output_folder: string;
      output_folder_abs?: string;
      result_file: string;
      result_file_abs?: string;
      llm_fallback_used: boolean;
    }>(`/api/applications/${encodeURIComponent(id)}/rerun`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteApplication: (id: string) =>
    req<{ ok: boolean }>(`/api/applications/${encodeURIComponent(id)}`, { method: "DELETE" }),
  askApplicationQuestion: (id: string, body: { question: string }) =>
    req<{ items: import("./types").FollowupQa[] }>(
      `/api/applications/${encodeURIComponent(id)}/qa`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  computeApplicationMatchScore: (
    id: string,
    override?: { provider: import("./types").LlmProvider; model: string },
  ) =>
    req<import("./types").MatchScoreSummary>(
      `/api/applications/${encodeURIComponent(id)}/match-score`,
      { method: "POST", body: JSON.stringify(override ?? {}) },
    ),
  getApplication: (id: string) =>
    req<import("./types").ResultJson>(`/api/applications/${encodeURIComponent(id)}`),
  generate: (body: {
    resume_profile: string;
    job_link: string;
    recruiter_name?: string | null;
    job_description: string;
    apply_form: string | null;
    theme?: string;
    gen_resume?: boolean;
    gen_cover_letter?: boolean;
    gen_cv?: boolean;
    gen_answers?: boolean;
    gen_fit_answer?: boolean;
    ignore_duplicate_check?: boolean;
  }) =>
    req<{
      id: string;
      run_uuid?: string;
      status: string;
      output_folder: string;
      output_folder_rel?: string;
      output_folder_abs?: string;
      result_file: string;
      result_file_abs?: string;
      llm_fallback_used: boolean;
      user_message?: string;
      /** Present when server was started with ENPPLY_VERBOSE=1 — full step trace on disk. */
      verbose_log_file?: string;
    }>("/api/applications/generate", { method: "POST", body: JSON.stringify(body) }),

  // ------------------------------------------------------------------
  // Auth + user management
  // ------------------------------------------------------------------
  getSetupStatus: () => req<{ needsSetup: boolean }>("/api/auth/setup-status"),
  setup: (body: { email: string; password: string }) =>
    req<{ user: import("./types").AuthUser }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  login: (body: { email: string; password: string }) =>
    req<{ user: import("./types").AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => req<{ user: import("./types").AuthUser }>("/api/auth/me"),
  changePassword: (body: { current_password: string; new_password: string }) =>
    req<{ ok: boolean }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateMyPreferences: (body: import("./types").UserPreferences) =>
    req<{ user: import("./types").AuthUser }>("/api/auth/me/preferences", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  listUsers: () => req<{ users: import("./types").AuthUser[] }>("/api/users"),
  createUser: (body: {
    email: string;
    password: string;
    role: import("./types").UserRole;
    profile_ids?: string[];
  }) =>
    req<{ user: import("./types").AuthUser }>("/api/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateUser: (
    id: string,
    body: {
      email?: string;
      password?: string;
      role?: import("./types").UserRole;
      profile_ids?: string[];
    },
  ) =>
    req<{ user: import("./types").AuthUser }>(`/api/users/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteUser: (id: string) =>
    req<{ ok: boolean }>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getEnpplifySettings: () =>
    req<import("./types").EnpplifyUserSettings>("/api/enpplify/settings"),
  getProfileAnswers: (profileId: string) =>
    req<{ items: import("./types").ProfileAnswer[] }>(
      `/api/enpplify/profile-answers?profileId=${encodeURIComponent(profileId)}`,
    ),
  saveProfileAnswer: (profileId: string, question: string, answer: string) =>
    req<{ items: import("./types").ProfileAnswer[] }>("/api/enpplify/profile-answers", {
      method: "PUT",
      body: JSON.stringify({ profileId, question, answer }),
    }),
  deleteProfileAnswer: (profileId: string, question: string) =>
    req<{ items: import("./types").ProfileAnswer[] }>(
      `/api/enpplify/profile-answers?profileId=${encodeURIComponent(profileId)}&question=${encodeURIComponent(question)}`,
      { method: "DELETE" },
    ),
  getAnswerPolicies: (profileId: string) =>
    req<{ items: import("./types").AnswerPolicy[] }>(
      `/api/enpplify/answer-policies?profileId=${encodeURIComponent(profileId)}`,
    ),
  saveAnswerPolicy: (
    profileId: string,
    policy: { id?: string; text?: string; enabled?: boolean },
  ) =>
    req<{ items: import("./types").AnswerPolicy[] }>("/api/enpplify/answer-policies", {
      method: "PUT",
      body: JSON.stringify({ profileId, ...policy }),
    }),
  deleteAnswerPolicy: (profileId: string, id: string) =>
    req<{ items: import("./types").AnswerPolicy[] }>(
      `/api/enpplify/answer-policies?profileId=${encodeURIComponent(profileId)}&id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  updateEnpplifySettings: (body: Partial<import("./types").EnpplifyUserSettings>) =>
    req<import("./types").EnpplifyUserSettings>("/api/enpplify/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  uploadBaseResume: (profileId: string, filename: string, dataBase64: string) =>
    req<import("./types").EnpplifyUserSettings>("/api/enpplify/base-resume", {
      method: "PUT",
      body: JSON.stringify({ profileId, filename, dataBase64 }),
    }),
  deleteBaseResume: (profileId: string) =>
    req<import("./types").EnpplifyUserSettings>(
      `/api/enpplify/base-resume?profileId=${encodeURIComponent(profileId)}`,
      { method: "DELETE" },
    ),
};
