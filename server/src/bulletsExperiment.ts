/**
 * Bullets-based résumé tailoring — EXPERIMENT HARNESS (MVP).
 *
 * This is intentionally self-contained and isolated from the production
 * generation pipeline (`generation.ts`). It implements the design in
 * `Experiment/enpply_tailoring_system.md`:
 *
 *   Phase 2  — JD extraction into K1/K2/K3 + domain breakdown (one LLM call,
 *              prompt = Experiment/jd_extraction_prompt.txt)
 *   Phase 3  — deterministic stack→company distribution + line-count slicing
 *              over PRE-BUILT bullet groups (Experiment/bullets/<profile>.json),
 *              then a light K2 injection pass (one LLM call per company,
 *              prompt = Experiment/k2_injection_prompt.txt)
 *
 * Everything reads from the `Experiment/` folder so the harness stays a
 * playground, not a production path. Surfaced via the admin Playground.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./paths.js";
import { readProfile } from "./profileStore.js";
import type { Profile } from "./types.js";
import { getLlmClientForConfig, getLlmModelForConfig, type LlmRuntimeConfig } from "./llmClient.js";

// ── Experiment file locations ──────────────────────────────────────────────
const experimentDir = () => path.join(projectRoot(), "Experiment");
const extractionPromptPath = () => path.join(experimentDir(), "jd_extraction_prompt.txt");
const injectionPromptPath = () => path.join(experimentDir(), "k2_injection_prompt.txt");
const bulletStorePath = (profileId: string) =>
  path.join(experimentDir(), "bullets", `${profileId}.json`);

// ── Types ───────────────────────────────────────────────────────────────────

/** Output of the JD extraction prompt (see jd_extraction_prompt.txt §4). */
export type KExtraction = {
  signal_quality: "high" | "medium" | "low" | "laundry_list";
  clearance_required: boolean;
  clearance_level: "active" | "ability_to_obtain" | "not_required";
  primary_domain: string;
  domain_breakdown: Record<string, number>;
  K1: {
    hard: Record<string, string[]>;
    soft: string[];
  };
  /** Flat strings or grouped OR-arrays. */
  K2: (string | string[])[];
  competency_signals: { category: string; raw: string }[];
};

type StackGroup = { domain: string; tier: 1 | 2; bullets: string[] };
type CompanyBullets = { project?: string; stacks: Record<string, StackGroup> };
type BulletStore = { profileId: string; companies: Record<string, CompanyBullets> };

/** One stack assigned to a company, with the bullets selected for it. */
export type SelectedStack = {
  stack: string;
  /** Store key actually used (may differ from `stack` when an alias resolved it). */
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
  /** Concatenated bullets in domain-weight order, before K2 injection. */
  preInjectionBullets: string[];
  /** After the K2 injection LLM pass (equals preInjection when injection skipped/failed). */
  finalBullets: string[];
  k2Placed: string[];
  k2Skipped: string[];
  injectionNote?: string;
};

/**
 * One experience block in the assembled résumé, in résumé (most-recent-first)
 * order. Per design §3.1 only the last 2 companies are tailored; everything
 * before that is passed through unchanged from the profile.
 */
export type ResumeSection = {
  company: string;
  title: string;
  startDate: string;
  endDate: string;
  /** True for the last 2 companies (whether or not stacks landed there). */
  tailored: boolean;
  bullets: string[];
  source: "tailored" | "tailored_fallback" | "as_is";
  note?: string;
};

export type BulletExperimentResult = {
  profileId: string;
  signal_quality: KExtraction["signal_quality"];
  clearance_required: boolean;
  clearance_level: string;
  primary_domain: string;
  domain_breakdown: Record<string, number>;
  extraction: KExtraction;
  /** Companies (in candidate order) that got tailored bullets. */
  companies: CompanySelection[];
  /**
   * Full résumé in display order: last 2 companies tailored, older companies
   * passed through as-is from the profile (design §3.1).
   */
  resume: ResumeSection[];
  /** K1 hard stacks with no pre-built bullet group at either company. */
  gaps: { domain: string; stack: string }[];
  warnings: string[];
  timings: {
    extraction_ms: number;
    injection_ms: number;
    total_ms: number;
  };
  usage: {
    extraction?: TokenUsage;
    injection_calls: { company: string; usage?: TokenUsage }[];
  };
  models: { extraction: string; injection: string };
};

type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

// ── LLM helper ────────────────────────────────────────────────────────────

/** gpt-5 / o-series reject an explicit temperature; omit it for those. */
function rejectsTemperature(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("gpt-5") ||
    /^o[1-9](-|$)/.test(m) ||
    m.startsWith("openai/gpt-5") ||
    /^openai\/o[1-9](-|$)/.test(m)
  );
}

function stripFence(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  }
  return t;
}

/** One JSON chat call with a json_object→plain fallback for providers that reject the format. */
async function chatJson<T>(
  llm: LlmRuntimeConfig,
  system: string,
  user: string
): Promise<{ parsed: T; usage?: TokenUsage; elapsed_ms: number }> {
  const client = getLlmClientForConfig(llm);
  const model = getLlmModelForConfig(llm);
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  const temp = rejectsTemperature(model) ? {} : { temperature: 0.2 };
  const startedAt = performance.now();
  let res;
  try {
    res = await client.chat.completions.create({
      model,
      messages,
      ...temp,
      response_format: { type: "json_object" },
    });
  } catch {
    // Some providers/models reject response_format — retry without it.
    res = await client.chat.completions.create({ model, messages, ...temp });
  }
  const elapsed_ms = Math.round(performance.now() - startedAt);
  const text = res.choices[0]?.message?.content;
  if (!text) throw new Error("Empty model response");
  const parsed = JSON.parse(stripFence(text)) as T;
  return { parsed, usage: res.usage ?? undefined, elapsed_ms };
}

// ── Phase 3 — deterministic selection ────────────────────────────────────

/** Lines pulled from a pre-built group, by domain weight (design §5.2). */
function lineCountForWeight(weight: number, tier: 1 | 2): number {
  let n: number;
  if (weight > 35) n = 5;
  else if (weight >= 20) n = 4;
  else if (weight >= 10) n = 3;
  else n = 2;
  if (tier === 2) n = Math.min(n, 2); // Tier 2 stacks cap at 2 lines regardless of weight.
  return n;
}

/**
 * Resolve a K1 stack key against a company's pre-built groups. Exact match
 * first; otherwise fall back to the language root (java_springboot → java,
 * python_django → python) since the store may key by language only.
 */
function resolveStackKey(
  stacks: Record<string, StackGroup>,
  stack: string
): { key: string; aliasUsed: boolean } | null {
  if (stacks[stack]) return { key: stack, aliasUsed: false };
  const root = stack.split("_")[0];
  if (root && root !== stack && stacks[root]) return { key: root, aliasUsed: true };
  return null;
}

/** Case-insensitive match of a profile company name to a store company key. */
function matchStoreCompany(store: BulletStore, company: string): string | null {
  const want = company.trim().toLowerCase();
  for (const key of Object.keys(store.companies)) {
    if (key.trim().toLowerCase() === want) return key;
  }
  return null;
}

/** Original profile bullets for an experience, stripped of leading bullet glyphs/tabs. */
function cleanProfileBullets(exp: Profile["experience"][number]): string[] {
  const raw =
    Array.isArray(exp.bullets) && exp.bullets.length
      ? exp.bullets
      : Array.isArray(exp.paragraphs) && exp.paragraphs.length
        ? exp.paragraphs
        : [];
  return raw
    .map((b) => String(b ?? "").replace(/^[\s••\-*]+/, "").trim())
    .filter(Boolean);
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function runBulletsExperiment(params: {
  profileId: string;
  jdText: string;
  extractionLlm: LlmRuntimeConfig;
  injectionLlm: LlmRuntimeConfig;
  /** When false, skip the K2 injection LLM pass (finalBullets = preInjection). */
  runInjection?: boolean;
  /** When provided, skip the extraction LLM call and use this K-structure directly (testing / re-run selection). */
  precomputedExtraction?: KExtraction;
}): Promise<BulletExperimentResult> {
  const totalStart = performance.now();
  const warnings: string[] = [];

  const profile = await readProfile(params.profileId);
  if (!profile) throw new Error(`Profile not found: ${params.profileId}`);

  let store: BulletStore;
  try {
    store = JSON.parse(await fs.readFile(bulletStorePath(params.profileId), "utf8")) as BulletStore;
  } catch {
    throw new Error(
      `No bullet store for "${params.profileId}". Create Experiment/bullets/${params.profileId}.json first.`
    );
  }

  // ── Phase 2: extraction ───────────────────────────────────────────────
  const extractionModel = getLlmModelForConfig(params.extractionLlm);
  let extraction: KExtraction;
  let extractionUsage: TokenUsage | undefined;
  let extraction_ms = 0;
  if (params.precomputedExtraction) {
    extraction = params.precomputedExtraction;
  } else {
    const extractionTemplate = await fs.readFile(extractionPromptPath(), "utf8");
    const extractionSystem = extractionTemplate.replace(/\{jd_text\}/g, params.jdText);
    const out = await chatJson<KExtraction>(
      params.extractionLlm,
      extractionSystem,
      "Extract the JSON now. Output only the JSON object."
    );
    extraction = out.parsed;
    extractionUsage = out.usage;
    extraction_ms = out.elapsed_ms;
  }

  // Normalize so downstream code never crashes on a missing field.
  extraction.domain_breakdown ??= {};
  extraction.K1 ??= { hard: {}, soft: [] };
  extraction.K1.hard ??= {};
  extraction.K2 ??= [];
  extraction.competency_signals ??= [];
  if (extraction.clearance_required) {
    warnings.push(
      `Security clearance required (${extraction.clearance_level}). In production this would warn the user before generating.`
    );
  }
  if (extraction.signal_quality === "low") {
    warnings.push("Low-signal JD — stacks inferred from title/domain; expect a thin bullet set.");
  }

  // ── Phase 3a: candidate's last-2 companies (in profile order) ──────────
  const lastTwo = profile.experience.slice(0, 2).map((e) => e.company);
  const orderedCompanies: { profileName: string; storeKey: string }[] = [];
  for (const name of lastTwo) {
    const key = matchStoreCompany(store, name);
    if (key) orderedCompanies.push({ profileName: name, storeKey: key });
  }
  if (orderedCompanies.length === 0) {
    warnings.push(
      `Bullet store has no groups for the candidate's last 2 companies (${lastTwo.join(", ") || "none"}). Nothing to assign.`
    );
  }
  const C1 = orderedCompanies[0];
  const C2 = orderedCompanies[1];

  // ── Phase 3b: flatten K1 hard stacks (preserve domain + within-domain order) ──
  type K1Stack = { domain: string; stack: string; orderInDomain: number };
  const k1Stacks: K1Stack[] = [];
  for (const [domain, stacks] of Object.entries(extraction.K1.hard)) {
    (stacks ?? []).forEach((stack, i) => k1Stacks.push({ domain, stack, orderInDomain: i }));
  }

  // ── Phase 3c: assign each stack to a company ───────────────────────────
  // Track assignments per company so we can slice + assemble below.
  const assignments = new Map<string, SelectedStack[]>(); // storeKey -> stacks
  const gaps: { domain: string; stack: string }[] = [];

  const presence = (
    co: { profileName: string; storeKey: string } | undefined,
    stack: string
  ): { key: string; aliasUsed: boolean } | null =>
    co ? resolveStackKey(store.companies[co.storeKey].stacks, stack) : null;

  for (const { domain, stack, orderInDomain } of k1Stacks) {
    const inC1 = presence(C1, stack);
    const inC2 = presence(C2, stack);

    let target: { profileName: string; storeKey: string } | undefined;
    let resolved: { key: string; aliasUsed: boolean } | null;
    if (inC1 && !inC2) {
      target = C1;
      resolved = inC1;
    } else if (inC2 && !inC1) {
      target = C2;
      resolved = inC2;
    } else if (inC1 && inC2) {
      // Both have it — first stack in the domain → C1, second → C2.
      target = orderInDomain >= 1 ? C2 : C1;
      resolved = target === C2 ? inC2 : inC1;
    } else {
      gaps.push({ domain, stack });
      continue;
    }

    const group = store.companies[target.storeKey].stacks[resolved!.key];
    const weight = extraction.domain_breakdown[group.domain] ?? 0;
    const linesRequested = lineCountForWeight(weight, group.tier);
    const bullets = group.bullets.slice(0, Math.min(linesRequested, group.bullets.length));

    const sel: SelectedStack = {
      stack,
      resolvedKey: resolved!.key,
      aliasUsed: resolved!.aliasUsed,
      domain: group.domain,
      tier: group.tier,
      weight,
      linesRequested,
      bullets,
    };
    const arr = assignments.get(target.storeKey) ?? [];
    arr.push(sel);
    assignments.set(target.storeKey, arr);
  }

  // ── Phase 3d: assemble per company (domain-weight order) + K2 injection ──
  const runInjection = params.runInjection !== false;
  const injectionTemplate = runInjection ? await fs.readFile(injectionPromptPath(), "utf8") : "";
  const injectionModel = getLlmModelForConfig(params.injectionLlm);
  const k2Json = JSON.stringify(extraction.K2, null, 2);

  const companies: CompanySelection[] = [];
  const injectionUsages: { company: string; usage?: TokenUsage }[] = [];
  let injectionTotalMs = 0;

  for (const { storeKey } of orderedCompanies) {
    const stacks = assignments.get(storeKey);
    if (!stacks || stacks.length === 0) continue;
    // Sort by domain weight desc; tie-break keeps stable insertion order.
    stacks.sort((a, b) => b.weight - a.weight);
    const preInjectionBullets = stacks.flatMap((s) => s.bullets);

    let finalBullets = preInjectionBullets;
    let k2Placed: string[] = [];
    let k2Skipped: string[] = [];
    let injectionNote: string | undefined;

    if (runInjection && extraction.K2.length > 0 && preInjectionBullets.length > 0) {
      const sys = injectionTemplate
        .replace(/\{company\}/g, storeKey)
        .replace(/\{bullets_json\}/g, JSON.stringify(preInjectionBullets, null, 2))
        .replace(/\{k2_json\}/g, k2Json);
      try {
        const { parsed, usage, elapsed_ms } = await chatJson<{
          bullets: string[];
          placed: string[];
          skipped: string[];
        }>(params.injectionLlm, sys, "Return the JSON now. Output only the JSON object.");
        injectionTotalMs += elapsed_ms;
        injectionUsages.push({ company: storeKey, usage });
        if (Array.isArray(parsed.bullets) && parsed.bullets.length === preInjectionBullets.length) {
          finalBullets = parsed.bullets.map((b) => String(b));
          k2Placed = Array.isArray(parsed.placed) ? parsed.placed.map(String) : [];
          k2Skipped = Array.isArray(parsed.skipped) ? parsed.skipped.map(String) : [];
        } else {
          injectionNote = `Injection returned ${parsed.bullets?.length ?? 0} bullets (expected ${preInjectionBullets.length}); kept pre-injection bullets.`;
          warnings.push(`${storeKey}: ${injectionNote}`);
        }
      } catch (e) {
        injectionNote = `Injection failed: ${e instanceof Error ? e.message : String(e)}`;
        warnings.push(`${storeKey}: ${injectionNote}`);
      }
    } else if (!runInjection) {
      injectionNote = "Injection skipped (toggle off).";
    }

    companies.push({
      company: storeKey,
      project: store.companies[storeKey].project,
      stacks,
      preInjectionBullets,
      finalBullets,
      k2Placed,
      k2Skipped,
      injectionNote,
    });
  }

  // ── Phase 3e: assemble the full résumé (design §3.1) ────────────────────
  // Last 2 companies are tailored; everything before is passed through as-is.
  // A last-2 company that received no distributed stacks falls back to its
  // original bullets so the résumé stays complete.
  const selByCompany = new Map(companies.map((c) => [c.company, c]));
  const storeKeyByProfileName = new Map(orderedCompanies.map((o) => [o.profileName, o.storeKey]));
  const resume: ResumeSection[] = profile.experience.map((exp, idx) => {
    const base = {
      company: exp.company,
      title: exp.title,
      startDate: exp.startDate,
      endDate: exp.endDate,
    };
    const original = cleanProfileBullets(exp);
    if (idx >= 2) {
      return { ...base, tailored: false, bullets: original, source: "as_is" as const };
    }
    const storeKey = storeKeyByProfileName.get(exp.company);
    const sel = storeKey ? selByCompany.get(storeKey) : undefined;
    if (sel && sel.finalBullets.length > 0) {
      return { ...base, tailored: true, bullets: sel.finalBullets, source: "tailored" as const };
    }
    return {
      ...base,
      tailored: true,
      bullets: original,
      source: "tailored_fallback" as const,
      note: storeKey
        ? "No K1 stacks distributed here; showing original bullets."
        : "No bullet store for this company; showing original bullets.",
    };
  });

  return {
    profileId: params.profileId,
    signal_quality: extraction.signal_quality,
    clearance_required: extraction.clearance_required,
    clearance_level: extraction.clearance_level,
    primary_domain: extraction.primary_domain,
    domain_breakdown: extraction.domain_breakdown,
    extraction,
    companies,
    resume,
    gaps,
    warnings,
    timings: {
      extraction_ms,
      injection_ms: injectionTotalMs,
      total_ms: Math.round(performance.now() - totalStart),
    },
    usage: { extraction: extractionUsage, injection_calls: injectionUsages },
    models: { extraction: extractionModel, injection: injectionModel },
  };
}

/** List profile ids that have a pre-built bullet store under Experiment/bullets/. */
export async function listBulletStoreProfiles(): Promise<string[]> {
  try {
    const dir = path.join(experimentDir(), "bullets");
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/i, ""))
      .sort();
  } catch {
    return [];
  }
}
