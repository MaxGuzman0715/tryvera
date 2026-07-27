import type { AnswersPayload, ExtractionResult, Profile } from "./types.js";

/** Used only when the extraction LLM call fails; keeps the pipeline running. */
export function placeholderExtraction(profile: Profile): ExtractionResult {
  return {
    company_name: "Sample Company (placeholder)",
    role_name: "Sample Role (placeholder)",
    role_summary:
      profile.basic.summary?.slice(0, 200) ||
      "Placeholder role summary — the extraction model did not return a result.",
    key_requirements: [
      "End-to-end ownership (placeholder)",
      "Collaboration across teams (placeholder)",
      "Strong communication (placeholder)",
    ],
    questions: [
      "Why are you interested in this role? (placeholder)",
      "Describe a challenging project. (placeholder)",
    ],
    answers: [
      {
        question: "Why are you interested in this role? (placeholder)",
        answer: "I like building real product features end to end and shipping with measurable impact.",
      },
      {
        question: "Describe a challenging project. (placeholder)",
        answer: "I led a production AI workflow from design to monitoring, then iterated after real user feedback.",
      },
    ],
    warnings: [
      "API key or model error — job metadata below is placeholder; résumé/cover letter/answers will also use placeholders if those steps fail.",
    ],
    // K-structure defaults so the bullets pipeline degrades safely (no stacks → untailored résumé).
    signal_quality: "low",
    clearance_required: false,
    clearance_level: "not_required",
    primary_domain: "",
    domain_breakdown: {},
    K1: { hard: {}, soft: [] },
    K2: [],
    competency_signals: [],
  };
}

function contactLineForPlaceholder(profile: Profile): string {
  const b = profile.basic;
  const parts = [b.location, b.phone, b.email, b.linkedin].filter(Boolean);
  if (parts.length) return parts.join(" | ");
  return `${b.location} · ${b.email}`;
}

export function placeholderResumeMarkdown(profile: Profile): string {
  const exp = profile.experience[0];
  const expBlock = exp
    ? `### ${exp.company} | ${exp.title} (${exp.startDate} – ${exp.endDate})
- ${(exp.bullets?.[0] ?? "[Add bullets in your profile]").slice(0, 120)}
- [Template] Add more bullets in your profile; the model will expand these when the API succeeds.`
    : `### [Template] Employer | Role (dates)
- Add roles under Profiles; this block is a placeholder because the resume model call failed.`;

  const title = profile.basic.title?.trim();
  const contact = contactLineForPlaceholder(profile);
  const nameBlock = title && !title.includes("|") ? `${title}\n${contact}` : contact;

  return `# ${profile.basic.fullName}
${nameBlock}

## Summary
[Placeholder — the resume model did not return a result.] Use 2–4 sentences tied to the job when generation works. Example style: lead with scope, then tools and outcomes.

## Experience
${expBlock}

## Skills
${profile.skills.length ? `Core: ${profile.skills.slice(0, 6).join(", ")}${profile.skills.length > 6 ? " …" : ""}` : "[Template] List skills from your profile; group as ML, languages, platforms if helpful."}

## Education
${profile.education[0] ? `${profile.education[0].school} — ${profile.education[0].degree} (${profile.education[0].field})` : "[Template] School — Degree, field (years)"}
`;
}

/** Used when the cover letter LLM call fails. */
export function placeholderCoverLetterMarkdown(profile: Profile): string {
  const b = profile.basic;
  return `Dear Hiring Manager,

[Placeholder — the cover letter model did not return a result. When generation works, this will be a tailored letter explaining why ${b.fullName} is applying and why they are a strong fit for this role, using the job description and profile only.]

I am writing to express my interest in the role and the opportunity to contribute at your company. My background in ${profile.skills.slice(0, 3).join(", ") || "my field"} aligns with the requirements you are seeking.

I would welcome the chance to discuss how my experience can support your team.

Sincerely,

${b.fullName}
`;
}

export function placeholderAnswersPayload(extraction: ExtractionResult): AnswersPayload {
  return {
    answers: extraction.questions.map((q) => ({
      question: q,
      answer: `[Placeholder — the answers model did not return a result. Original question: ${q.slice(0, 120)}]`,
    })),
    quick_reference: {
      what_to_remember: ["Placeholder quick reference — LLM answers step failed."],
      top_talking_points: ["Retry generation after fixing API key or network."],
    },
  };
}
