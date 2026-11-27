import type { HarnessName } from "../../src/config.ts";
import type { Usage } from "../../src/harness/types.ts";
import type { SessionOutcome } from "../../src/outcomes.ts";
import { listCostUsd, type PricingCatalog } from "../../src/pricing.ts";
import type { RouteRecord } from "../../src/route.ts";

const FULL_PERCENT = 100;
const PERCENT_DECIMALS = 10;
export const DEFAULT_SEED = 1;

// One line of `smart-router stats --export`.
export type ReplayLine = {
  handle: string;
  harness: HarnessName;
  model: string;
  effort: string;
  cwd: string;
  usage: Usage | null;
  listCostUsd: number | null;
  retryOf: string | null;
  escalated: boolean;
  route: RouteRecord | null;
  outcome: SessionOutcome;
};
export type PolicyResult = {
  policy: string;
  // Sessions the policy has a pick for.
  picks: number;
  // The recorded tokens priced at the policy's model: an estimate, since another model would use different tokens.
  estimatedListCostUsd: number;
  unpricedPicks: number;
  // Picks naming the model that actually ran; only these have an observed outcome.
  agreed: number;
  agreedOutcomes: {
    failedPercent: number | null;
    retriedPercent: number | null;
    ratedBadPercent: number | null;
    rerunPercent: number | null;
  };
};
export type ReplayReport = {
  sessions: number;
  policies: PolicyResult[];
  costMatchedRandom: {
    cheapModel: string;
    expensiveModel: string;
    expensiveShare: number;
  } | null;
  cascade: {
    chains: number;
    cascadeListCostUsd: number;
    // What the chains would have cost had the final model run first, on the first attempt's tokens.
    directToFinalListCostUsd: number;
  };
  notes: string[];
};
// A model id ("harness:model") per session handle; a missing handle means the policy has no pick.
type Picks = Map<string, string>;

export function parseReplayLines(text: string): ReplayLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function percent(count: number, total: number): number | null {
  if (total === 0) return null;
  return (
    Math.round((count / total) * FULL_PERCENT * PERCENT_DECIMALS) /
    PERCENT_DECIMALS
  );
}

function modelOf(pick: string | null | undefined): string | undefined {
  return pick?.split("@", 1)[0];
}

function actualModel(line: ReplayLine): string {
  return `${line.harness}:${line.model}`;
}

function costOn(
  line: ReplayLine,
  modelId: string,
  pricing: PricingCatalog | null,
): number | null {
  const separator = modelId.indexOf(":");
  return listCostUsd(
    {
      harness: modelId.slice(0, separator) as HarnessName,
      model: modelId.slice(separator + 1),
      usage: line.usage,
    },
    pricing,
  );
}

function policyResult(
  policy: string,
  lines: ReplayLine[],
  picks: Picks,
  pricing: PricingCatalog | null,
): PolicyResult {
  const picked = lines.filter(({ handle }) => picks.has(handle));
  const costs = picked.map((line) =>
    costOn(line, picks.get(line.handle) ?? "", pricing),
  );
  const agreed = picked.filter(
    (line) => picks.get(line.handle) === actualModel(line),
  );
  const rate = (matches: (outcome: SessionOutcome) => boolean) =>
    percent(
      agreed.filter(({ outcome }) => matches(outcome)).length,
      agreed.length,
    );
  return {
    policy,
    picks: picked.length,
    estimatedListCostUsd: costs.reduce<number>(
      (sum, cost) => sum + (cost ?? 0),
      0,
    ),
    unpricedPicks: costs.filter((cost) => cost === null).length,
    agreed: agreed.length,
    agreedOutcomes: {
      failedPercent: rate(({ failed }) => failed),
      retriedPercent: rate(({ retried }) => retried),
      ratedBadPercent: rate(({ rating }) => rating === "bad"),
      rerunPercent: rate(({ rerun }) => rerun),
    },
  };
}

function shadowPicks(
  lines: ReplayLine[],
  shadow: "fixedDefault" | "judgments",
): Picks {
  return new Map(
    lines.flatMap(({ handle, route }) => {
      const model = modelOf(route?.shadow?.[shadow]);
      return model ? [[handle, model]] : [];
    }),
  );
}

// Small seeded generator (mulberry32) so a replay gives the same random baseline every run.
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

// A weighted coin flip between the cheapest and the dearest model, weighted so the
// expected list cost matches what was actually spent. A router that cannot beat this
// baseline on quality is only choosing a price point.
function costMatchedRandom(
  lines: ReplayLine[],
  pricing: PricingCatalog | null,
  seed: number,
): { mix: ReplayReport["costMatchedRandom"]; picks: Picks } {
  const candidates = [
    ...new Set(lines.flatMap(({ route }) => route?.candidates ?? [])),
  ];
  const totals = candidates.flatMap((modelId) => {
    const costs = lines.map((line) => costOn(line, modelId, pricing));
    const priced = costs.some((cost) => cost !== null);
    const total = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
    return priced ? [{ modelId, total }] : [];
  });
  if (totals.length < 2) return { mix: null, picks: new Map() };
  const cheap = totals.reduce((best, entry) =>
    entry.total < best.total ? entry : best,
  );
  const expensive = totals.reduce((best, entry) =>
    entry.total > best.total ? entry : best,
  );
  const recorded = lines.reduce(
    (sum, { listCostUsd: cost }) => sum + (cost ?? 0),
    0,
  );
  const spread = expensive.total - cheap.total;
  const expensiveShare =
    spread === 0
      ? 0
      : Math.min(1, Math.max(0, (recorded - cheap.total) / spread));
  const random = seededRandom(seed);
  return {
    mix: {
      cheapModel: cheap.modelId,
      expensiveModel: expensive.modelId,
      expensiveShare,
    },
    picks: new Map(
      lines.map(({ handle }) => [
        handle,
        random() < expensiveShare ? expensive.modelId : cheap.modelId,
      ]),
    ),
  };
}

// The cascade that was actually run: each `retry --up` chain counts once, as its last model,
// at the cost of every attempt in it.
function observedCascade(
  lines: ReplayLine[],
  pricing: PricingCatalog | null,
): ReplayReport["cascade"] {
  const escalations = new Map(
    lines.flatMap((line) =>
      line.escalated && line.retryOf ? [[line.retryOf, line] as const] : [],
    ),
  );
  const escalatedHandles = new Set(
    [...escalations.values()].map(({ handle }) => handle),
  );
  const chains = lines
    .filter(
      ({ handle }) => escalations.has(handle) && !escalatedHandles.has(handle),
    )
    .map((first) => {
      const chain = [first];
      for (
        let next = escalations.get(first.handle);
        next;
        next = escalations.get(next.handle)
      )
        chain.push(next);
      return chain;
    });
  return {
    chains: chains.length,
    cascadeListCostUsd: chains
      .flat()
      .reduce((sum, { listCostUsd: cost }) => sum + (cost ?? 0), 0),
    directToFinalListCostUsd: chains.reduce(
      (sum, chain) =>
        sum + (costOn(chain[0], actualModel(chain.at(-1)!), pricing) ?? 0),
      0,
    ),
  };
}

// Scores each policy against recorded sessions. Nothing is executed: a policy's pick only has an
// observed outcome where it names the model that actually ran.
export async function replay(
  lines: ReplayLine[],
  pricing: PricingCatalog | null,
  options: {
    // Asks Jev again with the saved inputs and returns its pick; omit to skip that policy.
    ask?: (line: ReplayLine) => Promise<string | null>;
    seed?: number;
  } = {},
): Promise<ReplayReport> {
  const routed = lines.filter(({ route }) => route !== null);
  const notes = [
    "Estimated cost prices the recorded tokens at each policy's model; a different model would use a different number of tokens.",
    "Outcomes are observed only where a policy picks the model that ran. Comparing policies on quality needs an execution benchmark.",
  ];
  const policies = [
    policyResult(
      "recorded",
      routed,
      new Map(routed.map((line) => [line.handle, actualModel(line)])),
      pricing,
    ),
  ];
  if (options.ask) {
    const reasked: Picks = new Map();
    for (const line of routed) {
      const model = modelOf(await options.ask(line));
      if (model) reasked.set(line.handle, model);
    }
    policies.push(policyResult("jevReasked", routed, reasked, pricing));
  } else notes.push("jevReasked skipped: pass --reask to call Jev again.");
  const random = costMatchedRandom(
    routed,
    pricing,
    options.seed ?? DEFAULT_SEED,
  );
  policies.push(
    policyResult(
      "fixedDefault",
      routed,
      shadowPicks(routed, "fixedDefault"),
      pricing,
    ),
    policyResult(
      "judgments",
      routed,
      shadowPicks(routed, "judgments"),
      pricing,
    ),
    policyResult("costMatchedRandom", routed, random.picks, pricing),
  );
  return {
    sessions: routed.length,
    policies,
    costMatchedRandom: random.mix,
    cascade: observedCascade(lines, pricing),
    notes,
  };
}

function shown(value: number | null): string {
  return value === null ? "n/a" : `${value}%`;
}

export function formatReplay(report: ReplayReport): string {
  const mix = report.costMatchedRandom;
  return [
    `Replay of ${report.sessions} recorded routing decisions (dry run, nothing executed)`,
    ...report.policies.map(
      ({
        policy,
        picks,
        estimatedListCostUsd,
        unpricedPicks,
        agreed,
        agreedOutcomes,
      }) =>
        `  ${policy}: ${picks} picks, est. $${estimatedListCostUsd.toFixed(2)} (${unpricedPicks} unpriced), ${agreed} match the run; of those failed ${shown(agreedOutcomes.failedPercent)}, retried ${shown(agreedOutcomes.retriedPercent)}, rated bad ${shown(agreedOutcomes.ratedBadPercent)}, rerun ${shown(agreedOutcomes.rerunPercent)}`,
    ),
    mix
      ? `  costMatchedRandom mixes ${mix.cheapModel} and ${mix.expensiveModel} (${(mix.expensiveShare * FULL_PERCENT).toFixed(1)}% on the dearer one)`
      : "  costMatchedRandom: fewer than two priced candidate models",
    `  observed cascade: ${report.cascade.chains} retry --up chains cost $${report.cascade.cascadeListCostUsd.toFixed(2)}; starting on the final model would have cost about $${report.cascade.directToFinalListCostUsd.toFixed(2)}`,
    ...report.notes.map((note) => `  note: ${note}`),
    "",
  ].join("\n");
}
