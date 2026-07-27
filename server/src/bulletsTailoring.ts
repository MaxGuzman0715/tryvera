/**
 * Bullets-based résumé tailoring — SHARED CORE.
 *
 * Deterministic Phase-3 logic (stack→company distribution, line-count slicing,
 * résumé assembly) plus the LLM "resume generation" step (weave K2 into the
 * selected bullets + produce a tailored summary and an expanded skills list).
 *
 * Used by both the admin Playground harness (bulletsExperiment.ts) and the
 * production generation pipeline (generation.ts). Bullet stores are read from
 * `Experiment/bullets/<profileId>.json`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { bulletsProfilesDir } from "./paths.js";
import type { Profile, KExtraction } from "./types.js";
import { getLlmClientForConfig, getLlmModelForConfig, type LlmRuntimeConfig } from "./llmClient.js";
import { compactLlmErrorForLog, isTransientLlmError, llmErrorStatus, parseJsonLoose } from "./llmLog.js";

export type { KExtraction } from "./types.js";

// ── Locations ────────────────────────────────────────────────────────────
// Profiles and their bullet groups share one file: Experiment/bullets/<id>.json.
const bulletStorePath = (profileId: string) =>
  path.join(bulletsProfilesDir(), `${profileId}.json`);

// ── Types ───────────────────────────────────────────────────────────────

type StackGroup = { domain: string; tier: 1 | 2; bullets: string[] };
type CompanyBullets = { project?: string; stacks: Record<string, StackGroup> };
export type BulletStore = { profileId: string; companies: Record<string, CompanyBullets> };

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

/** A last-2 company with the stacks distributed to it and its pre-injection bullets. */
export type CompanySelection = {
  /** Store key (matches the company name in the store). */
  company: string;
  /** Profile experience index (0 or 1). */
  profileIndex: number;
  project?: string;
  stacks: SelectedStack[];
  /** Selected bullets concatenated in domain-weight order, before any LLM pass. */
  bullets: string[];
};

/** The shared (collaboration + mentorship) lines for a last-2 company, applied regardless of stacks. */
export type SharedSelection = {
  profileIndex: number;
  company: string;
  project?: string;
  lines: string[];
};

export type SelectionResult = {
  /** Last-2 companies (profile order) that matched the store AND got K1 stacks. */
  companies: CompanySelection[];
  /** K1 hard stacks with no pre-built bullet group at either matched company. */
  gaps: { domain: string; stack: string }[];
  /** Shared lines per last-2 company that has a `shared` group — appended in every generation. */
  shared: SharedSelection[];
};

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

export type TokenUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

/** Output of the resume-generation LLM step. */
export type ResumeContent = {
  summary: string;
  skills: string[];
  companies: { company: string; bullets: string[]; placed: string[]; skipped: string[] }[];
};

// ── Store loading ─────────────────────────────────────────────────────────

/**
 * Read a profile's pre-built bullet groups. Returns null when the file is
 * missing or has no `companies` (a profile-only file with no bullets yet) —
 * callers then degrade to an untailored résumé.
 */
export async function loadBulletStore(profileId: string): Promise<BulletStore | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(bulletStorePath(profileId), "utf8")) as Partial<BulletStore>;
    if (!parsed.companies || typeof parsed.companies !== "object" || Object.keys(parsed.companies).length === 0) {
      return null;
    }
    return parsed as BulletStore;
  } catch {
    return null;
  }
}

/** List profile ids whose file actually has bullet groups (for the Playground picker). */
export async function listBulletStoreProfiles(): Promise<string[]> {
  try {
    const dir = bulletsProfilesDir();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const ids: string[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, e.name), "utf8")) as Partial<BulletStore>;
        if (parsed.companies && Object.keys(parsed.companies).length > 0) {
          ids.push(e.name.replace(/\.json$/i, ""));
        }
      } catch {
        /* skip unreadable file */
      }
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/** A flat, display-friendly view of a profile's bullet groups for the Profiles UI. */
export type ProfileBulletsView = {
  has_bullets: boolean;
  totals: { companies: number; stacks: number; bullets: number };
  companies: {
    company: string;
    project?: string;
    stacks: { stack: string; domain: string; tier: 1 | 2; count: number; bullets: string[] }[];
  }[];
};

/** Build the bullets view for a profile (empty/has_bullets:false when there's no store). */
export async function getProfileBulletsView(profileId: string): Promise<ProfileBulletsView> {
  const store = await loadBulletStore(profileId);
  if (!store) return { has_bullets: false, totals: { companies: 0, stacks: 0, bullets: 0 }, companies: [] };
  let stackCount = 0;
  let bulletCount = 0;
  const companies = Object.entries(store.companies).map(([company, blk]) => {
    const stacks = Object.entries(blk.stacks).map(([stack, g]) => {
      stackCount += 1;
      bulletCount += g.bullets.length;
      return { stack, domain: g.domain, tier: g.tier, count: g.bullets.length, bullets: g.bullets };
    });
    return { company, project: blk.project, stacks };
  });
  return {
    has_bullets: true,
    totals: { companies: companies.length, stacks: stackCount, bullets: bulletCount },
    companies,
  };
}

// ── Deterministic selection (design §5.1–§5.3) ─────────────────────────────

/** Company-level group of senior collaboration + mentorship bullets, always included. */
const SHARED_KEY = "shared";
/** How many shared lines to surface per company (1st = collaboration, 2nd = mentorship). */
const SHARED_LINES = 2;

/** Lines pulled from a pre-built group, by domain weight (design §5.2). */
export function lineCountForWeight(weight: number, tier: 1 | 2): number {
  let n: number;
  if (weight > 35) n = 5;
  else if (weight >= 20) n = 4;
  else if (weight >= 10) n = 3;
  else n = 2;
  if (tier === 2) n = Math.min(n, 2);
  return n;
}

/** Exact stack key, else language-root fallback (java_springboot → java). */
function resolveStackKey(
  stacks: Record<string, StackGroup>,
  stack: string
): { key: string; aliasUsed: boolean } | null {
  if (stacks[stack]) return { key: stack, aliasUsed: false };
  const root = stack.split("_")[0];
  if (root && root !== stack && stacks[root]) return { key: root, aliasUsed: true };
  return null;
}

function matchStoreCompany(store: BulletStore, company: string): string | null {
  const want = company.trim().toLowerCase();
  for (const key of Object.keys(store.companies)) {
    if (key.trim().toLowerCase() === want) return key;
  }
  return null;
}

/** Original profile bullets, stripped of leading bullet glyphs/whitespace. */
export function cleanProfileBullets(exp: Profile["experience"][number]): string[] {
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

export function normalizeKExtraction(k: Partial<KExtraction>): KExtraction {
  return {
    signal_quality: k.signal_quality ?? "medium",
    clearance_required: Boolean(k.clearance_required),
    clearance_level: k.clearance_level ?? "not_required",
    primary_domain: k.primary_domain ?? "",
    domain_breakdown: k.domain_breakdown ?? {},
    K1: { hard: k.K1?.hard ?? {}, soft: k.K1?.soft ?? [] },
    K2: Array.isArray(k.K2) ? k.K2 : [],
    competency_signals: Array.isArray(k.competency_signals) ? k.competency_signals : [],
  };
}

/**
 * Distribute K1 hard stacks across the candidate's last 2 companies and slice
 * the pre-built bullet groups to the right line count.
 */
export function selectStacks(profile: Profile, kext: KExtraction, store: BulletStore): SelectionResult {
  // Last-2 companies (profile order) that have a store entry.
  const lastTwo = profile.experience.slice(0, 2).map((e, idx) => ({ idx, name: e.company }));
  const ordered: { profileIndex: number; profileName: string; storeKey: string }[] = [];
  for (const { idx, name } of lastTwo) {
    const key = matchStoreCompany(store, name);
    if (key) ordered.push({ profileIndex: idx, profileName: name, storeKey: key });
  }
  const C1 = ordered[0];
  const C2 = ordered[1];

  const presence = (
    co: { storeKey: string } | undefined,
    stack: string
  ): { key: string; aliasUsed: boolean } | null =>
    co ? resolveStackKey(store.companies[co.storeKey].stacks, stack) : null;

  const assignments = new Map<string, SelectedStack[]>();
  const gaps: { domain: string; stack: string }[] = [];

  for (const [domain, stacks] of Object.entries(kext.K1.hard)) {
    (stacks ?? []).forEach((stack, orderInDomain) => {
      const inC1 = presence(C1, stack);
      const inC2 = presence(C2, stack);
      let target: { storeKey: string } | undefined;
      let resolved: { key: string; aliasUsed: boolean } | null;
      if (inC1 && !inC2) {
        target = C1;
        resolved = inC1;
      } else if (inC2 && !inC1) {
        target = C2;
        resolved = inC2;
      } else if (inC1 && inC2) {
        target = orderInDomain >= 1 ? C2 : C1;
        resolved = target === C2 ? inC2 : inC1;
      } else {
        gaps.push({ domain, stack });
        return;
      }
      const group = store.companies[target!.storeKey].stacks[resolved!.key];
      const weight = kext.domain_breakdown[group.domain] ?? 0;
      const linesRequested = lineCountForWeight(weight, group.tier);
      assignments.set(target!.storeKey, [
        ...(assignments.get(target!.storeKey) ?? []),
        {
          stack,
          resolvedKey: resolved!.key,
          aliasUsed: resolved!.aliasUsed,
          domain: group.domain,
          tier: group.tier,
          weight,
          linesRequested,
          bullets: group.bullets.slice(0, Math.min(linesRequested, group.bullets.length)),
        },
      ]);
    });
  }

  // Guarantee: every matched last-2 company gets at least one K1 hard stack. The
  // greedy pass above can leave a company empty — e.g. a single K1 hard stack that
  // is present in both stores is handed to C1 on the orderInDomain tie-break, so C2
  // gets nothing even though its store has that stack. For any company still without
  // a stack, assign the strongest K1 hard stack that exists in ITS store, reusing one
  // already shown at the other company if needed (both genuinely used it). A company
  // whose store contains none of the K1 hard stacks stays empty — there are no
  // bullets to show — and falls back to its original bullets downstream.
  const k1ByWeight = Object.entries(kext.K1.hard)
    .flatMap(([domain, stacks]) =>
      (stacks ?? []).map((stack, orderInDomain) => ({ domain, stack, orderInDomain }))
    )
    .sort(
      (a, b) =>
        (kext.domain_breakdown[b.domain] ?? 0) - (kext.domain_breakdown[a.domain] ?? 0) ||
        a.orderInDomain - b.orderInDomain
    );
  for (const o of ordered) {
    const have = assignments.get(o.storeKey);
    if (have && have.length > 0) continue;
    for (const { stack } of k1ByWeight) {
      const resolved = resolveStackKey(store.companies[o.storeKey].stacks, stack);
      if (!resolved) continue;
      const group = store.companies[o.storeKey].stacks[resolved.key];
      const weight = kext.domain_breakdown[group.domain] ?? 0;
      const linesRequested = lineCountForWeight(weight, group.tier);
      assignments.set(o.storeKey, [
        {
          stack,
          resolvedKey: resolved.key,
          aliasUsed: resolved.aliasUsed,
          domain: group.domain,
          tier: group.tier,
          weight,
          linesRequested,
          bullets: group.bullets.slice(0, Math.min(linesRequested, group.bullets.length)),
        },
      ]);
      break;
    }
  }

  // Domain fallback: if a company STILL has no stack — its store contains none of the
  // K1 hard stacks, or the JD named no hard stacks at all — don't leave it untailored.
  // Pick the top (first-appearing in the store) stack per JD domain, highest-weight
  // domain first, so the résumé still leads with domain-aligned, role-relevant bullets
  // instead of nothing.
  const domainsByWeight = Object.entries(kext.domain_breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain);
  for (const o of ordered) {
    const have = assignments.get(o.storeKey);
    if (have && have.length > 0) continue;
    const storeStacks = store.companies[o.storeKey].stacks;
    const picked: SelectedStack[] = [];
    for (const domain of domainsByWeight) {
      const entry = Object.entries(storeStacks).find(
        ([key, g]) => key !== SHARED_KEY && g.domain === domain
      );
      if (!entry) continue;
      const [key, group] = entry;
      const weight = kext.domain_breakdown[domain] ?? 0;
      const linesRequested = lineCountForWeight(weight, group.tier);
      picked.push({
        stack: key,
        resolvedKey: key,
        aliasUsed: false,
        domain: group.domain,
        tier: group.tier,
        weight,
        linesRequested,
        bullets: group.bullets.slice(0, Math.min(linesRequested, group.bullets.length)),
      });
    }
    if (picked.length > 0) assignments.set(o.storeKey, picked);
  }

  const companies: CompanySelection[] = [];
  for (const o of ordered) {
    const base = assignments.get(o.storeKey);
    if (!base || base.length === 0) continue; // no K1 stacks here; shared is still applied below
    const stacks = [...base].sort((a, b) => b.weight - a.weight); // domain-weight order
    companies.push({
      company: o.storeKey,
      profileIndex: o.profileIndex,
      project: store.companies[o.storeKey].project,
      stacks,
      bullets: stacks.flatMap((s) => s.bullets),
    });
  }

  // The "shared" group (senior collaboration + mentorship) is not a JD stack.
  // Collect its lines for every last-2 company that has one; the caller appends
  // them to that company's résumé bullets regardless of whether stacks matched.
  const shared: SharedSelection[] = [];
  for (const o of ordered) {
    const g = store.companies[o.storeKey].stacks[SHARED_KEY];
    if (!g) continue;
    shared.push({
      profileIndex: o.profileIndex,
      company: o.storeKey,
      project: store.companies[o.storeKey].project,
      lines: g.bullets.slice(0, Math.min(SHARED_LINES, g.bullets.length)),
    });
  }

  return { companies, gaps, shared };
}

/**
 * Full résumé in display order: last-2 companies tailored (using `finalByCompany`
 * woven bullets when present, else the company's selected bullets), older
 * companies passed through as-is from the profile (design §3.1).
 */
export function assembleResume(
  profile: Profile,
  selection: SelectionResult,
  finalByCompany: Map<string, string[]>
): ResumeSection[] {
  const selByIndex = new Map(selection.companies.map((c) => [c.profileIndex, c]));
  return profile.experience.map((exp, idx) => {
    const base = { company: exp.company, title: exp.title, startDate: exp.startDate, endDate: exp.endDate };
    const original = cleanProfileBullets(exp);
    if (idx >= 2) return { ...base, tailored: false, bullets: original, source: "as_is" as const };
    const sel = selByIndex.get(idx);
    const tailoredBullets = sel ? (finalByCompany.get(sel.company) ?? sel.bullets) : [];
    if (sel && tailoredBullets.length > 0) {
      return { ...base, tailored: true, bullets: tailoredBullets, source: "tailored" as const };
    }
    return {
      ...base,
      tailored: true,
      bullets: original,
      source: "tailored_fallback" as const,
      note: "No K1 stacks distributed here; showing original bullets.",
    };
  });
}

// ── LLM helpers ─────────────────────────────────────────────────────────

function rejectsTemperature(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("gpt-5") ||
    /^o[1-9](-|$)/.test(m) ||
    m.startsWith("openai/gpt-5") ||
    /^openai\/o[1-9](-|$)/.test(m)
  );
}

/** One JSON chat call: text-first with a json_object escalation + transient retry. */
export async function chatJson<T>(
  llm: LlmRuntimeConfig,
  system: string,
  user: string,
  temperature = 0.2
): Promise<{ parsed: T; usage?: TokenUsage; elapsed_ms: number }> {
  const client = getLlmClientForConfig(llm);
  const model = getLlmModelForConfig(llm);
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  const temp = rejectsTemperature(model) ? {} : { temperature };
  const startedAt = performance.now();
  // Start WITHOUT response_format (the json_object constraint narrows OpenRouter
  // to the rate-limited structured-output subset); parse defensively and
  // escalate to json_object only on an unparseable reply. Retry 429/5xx backoff.
  const MAX_RETRIES = 2;
  let useJsonMode = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const base = { model, messages, ...temp };
      const res = await client.chat.completions.create(
        useJsonMode ? { ...base, response_format: { type: "json_object" } } : base
      );
      const elapsed_ms = Math.round(performance.now() - startedAt);
      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("Empty model response");
      try {
        return { parsed: parseJsonLoose<T>(text), usage: res.usage ?? undefined, elapsed_ms };
      } catch (parseErr) {
        if (!useJsonMode && attempt < MAX_RETRIES) {
          console.warn("[enpply] LLM resume [json] reply not JSON — retrying with response_format");
          useJsonMode = true;
          continue;
        }
        throw parseErr;
      }
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES && isTransientLlmError(e)) {
        const waitMs = 700 * 2 ** attempt; // 700ms, 1400ms
        console.warn(`[enpply] LLM resume [json] transient ${llmErrorStatus(e) ?? "?"} — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }
  console.warn(`[enpply] LLM resume [json] failed — ${compactLlmErrorForLog(lastErr)}`);
  throw lastErr;
}

/**
 * Resume-generation LLM step: weave K2 into the selected bullets where natural,
 * write a tailored summary, and produce an expanded genuine skills list.
 * `promptTemplate` is the resume prompt (from the prompt store). Bullets that K2
 * doesn't fit are discarded (reported in `skipped`), not surfaced into skills.
 */
export async function generateResumeContent(params: {
  promptTemplate: string;
  llm: LlmRuntimeConfig;
  profile: Profile;
  kext: KExtraction;
  companyName: string;
  roleName: string;
  /** High-level, stack-free role summary from extraction — the summary is written from this. */
  roleSummary?: string;
  companies: CompanySelection[];
}): Promise<{ content: ResumeContent; usage?: TokenUsage; elapsed_ms: number }> {
  const input = {
    candidate: {
      full_name: params.profile.basic.fullName,
      current_title: params.profile.basic.title ?? "",
      profile_skills: params.profile.skills,
    },
    target: {
      company: params.companyName,
      role: params.roleName,
      primary_domain: params.kext.primary_domain,
      role_summary: params.roleSummary ?? "",
    },
    domain_breakdown: params.kext.domain_breakdown,
    K1: params.kext.K1,
    K2: params.kext.K2,
    companies: params.companies.map((c) => ({
      company: c.company,
      project: c.project ?? "",
      bullets: c.bullets,
    })),
  };
  const { parsed, usage, elapsed_ms } = await chatJson<ResumeContent>(
    params.llm,
    params.promptTemplate,
    `${JSON.stringify(input, null, 2)}\n\nReturn the JSON now. Output only the JSON object.`,
    0.3
  );

  // Defensive normalization: keep bullet counts/order stable per company.
  const byCompany = new Map((parsed.companies ?? []).map((c) => [c.company, c]));
  const companies = params.companies.map((c) => {
    const out = byCompany.get(c.company);
    const bullets =
      out && Array.isArray(out.bullets) && out.bullets.length === c.bullets.length
        ? out.bullets.map(String)
        : c.bullets;
    return {
      company: c.company,
      bullets,
      placed: Array.isArray(out?.placed) ? out!.placed.map(String) : [],
      skipped: Array.isArray(out?.skipped) ? out!.skipped.map(String) : [],
    };
  });
  const content: ResumeContent = {
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    skills: Array.isArray(parsed.skills) ? parsed.skills.map(String).filter(Boolean) : [],
    companies,
  };
  return { content, usage, elapsed_ms };
}
