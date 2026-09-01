import "./loadEnv.js";
import express from "express";
import cors from "cors";
import path from "node:path";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { dataDir, ensureDirs, projectRoot } from "./paths.js";
import { isSafeArtifactBasename } from "./filenameSafe.js";
import { readSettings, writeSettings } from "./appSettings.js";
import {
  listProfiles,
  readProfile,
  writeProfile,
  deleteProfile,
} from "./profileStore.js";
import {
  profileBodySchema,
  type ArtifactKey,
  type ArtifactStatus,
  type ResultJson,
} from "./types.js";
import { normalizeJobRefForGenerate, isHttpUrl } from "./jobRef.js";
import {
  appendApplication,
  getApplication,
  listApplications,
  removeApplication,
  updateApplication,
} from "./logStore.js";
import {
  readAllPrompts,
  writePrompts,
  resetPrompt,
  getPromptState,
  readVariant,
  writeVariant,
  deleteVariant,
  setActiveName,
  normalizeVariantName,
  listVariants,
  getActiveName,
} from "./promptStore.js";
import { DEFAULT_PROMPTS, type PromptKey } from "./defaultPrompts.js";
import { getThemeSummaries } from "./resumeThemes.js";
import { buildResumePreviewHtml } from "./resumePreview.js";
import { extractResumeFigures, newAppId, ownedArtifactName, runGeneration } from "./generation.js";
import { buildFolderZip, isShareableArtifact } from "./zip.js";
import {
  buildCaption,
  isTelegramConfigured,
  sendDocument,
  sendFiles,
  type TelegramResult,
} from "./telegram.js";

/**
 * Filename for a run's archive, taken from its output folder so several batches sitting in
 * a Downloads folder (or a Telegram channel) stay tellable apart.
 */
function zipBaseName(outputFolder: string): string {
  const base = path.basename(outputFolder) || "application";
  return base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100) || "application";
}

/**
 * Post a finished run's documents to Telegram. Best-effort by design: the PDFs are already
 * on disk, so a failed send is logged and nothing else changes.
 */
async function postRunToTelegram(
  outputFolderRel: string,
  job: { companyName: string; roleName: string; jobLink: string; recruiterName: string; profiles: string[] }
): Promise<void> {
  if (!isTelegramConfigured()) {
    console.warn("[enpply] telegram: requested but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set — skipping.");
    return;
  }
  try {
    const root = toAbsoluteFromStoredPath(outputFolderRel);
    const names = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isFile() && isShareableArtifact(d.name))
      .map((d) => d.name)
      .sort();
    if (names.length === 0) {
      console.warn("[enpply] telegram: nothing shareable in the run folder — skipping.");
      return;
    }

    // Loose files, not a ZIP: the recipient opens or forwards the PDFs directly. At the
    // volume this runs at, a ZIP per batch would mean unzipping dozens of times a day.
    // Telegram caps a group at 10, so anything larger falls back to a single archive.
    const caption = buildCaption(job);
    let r: TelegramResult;
    let what: string;
    if (names.length <= 10) {
      const files = await Promise.all(
        names.map(async (name) => ({
          filename: name,
          data: await fs.readFile(path.join(root, name)),
          mime: name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain",
        }))
      );
      r = await sendFiles(files, caption);
      what = `${names.length} file(s)`;
    } else {
      const { zip } = await buildFolderZip(root);
      r = await sendDocument(`${zipBaseName(outputFolderRel)}.zip`, zip, caption);
      what = `${names.length} files as one ZIP (over the 10-file group limit)`;
    }

    if (r.ok) console.log(`[enpply] telegram: sent ${what}.`);
    else console.warn(`[enpply] telegram: send FAILED — ${r.error}`);
  } catch (e) {
    console.warn("[enpply] telegram: send threw —", e instanceof Error ? e.message : String(e));
  }
}
import { resolveStepModel } from "./llmTiers.js";
import { runBulletsExperiment } from "./bulletsExperiment.js";
import { listBulletStoreProfiles, getProfileBulletsView } from "./bulletsTailoring.js";
import { answerFollowupQuestions, computeMatchScore } from "./qaMatchService.js";
import { buildFillMap, questionOf, jobContextFromResult } from "./fillMapService.js";
import {
  getProfileAnswers,
  getProfileAnswerMap,
  upsertProfileAnswer,
  deleteProfileAnswer,
  normalizeQuestion,
} from "./profileAnswers.js";
import {
  getAnswerPolicies,
  getEnabledPolicyTexts,
  upsertAnswerPolicy,
  deleteAnswerPolicy,
} from "./answerPolicies.js";
import {
  getEnpplifySettings,
  updateEnpplifySettings,
  settingsSchema as enpplifySettingsSchema,
  saveBaseResume,
  readBaseResume,
  clearBaseResume,
} from "./enpplifySettings.js";
import { USER_MESSAGE_LLM_FALLBACK, warnIfLlmKeyLooksInvalid } from "./llmLog.js";
import { createVerboseLogger, isVerboseEnabled } from "./verboseLog.js";
import { logLlmConfig, getLlmClientForConfig, getLlmModelForConfig, defaultModelForProvider } from "./llmClient.js";
import { jstYmdCompact, nowJstIso } from "./timeJst.js";
import {
  resolveUser,
  requireAuth,
  requireAdmin,
  canAccessProfile,
  canAccessApplication,
} from "./auth/middleware.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerUserRoutes } from "./auth/userRoutes.js";
import { unassignProfileFromAllUsers } from "./auth/userStore.js";

ensureDirs();
void readSettings()
  .then((s) => {
    logLlmConfig({ provider: s.llm_light.provider, model: s.llm_light.model });
    logLlmConfig({ provider: s.llm_heavy.provider, model: s.llm_heavy.model });
  })
  .catch(() => {});
void warnIfLlmKeyLooksInvalid();
console.log("[enpply] project root:", projectRoot());
console.log("[enpply] data dir:", dataDir());
if (isVerboseEnabled()) {
  console.log("[enpply] ENPPLY_VERBOSE is on — each generate run writes data/logs/verbose/<appId>.log (full step I/O)");
} else {
  const raw = process.env.ENPPLY_VERBOSE;
  if (raw !== undefined && String(raw).trim() !== "") {
    console.warn(
      `[enpply] ENPPLY_VERBOSE=${JSON.stringify(raw)} is not treated as enabled — use 1, true, yes, or on (restart server after .env changes)`
    );
  }
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(resolveUser);
registerAuthRoutes(app);
registerUserRoutes(app);
const cancelledRuns = new Set<string>();

const generateBody = z.object({
  resume_profile: z.string().min(1),
  job_link: z.string().default(""),
  /** Plain-text recruiter when there is no job URL (optional). */
  recruiter_name: z.string().nullable().optional(),
  job_description: z.string().min(1),
  apply_form: z.string().nullable().optional(),
  theme: z.string().optional(),
  gen_resume: z.boolean().optional(),
  gen_cover_letter: z.boolean().optional(),
  gen_cv: z.boolean().optional(),
  gen_answers: z.boolean().optional(),
  gen_fit_answer: z.boolean().optional(),
  ignore_duplicate_check: z.boolean().optional(),
  /** On duplicate, suffix the role with -1/-2/… instead of failing. */
  suffix_on_duplicate: z.boolean().optional(),
  /**
   * Manual company/role for a log-only run. When both are set AND neither
   * résumé nor cover letter is requested, the extraction LLM is skipped and
   * these values drive the log entry, folder, and duplicate check.
   */
  company_name: z.string().optional(),
  role_name: z.string().optional(),
  /** Post the finished documents to the configured Telegram channel. Opt-in per run. */
  send_to_telegram: z.boolean().optional(),
});

function normalizeJobLinkForDup(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${pathname}${u.search}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\s+/g, " ");
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/profiles", requireAuth, async (req, res) => {
  try {
    const rows = await listProfiles();
    if (req.user!.role === "admin") {
      res.json(rows);
      return;
    }
    const allowed = new Set(req.user!.profile_ids ?? []);
    res.json(rows.filter((r) => allowed.has(r.id)));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get<{ id: string }>("/api/profiles/:id", requireAuth, async (req, res) => {
  try {
    if (!canAccessProfile(req.user!, req.params.id)) {
      return res.status(404).json({ error: "Profile not found" });
    }
    const p = await readProfile(req.params.id);
    if (!p) return res.status(404).json({ error: "Profile not found" });
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Bullet groups for a profile (summary counts + bullets for the Profiles UI picker). */
app.get<{ id: string }>("/api/profiles/:id/bullets", requireAuth, async (req, res) => {
  try {
    if (!canAccessProfile(req.user!, req.params.id)) {
      return res.status(404).json({ error: "Profile not found" });
    }
    res.json(await getProfileBulletsView(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/profiles", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = profileBodySchema.parse(req.body);
    const existing = await readProfile(body.id);
    if (existing) return res.status(409).json({ error: "Profile id already exists" });
    await writeProfile(body);
    res.status(201).json(body);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.put<{ id: string }>("/api/profiles/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = profileBodySchema.parse({ ...req.body, id: req.params.id });
    await writeProfile(body);
    res.json(body);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete<{ id: string }>("/api/profiles/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ok = await deleteProfile(req.params.id);
    if (!ok) return res.status(404).json({ error: "Profile not found" });
    await unassignProfileFromAllUsers(req.params.id);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/config/settings", requireAuth, async (_req, res) => {
  try {
    const s = await readSettings();
    // Resolve the stored (possibly relative) output path against the project
    // root so the client can show a full absolute path and offer a Copy
    // button. Not persisted — the stored value stays portable.
    const default_output_path_abs = path.resolve(projectRoot(), s.default_output_path);
    res.json({ ...s, default_output_path_abs });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Résumé + cover letter PDF themes (HTML shells under `server/templates/`; see `registry.json`). */
/**
 * Whether the server can post to Telegram at all. The UI uses this to disable the
 * "send" checkbox and say why, instead of letting a run silently go nowhere.
 * Reports only configured/not — never the token.
 */
app.get("/api/config/telegram", requireAuth, (_req, res) => {
  res.json({ configured: isTelegramConfigured() });
});

app.get("/api/config/themes", requireAuth, (_req, res) => {
  try {
    res.json({ themes: getThemeSummaries() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** In-browser preview: résumé shell for `theme` filled with fixed sample Markdown (HTML, not PDF). */
app.get<{ theme: string }>("/api/preview/resume/:theme", requireAuth, async (req, res) => {
  try {
    const html = await buildResumePreviewHtml(req.params.theme);
    if (!html) return res.status(404).json({ error: "Unknown theme" });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(html);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.put("/api/config/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const providerEnum = z.enum(["openrouter", "openai", "deepseek", "gemini"]);
    const modelConfigSchema = z.object({
      provider: providerEnum,
      model: z.string().min(1).max(200),
    });
    const schema = z.object({
      ui_theme: z.enum(["light", "dark"]),
      default_output_path: z.string().min(1),
      default_theme: z.string().min(1),
      default_theme_by_profile: z.record(z.string()).optional(),
      // The two models the whole app runs on. Admin-only.
      llm_light: modelConfigSchema,
      llm_heavy: modelConfigSchema,
      // Optional per-step overrides; null/absent = fall back to the tier.
      llm_extraction: modelConfigSchema.nullish(),
      llm_generation: modelConfigSchema.nullish(),
    });
    const parsed = schema.parse(req.body);
    const trimModel = (m: z.infer<typeof modelConfigSchema>) => ({ provider: m.provider, model: m.model.trim() });
    await writeSettings({
      ui_theme: parsed.ui_theme,
      default_output_path: parsed.default_output_path,
      default_theme: parsed.default_theme,
      default_theme_by_profile: parsed.default_theme_by_profile ?? {},
      llm_light: trimModel(parsed.llm_light),
      llm_heavy: trimModel(parsed.llm_heavy),
      ...(parsed.llm_extraction ? { llm_extraction: trimModel(parsed.llm_extraction) } : {}),
      ...(parsed.llm_generation ? { llm_generation: trimModel(parsed.llm_generation) } : {}),
    });
    const fresh = await readSettings();
    res.json({
      ...fresh,
      default_output_path_abs: path.resolve(projectRoot(), fresh.default_output_path),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/config/prompts", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const prompts = await readAllPrompts();
    res.json(prompts);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.put("/api/config/prompts", requireAuth, requireAdmin, async (req, res) => {
  try {
    const schema = z.object({
      resume: z.string().optional(),
      coverLetter: z.string().optional(),
      qa: z.string().optional(),
      matchScore: z.string().optional(),
    });
    const parsed = schema.parse(req.body);
    const next = await writePrompts(parsed);
    res.json(next);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/config/prompt-defaults", requireAuth, requireAdmin, (_req, res) => {
  res.json(DEFAULT_PROMPTS);
});

const promptKeyParam = z.enum(["extraction", "resume", "coverLetter", "qa", "matchScore"]);

/** Prompt text for each key (active variant) plus registry of names per key. */
app.get("/api/config/prompts/full", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const prompts = await readAllPrompts();
    const meta = await getPromptState();
    res.json({ prompts, meta });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/config/prompts/meta", requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json(await getPromptState());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get<{ key: string; name: string }>(
  "/api/config/prompts/:key/variants/:name",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const key = promptKeyParam.parse(req.params.key);
      const name = req.params.name;
      const content = await readVariant(key, name);
      res.json({ content });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

app.put<{ key: string }>(
  "/api/config/prompts/:key/active",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const key = promptKeyParam.parse(req.params.key);
      const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
      await setActiveName(key, name);
      res.json({ ok: true, ...(await getPromptState()) });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

app.put<{ key: string; name: string }>(
  "/api/config/prompts/:key/variants/:name",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const key = promptKeyParam.parse(req.params.key);
      const name = req.params.name;
      const { content } = z.object({ content: z.string() }).parse(req.body);
      await writeVariant(key, name, content);
      res.json({ ok: true, content: await readVariant(key, name) });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

app.post<{ key: string }>(
  "/api/config/prompts/:key/variants",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const key = promptKeyParam.parse(req.params.key);
      const { name, content } = z
        .object({
          name: z.string().min(1).max(48),
          content: z.string().optional(),
        })
        .parse(req.body);
      const slug = normalizeVariantName(name);
      if (slug === "default") {
        return res.status(400).json({ error: 'Use a name other than "default" for new variants.' });
      }
      const variants = await listVariants(key);
      if (variants.includes(slug)) {
        return res.status(409).json({ error: `Variant "${slug}" already exists.` });
      }
      const initial = content ?? (await readVariant(key, await getActiveName(key)));
      await writeVariant(key, slug, initial);
      res.json({ ok: true, name: slug, ...(await getPromptState()) });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

app.delete<{ key: string; name: string }>(
  "/api/config/prompts/:key/variants/:name",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const key = promptKeyParam.parse(req.params.key);
      const name = req.params.name;
      await deleteVariant(key, name);
      res.json({ ok: true, ...(await getPromptState()) });
    } catch (e) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

app.post<{ key: string }>(
  "/api/config/prompts/:key/reset",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const key = req.params.key as PromptKey;
      if (!(key in DEFAULT_PROMPTS)) return res.status(400).json({ error: "Invalid prompt key" });
      await resetPrompt(key);
      res.json(await readAllPrompts());
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

/**
 * Admin "Playground" — send an arbitrary system+user prompt straight to a
 * chosen provider/model and return the raw reply. Not part of any generation
 * flow; purely for poking at models. Keys stay server-side in `.env`.
 */
app.post("/api/playground/chat", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = z
      .object({
        system: z.string().max(100_000).optional().default(""),
        user: z.string().min(1).max(100_000),
        provider: z.enum(["openrouter", "openai", "deepseek", "gemini"]),
        model: z.string().min(1).max(200),
        temperature: z.number().min(0).max(2).optional(),
      })
      .parse(req.body ?? {});

    const llm = { provider: body.provider, model: body.model };
    const client = getLlmClientForConfig(llm);
    const model = getLlmModelForConfig(llm);
    const messages = [
      ...(body.system.trim() ? [{ role: "system" as const, content: body.system }] : []),
      { role: "user" as const, content: body.user },
    ];

    // gpt-5 / o-series reject an explicit temperature; omit it for those.
    const lower = model.toLowerCase();
    const noTemp =
      lower.startsWith("gpt-5") ||
      /^o[1-9](-|$)/.test(lower) ||
      lower.startsWith("openai/gpt-5") ||
      /^openai\/o[1-9](-|$)/.test(lower);

    const startedAt = performance.now();
    const completion = await client.chat.completions.create({
      model,
      messages,
      ...(noTemp || body.temperature === undefined ? {} : { temperature: body.temperature }),
    });
    const text = completion.choices[0]?.message?.content ?? "";
    res.json({
      text,
      provider: llm.provider,
      model,
      finish_reason: completion.choices[0]?.finish_reason ?? null,
      usage: completion.usage ?? null,
      elapsed_ms: Math.round(performance.now() - startedAt),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Bullets-experiment harness (admin Playground → "Bullets Experiment" tab).
 * Runs the design in Experiment/enpply_tailoring_system.md against a JD using a
 * pre-built bullet store. Isolated from the production generation pipeline.
 */
app.get("/api/playground/bullets/profiles", requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json({ profiles: await listBulletStoreProfiles() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/playground/bullets/run", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = z
      .object({
        profileId: z.string().min(1).max(120),
        jd_text: z.string().min(1).max(100_000),
        provider: z.enum(["openrouter", "openai", "deepseek", "gemini"]),
        model: z.string().min(1).max(200),
        inject_provider: z.enum(["openrouter", "openai", "deepseek", "gemini"]).optional(),
        inject_model: z.string().min(1).max(200).optional(),
        run_injection: z.boolean().optional().default(true),
      })
      .parse(req.body ?? {});

    const extractionLlm = { provider: body.provider, model: body.model };
    const injectionLlm = {
      provider: body.inject_provider ?? body.provider,
      model: body.inject_model ?? body.model,
    };
    const result = await runBulletsExperiment({
      profileId: body.profileId,
      jdText: body.jd_text,
      extractionLlm,
      injectionLlm,
      runInjection: body.run_injection,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/applications", requireAuth, async (req, res) => {
  try {
    const apps = await listApplications();
    // Decorate each row with `output_folder_abs` so the Logs page can show
    // a Copy-path button without a round-trip per row. Empty output_folder
    // (e.g. a freshly-queued run that hasn't finished extraction yet) is
    // passed through as an empty string.
    const withAbs = apps.map((a) => ({
      ...a,
      output_folder_abs: a.output_folder ? toAbsoluteFromStoredPath(a.output_folder) : "",
    }));
    if (req.user!.role === "admin") {
      res.json({ applications: withAbs });
      return;
    }
    res.json({ applications: withAbs.filter((a) => a.user_id === req.user!.id) });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

function toAbsoluteFromStoredPath(storedPath: string): string {
  return path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(projectRoot(), storedPath);
}

async function patchResultJsonForApplication(
  id: string,
  patch: Partial<Pick<ResultJson, "company_name" | "role_name" | "job_link" | "recruiter_name">>
): Promise<void> {
  const entry = await getApplication(id);
  if (!entry?.result_file) return;
  const abs = toAbsoluteFromStoredPath(entry.result_file);
  try {
    const raw = await fs.readFile(abs, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (patch.company_name !== undefined) data.company_name = patch.company_name;
    if (patch.role_name !== undefined) data.role_name = patch.role_name;
    if (patch.job_link !== undefined) data.job_link = patch.job_link;
    if (patch.recruiter_name !== undefined) data.recruiter_name = patch.recruiter_name;
    await fs.writeFile(abs, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Missing or unreadable result file — log entry still updates.
  }
}

async function removeDirIfExists(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

async function nextRunUuid(profileId: string): Promise<string> {
  const ymd = jstYmdCompact();
  const rows = await listApplications();
  const prefix = `${profileId}-${ymd}-`;
  let max = 0;
  for (const r of rows) {
    const ru = (r as { run_uuid?: string }).run_uuid;
    if (!ru || !ru.startsWith(prefix)) continue;
    const n = Number(ru.slice(prefix.length));
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

/** Download or open a generated file (must be registered before /api/applications/:id). */
app.get<{ id: string; name: string }>(
  "/api/applications/:id/artifacts/:name",
  requireAuth,
  async (req, res) => {
    try {
      const name = req.params.name;
      if (!isSafeArtifactBasename(name)) {
        return res.status(400).json({ error: "Unknown artifact name" });
      }
      const entry = await getApplication(req.params.id);
      if (!entry?.output_folder) return res.status(404).json({ error: "Application not found" });
      if (!canAccessApplication(req.user!, entry)) {
        return res.status(404).json({ error: "Application not found" });
      }
      const root = toAbsoluteFromStoredPath(entry.output_folder);
      const filePath = path.resolve(root, name);
      const rel = path.relative(root, filePath);
      if (rel.startsWith("..")) {
        return res.status(403).json({ error: "Invalid path" });
      }
      await fs.access(filePath);
      if (name.endsWith(".pdf")) res.setHeader("Content-Type", "application/pdf");
      else if (name.endsWith(".json")) res.setHeader("Content-Type", "application/json; charset=utf-8");
      else if (name.endsWith(".md")) res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      else if (name.endsWith(".txt")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "File not found" });
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return res.status(404).json({ error: "Not found" });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  },
);

/**
 * Download a run's whole output folder as one ZIP.
 *
 * For a BATCH this is the point of the feature: the folder holds every profile's résumé
 * for one job description, so one click gets the lot. For a single run it is simply that
 * run's files. Must be registered before /api/applications/:id so the route is not shadowed.
 */
app.get<{ id: string }>("/api/applications/:id/folder.zip", requireAuth, async (req, res) => {
  try {
    const entry = await getApplication(req.params.id);
    if (!entry?.output_folder) return res.status(404).json({ error: "Application not found" });
    if (!canAccessApplication(req.user!, entry)) {
      return res.status(404).json({ error: "Application not found" });
    }
    const root = toAbsoluteFromStoredPath(entry.output_folder);
    // `?all=1` returns the whole folder for the owner's own debugging. The default is the
    // shareable set only — see buildFolderZip; the folder also holds the system prompts.
    let zip: Buffer;
    let names: string[];
    try {
      ({ zip, names } = await buildFolderZip(root, { all: req.query.all === "1" }));
    } catch {
      return res.status(404).json({ error: "Output folder not found" });
    }
    if (names.length === 0) return res.status(404).json({ error: "No documents in this run yet" });

    // Name the download after the folder (e.g. 083251_Acme_Senior_Engineer.zip) so several
    // batches in the Downloads folder stay tellable apart.
    const safe = zipBaseName(entry.output_folder);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.zip"`);
    res.setHeader("Content-Length", String(zip.length));
    res.end(zip);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get<{ id: string }>("/api/applications/:id", requireAuth, async (req, res) => {
  try {
    const entry = await getApplication(req.params.id);
    if (!entry) return res.status(404).json({ error: "Application not found" });
    if (!canAccessApplication(req.user!, entry)) {
      return res.status(404).json({ error: "Application not found" });
    }
    const resultFileAbs = toAbsoluteFromStoredPath(entry.result_file);
    const raw = await fs.readFile(resultFileAbs, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const storedOut = typeof data.output_folder === "string" ? data.output_folder : entry.output_folder;
    res.json({
      ...data,
      output_folder: storedOut,
      output_folder_abs: toAbsoluteFromStoredPath(storedOut),
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete<{ id: string }>("/api/applications/:id", requireAuth, async (req, res) => {
  try {
    const entry = await getApplication(req.params.id);
    if (!entry) return res.status(404).json({ error: "Application not found" });
    if (!canAccessApplication(req.user!, entry)) {
      return res.status(404).json({ error: "Application not found" });
    }

    if (entry.output_folder) {
      const root = toAbsoluteFromStoredPath(entry.output_folder);
      await removeDirIfExists(root);
    }

    // Optional cleanup for verbose logs created as data/logs/verbose/<appId>.log
    const verbosePath = path.join(projectRoot(), "data", "logs", "verbose", `${entry.id}.log`);
    try {
      await fs.unlink(verbosePath);
    } catch {
      // ignore if absent
    }

    await removeApplication(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

const rerunBody = z
  .object({
    gen_resume: z.boolean().optional(),
    gen_cover_letter: z.boolean().optional(),
    gen_answers: z.boolean().optional(),
    gen_fit_answer: z.boolean().optional(),
    /**
     * Replacement job description for this rerun. Empty/omitted = reuse the
     * one stored in result.json. When provided, it overwrites the stored JD
     * (so subsequent reruns start from the new text too).
     */
    job_description: z.string().max(200_000).optional(),
    /** Extra context / apply-form text. Appended to the prompts; not persisted. */
    apply_form: z.string().max(50_000).nullable().optional(),
    /**
     * PDF theme for this rerun. Omitted = keep whatever the slot was created with.
     * Without this the theme was frozen at creation, so the picker silently did
     * nothing on every rerun and the layout looked like it changed at random.
     */
    theme: z.string().optional(),
  })
  .refine(
    (b) => b.gen_resume === true || b.gen_cover_letter === true || b.gen_answers === true || b.gen_fit_answer === true,
    { message: "Pick at least one item to rerun (resume, cover letter, answers, or fit answer)." }
  );

app.post<{ id: string }>("/api/applications/:id/rerun", requireAuth, async (req, res) => {
  try {
    const entry = await getApplication(req.params.id);
    if (!entry) return res.status(404).json({ error: "Application not found" });
    if (!canAccessApplication(req.user!, entry)) {
      return res.status(404).json({ error: "Application not found" });
    }
    if (entry.status === "generating") {
      return res.status(409).json({ error: "This run is still generating — wait for it to finish." });
    }
    if (!canAccessProfile(req.user!, entry.resume_profile)) {
      return res.status(403).json({ error: "You don't have access to this profile." });
    }
    const body = rerunBody.parse(req.body);

    const profile = await readProfile(entry.resume_profile);
    if (!profile) return res.status(400).json({ error: "Original profile no longer exists." });

    // Try to load the prior result so we can reuse its folder + artifact/answer
    // state. If it's missing (a run that failed before writing result.json — a
    // duplicate rejection or extraction failure — or whose files were deleted),
    // DON'T dead-end: fall back to a FRESH generation under the same appId so
    // Regenerate always works.
    let prior: ResultJson | null = null;
    const resultFileAbs = entry.result_file ? toAbsoluteFromStoredPath(entry.result_file) : "";
    if (resultFileAbs && entry.output_folder) {
      try {
        prior = JSON.parse(await fs.readFile(resultFileAbs, "utf8")) as ResultJson;
      } catch {
        prior = null;
      }
    }

    const overrideJd = (body.job_description ?? "").trim();
    const storedJd = typeof prior?.job_description === "string" ? prior.job_description : "";
    const jobDescription = overrideJd.length > 0 ? overrideJd : storedJd;
    if (!jobDescription.trim()) {
      return res.status(400).json({
        error:
          "No job description on file and none was provided in this rerun — open the job page and regenerate from there.",
      });
    }
    const applyFormForRerun = body.apply_form && body.apply_form.trim().length > 0 ? body.apply_form : null;

    const settings = await readSettings();
    // An explicit choice on THIS rerun wins; otherwise keep the slot's stored theme.
    const theme =
      (body.theme && body.theme.trim()) || prior?.theme || entry.theme || settings.default_theme;
    // Reuse the prior output folder only when we have a prior result; otherwise
    // a fresh generation computes a new folder under the output root.
    const outputFolderRel = prior ? entry.output_folder : "";
    const outputFolderAbs = outputFolderRel ? toAbsoluteFromStoredPath(outputFolderRel) : "";

    await updateApplication(entry.id, {
      status: "generating",
      status_step: "queued",
      tracking_status: "pending",
      generation_error: "",
    });

    const verboseLog = await createVerboseLogger(entry.id);
    if (verboseLog) {
      await verboseLog.writeSection(
        "HTTP POST /api/applications/:id/rerun — body (parsed)",
        JSON.stringify({ appId: entry.id, ...body }, null, 2)
      );
    }

    res.json({
      id: entry.id,
      run_uuid: entry.run_uuid,
      status: "generating",
      output_folder: outputFolderRel,
      output_folder_abs: outputFolderAbs,
      result_file: entry.result_file,
      result_file_abs: resultFileAbs,
      llm_fallback_used: false,
      ...(verboseLog ? { verbose_log_file: verboseLog.filePath } : {}),
    });

    void (async () => {
      try {
        cancelledRuns.delete(entry.id);
        const toastStage = (step: string) => {
          const label: Record<string, string> = {
            queued: "queued",
            extracting_keywords: "extracting_keywords",
            generating_resume: "generating_resume",
            generating_cover_letter: "generating_cover_letter",
            generating_answers: "generating_answers",
            completed: "completed",
          };
          return label[step] ?? step;
        };
        const result = await runGeneration({
          profile,
          job_link: prior?.job_link || entry.job_link || "",
          recruiter_name: prior?.recruiter_name || entry.recruiter_name || "",
          job_description: jobDescription,
          apply_form: applyFormForRerun,
          theme,
          appId: entry.id,
          outputRootAbs: path.resolve(projectRoot(), settings.default_output_path),
          llmLight: settings.llm_light,
          llmHeavy: settings.llm_heavy,
          llmExtraction: settings.llm_extraction,
          llmGeneration: settings.llm_generation,
          llmTiers: req.user!.preferences?.llm_tiers,
          gen_resume: body.gen_resume === true,
          gen_cover_letter: body.gen_cover_letter === true,
          gen_answers: body.gen_answers === true,
          gen_fit_answer: body.gen_fit_answer === true,
          ignore_duplicate_check: true,
          run_uuid: entry.run_uuid,
          onStage: async (stage) => {
            if (cancelledRuns.has(entry.id)) {
              throw new Error("Run cancelled by user.");
            }
            await updateApplication(entry.id, {
              status: "generating",
              status_step: toastStage(stage),
            });
          },
          shouldCancel: () => cancelledRuns.has(entry.id),
          verbose: verboseLog,
          // Reuse the prior folder + artifact/answer state when we have a prior
          // result; otherwise generate fresh into a new folder under the root.
          ...(prior
            ? {
                reuseFolder: {
                  outputFolderAbs,
                  outputFolderRel,
                  priorArtifactStatus: prior.artifact_status,
                  priorArtifacts: prior.artifacts,
                  priorAnswers: prior.answers ?? [],
                  priorCompanyName: prior.company_name,
                  priorRoleName: prior.role_name,
                  priorCreatedAt: prior.created_at,
                  priorQuickReference: prior.quick_reference,
                  priorApplyForm: typeof prior.apply_form === "string" ? prior.apply_form : "",
                },
              }
            : {}),
        });
        const resultPathRel = path.join(result.output_folder, "result.json").split(path.sep).join("/");
        await updateApplication(entry.id, {
          company_name: result.company_name,
          role_name: result.role_name,
          status: result.status,
          status_step: result.status === "completed" ? "completed" : "failed",
          output_folder: result.output_folder,
          result_file: resultPathRel,
          generation_error: result.status === "failed" ? (result.error ?? "Rerun failed") : "",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[enpply] HTTP rerun runGeneration threw appId=${entry.id}`, err);
        await updateApplication(entry.id, {
          status: "failed",
          status_step: /cancelled/i.test(msg) ? "cancelled" : "failed",
          generation_error: msg,
        });
      } finally {
        cancelledRuns.delete(entry.id);
      }
    })();
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Patch fields on a run's result.json on disk (best-effort).
 * Skips when the run is mid-generation, since runGeneration rewrites the whole
 * file on completion and would clobber our patch.
 */
async function patchResultJsonExtras(
  appId: string,
  patch: (data: Record<string, unknown>) => void,
): Promise<boolean> {
  const entry = await getApplication(appId);
  if (!entry || entry.status === "generating" || !entry.result_file) return false;
  try {
    const abs = toAbsoluteFromStoredPath(entry.result_file);
    const raw = await fs.readFile(abs, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    patch(data);
    await fs.writeFile(abs, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch {
    // best-effort persistence — caller still returns the live computed value
    return false;
  }
}

async function loadProfileAndResultForApp(
  appId: string,
  user: NonNullable<Parameters<typeof canAccessApplication>[0]>,
): Promise<
  | { ok: true; profile: import("./types.js").Profile; result: ResultJson }
  | { ok: false; status: number; error: string }
> {
  const entry = await getApplication(appId);
  if (!entry) return { ok: false, status: 404, error: "Application not found" };
  if (!canAccessApplication(user, entry)) {
    return { ok: false, status: 404, error: "Application not found" };
  }
  if (!canAccessProfile(user, entry.resume_profile)) {
    return { ok: false, status: 403, error: "You don't have access to this profile." };
  }
  const profile = await readProfile(entry.resume_profile);
  if (!profile) return { ok: false, status: 400, error: "Profile no longer exists." };
  if (!entry.result_file) {
    return { ok: false, status: 400, error: "This run has no stored result file." };
  }
  const resultFileAbs = toAbsoluteFromStoredPath(entry.result_file);
  let result: ResultJson;
  try {
    const raw = await fs.readFile(resultFileAbs, "utf8");
    result = JSON.parse(raw) as ResultJson;
  } catch {
    return { ok: false, status: 400, error: "Result file is missing or unreadable." };
  }
  return { ok: true, profile, result };
}

app.post<{ id: string }>("/api/applications/:id/qa", requireAuth, async (req, res) => {
  try {
    const body = z
      .object({
        /** Raw user input — may contain one or several questions; the model splits them. */
        question: z.string().min(1).max(8000),
      })
      .parse(req.body);
    const loaded = await loadProfileAndResultForApp(req.params.id, req.user!);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error });
    const settings = await readSettings();
    // Follow-up Q&A uses the user's "answers" function tier.
    const llm = resolveStepModel("qa", settings, req.user!.preferences?.llm_tiers);
    const pairs = await answerFollowupQuestions({
      profile: loaded.profile,
      result: loaded.result,
      input: body.question,
      policies: await getEnabledPolicyTexts(loaded.profile.id),
      llm,
    });
    if (pairs.length === 0) {
      return res
        .status(422)
        .json({ error: "No questions detected in the input. Try rephrasing as one or more questions." });
    }
    const askedAt = nowJstIso();
    const items = pairs.map((p) => ({ ...p, llm, asked_at: askedAt }));
    await patchResultJsonExtras(req.params.id, (data) => {
      const prior = Array.isArray(data.followups) ? (data.followups as unknown[]) : [];
      data.followups = [...prior, ...items];
    });
    res.json({ items });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post<{ id: string }>("/api/applications/:id/match-score", requireAuth, async (req, res) => {
  try {
    const loaded = await loadProfileAndResultForApp(req.params.id, req.user!);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error });
    // Match score model: an explicit provider (+model) chosen on the Result page wins;
    // otherwise fall back to the user's "matchScore" function tier.
    const overrideBody = z
      .object({
        provider: z.enum(["openrouter", "openai", "deepseek", "gemini"]).optional(),
        model: z.string().trim().optional(),
      })
      .parse(req.body ?? {});
    const llm = overrideBody.provider
      ? { provider: overrideBody.provider, model: overrideBody.model || defaultModelForProvider(overrideBody.provider) }
      : resolveStepModel("matchScore", await readSettings(), req.user!.preferences?.llm_tiers);
    const score = await computeMatchScore({
      profile: loaded.profile,
      result: loaded.result,
      llm,
    });
    const summary = { ...score, llm, computed_at: nowJstIso() };
    await patchResultJsonExtras(req.params.id, (data) => {
      data.match_score = summary;
    });
    res.json(summary);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Map a job application form's fields to values (Tryvify "Fill"). The
 * extension harvests each field into a descriptor with a self-minted `ref`,
 * posts the batch here, and applies the returned `ref -> value` map back onto
 * the page. Selectors never leave the browser. Heuristic match first, then a
 * single batched LLM call for the leftovers.
 */
/**
 * Per-user Tryvify extension settings (feature flags, fill-map LLM override,
 * autofill password). Each user manages only their own. The autofill password
 * is returned only to its owner and never logged.
 */
app.get("/api/enpplify/settings", requireAuth, async (req, res) => {
  try {
    res.json(await getEnpplifySettings(req.user!.id));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.put("/api/enpplify/settings", requireAuth, async (req, res) => {
  try {
    const patch = enpplifySettingsSchema.parse(req.body);
    res.json(await updateEnpplifySettings(req.user!.id, patch));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Upload the per-user base résumé PDF (used when "Use base resume" is on, so
 * the extension attaches this instead of a per-job tailored résumé). Body is
 * JSON { filename, dataBase64 }; a larger json limit is applied just here since
 * the global limit is 2mb.
 */
app.put("/api/enpplify/base-resume", requireAuth, express.json({ limit: "12mb" }), async (req, res) => {
  try {
    const body = z
      .object({
        profileId: z.string().min(1).max(128),
        filename: z.string().max(255).optional(),
        dataBase64: z.string().min(1),
      })
      .parse(req.body);
    const comma = body.dataBase64.indexOf(",");
    const b64 = comma >= 0 && body.dataBase64.slice(0, comma).includes("base64")
      ? body.dataBase64.slice(comma + 1)
      : body.dataBase64;
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0) return res.status(400).json({ error: "Empty file." });
    if (bytes.length > 10 * 1024 * 1024) return res.status(413).json({ error: "File too large (max 10MB)." });
    // Sanity-check it's a PDF (magic bytes %PDF).
    if (bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
      return res.status(400).json({ error: "File does not look like a PDF." });
    }
    await saveBaseResume(req.user!.id, body.profileId, bytes, body.filename ?? "base_resume.pdf");
    res.json(await getEnpplifySettings(req.user!.id));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Download the caller's base résumé PDF (extension fetches this to attach). */
app.get("/api/enpplify/base-resume", requireAuth, async (req, res) => {
  try {
    const profileId = z.string().min(1).max(128).parse(req.query.profileId);
    const bytes = await readBaseResume(req.user!.id, profileId);
    if (!bytes) return res.status(404).json({ error: "No base resume uploaded for this profile." });
    const settings = await getEnpplifySettings(req.user!.id);
    const name = settings.base_resume_names?.[profileId] ?? "base_resume.pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${name.replace(/"/g, "")}"`);
    res.send(bytes);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/api/enpplify/base-resume", requireAuth, async (req, res) => {
  try {
    const profileId = z.string().min(1).max(128).parse(req.query.profileId);
    await clearBaseResume(req.user!.id, profileId);
    res.json(await getEnpplifySettings(req.user!.id));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- per-profile reusable answers -----------------------------------------
// A profile-scoped store of question→answer the user marks "reusable". Served
// with no LLM for every application on that profile (Without-AI). Managed from
// the extension panel and the web /enpplify tab.

app.get("/api/enpplify/profile-answers", requireAuth, async (req, res) => {
  try {
    const profileId = z.string().min(1).max(128).parse(req.query.profileId);
    if (!canAccessProfile(req.user!, profileId)) return res.status(404).json({ error: "Profile not found" });
    res.json({ items: await getProfileAnswers(profileId) });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.put("/api/enpplify/profile-answers", requireAuth, async (req, res) => {
  try {
    const body = z
      .object({
        profileId: z.string().min(1).max(128),
        question: z.string().min(1).max(2000),
        answer: z.string().max(8000),
      })
      .parse(req.body);
    if (!canAccessProfile(req.user!, body.profileId)) return res.status(404).json({ error: "Profile not found" });
    const items = await upsertProfileAnswer(body.profileId, body.question, body.answer);
    res.json({ items });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/api/enpplify/profile-answers", requireAuth, async (req, res) => {
  try {
    const profileId = z.string().min(1).max(128).parse(req.query.profileId);
    const question = z.string().min(1).max(2000).parse(req.query.question);
    if (!canAccessProfile(req.user!, profileId)) return res.status(404).json({ error: "Profile not found" });
    const items = await deleteProfileAnswer(profileId, question);
    res.json({ items });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- per-profile answering policies ---------------------------------------
// Free-text DIRECTIVES (not fixed answers) the model follows when filling/Q&A —
// e.g. how to derive a salary figure from the posted range. Injected as
// authoritative instructions into the fill + Q&A prompts. See answerPolicies.ts.

app.get("/api/enpplify/answer-policies", requireAuth, async (req, res) => {
  try {
    const profileId = z.string().min(1).max(128).parse(req.query.profileId);
    if (!canAccessProfile(req.user!, profileId)) return res.status(404).json({ error: "Profile not found" });
    res.json({ items: await getAnswerPolicies(profileId) });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Upsert: with `id` edits that policy (text and/or enabled); without `id` appends.
app.put("/api/enpplify/answer-policies", requireAuth, async (req, res) => {
  try {
    const body = z
      .object({
        profileId: z.string().min(1).max(128),
        id: z.string().max(128).optional(),
        text: z.string().max(8000).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    if (!canAccessProfile(req.user!, body.profileId)) return res.status(404).json({ error: "Profile not found" });
    const items = await upsertAnswerPolicy(body.profileId, {
      id: body.id,
      text: body.text,
      enabled: body.enabled,
    });
    res.json({ items });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/api/enpplify/answer-policies", requireAuth, async (req, res) => {
  try {
    const profileId = z.string().min(1).max(128).parse(req.query.profileId);
    const id = z.string().min(1).max(128).parse(req.query.id);
    if (!canAccessProfile(req.user!, profileId)) return res.status(404).json({ error: "Profile not found" });
    const items = await deleteAnswerPolicy(profileId, id);
    res.json({ items });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Upsert (or, with an empty answer, delete) one answer in an application's
 * shared `result.json` answers — used when the user edits a Without-AI answer
 * whose origin is this application. Matched/keyed by normalized question.
 */
app.put<{ id: string }>("/api/applications/:id/answers", requireAuth, async (req, res) => {
  try {
    const body = z
      .object({ question: z.string().min(1).max(2000), answer: z.string().max(8000) })
      .parse(req.body);
    const loaded = await loadProfileAndResultForApp(req.params.id, req.user!);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error });
    const key = normalizeQuestion(body.question);
    const trimmed = body.answer.trim();
    const persisted = await patchResultJsonExtras(req.params.id, (data) => {
      const answers = (Array.isArray(data.answers) ? data.answers : (data.answers = [])) as {
        question: string;
        answer: string;
      }[];
      const idx = answers.findIndex((a) => normalizeQuestion(a?.question || "") === key);
      if (idx >= 0) {
        if (trimmed) answers[idx] = { question: answers[idx].question || body.question, answer: trimmed };
        else answers.splice(idx, 1);
      } else if (trimmed) {
        answers.push({ question: body.question, answer: trimmed });
      }
    });
    // patchResultJsonExtras is best-effort and SKIPS a run that is mid-generation
    // (runGeneration rewrites result.json wholesale on completion, so a patch
    // written now would be clobbered on finish). Returning ok:true in that case
    // made the extension's "Add to Q&A" look successful while the answer was
    // silently discarded, which is exactly how that button appeared dead.
    if (!persisted) {
      return res.status(409).json({
        error:
          "Answer not saved: this run's result file could not be written. " +
          "If a generation is still in progress, wait for it to finish and add the answer again.",
      });
    }
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Store/refresh the full application-form page text on a run (separate from the
 * JD). The extension calls this whenever Q&A runs on the apply page so the
 * application record always carries the latest page text. Empty clears it.
 */
app.put<{ id: string }>("/api/applications/:id/apply-form", requireAuth, async (req, res) => {
  try {
    const body = z.object({ apply_form: z.string().max(200_000) }).parse(req.body ?? {});
    const loaded = await loadProfileAndResultForApp(req.params.id, req.user!);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error });
    const text = body.apply_form.trim();
    await patchResultJsonExtras(req.params.id, (data) => {
      if (text) data.apply_form = text;
      else delete data.apply_form;
    });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

const fillMapFieldSchema = z.object({
  ref: z.string().min(1).max(64),
  label: z.string().max(2000).optional(),
  name: z.string().max(500).optional(),
  id: z.string().max(500).optional(),
  placeholder: z.string().max(1000).optional(),
  ariaLabel: z.string().max(1000).optional(),
  autocomplete: z.string().max(100).optional(),
  type: z.string().max(40).optional(),
  // Real selects can be long (country ≈250, some location pickers more), so
  // allow a generous cap; the client caps to the same bound before sending.
  options: z.array(z.string().max(500)).max(1000).optional(),
  surroundingText: z.string().max(4000).optional(),
});

app.post<{ id: string }>("/api/applications/:id/fill-map", requireAuth, async (req, res) => {
  try {
    const body = z
      .object({
        fields: z.array(fillMapFieldSchema).min(1).max(600),
        mode: z.enum(["heuristic", "ai", "both"]).optional(),
      })
      .parse(req.body);

    const loaded = await loadProfileAndResultForApp(req.params.id, req.user!);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error });

    // Filling application answers is "answers"-tier work — use the user's
    // answers-function tier. (Heuristic mode never calls the LLM.)
    const settings = await readSettings();
    const llm = resolveStepModel("fill", settings, req.user!.preferences?.llm_tiers);
    // Saved answers served with no LLM: this application's stored answers
    // (result.json `answers`, the shared source) merged with the profile's
    // reusable answers — profile takes precedence.
    // Easy Fill is PROFILE-store only: profile basics (heuristic) + the profile's
    // reusable answers. This application's saved answers belong to Q&A, not here.
    const savedAnswers = new Map<string, { answer: string; origin: "app" | "profile" }>();
    const profileMap = await getProfileAnswerMap(loaded.profile.id);
    for (const [k, v] of profileMap) savedAnswers.set(k, { answer: v, origin: "profile" });
    // The full reusable-answer list also goes to the AI pass as context.
    const reusableAnswers = await getProfileAnswers(loaded.profile.id);
    const policies = await getEnabledPolicyTexts(loaded.profile.id);

    const result = await buildFillMap({
      fields: body.fields,
      profile: loaded.profile,
      context: jobContextFromResult(loaded.result),
      llm,
      mode: body.mode,
      savedAnswers,
      reusableAnswers,
      policies,
    });

    // Persist freshly AI-generated answers into this application's shared
    // `answers` so next time they're served instantly (Without-AI) for this app.
    const aiValues = result.values.filter((v) => v.source === "ai");
    if (aiValues.length > 0) {
      const byRef = new Map(body.fields.map((f) => [f.ref, f]));
      await patchResultJsonExtras(req.params.id, (data) => {
        const answers = (Array.isArray(data.answers) ? data.answers : (data.answers = [])) as {
          question: string;
          answer: string;
        }[];
        for (const v of aiValues) {
          const f = byRef.get(v.ref);
          const q = f ? questionOf(f) : "";
          if (!q) continue;
          const key = normalizeQuestion(q);
          const idx = answers.findIndex((a) => normalizeQuestion(a?.question || "") === key);
          if (idx >= 0) answers[idx] = { question: answers[idx].question || q, answer: v.value };
          else answers.push({ question: q, answer: v.value });
        }
      });
    }

    res.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Profile-scoped fill-map — no generated run required.
 *  - "Easy Fill" (mode heuristic, default): page standard fields + the profile's
 *    reusable answers, from the profile alone.
 *  - Run-free Q&A (mode ai/both): the caller passes the current page's job text
 *    (job_description / apply_form), so the AI pass can answer open questions
 *    without a stored run. This powers Q&A Generate before/while generating.
 */
app.post("/api/enpplify/fill-map", requireAuth, async (req, res) => {
  try {
    const body = z
      .object({
        profileId: z.string().min(1),
        fields: z.array(fillMapFieldSchema).min(1).max(600),
        mode: z.enum(["heuristic", "ai", "both"]).optional(),
        // Optional job context for the AI pass (no stored run needed).
        job_description: z.string().max(100_000).optional(),
        apply_form: z.string().max(100_000).optional(),
        company: z.string().max(500).optional(),
        role: z.string().max(500).optional(),
      })
      .parse(req.body);
    if (!canAccessProfile(req.user!, body.profileId)) {
      return res.status(404).json({ error: "Profile not found" });
    }
    const profile = await readProfile(body.profileId);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const settings = await readSettings();
    const llm = resolveStepModel("fill", settings, req.user!.preferences?.llm_tiers);
    // Easy Fill is PROFILE-store only: profile basics (heuristic) + the
    // profile's reusable answers. No per-application answers here (no run).
    const savedAnswers = new Map<string, { answer: string; origin: "app" | "profile" }>();
    const profileMap = await getProfileAnswerMap(profile.id);
    for (const [k, v] of profileMap) savedAnswers.set(k, { answer: v, origin: "profile" });
    const reusableAnswers = await getProfileAnswers(profile.id);
    const policies = await getEnabledPolicyTexts(profile.id);

    const result = await buildFillMap({
      fields: body.fields,
      profile,
      context: {
        company: body.company,
        role: body.role,
        job_description: body.job_description,
        apply_form: body.apply_form,
      },
      llm,
      mode: body.mode ?? "heuristic",
      savedAnswers,
      reusableAnswers,
      policies,
    });
    res.json({ values: result.values, unmatchedRefs: result.unmatchedRefs });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post<{ id: string }>("/api/applications/:id/cancel", requireAuth, async (req, res) => {
  try {
    const entry = await getApplication(req.params.id);
    if (!entry) return res.status(404).json({ error: "Application not found" });
    if (!canAccessApplication(req.user!, entry)) {
      return res.status(404).json({ error: "Application not found" });
    }
    cancelledRuns.add(req.params.id);
    await updateApplication(req.params.id, {
      status: "failed",
      status_step: "cancelled",
      tracking_status: "failed",
      company_name: entry.company_name || "Cancelled",
      role_name: "Run cancelled by user.",
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.put<{ id: string }>("/api/applications/:id/meta", requireAuth, async (req, res) => {
  try {
    const existing = await getApplication(req.params.id);
    if (!existing) return res.status(404).json({ error: "Application not found" });
    if (!canAccessApplication(req.user!, existing)) {
      return res.status(404).json({ error: "Application not found" });
    }
    const body = z
      .object({
        note: z.string().max(5000).optional(),
        tracking_status: z.enum(["pending", "in_process", "failed"]).optional(),
        company_name: z.string().min(1).max(500).optional(),
        role_name: z.string().min(1).max(500).optional(),
        job_link: z.string().max(2000).optional(),
        recruiter_name: z.string().max(500).optional(),
      })
      .parse(req.body);
    if (body.job_link !== undefined) {
      const t = body.job_link.trim();
      if (t && !isHttpUrl(t)) {
        return res.status(400).json({ error: "job_link must be a valid http(s) URL or empty" });
      }
    }
    const logPatch: Parameters<typeof updateApplication>[1] = {
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.tracking_status !== undefined ? { tracking_status: body.tracking_status } : {}),
      ...(body.company_name !== undefined ? { company_name: body.company_name.trim() } : {}),
      ...(body.role_name !== undefined ? { role_name: body.role_name.trim() } : {}),
      ...(body.job_link !== undefined ? { job_link: body.job_link.trim() } : {}),
      ...(body.recruiter_name !== undefined ? { recruiter_name: body.recruiter_name.trim() } : {}),
    };
    const next = await updateApplication(req.params.id, logPatch);
    if (!next) return res.status(404).json({ error: "Application not found" });
    const rPatch: Partial<Pick<ResultJson, "company_name" | "role_name" | "job_link" | "recruiter_name">> = {};
    if (body.company_name !== undefined) rPatch.company_name = body.company_name.trim();
    if (body.role_name !== undefined) rPatch.role_name = body.role_name.trim();
    if (body.job_link !== undefined) rPatch.job_link = body.job_link.trim();
    if (body.recruiter_name !== undefined) rPatch.recruiter_name = body.recruiter_name.trim();
    if (Object.keys(rPatch).length > 0) {
      await patchResultJsonForApplication(req.params.id, rPatch);
    }
    res.json({ ok: true, application: next });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

const qaCreateBody = z.object({
  resume_profile: z.string().min(1),
  job_link: z.string().default(""),
  recruiter_name: z.string().nullable().optional(),
  job_description: z.string().min(1),
  apply_form: z.string().nullable().optional(),
  /** Extract + answer the JD/apply-form questions in this lightweight pass. */
  gen_answers: z.boolean().optional(),
  gen_fit_answer: z.boolean().optional(),
  /**
   * PDF theme to store on the slot. This path renders no résumé, but a later /rerun
   * does and reads the theme stored here - so omitting it meant the Q&A route always
   * produced the default theme however the picker was set.
   */
  theme: z.string().optional(),
});

/**
 * Create a generation "slot" WITHOUT résumé tailoring — the Q&A-only path. Runs
 * a LIGHTWEIGHT extraction (company/role, optionally JD answers) with the cheap
 * `extractionLite` model and stores it as a normal application, so follow-up Q&A
 * and "Fill" work immediately. Pressing "Generate résumé" later reuses this same
 * slot (POST /:id/rerun), re-extracting deeply with the strong model and
 * preserving the answers stored here.
 *
 * Unlike /generate this is SYNCHRONOUS: a lightweight extraction is a single
 * fast LLM call, and the caller (extension Q&A button) wants company/role +
 * answers back in one round-trip so it can render the Q&A list right away.
 */
app.post("/api/applications/qa-create", requireAuth, async (req, res) => {
  try {
    const body = qaCreateBody.parse(req.body);
    if (!canAccessProfile(req.user!, body.resume_profile)) {
      return res.status(403).json({ error: "You don't have access to this profile." });
    }
    const profile = await readProfile(body.resume_profile);
    if (!profile) return res.status(400).json({ error: "Profile not found" });

    const { job_link: jobLinkNorm, recruiter_name: recruiterNorm } = normalizeJobRefForGenerate(
      body.job_link,
      body.recruiter_name ?? ""
    );
    const settings = await readSettings();
    const theme =
      (body.theme && body.theme.trim()) ||
      settings.default_theme_by_profile[body.resume_profile] ||
      settings.default_theme;
    const outRoot = path.resolve(projectRoot(), settings.default_output_path);
    await fs.mkdir(outRoot, { recursive: true });

    const appId = newAppId();
    const runUuid = await nextRunUuid(body.resume_profile);
    const createdAt = nowJstIso();
    await appendApplication({
      id: appId,
      run_uuid: runUuid,
      created_at: createdAt,
      company_name: "Reading…",
      role_name: "…",
      resume_profile: body.resume_profile,
      theme,
      job_link: jobLinkNorm,
      recruiter_name: recruiterNorm,
      status: "generating",
      status_step: "extracting_keywords",
      tracking_status: "pending",
      note: "",
      output_folder: "",
      result_file: "",
      user_id: req.user!.id,
      user_email: req.user!.email,
    });

    const verboseLog = await createVerboseLogger(appId);
    if (verboseLog) {
      await verboseLog.writeSection("HTTP POST /api/applications/qa-create — body (parsed)", JSON.stringify(body, null, 2));
    }

    try {
      const result = await runGeneration({
        profile,
        job_link: jobLinkNorm,
        recruiter_name: recruiterNorm,
        job_description: body.job_description,
        apply_form: body.apply_form ?? null,
        theme,
        appId,
        outputRootAbs: outRoot,
        llmLight: settings.llm_light,
        llmHeavy: settings.llm_heavy,
        llmExtraction: settings.llm_extraction,
        llmGeneration: settings.llm_generation,
        llmTiers: req.user!.preferences?.llm_tiers,
        extractionStepKey: "extractionLite",
        gen_resume: false,
        gen_cover_letter: false,
        gen_answers: body.gen_answers ?? true,
        gen_fit_answer: body.gen_fit_answer === true,
        // A Q&A slot should always succeed — never dead-end on a duplicate.
        ignore_duplicate_check: true,
        run_uuid: runUuid,
        verbose: verboseLog,
      });
      const resultPathRel = path.join(result.output_folder, "result.json").split(path.sep).join("/");
      await updateApplication(appId, {
        company_name: result.company_name,
        role_name: result.role_name,
        status: result.status,
        run_uuid: runUuid,
        status_step: result.status === "completed" ? "completed" : "failed",
        output_folder: result.output_folder,
        result_file: resultPathRel,
        generation_error: result.status === "failed" ? (result.error ?? "Q&A extraction failed") : "",
      });
      res.json({
        id: appId,
        run_uuid: runUuid,
        status: result.status,
        company_name: result.company_name,
        role_name: result.role_name,
        answers: result.answers ?? [],
        output_folder: result.output_folder,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[enpply] HTTP qa-create runGeneration threw appId=${appId}`, err);
      await updateApplication(appId, {
        status: "failed",
        status_step: "failed",
        company_name: "Error",
        role_name: msg.slice(0, 120),
        generation_error: msg,
      });
      res.status(500).json({ error: msg });
    }
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/applications/generate", requireAuth, async (req, res) => {
  try {
    const body = generateBody.parse(req.body);
    if (!canAccessProfile(req.user!, body.resume_profile)) {
      return res.status(403).json({ error: "You don't have access to this profile." });
    }
    const { job_link: jobLinkNorm, recruiter_name: recruiterNorm } = normalizeJobRefForGenerate(
      body.job_link,
      body.recruiter_name ?? ""
    );
    console.log(
      `[enpply] HTTP POST /api/applications/generate profile=${body.resume_profile} user=${req.user!.id} jobDescChars=${body.job_description?.length ?? 0}`
    );
    const profile = await readProfile(body.resume_profile);
    if (!profile) return res.status(400).json({ error: "Profile not found" });

    const settings = await readSettings();
    const theme =
      body.theme ??
      settings.default_theme_by_profile[body.resume_profile] ??
      settings.default_theme;

    const outRoot = path.resolve(projectRoot(), settings.default_output_path);
    await fs.mkdir(outRoot, { recursive: true });

    const appId = newAppId();
    const runUuid = await nextRunUuid(body.resume_profile);
    const createdAt = nowJstIso();

    // Log-only manual mode: no résumé/CV requested AND a company+role were typed
    // by hand → skip the extraction LLM and use those values verbatim.
    const manualCompany = (body.company_name ?? "").trim();
    const manualRole = (body.role_name ?? "").trim();
    const wantResume = body.gen_resume === true;
    const wantCover = (body.gen_cover_letter ?? body.gen_cv) === true;
    const extractionOverride =
      !wantResume && !wantCover && manualCompany && manualRole
        ? { company_name: manualCompany, role_name: manualRole }
        : undefined;

    await appendApplication({
      id: appId,
      run_uuid: runUuid,
      created_at: createdAt,
      // Seed the manual values immediately so the log reads right even before the
      // run finishes; otherwise show the usual generating placeholders.
      company_name: extractionOverride ? extractionOverride.company_name : "Generating…",
      role_name: extractionOverride ? extractionOverride.role_name : "…",
      resume_profile: body.resume_profile,
      theme,
      job_link: jobLinkNorm,
      recruiter_name: recruiterNorm,
      status: "generating",
      status_step: "queued",
      tracking_status: "pending",
      note: "",
      output_folder: "",
      result_file: "",
      user_id: req.user!.id,
      user_email: req.user!.email,
    });

    const verboseLog = await createVerboseLogger(appId);
    if (verboseLog) {
      await verboseLog.writeSection("HTTP POST /api/applications/generate — body (parsed)", JSON.stringify(body, null, 2));
    }

    res.json({
      id: appId,
      run_uuid: runUuid,
      status: "generating",
      output_folder: "",
      output_folder_rel: "",
      output_folder_abs: "",
      result_file: "",
      result_file_abs: "",
      llm_fallback_used: false,
      ...(verboseLog ? { verbose_log_file: verboseLog.filePath } : {}),
    });

    void (async () => {
      try {
        cancelledRuns.delete(appId);
        const normalizedInputLink = normalizeJobLinkForDup(jobLinkNorm);
        // Force regenerate (suffix_on_duplicate) intentionally re-applies to the
        // SAME job link, so skip the job-link rejection here — the company+role
        // check in runGeneration will instead suffix the role with -1/-2/… to
        // keep the new run distinct. Otherwise this would mark the run failed
        // before generation starts (and strand the extension's poller).
        if (!body.ignore_duplicate_check && !body.suffix_on_duplicate && normalizedInputLink) {
          const existing = await listApplications();
          const dup = existing.find(
            (a) =>
              a.id !== appId &&
              a.resume_profile === body.resume_profile &&
              normalizeJobLinkForDup(a.job_link) === normalizedInputLink
          );
          if (dup) {
            const reason = `Duplicate job link for this profile (existing run ${dup.id}).`;
            if (verboseLog) {
              await verboseLog.writeSection("duplicate-job-link — REJECTED", reason);
            }
            await updateApplication(appId, {
              status: "failed",
              status_step: "failed",
              company_name: "Duplicate",
              role_name: reason.slice(0, 120),
              generation_error: reason,
              duplicate_of: dup.id,
            });
            return;
          }
        }

        console.log(`[enpply] HTTP generate starting runGeneration appId=${appId}`);
        const result = await runGeneration({
          profile,
          job_link: jobLinkNorm,
          recruiter_name: recruiterNorm,
          job_description: body.job_description,
          apply_form: body.apply_form ?? null,
          theme,
          appId,
          outputRootAbs: outRoot,
          llmLight: settings.llm_light,
          llmHeavy: settings.llm_heavy,
          llmExtraction: settings.llm_extraction,
          llmGeneration: settings.llm_generation,
          llmTiers: req.user!.preferences?.llm_tiers,
          gen_resume: body.gen_resume,
          gen_cover_letter: body.gen_cover_letter ?? body.gen_cv,
          gen_answers: body.gen_answers,
          gen_fit_answer: body.gen_fit_answer,
          ignore_duplicate_check: body.ignore_duplicate_check,
          suffix_on_duplicate: body.suffix_on_duplicate,
          ...(extractionOverride ? { extractionOverride } : {}),
          run_uuid: runUuid,
          onStage: async (stage, info) => {
            if (cancelledRuns.has(appId)) {
              throw new Error("Run cancelled by user.");
            }
            await updateApplication(appId, {
              status: "generating",
              status_step: stage,
              ...(info?.company_name ? { company_name: info.company_name } : {}),
              ...(info?.role_name ? { role_name: info.role_name } : {}),
            });
          },
          shouldCancel: () => cancelledRuns.has(appId),
          verbose: verboseLog,
        });
        console.log(`[enpply] HTTP generate runGeneration finished appId=${appId} status=${result.status}`);
        const resultPathRel = path.join(result.output_folder, "result.json").split(path.sep).join("/");
        await updateApplication(appId, {
          company_name: result.company_name,
          role_name: result.role_name,
          status: result.status,
          run_uuid: runUuid,
          status_step: result.status === "completed" ? "completed" : "failed",
          output_folder: result.output_folder,
          result_file: resultPathRel,
          generation_error: result.status === "failed" ? (result.error ?? "Generation failed") : "",
        });

        if (body.send_to_telegram && result.status === "completed" && result.output_folder) {
          await postRunToTelegram(result.output_folder, {
            companyName: result.company_name,
            roleName: result.role_name,
            jobLink: jobLinkNorm,
            recruiterName: recruiterNorm,
            profiles: [body.resume_profile],
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[enpply] HTTP generate runGeneration threw appId=${appId}`, err);
        // A company+role duplicate carries the existing run's id; record it as
        // duplicate_of so clients can recover by loading that run.
        const dupOf = (err as { duplicateOf?: string })?.duplicateOf;
        const isDup = typeof dupOf === "string" && dupOf.length > 0;
        await updateApplication(appId, {
          status: "failed",
          status_step: /cancelled/i.test(msg) ? "cancelled" : "failed",
          company_name: isDup ? "Duplicate" : "Error",
          role_name: msg.slice(0, 120),
          generation_error: msg,
          ...(isDup ? { duplicate_of: dupOf } : {}),
        });
      } finally {
        cancelledRuns.delete(appId);
      }
    })();
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Prior-artifact status for a profile joining an existing BATCH folder.
 *
 * Everything is "skipped", not "failed": nothing was generated for THIS profile in that
 * folder yet. runGeneration treats a reuseFolder run as a rerun and accepts
 * completed-or-skipped, so "failed" here would sink an otherwise good batch run whenever
 * an artifact was not requested.
 */
function emptyBatchArtifactStatus(): Record<ArtifactKey, ArtifactStatus> {
  return {
    resume_pdf: "skipped",
    cover_letter_pdf: "skipped",
    answers_json: "skipped",
    answers_md: "skipped",
    metadata_json: "skipped",
    job_description_txt: "skipped",
  };
}

/**
 * Batch generate: ONE job description, several profiles, one output folder.
 *
 * Why sequential and not parallel:
 *   - each profile can then be told what the previous ones already used, which is the
 *     whole point (three independent requests cannot avoid looking alike);
 *   - three concurrent Chromium launches is exactly how the PDF render timeout fires.
 *
 * Each profile still gets its own application row, so Logs, rerun, the Result page and
 * the extension keep working unchanged. The first profile creates the folder (named
 * "_batch" instead of a profile id); the rest reuse it.
 */
const generateBatchBody = z.object({
  profiles: z
    .array(
      z.object({
        resume_profile: z.string().min(1),
        /** Per-profile theme. Falls back to that profile default, then the global default. */
        theme: z.string().optional(),
      })
    )
    .min(1)
    .max(6),
  job_link: z.string().default(""),
  recruiter_name: z.string().nullable().optional(),
  job_description: z.string().min(1),
  apply_form: z.string().nullable().optional(),
  gen_resume: z.boolean().optional(),
  gen_cover_letter: z.boolean().optional(),
  gen_answers: z.boolean().optional(),
  gen_fit_answer: z.boolean().optional(),
  ignore_duplicate_check: z.boolean().optional(),
  suffix_on_duplicate: z.boolean().optional(),
  /** Post the finished documents to the configured Telegram channel. Opt-in per run. */
  send_to_telegram: z.boolean().optional(),
});

app.post("/api/applications/generate-batch", requireAuth, async (req, res) => {
  try {
    const body = generateBatchBody.parse(req.body);

    // Reject duplicate profile ids: two runs of the same profile in one folder would
    // fight over the same filenames, and it is never what the user meant.
    const ids = body.profiles.map((p) => p.resume_profile);
    const dupId = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dupId) {
      return res.status(400).json({ error: `Profile "${dupId}" is selected more than once.` });
    }
    for (const id of ids) {
      if (!canAccessProfile(req.user!, id)) {
        return res.status(403).json({ error: `You do not have access to profile "${id}".` });
      }
    }

    const { job_link: jobLinkNorm, recruiter_name: recruiterNorm } = normalizeJobRefForGenerate(
      body.job_link,
      body.recruiter_name ?? ""
    );
    const settings = await readSettings();
    const outRoot = path.resolve(projectRoot(), settings.default_output_path);
    await fs.mkdir(outRoot, { recursive: true });

    // Resolve every profile BEFORE creating any row, so a bad id fails the whole
    // request cleanly instead of leaving half a batch queued.
    const planned: {
      appId: string;
      runUuid: string;
      profile: NonNullable<Awaited<ReturnType<typeof readProfile>>>;
      profileId: string;
      theme: string;
    }[] = [];
    for (const entry of body.profiles) {
      const profile = await readProfile(entry.resume_profile);
      if (!profile) return res.status(400).json({ error: `Profile not found: ${entry.resume_profile}` });
      planned.push({
        appId: newAppId(),
        runUuid: await nextRunUuid(entry.resume_profile),
        profile,
        profileId: entry.resume_profile,
        theme:
          (entry.theme && entry.theme.trim()) ||
          settings.default_theme_by_profile[entry.resume_profile] ||
          settings.default_theme,
      });
    }

    const batchId = newAppId();
    console.log(
      `[enpply] HTTP POST /api/applications/generate-batch batch=${batchId} profiles=${ids.join(",")} user=${req.user!.id} jobDescChars=${body.job_description.length}`
    );

    const createdAt = nowJstIso();
    for (const p of planned) {
      await appendApplication({
        id: p.appId,
        run_uuid: p.runUuid,
        created_at: createdAt,
        company_name: "Generating…",
        role_name: "…",
        resume_profile: p.profileId,
        theme: p.theme,
        job_link: jobLinkNorm,
        recruiter_name: recruiterNorm,
        status: "generating",
        status_step: "queued",
        tracking_status: "pending",
        note: "",
        output_folder: "",
        result_file: "",
        user_id: req.user!.id,
        user_email: req.user!.email,
      });
    }

    res.json({
      batch_id: batchId,
      status: "generating",
      applications: planned.map((p) => ({
        id: p.appId,
        run_uuid: p.runUuid,
        resume_profile: p.profileId,
        theme: p.theme,
        status: "generating",
      })),
    });

    void (async () => {
      // Set by the first profile that gets far enough to name a folder; every later
      // profile reuses it so the whole batch lands together.
      let sharedFolderAbs = "";
      let sharedFolderRel = "";
      // Figures already spent by earlier profiles. This is the whole reason the batch runs
      // sequentially: each candidate is told what the previous ones used, so three résumés
      // for one job stop sharing the same numbers.
      const usedFigures: string[] = [];

      for (const p of planned) {
        const verboseLog = await createVerboseLogger(p.appId);
        if (verboseLog) {
          await verboseLog.writeSection(
            "HTTP POST /api/applications/generate-batch — body (parsed)",
            JSON.stringify({ batch_id: batchId, profile: p.profileId, theme: p.theme, ...body }, null, 2)
          );
        }
        try {
          cancelledRuns.delete(p.appId);
          const result = await runGeneration({
            profile: p.profile,
            job_link: jobLinkNorm,
            recruiter_name: recruiterNorm,
            job_description: body.job_description,
            apply_form: body.apply_form ?? null,
            theme: p.theme,
            appId: p.appId,
            outputRootAbs: outRoot,
            llmLight: settings.llm_light,
            llmHeavy: settings.llm_heavy,
            llmExtraction: settings.llm_extraction,
            llmGeneration: settings.llm_generation,
            llmTiers: req.user!.preferences?.llm_tiers,
            gen_resume: body.gen_resume,
            gen_cover_letter: body.gen_cover_letter,
            gen_answers: body.gen_answers,
            gen_fit_answer: body.gen_fit_answer,
            ignore_duplicate_check: body.ignore_duplicate_check,
            suffix_on_duplicate: body.suffix_on_duplicate,
            run_uuid: p.runUuid,
            // One folder for the batch, and per-profile names for the files that
            // would otherwise collide inside it.
            sharedFolder: true,
            folderProfileSegment: "_batch",
            ...(usedFigures.length
              ? (console.log(
                  `[enpply] batch=${batchId} ${p.profileId} will avoid ${usedFigures.length} figure(s) used earlier.`
                ),
                { avoidFigures: [...usedFigures] })
              : {}),
            ...(sharedFolderAbs
              ? {
                  reuseFolder: {
                    outputFolderAbs: sharedFolderAbs,
                    outputFolderRel: sharedFolderRel,
                    priorArtifactStatus: emptyBatchArtifactStatus(),
                    priorArtifacts: {} as Record<ArtifactKey, string>,
                    priorAnswers: [],
                  },
                }
              : {}),
            onStage: async (stage, info) => {
              if (cancelledRuns.has(p.appId)) throw new Error("Run cancelled by user.");
              await updateApplication(p.appId, {
                status: "generating",
                status_step: stage,
                ...(info?.company_name ? { company_name: info.company_name } : {}),
                ...(info?.role_name ? { role_name: info.role_name } : {}),
              });
            },
            shouldCancel: () => cancelledRuns.has(p.appId),
            verbose: verboseLog,
          });

          if (typeof result.resume_markdown === "string" && result.resume_markdown) {
            const before = usedFigures.length;
            for (const f of extractResumeFigures(result.resume_markdown)) {
              if (!usedFigures.includes(f)) usedFigures.push(f);
            }
            console.log(
              `[enpply] batch=${batchId} ${p.profileId} contributed ${usedFigures.length - before} new figure(s); ` +
                `${usedFigures.length} now reserved for later profiles.`
            );
          }

          if (!sharedFolderAbs && result.output_folder) {
            sharedFolderRel = result.output_folder;
            sharedFolderAbs = toAbsoluteFromStoredPath(result.output_folder);
            console.log(`[enpply] batch=${batchId} folder fixed by ${p.profileId} -> ${sharedFolderRel}`);
          }

          const resultPathRel = path
            .join(result.output_folder, ownedArtifactName(p.profileId, "result.json", true))
            .split(path.sep)
            .join("/");
          await updateApplication(p.appId, {
            company_name: result.company_name,
            role_name: result.role_name,
            status: result.status,
            run_uuid: p.runUuid,
            status_step: result.status === "completed" ? "completed" : "failed",
            output_folder: result.output_folder,
            result_file: resultPathRel,
            generation_error: result.status === "failed" ? (result.error ?? "Generation failed") : "",
          });
          console.log(
            `[enpply] batch=${batchId} ${p.profileId} finished status=${result.status} (${planned.indexOf(p) + 1}/${planned.length})`
          );
        } catch (err) {
          // One profile failing must NOT abandon the rest of the batch.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[enpply] batch=${batchId} ${p.profileId} threw`, err);
          const dupOf = (err as { duplicateOf?: string })?.duplicateOf;
          const isDup = typeof dupOf === "string" && dupOf.length > 0;
          await updateApplication(p.appId, {
            status: "failed",
            status_step: /cancelled/i.test(msg) ? "cancelled" : "failed",
            company_name: isDup ? "Duplicate" : "Error",
            role_name: msg.slice(0, 120),
            generation_error: msg,
            ...(isDup ? { duplicate_of: dupOf } : {}),
          });
        } finally {
          cancelledRuns.delete(p.appId);
        }
      }
      console.log(`[enpply] batch=${batchId} done (${planned.length} profiles)`);

      // One post for the whole batch, after every profile has written into the shared
      // folder — so the archive holds all of them, not just whoever finished first.
      if (body.send_to_telegram && sharedFolderRel) {
        const finished = await Promise.all(planned.map((p) => getApplication(p.appId)));
        const okRows = finished.filter((r) => r?.status === "completed");
        if (okRows.length === 0) {
          console.warn(`[enpply] batch=${batchId} telegram: no profile completed — not sending.`);
        } else {
          await postRunToTelegram(sharedFolderRel, {
            companyName: okRows[0]?.company_name ?? "Unknown",
            roleName: okRows[0]?.role_name ?? "Unknown",
            jobLink: jobLinkNorm,
            recruiterName: recruiterNorm,
            profiles: okRows.map((r) => r!.resume_profile),
          });
        }
      }
    })();
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.flatten() });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

const clientDist = path.join(projectRoot(), "client", "dist");
app.use(express.static(clientDist));

app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

const port = Number(process.env.PORT ?? 80);
// Mirrors the Vite dev-server port (client/vite.config.ts), so these hints stay
// correct when CLIENT_PORT is overridden to avoid clashing with another instance.
const clientPort = Number(process.env.CLIENT_PORT ?? 5273);
const server = app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  const distIndex = path.join(projectRoot(), "client", "dist", "index.html");
  if (existsSync(distIndex)) {
    console.log(
      `[enpply] This port also serves ./client/dist (from the last npm run build). That UI can look outdated in development. Use the Vite dev server at http://localhost:${clientPort} for the current React app (run npm run dev from the repo root so both server and client start).`
    );
  } else {
    console.log(
      `[enpply] No client/dist yet — open http://localhost:${clientPort} for the UI after npm run dev (API stays on port ${port}).`
    );
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[enpply] Cannot start: port ${port} is already in use. Stop the other process or set PORT in .env (e.g. PORT=3002).`
    );
  } else {
    console.error("[enpply] Server failed to start:", err.message);
  }
  process.exitCode = 1;
});
