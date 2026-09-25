/**
 * Flags technically incoherent technology combinations in a generated company section.
 *
 * The coverage rule puts every technology the posting names into a bullet, and that is what
 * makes the résumé match on screening. It is not a defect for a JD tool to appear — the skills
 * section is tailored per posting too, so "absent from the stored profile" proves nothing.
 *
 * What IS a defect is a combination no working engineer would ship, which the résumé prompt
 * already forbids in prose: one cloud provider, one CI system and one model provider per piece
 * of work, and never two competing tools doing the same single job. Measured on one batch of
 * 65 runs: FastAPI with Django and Flask in one company, an Azure data stack inside a Google
 * Cloud company, AWS beside Azure in a single bullet. A reviewer who knows the employer sees
 * these immediately.
 *
 * This reports; it never edits. The caller decides what to do with the list.
 */

/** Tools that do the same single job. Two from one group in one bullet is a choice nobody makes twice. */
const EXCLUSIVE_GROUPS: { job: string; tools: string[] }[] = [
  { job: "cloud provider", tools: ["AWS", "Amazon Web Services", "Azure", "Google Cloud", "GCP"] },
  { job: "managed Kubernetes", tools: ["EKS", "AKS", "GKE"] },
  { job: "infrastructure templating", tools: ["CloudFormation", "Bicep", "ARM templates", "Deployment Manager"] },
  { job: "Python web framework", tools: ["FastAPI", "Django", "Flask", "Tornado"] },
  { job: "front-end framework", tools: ["React", "Angular", "Vue", "Svelte"] },
  { job: "CI system", tools: ["GitHub Actions", "Jenkins", "GitLab CI", "Azure DevOps", "Buildkite", "CircleCI", "Travis CI"] },
  { job: "message broker", tools: ["Kafka", "RabbitMQ", "ActiveMQ", "NATS", "Amazon SQS", "Pub/Sub"] },
  { job: "data warehouse", tools: ["Snowflake", "BigQuery", "Redshift", "Synapse"] },
  { job: "model provider", tools: ["OpenAI", "Anthropic", "Claude", "Gemini", "Bedrock", "Azure OpenAI"] },
  { job: "ORM", tools: ["ActiveRecord", "Hibernate", "Entity Framework", "SQLAlchemy", "Prisma"] },
];

/** Groups where using two across ONE EMPLOYER is already implausible, not just within one bullet. */
const COMPANY_WIDE = new Set(["cloud provider", "managed Kubernetes", "infrastructure templating", "Python web framework"]);

/** Word-boundary match that also works for names carrying symbols: C#, .NET, Node.js, Azure OpenAI. */
function mentions(haystack: string, term: string): boolean {
  const t = term.trim();
  if (t.length < 2) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^A-Za-z0-9#+.])${escaped}($|[^A-Za-z0-9#+.])`, "i");
  return re.test(haystack);
}

/**
 * Picks ONE tool per job for each of the two companies, so a bullet cannot pair two that do the
 * same thing. Measured need: of 53 conflicts in one batch, 24 came from the posting naming two
 * (AWS and Azure), 20 from the candidate's own skills holding several (GitHub Actions and
 * Jenkins), and 9 from one of each. Splitting only the posting's tools would leave most of it.
 *
 * The candidate's skills list is NOT reduced by this: it should carry every tool a long career
 * touched, and every requirement the posting names. Only the BULLETS are constrained.
 *
 * The anchor keeps the tool that employer could plausibly run (its stackExclusions decide);
 * consulting takes a different one, which is true of client work anyway.
 */
export function assignToolsPerJob(opts: {
  /** Technologies the posting names. */
  jdTools: string[];
  /** The candidate's stored skills lines — read for candidates only, never trimmed. */
  profileSkills: string[];
  /** Technologies the anchor employer does not run. */
  anchorExclusions: string[];
}): {
  anchor: Record<string, string>;
  consulting: Record<string, string>;
  anchorNot: Record<string, string[]>;
  consultingNot: Record<string, string[]>;
} {
  const { jdTools, profileSkills, anchorExclusions } = opts;
  const skillText = profileSkills.join("\n");
  const banned = new Set(anchorExclusions.map((x) => x.trim().toLowerCase()));
  const inJd = (t: string) => jdTools.some((x) => x.trim().toLowerCase() === t.trim().toLowerCase());

  const anchor: Record<string, string> = {};
  const consulting: Record<string, string> = {};
  const anchorNot: Record<string, string[]> = {};
  const consultingNot: Record<string, string[]> = {};
  for (const group of EXCLUSIVE_GROUPS) {
    // Candidates are tools the posting asked for, or the candidate already lists. Posting first,
    // so a requirement is never the one dropped.
    const available = group.tools.filter((t) => inJd(t) || mentions(skillText, t));
    if (available.length < 2) continue;
    const ordered = [...available].sort((a, b) => Number(inJd(b)) - Number(inJd(a)));
    const forAnchor = ordered.find((t) => !banned.has(t.trim().toLowerCase()));
    if (forAnchor) anchor[group.job] = forAnchor;
    const forConsulting = ordered.find((t) => t !== forAnchor);
    if (forConsulting) consulting[group.job] = forConsulting;
    // A third tool in the same group (a posting naming AWS, Azure AND GCP) has no company left.
    // Unassigned it is free for either section, which is how "Azure and GCP" reached one bullet.
    // Name every alternative so each company knows what is not its own.
    const leftovers = group.tools.filter((t) => t !== forAnchor && t !== forConsulting);
    if (forAnchor) anchorNot[group.job] = group.tools.filter((t) => t !== forAnchor);
    if (forConsulting) consultingNot[group.job] = group.tools.filter((t) => t !== forConsulting);
    void leftovers;
  }
  return { anchor, consulting, anchorNot, consultingNot };
}

/** One conflict: two or more tools from the same job, and where they were found. */
export type ToolConflict = { job: string; tools: string[]; scope: "bullet" | "company" };

/** Returns the incoherent combinations in one company's generated bullets. */
export function findToolConflicts(bullets: string[]): ToolConflict[] {
  if (!bullets.length) return [];
  const out: ToolConflict[] = [];
  const seen = new Set<string>();

  for (const bullet of bullets) {
    for (const group of EXCLUSIVE_GROUPS) {
      const hits = group.tools.filter((t) => mentions(bullet, t));
      if (hits.length < 2) continue;
      const key = `bullet:${group.job}:${hits.join("|")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ job: group.job, tools: hits, scope: "bullet" });
    }
  }

  const whole = bullets.join("\n");
  for (const group of EXCLUSIVE_GROUPS) {
    if (!COMPANY_WIDE.has(group.job)) continue;
    const hits = group.tools.filter((t) => mentions(whole, t));
    if (hits.length < 2) continue;
    // Already reported inside a single bullet; the company-wide line would repeat it.
    if (out.some((c) => c.job === group.job && c.scope === "bullet")) continue;
    out.push({ job: group.job, tools: hits, scope: "company" });
  }
  return out;
}

/** One line per conflict, for a warning or a log. */
export function describeConflicts(company: string, conflicts: ToolConflict[]): string[] {
  return conflicts.map(
    (c) =>
      `${company}: ${c.tools.join(" and ")} both do the ${c.job} job` +
      (c.scope === "bullet" ? " in one bullet" : " in this section")
  );
}
