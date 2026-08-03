import fs from "node:fs/promises";
import path from "node:path";
import { profileAnswersDir } from "./paths.js";
import { nowJstIso } from "./timeJst.js";

/**
 * Per-PROFILE reusable answers for the Tryvify extension. When a user marks a
 * field's answer "reusable", we store it here keyed (for lookup) by the
 * normalized question text, so the SAME answer is served — with no AI call —
 * for every application that uses this profile.
 *
 * This is the profile-scoped half of the fill answer model. The other half is
 * application-scoped and lives in each run's `result.json` `answers` array (the
 * shared source, reused by the Result page and seeded by AI fills).
 *
 * Stored as `Experiment/answers/<profileId>.json` = { items: [...] }, beside the
 * profiles (so it's version-controlled with them — see profileAnswersDir).
 */

export type ProfileAnswer = { question: string; answer: string; updated_at: string };

/** On-disk shape. `seeded` records that the one-time defaults were applied. */
type AnswersFile = { items: ProfileAnswer[]; seeded?: boolean };

/**
 * Questions pre-seeded into every profile's reusable answers the FIRST time its
 * answers are read. EEO self-identification questions default to "Decline to
 * self-identify" — always a valid, truthful option — while work-eligibility and
 * screening questions are seeded blank for the candidate to fill in the
 * Tryvify tab (we must never guess those). Every row is editable/removable, and
 * removals stick because the profile is marked `seeded` (see getProfileAnswers).
 */
const DECLINE = "Decline to self-identify";
export const DEFAULT_REUSABLE_ANSWERS: Array<{ question: string; answer: string }> = [
  // EEO self-identification
  { question: "Gender", answer: DECLINE },
  { question: "Race / Ethnicity", answer: DECLINE },
  { question: "Are you Hispanic or Latino?", answer: DECLINE },
  { question: "Veteran status", answer: DECLINE },
  { question: "Disability status", answer: DECLINE },
  // Work eligibility — blank; the candidate must answer these truthfully.
  { question: "Are you legally authorized to work in the country where this role is based?", answer: "" },
  { question: "Will you now or in the future require visa sponsorship for employment?", answer: "" },
  // Common screening — blank.
  { question: "What is your notice period?", answer: "" },
  { question: "What is your earliest available start date?", answer: "" },
  { question: "What are your salary expectations?", answer: "" },
  { question: "Are you open to relocation?", answer: "" },
  { question: "Preferred work arrangement (onsite / hybrid / remote)?", answer: "" },
];

/** Canonical key for matching a question across phrasings/spacing. */
export function normalizeQuestion(q: string): string {
  return String(q || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function answersPath(profileId: string): string {
  const safe = String(profileId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(profileAnswersDir(), `${safe}.json`);
}

async function readAnswersFile(profileId: string): Promise<AnswersFile> {
  try {
    const raw = await fs.readFile(answersPath(profileId), "utf8");
    const parsed = JSON.parse(raw) as Partial<AnswersFile>;
    return { items: Array.isArray(parsed.items) ? parsed.items : [], seeded: parsed.seeded === true };
  } catch {
    return { items: [], seeded: false };
  }
}

/**
 * A profile's reusable answers. On the FIRST read (not yet `seeded`), merge in
 * the default questions the user doesn't already have, mark the profile seeded
 * so later removals are respected, and persist. Subsequent reads are pass-through.
 */
export async function getProfileAnswers(profileId: string): Promise<ProfileAnswer[]> {
  const file = await readAnswersFile(profileId);
  if (file.seeded) return file.items;
  const have = new Set(file.items.map((it) => normalizeQuestion(it.question)));
  const merged = [...file.items];
  for (const d of DEFAULT_REUSABLE_ANSWERS) {
    if (!have.has(normalizeQuestion(d.question))) {
      merged.push({ question: d.question, answer: d.answer, updated_at: nowJstIso() });
    }
  }
  merged.sort((a, b) => a.question.localeCompare(b.question));
  await writeProfileAnswers(profileId, merged);
  return merged;
}

/** Persist answers; always marks the profile seeded so defaults aren't re-added. */
async function writeProfileAnswers(profileId: string, items: ProfileAnswer[]): Promise<void> {
  await fs.mkdir(profileAnswersDir(), { recursive: true });
  const payload: AnswersFile = { items, seeded: true };
  await fs.writeFile(answersPath(profileId), JSON.stringify(payload, null, 2), "utf8");
}

/** Normalized-question → answer map for fast fill-time lookup. */
export async function getProfileAnswerMap(profileId: string): Promise<Map<string, string>> {
  const items = await getProfileAnswers(profileId);
  const m = new Map<string, string>();
  for (const it of items) {
    if (it.answer) m.set(normalizeQuestion(it.question), it.answer);
  }
  return m;
}

/** Upsert by normalized question. An empty answer removes the entry. */
export async function upsertProfileAnswer(
  profileId: string,
  question: string,
  answer: string,
): Promise<ProfileAnswer[]> {
  const q = String(question || "").trim();
  if (!q) return getProfileAnswers(profileId);
  const key = normalizeQuestion(q);
  const items = (await getProfileAnswers(profileId)).filter(
    (it) => normalizeQuestion(it.question) !== key,
  );
  const trimmed = String(answer || "").trim();
  if (trimmed) items.push({ question: q, answer: trimmed, updated_at: nowJstIso() });
  items.sort((a, b) => a.question.localeCompare(b.question));
  await writeProfileAnswers(profileId, items);
  return items;
}

export async function deleteProfileAnswer(profileId: string, question: string): Promise<ProfileAnswer[]> {
  return upsertProfileAnswer(profileId, question, "");
}
