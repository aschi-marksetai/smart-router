import type { Session, SessionRating } from "./sessions.ts";

export const RERUN_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type SessionOutcome = {
  status: Session["status"];
  failed: boolean;
  retried: boolean;
  followUpSends: number;
  rating: SessionRating["value"] | null;
  // The same prompt was started again within a day without `retry`: a sign the first run was not good enough.
  rerun: boolean;
};

// For each retried session, the handles that retried it, oldest first. retryOf on the retry is the
// only stored link, so a crash can never leave the two ends disagreeing. One pass, because session
// lists run to thousands.
export function retriesByOriginal(sessions: Session[]): Map<string, string[]> {
  const retries = new Map<string, string[]>();
  const oldestFirst = [...sessions].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  for (const { retryOf, handle } of oldestFirst)
    if (retryOf)
      retries.set(retryOf, [...(retries.get(retryOf) ?? []), handle]);
  return retries;
}

// Derived on read from the session records, so there is no second copy to keep in step.
export function sessionOutcome(
  session: Session,
  sessions: Session[],
): SessionOutcome {
  const createdAt = Date.parse(session.createdAt);
  const rerun =
    session.promptSha256 !== undefined &&
    sessions.some((other) => {
      const sincePrevious = Date.parse(other.createdAt) - createdAt;
      return (
        other.promptSha256 === session.promptSha256 &&
        // Any linked retry is counted as a retry of its original, never as a manual rerun.
        !other.retryOf &&
        sincePrevious > 0 &&
        sincePrevious <= RERUN_WINDOW_MS
      );
    });
  return {
    status: session.status,
    failed: session.status === "failed",
    retried: sessions.some(({ retryOf }) => retryOf === session.handle),
    followUpSends: (session.turns ?? []).filter(
      ({ kind }) => kind === "resumed",
    ).length,
    rating: session.rating?.value ?? null,
    rerun,
  };
}

export const RECENT_OUTCOMES_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

export type ModelOutcomes = {
  runs: number;
  failed: number;
  retried: number;
  escalatedFrom: number;
  ratedGood: number;
  ratedBad: number;
};

// What each candidate model did over the last two weeks, given to Jev when the outcomeFeedback arm is on.
export function recentModelOutcomes(
  sessions: Session[],
  modelIds: string[],
  now: number,
): Record<string, ModelOutcomes> {
  const recent = sessions.filter(
    ({ createdAt }) => now - Date.parse(createdAt) <= RECENT_OUTCOMES_WINDOW_MS,
  );
  const retries = retriesByOriginal(sessions);
  const escalatedFrom = new Set(
    sessions.flatMap(({ escalated, retryOf }) =>
      escalated && retryOf ? [retryOf] : [],
    ),
  );
  return Object.fromEntries(
    modelIds.map((modelId) => {
      const runs = recent.filter(
        ({ harness, model }) => `${harness}:${model}` === modelId,
      );
      const count = (matches: (session: Session) => boolean) =>
        runs.filter(matches).length;
      return [
        modelId,
        {
          runs: runs.length,
          failed: count(({ status }) => status === "failed"),
          retried: count(({ handle }) => retries.has(handle)),
          escalatedFrom: count(({ handle }) => escalatedFrom.has(handle)),
          ratedGood: count(({ rating }) => rating?.value === "good"),
          ratedBad: count(({ rating }) => rating?.value === "bad"),
        },
      ];
    }),
  );
}
