import fs from "node:fs";
import path from "node:path";
import { promptDefaultsDir } from "./paths.js";

export type PromptKey = "extraction" | "resume" | "coverLetter" | "qa" | "matchScore";

/**
 * Pristine factory text for each prompt, read once at boot from the `default`
 * variant in the prompt store (`<key>/default.txt`). Since the store is the live,
 * git-tracked home (no separate pristine copy), "reset to default" restores this
 * boot snapshot — i.e. the last committed/saved `default` variant.
 */
function readDefaultPromptFile(key: PromptKey): string {
  const filePath = path.join(promptDefaultsDir(), key, "default.txt");
  return fs.readFileSync(filePath, "utf8");
}

export const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  extraction: readDefaultPromptFile("extraction"),
  resume: readDefaultPromptFile("resume"),
  coverLetter: readDefaultPromptFile("coverLetter"),
  qa: readDefaultPromptFile("qa"),
  matchScore: readDefaultPromptFile("matchScore"),
};
