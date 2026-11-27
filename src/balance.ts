import { DEFAULT_PACE_TILT, type Config, type HarnessName } from "./config.ts";
import type { ModelWindow, QuotaSnapshot } from "./quota.ts";

// A pool this many points over pace, next to another with this much reserve, counts as out of balance.
export const PACE_IMBALANCE_THRESHOLD = 10;
const FULL_PERCENT = 100;
const POOL_NAMES: Record<HarnessName, string> = {
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
};

export type ExclusionKind = "quota" | "scope" | "confidential" | "escalation";
export type Exclusion = { id: string; reason: string; kind: ExclusionKind };
export type BalancedCandidate = { id: string; harness: HarnessName };
export type PoolImbalance = {
  guardedGap: number;
  otherHarness: HarnessName;
  otherGap: number;
};

function modelWindowsFor(
  candidate: BalancedCandidate,
  quota: QuotaSnapshot | null,
): ModelWindow[] {
  return (quota?.[candidate.harness]?.modelWindows ?? []).filter(({ models }) =>
    models.some((glob) => new Bun.Glob(glob).match(candidate.id)),
  );
}

export function quotaLimitReason(
  candidate: BalancedCandidate,
  quota: QuotaSnapshot | null,
  rules: Config["rules"],
): string | null {
  const pool = quota?.[candidate.harness];
  if (!pool) return null;
  const poolCutoff = rules.quotaCutoffPercent?.[candidate.harness];
  if (typeof poolCutoff === "number" && pool.weeklyUsedPercent >= poolCutoff)
    return `${candidate.harness} pool at ${pool.weeklyUsedPercent}% (cutoff ${poolCutoff}%)`;
  const windowCutoff = rules.modelWindowCutoffPercent;
  if (windowCutoff === undefined) return null;
  const fullWindow = modelWindowsFor(candidate, quota).find(
    ({ usedPercent }) => usedPercent >= windowCutoff,
  );
  if (!fullWindow) return null;
  return `${fullWindow.label} window at ${fullWindow.usedPercent}% (cutoff ${windowCutoff}%)`;
}

// Applies the quota cutoffs. When they would leave nothing, they are dropped and only the
// least-used pool stays, so a fully spent week still routes somewhere.
export function applyQuotaLimits<Candidate extends BalancedCandidate>(
  candidates: Candidate[],
  quota: QuotaSnapshot | null,
  rules: Config["rules"],
): { eligible: Candidate[]; excluded: Exclusion[]; limitsRelaxed: boolean } {
  const excluded: Exclusion[] = [];
  const eligible = candidates.filter((candidate) => {
    const reason = quotaLimitReason(candidate, quota, rules);
    if (reason) excluded.push({ id: candidate.id, reason, kind: "quota" });
    return !reason;
  });
  if (eligible.length > 0 || candidates.length === 0)
    return { eligible, excluded, limitsRelaxed: false };
  const weeklyUsed = (harness: HarnessName) =>
    quota?.[harness]?.weeklyUsedPercent ?? FULL_PERCENT;
  const leastUsedPool = candidates
    .map(({ harness }) => harness)
    .reduce((least, harness) =>
      weeklyUsed(harness) < weeklyUsed(least) ? harness : least,
    );
  const kept = candidates.filter(({ harness }) => harness === leastUsedPool);
  return {
    eligible: kept,
    excluded: excluded.filter(({ id }) => !kept.some((kept) => kept.id === id)),
    limitsRelaxed: true,
  };
}

// The pool's gap, or a covering model window's gap when that one is tighter.
export function paceGapFor(
  candidate: BalancedCandidate,
  quota: QuotaSnapshot | null,
): number {
  const pool = quota?.[candidate.harness];
  if (!pool) return 0;
  return Math.min(
    pool.paceGap,
    ...modelWindowsFor(candidate, quota).map(({ paceGap }) => paceGap),
  );
}

export function paceWeight(
  candidate: BalancedCandidate,
  quota: QuotaSnapshot | null,
  paceTilt: number = DEFAULT_PACE_TILT,
): number {
  return Math.exp((paceTilt * paceGapFor(candidate, quota)) / FULL_PERCENT);
}

export function weightedPick(
  candidates: BalancedCandidate[],
  probabilities: Record<string, number>,
  quota: QuotaSnapshot | null,
  paceTilt: number = DEFAULT_PACE_TILT,
): {
  pick: string | null;
  untiltedPick: string | null;
  weights: Record<string, number>;
  weightedScores: Record<string, number>;
} {
  const weights: Record<string, number> = {};
  const weightedScores: Record<string, number> = {};
  let pick: string | null = null;
  let untiltedPick: string | null = null;
  for (const candidate of candidates) {
    const probability = probabilities[candidate.id] ?? 0;
    const weight = paceWeight(candidate, quota, paceTilt);
    weights[candidate.id] = weight;
    weightedScores[candidate.id] = probability * weight;
    // Strict comparisons keep config order as the tie-break.
    if (weightedScores[candidate.id] > (pick ? weightedScores[pick] : 0))
      pick = candidate.id;
    if (probability > (untiltedPick ? (probabilities[untiltedPick] ?? 0) : 0))
      untiltedPick = candidate.id;
  }
  return { pick, untiltedPick, weights, weightedScores };
}

// Used when Jev gives no usable answer: the default when eligible, else the first
// candidate (config order) from the pool with the most reserve.
export function fallbackCandidate<Candidate extends BalancedCandidate>(
  candidates: Candidate[],
  defaultModelId: string,
  quota: QuotaSnapshot | null,
): Candidate {
  const eligibleDefault = candidates.find(({ id }) => id === defaultModelId);
  if (eligibleDefault) return eligibleDefault;
  const poolGap = ({ harness }: Candidate) => quota?.[harness]?.paceGap ?? 0;
  return candidates.reduce((best, candidate) =>
    poolGap(candidate) > poolGap(best) ? candidate : best,
  );
}

export function poolImbalance(
  harness: HarnessName,
  quota: QuotaSnapshot | null,
  enabledHarnesses: HarnessName[],
): PoolImbalance | null {
  const guardedGap = quota?.[harness]?.paceGap;
  if (guardedGap === undefined || guardedGap >= -PACE_IMBALANCE_THRESHOLD)
    return null;
  for (const otherHarness of enabledHarnesses) {
    const otherGap = quota?.[otherHarness]?.paceGap;
    if (
      otherHarness !== harness &&
      otherGap !== undefined &&
      otherGap > PACE_IMBALANCE_THRESHOLD
    )
      return { guardedGap, otherHarness, otherGap };
  }
  return null;
}

export function enabledHarnesses(config: Config): HarnessName[] {
  return (Object.keys(config.harnesses) as HarnessName[]).filter(
    (harness) => config.harnesses[harness]?.enabled,
  );
}

export function pinWarnings(
  candidate: BalancedCandidate,
  quota: QuotaSnapshot | null,
  config: Config,
): string[] {
  const warnings: string[] = [];
  const limitReason = quotaLimitReason(candidate, quota, config.rules);
  if (limitReason)
    warnings.push(`${candidate.id} is over its quota cutoff: ${limitReason}`);
  const imbalance = poolImbalance(
    candidate.harness,
    quota,
    enabledHarnesses(config),
  );
  if (imbalance)
    warnings.push(
      `${POOL_NAMES[candidate.harness]} is ${Math.round(-imbalance.guardedGap)} pts over pace while ${POOL_NAMES[imbalance.otherHarness]} has ${Math.round(imbalance.otherGap)} in reserve; let the router choose instead of pinning`,
    );
  return warnings;
}

export function paceSummary(quota: QuotaSnapshot | null): string {
  return (Object.keys(quota ?? {}) as HarnessName[])
    .flatMap((harness) => {
      const gap = quota?.[harness]?.paceGap;
      if (gap === undefined) return [];
      const points = Math.round(Math.abs(gap));
      if (points === 0) return [`${POOL_NAMES[harness]} on pace`];
      return [
        gap < 0
          ? `${POOL_NAMES[harness]} ${points} pts over pace`
          : `${POOL_NAMES[harness]} ${points} in reserve`,
      ];
    })
    .join(", ");
}
