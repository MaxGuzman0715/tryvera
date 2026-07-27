import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { answerPoliciesDir } from "./paths.js";
import { nowJstIso } from "./timeJst.js";

/**
 * Per-PROFILE answering policies for the enpplify extension. A policy is a
 * free-text DIRECTIVE — "how I want fields of a certain kind answered" — not a
 * fixed answer. It differs from a reusable answer (see profileAnswers.ts) in two
 * ways: (1) its value is a rule the model APPLIES, often computed from the JD,
 * not a literal string served verbatim; (2) it is authoritative *instruction*,
 * injected into the fill and Q&A prompts, rather than a question→answer lookup.
 *
 * Examples a user might set:
 *  - "For a posted salary range X–Y, answer the 80th percentile (round to the
 *     nearest $5k). If no range is posted, use $150,000."
 *  - "Answer yes/true to 'I accept that …' acknowledgement checkboxes that
 *     expect a positive answer."
 *
 * Stored as `Experiment/policies/<profileId>.json` = { items: [...] }, beside the
 * profiles (so it's version-controlled with them — see answerPoliciesDir).
 */

export type AnswerPolicy = { id: string; text: string; enabled: boolean; updated_at: string };

/** On-disk shape. `seeded` records that the one-time defaults were applied. */
type PoliciesFile = { items: AnswerPolicy[]; seeded?: boolean };

/**
 * Policies pre-seeded into every profile the FIRST time its policies are read.
 * These encode the two motivating cases; every row is editable/removable, and
 * removals stick because the profile is marked `seeded` (see getAnswerPolicies).
 */
export const DEFAULT_POLICIES: string[] = [
  "Salary / compensation expectation: if the job description posts a range X–Y, " +
    "answer the value 80% of the way from X to Y (i.e. X + 0.8*(Y-X)); when a " +
    "range is requested, give the 40%-to-120% span (X+0.4*(Y-X) to X+1.2*(Y-X)). " +
    "Round every figure to the nearest $5,000. If no range is posted, use " +
    "$150,000 for a single value, or $140,000–$200,000 for a range.",
  "For acknowledgement / consent fields phrased as \"I accept that …\", " +
    "\"I agree …\", \"I certify …\", or \"I consent …\" that expect a positive " +
    "answer to proceed, answer yes / true / the affirmative option — unless the " +
    "statement is something a candidate should plausibly decline.",
];

function policiesPath(profileId: string): string {
  const safe = String(profileId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(answerPoliciesDir(), `${safe}.json`);
}

async function readPoliciesFile(profileId: string): Promise<PoliciesFile> {
  try {
    const raw = await fs.readFile(policiesPath(profileId), "utf8");
    const parsed = JSON.parse(raw) as Partial<PoliciesFile>;
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((it) => ({
            id: String(it?.id ?? "").trim() || crypto.randomUUID(),
            text: String(it?.text ?? "").trim(),
            enabled: it?.enabled !== false,
            updated_at: String(it?.updated_at ?? "").trim() || nowJstIso(),
          }))
          .filter((it) => it.text)
      : [];
    return { items, seeded: parsed.seeded === true };
  } catch {
    return { items: [], seeded: false };
  }
}

/**
 * A profile's answering policies. On the FIRST read (not yet `seeded`), append
 * the default policies the profile doesn't already have, mark it seeded so later
 * removals are respected, and persist. Subsequent reads are pass-through.
 */
export async function getAnswerPolicies(profileId: string): Promise<AnswerPolicy[]> {
  const file = await readPoliciesFile(profileId);
  if (file.seeded) return file.items;
  const have = new Set(file.items.map((it) => it.text.trim()));
  const merged = [...file.items];
  for (const text of DEFAULT_POLICIES) {
    if (!have.has(text.trim())) {
      merged.push({ id: crypto.randomUUID(), text, enabled: true, updated_at: nowJstIso() });
    }
  }
  await writeAnswerPolicies(profileId, merged);
  return merged;
}

/** Persist policies; always marks the profile seeded so defaults aren't re-added. */
async function writeAnswerPolicies(profileId: string, items: AnswerPolicy[]): Promise<void> {
  await fs.mkdir(answerPoliciesDir(), { recursive: true });
  const payload: PoliciesFile = { items, seeded: true };
  await fs.writeFile(policiesPath(profileId), JSON.stringify(payload, null, 2), "utf8");
}

/** The enabled policy texts, for injection into a prompt. */
export async function getEnabledPolicyTexts(profileId: string): Promise<string[]> {
  const items = await getAnswerPolicies(profileId);
  return items.filter((it) => it.enabled && it.text.trim()).map((it) => it.text.trim());
}

/**
 * Render policies as an authoritative prompt block (or "" when there are none).
 * These are user-authored directives the model must FOLLOW — including deriving
 * values like salary from the job description — so they take precedence over the
 * generic "do not fabricate" guidance. Both the fill and Q&A prompts inject this.
 */
export function policyPromptBlock(policies: string[]): string {
  const list = (policies ?? []).map((p) => (p ?? "").trim()).filter(Boolean);
  if (!list.length) return "";
  return (
    "\nAnswering policies the candidate has set (FOLLOW these exactly whenever a " +
    "field or question matches — they are authoritative and OVERRIDE the general " +
    "\"do not fabricate\" rules: when a policy tells you how to DERIVE a value, " +
    "such as a salary computed from the posted range or a default, compute it and " +
    "enter it; do not leave such a field blank):\n" +
    list.map((p) => `- ${p}`).join("\n")
  );
}

/**
 * Upsert a policy. With an `id`, edits that row (text and/or enabled). Without an
 * `id`, appends a new policy (empty text is a no-op). Returns the full list.
 */
export async function upsertAnswerPolicy(
  profileId: string,
  policy: { id?: string; text?: string; enabled?: boolean },
): Promise<AnswerPolicy[]> {
  const items = await getAnswerPolicies(profileId);
  const id = String(policy.id ?? "").trim();
  if (id) {
    const idx = items.findIndex((it) => it.id === id);
    if (idx >= 0) {
      const text = policy.text !== undefined ? String(policy.text).trim() : items[idx].text;
      if (!text) {
        items.splice(idx, 1); // clearing the text removes the policy
      } else {
        items[idx] = {
          ...items[idx],
          text,
          enabled: policy.enabled !== undefined ? Boolean(policy.enabled) : items[idx].enabled,
          updated_at: nowJstIso(),
        };
      }
    }
  } else {
    const text = String(policy.text ?? "").trim();
    if (text) {
      items.push({
        id: crypto.randomUUID(),
        text,
        enabled: policy.enabled !== undefined ? Boolean(policy.enabled) : true,
        updated_at: nowJstIso(),
      });
    }
  }
  await writeAnswerPolicies(profileId, items);
  return items;
}

export async function deleteAnswerPolicy(profileId: string, id: string): Promise<AnswerPolicy[]> {
  const items = (await getAnswerPolicies(profileId)).filter((it) => it.id !== String(id).trim());
  await writeAnswerPolicies(profileId, items);
  return items;
}
