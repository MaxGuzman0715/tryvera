import fs from "node:fs/promises";
import path from "node:path";

/**
 * Extraction is told to carry every JD-named tool into the consulting variation and the skills block,
 * but it rewrites and trims lists, and a dropped tool can never reach the résumé: the writer never sees
 * the JD. restoreDroppedJdTools puts back, after the model, every known tool the raw JD names that the
 * variation or the skills block lost, and files each one under the category a reader expects.
 */

/** Lower-case tool names that are real products, not practices. */
export const LOWERCASE_TOOLS = new Set(["pandas", "pytest", "dbt", "pgvector", "scikit-learn", "numpy", "scipy"]);

/** Programming languages: a category made mostly of these holds languages, not libraries. */
export const PROGRAMMING_LANGUAGES = new Set([
  "python", "java", "javascript", "typescript", "go", "golang", "kotlin", "swift", "c", "c++", "c#", "rust",
  "scala", "ruby", "php", "sql", "bash", "r", "dart", "objective-c", "perl", "elixir", "haskell", "lua",
  "matlab", "pl/sql", "shell", "powershell", "groovy", "clojure", "f#", "julia", "solidity", "zig",
]);

export type Domain =
  | "mlops" | "genai" | "data" | "database" | "frontend" | "cloud" | "ml"
  | "backend" | "observability" | "testing" | "security" | "language";

/**
 * The domain a category name belongs to. Order matters: "ML Systems & Data Engineering" is data work,
 * "Cloud & AI Platforms" is cloud, "Languages & Backend" is backend.
 */
const DOMAIN_PATTERNS: [Domain, RegExp][] = [
  ["mlops", /mlops|model systems|model ops|model serving/i],
  ["genai", /generative|agentic|\bllm/i],
  ["data", /data eng|streaming|big data|analytics|pipeline|etl|data platform|lakehouse/i],
  ["database", /database|data ?store|storage|search|retrieval/i],
  ["frontend", /front-?end|\bui\b|mobile|product engineering|web/i],
  ["cloud", /cloud|platform|devops|infra|container|kubernetes/i],
  ["ml", /machine learning|\bai\b|\bml\b|data science|deep learning|computer vision|nlp/i],
  ["backend", /back-?end|\bapi|distributed|architecture|server|microservice/i],
  ["observability", /observab|reliab|monitor/i],
  ["testing", /test|quality/i],
  ["security", /security|identity|compliance|governance/i],
  ["language", /language/i],
];

export function categoryDomain(name: string): Domain | null {
  for (const [d, re] of DOMAIN_PATTERNS) if (re.test(name)) return d;
  return null;
}

/** Tools whose domain no profile category spells out, or whose profile filing is misleading. */
const TOOL_DOMAIN_OVERRIDES: Record<string, Domain> = {
  nosql: "database",
  hadoop: "data",
  mlops: "mlops",
  pandas: "ml",
  numpy: "ml",
  scipy: "ml",
  "scikit-learn": "ml",
  microservices: "backend",
};

/** Named tools a JD commonly asks for that no stored profile spells out. */
const EXTRA_JD_TOOLS = ["NoSQL", "Hadoop"];

export type JdTool = { item: string; categories: string[]; siblings: Set<string> };

/** Named items of a "Category: a, b (c, d)" line, lower-cased. */
export function skillLineItems(line: string): string[] {
  const idx = line.indexOf(":");
  return line
    .slice(idx + 1)
    .split(/[,()]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isLanguageCategory(line: string): boolean {
  const items = skillLineItems(line);
  if (!items.length) return false;
  return items.filter((i) => PROGRAMMING_LANGUAGES.has(i)).length / items.length >= 0.5;
}

/** Disciplines and practices that profiles write in title case or with hyphens but are not tools. */
const NOT_TOOLS = new Set([
  "machine learning", "deep learning", "data science", "artificial intelligence", "computer vision",
  "natural language processing", "reinforcement learning", "generative ai", "data engineering",
  "end-to-end", "fine-tuning", "real-time", "multi-tenant", "multi-tenancy", "event-driven", "open-source",
  "cross-functional", "high-availability", "low-latency", "large-scale", "on-device", "on-call", "a/b testing",
]);

export function isNamedTool(item: string): boolean {
  if (item.length < 2 || item.length > 30 || item.split(/\s+/).length > 3) return false;
  if (NOT_TOOLS.has(item.toLowerCase())) return false;
  // A named tool carries a capital, a digit or a symbol (PyTorch, S3, Next.js, CI/CD); lower-case words
  // are practices ("caching", "fine-tuning") unless they are known lower-case products.
  const named = /[A-Z0-9.+#/]/.test(item) || LOWERCASE_TOOLS.has(item.toLowerCase());
  return named && !(item.includes(" ") && item === item.toLowerCase());
}

/** Every named tool across the given profiles' skills, with its category names and line neighbours. */
export function buildJdToolVocabulary(profileSkillLists: string[][]): Map<string, JdTool> {
  const vocab = new Map<string, JdTool>();
  for (const skills of profileSkillLists) {
    for (const line of skills) {
      if (typeof line !== "string") continue;
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const category = line.slice(0, idx).trim();
      const lineItems = skillLineItems(line);
      for (const raw of line.slice(idx + 1).split(/[,()]/)) {
        const item = raw.trim();
        if (item.length < 3 || !isNamedTool(item)) continue;
        const entry = vocab.get(item.toLowerCase()) ?? { item, categories: [], siblings: new Set<string>() };
        entry.categories.push(category);
        for (const other of lineItems) if (other !== item.toLowerCase()) entry.siblings.add(other);
        vocab.set(item.toLowerCase(), entry);
      }
    }
  }
  return vocab;
}

let cachedVocabulary: Map<string, JdTool> | null = null;

export async function loadJdToolVocabulary(bulletsDir: string): Promise<Map<string, JdTool>> {
  if (cachedVocabulary) return cachedVocabulary;
  const lists: string[][] = [];
  let files: string[] = [];
  try {
    files = (await fs.readdir(bulletsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  for (const f of files) {
    try {
      const skills = JSON.parse(await fs.readFile(path.join(bulletsDir, f), "utf8"))?.skills;
      if (Array.isArray(skills)) lists.push(skills.filter((s: unknown): s is string => typeof s === "string"));
    } catch {
      continue;
    }
  }
  cachedVocabulary = buildJdToolVocabulary(lists);
  return cachedVocabulary;
}

/** The domain a tool belongs to: an explicit override, else the majority of the categories it is filed under. */
export function toolDomain(tool: JdTool): Domain | null {
  const low = tool.item.toLowerCase();
  if (TOOL_DOMAIN_OVERRIDES[low]) return TOOL_DOMAIN_OVERRIDES[low];
  const votes = new Map<Domain, number>();
  for (const c of tool.categories) {
    const d = categoryDomain(c);
    // A library filed in a "Languages & Tooling" line is not a language.
    if (!d || (d === "language" && !PROGRAMMING_LANGUAGES.has(low))) continue;
    votes.set(d, (votes.get(d) ?? 0) + 1);
  }
  let best: Domain | null = null;
  let bestVotes = 0;
  for (const [d, v] of votes) {
    if (v > bestVotes) {
      best = d;
      bestVotes = v;
    }
  }
  return best;
}

const nameOf = (l: string) => l.slice(0, Math.max(0, l.indexOf(":"))).trim();

/**
 * True when the skills already list this tool as an item of its own. "React Query" does not list React
 * and "Spark SQL" does not list SQL; "Apache Spark" does list Spark and "AWS (S3, Lambda)" lists AWS.
 */
export function skillsListTool(skills: string[], item: string): boolean {
  const low = item.toLowerCase();
  return skills.some((l) =>
    splitTopLevel(l.slice(l.indexOf(":") + 1))
      .map((x) => x.toLowerCase())
      .some((x) => {
        const head = x.replace(/\s*\(.*$/, "").trim();
        const inner = (x.match(/\(([^)]*)\)?/)?.[1] ?? "").split(/[,/]/).map((y) => y.trim());
        return head === low || head === `apache ${low}` || inner.includes(low);
      })
  );
}

/** Comma-separated items, keeping "AWS (S3, Lambda, EKS)" together as one. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Where a tool goes in the printed skills. Returns the updated lines (a new category line may be
 * appended) or null when no sensible home exists.
 */
export function placeTool(skills: string[], profileSkills: string[], tool: JdTool): string[] | null {
  const low = tool.item.toLowerCase();
  const isLanguage = PROGRAMMING_LANGUAGES.has(low);
  const domain = toolDomain(tool);
  const siblingScore = (l: string) => skillLineItems(l).filter((x) => tool.siblings.has(x)).length;
  const bestBy = (lines: { line: string; k: number }[]) =>
    lines.reduce<{ line: string; k: number } | null>(
      (a, b) => (a === null || siblingScore(b.line) > siblingScore(a.line) ? b : a),
      null
    );
  const add = (k: number) => {
    const next = [...skills];
    next[k] = `${next[k].replace(/[,\s]+$/, "")}, ${tool.item}`;
    return next;
  };
  const printed = skills.map((line, k) => ({ line, k })).filter((x) => nameOf(x.line) !== "");

  // 1. A printed category of the tool's own domain (a language only into a languages line, never the reverse).
  const sameDomain = printed.filter(({ line }) => {
    const d = categoryDomain(nameOf(line));
    if (isLanguageCategory(line) && !isLanguage) return false;
    return d === domain || (isLanguage && d === "language");
  });
  const inDomain = bestBy(sameDomain);
  if (inDomain) return add(inDomain.k);

  // 2. The candidate's own category for that domain is not printed: bring it back with its strongest items.
  if (domain) {
    const source = profileSkills.find(
      (l) => nameOf(l) !== "" && categoryDomain(nameOf(l)) === domain && !(isLanguageCategory(l) && !isLanguage)
    );
    if (source && !skills.some((l) => nameOf(l).toLowerCase() === nameOf(source).toLowerCase())) {
      const siblings = source
        .slice(source.indexOf(":") + 1)
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x && x.toLowerCase() !== low)
        .slice(0, 5);
      return [...skills, `${nameOf(source)}: ${[tool.item, ...siblings].join(", ")}`];
    }
  }

  // 3. No domain match anywhere: beside at least two of its usual neighbours, never in a languages line.
  const byNeighbours = bestBy(printed.filter(({ line }) => !(isLanguageCategory(line) && !isLanguage)));
  if (byNeighbours && siblingScore(byNeighbours.line) >= 2) return add(byNeighbours.k);
  return null;
}

type Variation = { label?: string; reframed_jd: string };

export function restoreDroppedJdTools(params: {
  jd: string;
  variations: Variation[];
  skills: string[];
  profileSkills: string[];
  usesConsulting: boolean;
  vocab: Map<string, JdTool>;
}): { restored: string[]; skills: string[]; tools: string[] } {
  const { jd, variations, profileSkills, usesConsulting, vocab } = params;
  let skills = [...params.skills];
  if (!jd.trim() || !variations.length) return { restored: [], skills, tools: [] };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const has = (text: string, item: string) => {
    const caseSensitive = /[A-Z]/.test(item);
    return new RegExp(`(^|[^A-Za-z0-9])${esc(item)}([^A-Za-z0-9]|$)`, caseSensitive ? "" : "i").test(text);
  };

  const named: JdTool[] = [];
  for (const entry of vocab.values()) if (has(jd, entry.item)) named.push(entry);
  for (const extra of EXTRA_JD_TOOLS) {
    if (has(jd, extra) && !named.some((n) => n.item.toLowerCase() === extra.toLowerCase())) {
      named.push({ item: extra, categories: [], siblings: new Set<string>() });
    }
  }
  // Drop a term the JD only uses inside a longer named tool ("Spark" inside "Apache Spark", "AWS" inside
  // "AWS Glue"). It stays when the JD also names it on its own - "SQL" beside "MySQL" is its own term.
  const tools = named.filter((n) => {
    const longer = named.filter((o) => o !== n && o.item.length > n.item.length && has(o.item, n.item));
    if (!longer.length) return true;
    let rest = jd;
    for (const o of longer) rest = rest.replace(new RegExp(esc(o.item), /[A-Z]/.test(o.item) ? "g" : "gi"), " ");
    return has(rest, n.item);
  });
  if (!tools.length) return { restored: [], skills, tools: [] };

  const target =
    (usesConsulting ? variations.find((v) => v.label?.toUpperCase() === "B") ?? variations[1] : undefined) ??
    variations.find((v) => v.label?.toUpperCase() === "A") ??
    variations[0];
  const restored: string[] = [];

  const missingInVariation = tools.filter((t) => !has(target.reframed_jd, t.item)).map((t) => t.item);
  if (missingInVariation.length) {
    target.reframed_jd = `${target.reframed_jd.trim()} The work also uses ${missingInVariation.join(", ")}.`;
    restored.push(...missingInVariation);
  }

  if (skills.length) {
    for (const t of tools) {
      if (skillsListTool(skills, t.item)) continue;
      const next = placeTool(skills, profileSkills, t);
      if (!next) continue;
      skills = next;
      if (!restored.includes(t.item)) restored.push(t.item);
    }
  }
  return { restored, skills, tools: tools.map((t) => t.item) };
}

/**
 * Keeps the printed skills block to a readable size WITHOUT ever removing a JD technology.
 * Limits apply only to everything else:
 *   - at most `maxCategories` lines; a line holding a JD tool is always kept, even past the limit;
 *   - at most `maxItems` items per line; JD tools always stay, then tools the bullets name, then other
 *     named tools, and concept phrases ("model evaluation and calibration") are the first to go.
 * Lines arrive ordered most-relevant-first (extraction orders them by domain score), so later lines and
 * later items are the ones cut.
 */
export function trimSkills(
  skills: string[],
  jdTools: string[],
  bulletText: string,
  maxCategories = 8,
  maxItems = 8
): { skills: string[]; removed: string[] } {
  const removed: string[] = [];
  const isJd = (item: string) => jdTools.some((t) => skillsListTool([`x: ${item}`], t));
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inBullets = (item: string) => {
    const head = item.replace(/\s*\(.*$/, "").trim();
    return head.length > 1 && new RegExp(`(^|[^A-Za-z0-9])${esc(head)}([^A-Za-z0-9]|$)`, "i").test(bulletText);
  };
  const isConcept = (item: string) => !isNamedTool(item.replace(/\s*\(.*$/, "").trim());

  const lines = skills
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx <= 0) return { line, name: "", items: [] as string[], jd: false };
      const items = splitTopLevel(line.slice(idx + 1));
      return { line, name: line.slice(0, idx).trim(), items, jd: items.some(isJd) };
    });

  // Categories: the first maxCategories, plus any later one that carries a JD tool.
  let kept = 0;
  const keptLines = lines.filter((l) => {
    if (!l.name) return true;
    if (kept < maxCategories || l.jd) {
      kept++;
      return true;
    }
    removed.push(`[${l.name}]`);
    return false;
  });

  const out = keptLines.map((l) => {
    if (!l.name || l.items.length <= maxItems) return l.line;
    const rank = (item: string) => (isJd(item) ? 0 : inBullets(item) ? 1 : isConcept(item) ? 3 : 2);
    const order = l.items.map((item, i) => ({ item, i, r: rank(item) })).sort((a, b) => a.r - b.r || a.i - b.i);
    const protectedCount = order.filter((x) => x.r === 0).length;
    const limit = Math.max(maxItems, protectedCount);
    const keep = new Set(order.slice(0, limit).map((x) => x.i));
    for (const x of order.slice(limit)) removed.push(x.item);
    // Print in the original order so the most relevant items still lead.
    return `${l.name}: ${l.items.filter((_, i) => keep.has(i)).join(", ")}`;
  });
  return { skills: out, removed };
}
