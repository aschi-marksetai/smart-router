import {
  applyQuotaLimits,
  paceWeight,
  type BalancedCandidate,
} from "./balance.ts";
import type { Config } from "./config.ts";
import type { QuotaSnapshot } from "./quota.ts";

// The weakest tier trusted with each difficulty; the policy picks at that tier and climbs only when it is empty.
export const DIFFICULTY_MINIMUM_TIER = {
  trivial: 1,
  bounded: 2,
  hard: 3,
  frontier: 4,
} as const;
export const DIFFICULTY_CRITERIA: Record<Difficulty, string> = {
  trivial:
    "Mechanical, fully specified work: renames, classification, extraction, running a command and reporting the output",
  bounded:
    "A well-specified change or investigation with clear success criteria",
  hard: "Multi-step work that needs judgment: debugging without a known cause, design across modules, deep review",
  frontier:
    "The hardest problems: long unsupervised runs, novel architecture, decisions with no clear right answer",
};
export const TASTE_THRESHOLD = 0.5;

export type Difficulty = keyof typeof DIFFICULTY_MINIMUM_TIER;
export type Judgments = {
  difficulty: Difficulty;
  difficultyProbabilities: Record<string, number>;
  needsTaste: number;
};

export function isDifficulty(value: string): value is Difficulty {
  return value in DIFFICULTY_MINIMUM_TIER;
}

// Jev judges the task (how hard, whether taste matters); this code turns those judgments into a model.
// It takes the candidates before quota limits: when every model that meets the requirement is over a
// cutoff, the limits are relaxed inside that set (as for a normal route) instead of dropping the requirement.
// A null pick means nothing meets the requirement at all.
export function judgmentPick(
  candidates: BalancedCandidate[],
  judgments: Judgments,
  config: Config,
  quota: QuotaSnapshot | null,
): { pick: string | null; limitsRelaxed: boolean } {
  const minimumTier = DIFFICULTY_MINIMUM_TIER[judgments.difficulty];
  const needsTaste = judgments.needsTaste > TASTE_THRESHOLD;
  const tierOf = (candidate: BalancedCandidate) =>
    config.models.find(({ id }) => id === candidate.id)?.tier ?? 0;
  const qualifying = candidates.filter((candidate) => {
    const model = config.models.find(({ id }) => id === candidate.id);
    return tierOf(candidate) >= minimumTier && (!needsTaste || model?.taste);
  });
  if (qualifying.length === 0) return { pick: null, limitsRelaxed: false };
  const { eligible, limitsRelaxed } = applyQuotaLimits(
    qualifying,
    quota,
    config.rules,
  );
  const lowestTier = Math.min(...eligible.map(tierOf));
  const weight = (candidate: BalancedCandidate) =>
    paceWeight(candidate, quota, config.rules.paceTilt);
  // reduce keeps the earlier candidate on a tie, so config order breaks ties.
  const pick = eligible
    .filter((candidate) => tierOf(candidate) === lowestTier)
    .reduce((best, candidate) =>
      weight(candidate) > weight(best) ? candidate : best,
    ).id;
  return { pick, limitsRelaxed };
}
