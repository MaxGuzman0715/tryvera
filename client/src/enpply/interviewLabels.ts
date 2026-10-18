/** Labels for interview emails, shared by the Interviews page and the Application Logs column. */

/** Same wording as the Slack cards, so a row reads the same in both places. */
export const KIND_LABEL: Record<string, string> = {
  SCHEDULING: "Scheduling",
  RESCHEDULE: "Reschedule",
  NEXT_ROUND: "Next round",
  SCREENING_QUESTION: "Question to answer",
  DOCUMENT_REQUEST: "Send something",
  ASSESSMENT: "Assessment",
  OFFER: "Offer",
  OTHER: "Needs a look",
  REJECTION: "Rejected",
};

export function kindLabel(kind: string | null, verdict: string): string {
  if (verdict === "MAYBE") return "Maybe";
  if (verdict === "REJECTION") return "Rejected";
  return KIND_LABEL[kind ?? ""] ?? "Needs a look";
}

export function kindBadge(kind: string | null, verdict: string): string {
  if (verdict === "MAYBE") return "skip";
  if (verdict === "REJECTION") return "fail";
  if (kind === "OFFER" || kind === "NEXT_ROUND") return "ok";
  if (kind === "SCHEDULING" || kind === "ASSESSMENT") return "info";
  if (kind === "RESCHEDULE") return "gen";
  return "skip";
}

/** Application pipeline stages, in order. Mirrors server PIPELINE_STAGES. */
export const STAGE_LABEL: Record<string, string> = {
  applied: "Applied",
  screening: "Screening",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export function stageBadge(stage: string): string {
  if (stage === "offer") return "ok";
  if (stage === "interviewing") return "info";
  if (stage === "screening") return "gen";
  if (stage === "rejected") return "fail";
  return "skip";
}
