import type { InterviewEvent, PipelineStage } from "./types.js";

/**
 * Where an application stands, read off the emails linked to it.
 *
 * Emails only ever move an application forward, except a rejection, which
 * ends it — but only when it is the LATEST email. A rejection followed by a
 * new interview invite (a different team, a reopened role) is still live.
 * MAYBE emails don't count: the classifier itself wasn't sure they were real.
 */

const RANK: Record<PipelineStage, number> = {
  applied: 0,
  screening: 1,
  interviewing: 2,
  offer: 3,
  rejected: 4,
  withdrawn: 4,
};

function stageOfKind(kind: string | null): PipelineStage {
  switch (kind) {
    case "SCHEDULING":
    case "RESCHEDULE":
    case "NEXT_ROUND":
    case "ASSESSMENT":
      return "interviewing";
    case "OFFER":
      return "offer";
    default:
      // SCREENING_QUESTION, DOCUMENT_REQUEST, OTHER: a person replied, no interview yet.
      return "screening";
  }
}

/** `events` must be the application's linked emails, newest first. */
export function autoStage(events: Pick<InterviewEvent, "verdict" | "kind">[]): PipelineStage {
  const real = events.filter((e) => e.verdict !== "MAYBE");
  if (!real.length) return "applied";
  if (real[0].verdict === "REJECTION") return "rejected";
  let best: PipelineStage = "applied";
  for (const e of real) {
    if (e.verdict === "REJECTION") continue;
    const s = stageOfKind(e.kind);
    if (RANK[s] > RANK[best]) best = s;
  }
  return best;
}
