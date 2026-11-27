import "./environment.ts";
import { expect, test } from "bun:test";
import {
  formatReplay,
  parseReplayLines,
  replay,
  type ReplayLine,
} from "../evals/replay/replay.ts";
import type { RouteRecord } from "../src/route.ts";

// $ per million tokens: luna is cheap, astra dear, sol in between.
const pricing = {
  openai: {
    models: {
      luna: { cost: { input: 1, output: 1 } },
      sol: { cost: { input: 5, output: 5 } },
      astra: { cost: { input: 10, output: 10 } },
    },
  },
};
const usage = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  costUsd: null,
};
const outcome = {
  status: "done" as const,
  failed: false,
  retried: false,
  followUpSends: 0,
  rating: null,
  rerun: false,
};
const candidates = ["codex:luna", "codex:sol", "codex:astra", "codex:unpriced"];

function line(
  handle: string,
  model: string,
  listCostUsd: number | null,
  overrides: Partial<ReplayLine> = {},
  shadow: object | null = {
    fixedDefault: "codex:sol@high",
    judgments: `codex:${model}@high`,
  },
): ReplayLine {
  return {
    handle,
    harness: "codex",
    model,
    effort: "high",
    cwd: "/repo",
    usage,
    listCostUsd,
    retryOf: null,
    escalated: false,
    route: { kind: "routed", candidates, shadow } as unknown as RouteRecord,
    outcome,
    ...overrides,
  };
}

const lines = [
  line("a", "luna", 1, {
    outcome: { ...outcome, failed: true, retried: true },
  }),
  line("b", "sol", 5, { retryOf: "a", escalated: true }),
  line("c", "astra", 10, {
    retryOf: "b",
    escalated: true,
    outcome: { ...outcome, rating: "bad", rerun: true },
  }),
  line("d", "sol", 5, {}, null),
  line("e", "luna", null, { usage: null }),
  { ...line("f", "sol", 5), route: null },
];

test("parses an export and scores each policy against what ran", async () => {
  const text = `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n\n`;
  const parsed = parseReplayLines(text);
  expect(parsed).toHaveLength(6);
  const report = await replay(parsed, pricing);
  // The session saved without a route record is not a routing decision.
  expect(report.sessions).toBe(5);
  const policy = (name: string) =>
    report.policies.find((result) => result.policy === name);
  expect(policy("recorded")).toEqual({
    policy: "recorded",
    picks: 5,
    estimatedListCostUsd: 21,
    unpricedPicks: 1,
    agreed: 5,
    agreedOutcomes: {
      failedPercent: 20,
      retriedPercent: 20,
      ratedBadPercent: 20,
      rerunPercent: 20,
    },
  });
  // The default (sol) on the four sessions with a shadow: three priced at $5, one without usage.
  expect(policy("fixedDefault")).toMatchObject({
    picks: 4,
    estimatedListCostUsd: 15,
    unpricedPicks: 1,
    agreed: 1,
    agreedOutcomes: { failedPercent: 0 },
  });
  expect(policy("judgments")).toMatchObject({ picks: 4, agreed: 4 });
  expect(policy("jevReasked")).toBeUndefined();
  expect(report.notes.at(-1)).toContain("jevReasked skipped");
  // $21 was spent; all-luna costs $4 and all-astra $40, so 17/36 of the flips go to astra.
  expect(report.costMatchedRandom).toEqual({
    cheapModel: "codex:luna",
    expensiveModel: "codex:astra",
    expensiveShare: 17 / 36,
  });
  expect(policy("costMatchedRandom")?.picks).toBe(5);
  // One chain, a -> b -> c: $16 across three attempts, against $10 for astra on the first attempt's tokens.
  expect(report.cascade).toEqual({
    chains: 1,
    cascadeListCostUsd: 16,
    directToFinalListCostUsd: 10,
  });
  const text2 = formatReplay(report);
  expect(text2).toContain("Replay of 5 recorded routing decisions");
  expect(text2).toContain(
    "recorded: 5 picks, est. $21.00 (1 unpriced), 5 match",
  );
  expect(text2).toContain(
    "mixes codex:luna and codex:astra (47.2% on the dearer one)",
  );
  expect(text2).toContain("1 retry --up chains cost $16.00");
});

test("the random baseline is reproducible for a seed and changes with it", async () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    line(`h${index}`, "sol", 5),
  );
  const picks = async (seed?: number) =>
    (await replay(many, pricing, { seed })).policies.find(
      ({ policy }) => policy === "costMatchedRandom",
    );
  expect(await picks(7)).toEqual(await picks(7));
  expect(await picks()).toEqual(await picks(1));
  const agreedCounts = new Set(
    await Promise.all(
      [1, 2, 3, 4, 5].map(
        async (seed) => (await picks(seed))?.estimatedListCostUsd,
      ),
    ),
  );
  expect(agreedCounts.size).toBeGreaterThan(1);
});

test("re-asking Jev is scored when an ask function is given", async () => {
  const asked: string[] = [];
  const report = await replay(lines, pricing, {
    ask: async ({ handle, model }) => {
      asked.push(handle);
      return handle === "d" ? null : `codex:${model}@low`;
    },
  });
  expect(asked).toEqual(["a", "b", "c", "d", "e"]);
  expect(
    report.policies.find(({ policy }) => policy === "jevReasked"),
  ).toMatchObject({ picks: 4, agreed: 4 });
  expect(report.notes).toHaveLength(2);
});

test("handles an empty export, a single priced model and equal prices", async () => {
  const empty = await replay([], pricing);
  expect(empty).toMatchObject({
    sessions: 0,
    costMatchedRandom: null,
    cascade: { chains: 0, cascadeListCostUsd: 0, directToFinalListCostUsd: 0 },
  });
  expect(empty.policies[0].agreedOutcomes.failedPercent).toBeNull();
  expect(formatReplay(empty)).toContain(
    "costMatchedRandom: fewer than two priced candidate models",
  );
  const unpriced = await replay(lines, null);
  expect(unpriced.costMatchedRandom).toBeNull();
  const flat = {
    openai: {
      models: {
        luna: { cost: { input: 2, output: 2 } },
        sol: { cost: { input: 2, output: 2 } },
      },
    },
  };
  expect(
    (await replay([line("a", "luna", 2)], flat)).costMatchedRandom,
  ).toMatchObject({ expensiveShare: 0 });
});
