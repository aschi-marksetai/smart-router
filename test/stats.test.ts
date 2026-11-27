import "./environment.ts";
import { expect, test } from "bun:test";
import type { RouteRecord } from "../src/route.ts";
import type { Session } from "../src/sessions.ts";
import {
  COLLAPSE_MINIMUM_ROUTED,
  exportLines,
  formatStats,
  statsEntries,
  statsReport,
  statsWindow,
} from "../src/stats.ts";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const window = statsWindow({ days: 7 }, null, NOW);
let nextHandle = 0;

function routeRecord(overrides: Partial<RouteRecord> = {}): RouteRecord {
  return {
    version: 2,
    kind: "routed",
    pick: "codex:sol@high",
    confidence: 0.9,
    probabilities: {},
    effortProbabilities: {},
    reason: "test",
    fellBack: false,
    candidates: [],
    availableModels: [],
    needsBrowser: 0,
    statesStoppingPoint: 1,
    needsNetwork: 0,
    needsFullAccess: 0,
    rawPick: "codex:sol",
    weights: {},
    weightedScores: {},
    tiltChanged: false,
    lowConfidence: false,
    excluded: [],
    limitsRelaxed: false,
    warnings: [],
    inputs: {
      hint: null,
      quota: null,
      preferencesSha256: null,
      jevModel: null,
      jevServedModel: null,
      routingLatencyMs: null,
      quotaLatencyMs: null,
      quotaAgeMs: null,
    },
    policy: "jev",
    policyRelaxed: false,
    judgments: null,
    shadow: null,
    experiments: {},
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  nextHandle += 1;
  return {
    handle: `h${nextHandle}`,
    harness: "codex",
    model: "sol",
    effort: "high",
    cwd: "/repo",
    owner: "owner",
    createdAt: new Date(NOW - 60_000).toISOString(),
    promptPreview: "task",
    promptSha256: `hash-${nextHandle}`,
    status: "done",
    route: routeRecord(),
    ...overrides,
  };
}

function report(sessions: Session[]) {
  const entries = statsEntries(sessions, window, null);
  return statsReport({
    entries,
    window,
    quota: null,
    pinWarnings: [],
    guardDecisions: [],
    externalCostUsd: {},
  });
}

test("windows follow --days or the quota reset times", () => {
  expect(statsWindow({}, null, NOW)).toEqual({
    label: "last 7 days",
    from: "2026-11-20T12:00:00.000Z",
    to: "2026-11-27T12:00:00.000Z",
    rollingDays: 7,
  });
  const quota = {
    claude: {
      weeklyUsedPercent: 1,
      weeklyResetsAt: "2026-11-29T10:00:00Z",
      fiveHourUsedPercent: null,
      pace: "",
      paceGap: 0,
      modelWindows: [],
    },
    codex: {
      weeklyUsedPercent: 1,
      weeklyResetsAt: "2026-12-04T01:30:00Z",
      fiveHourUsedPercent: null,
      pace: "",
      paceGap: 0,
      modelWindows: [],
    },
    pi: null,
  };
  // The earliest current window (Claude's) starts the report so every pool's window is covered.
  expect(statsWindow({ window: "current" }, quota, NOW)).toEqual({
    label: "current quota window",
    from: "2026-11-22T10:00:00.000Z",
    to: "2026-11-27T12:00:00.000Z",
    rollingDays: 6,
  });
  expect(statsWindow({ window: "previous" }, quota, NOW)).toEqual({
    label: "previous quota window",
    from: "2026-11-15T10:00:00.000Z",
    to: "2026-11-22T10:00:00.000Z",
    rollingDays: null,
  });
  expect(() =>
    statsWindow(
      { window: "current" },
      { claude: { ...quota.claude, weeklyResetsAt: "soon" } },
      NOW,
    ),
  ).toThrow("--window needs the quota reset times");
});

test("only sessions created inside the window are counted, and old route shapes are unrecorded", () => {
  const sessions = [
    session(),
    session({
      createdAt: new Date(NOW - 8 * 24 * 60 * 60 * 1_000).toISOString(),
    }),
    // Created this instant: inside a window that ends now.
    session({ createdAt: new Date(NOW).toISOString() }),
    // Exactly at the start: belongs to the window before.
    session({ createdAt: window.from }),
    session({ route: null }),
    session({ route: { pick: "codex:sol@high" } as Session["route"] }),
  ];
  const stats = report(sessions);
  expect(stats.sessions).toBe(4);
  expect(stats.pickSources).toMatchObject({ routed: 2, unrecorded: 2 });
});

test("the feature audit compares outcomes where a feature fired with where it did not", () => {
  const tilted = session({
    route: routeRecord({ tiltChanged: true }),
    status: "failed",
  });
  const limited = session({
    route: routeRecord({
      excluded: [{ id: "codex:sol", reason: "full", kind: "quota" }],
    }),
    rating: { value: "bad", note: null, at: "now" },
  });
  const relaxed = session({
    route: routeRecord({
      kind: "fallback",
      limitsRelaxed: true,
      lowConfidence: true,
    }),
  });
  const scoped = session({
    route: routeRecord({
      excluded: [{ id: "pi:x", reason: "scope", kind: "scope" }],
    }),
  });
  const rerunOf = session({ promptSha256: "same" });
  const rerun = session({
    promptSha256: "same",
    createdAt: new Date(NOW - 30_000).toISOString(),
  });
  const stats = report([tilted, limited, relaxed, scoped, rerunOf, rerun]);
  const feature = (name: string) =>
    stats.features.find((candidate) => candidate.name === name);
  expect(feature("paceTilt")).toEqual({
    name: "paceTilt",
    fired: {
      sessions: 1,
      failedPercent: 100,
      retriedPercent: 0,
      ratedBadPercent: 0,
      rerunPercent: 0,
    },
    notFired: {
      sessions: 4,
      failedPercent: 0,
      retriedPercent: 0,
      ratedBadPercent: 25,
      rerunPercent: 25,
    },
  });
  expect(feature("hardLimits")).toMatchObject({
    fired: { sessions: 2, ratedBadPercent: 50 },
    notFired: { sessions: 4 },
  });
  expect(stats.pickSources).toMatchObject({
    routed: 5,
    fallback: 1,
    tiltChanged: 1,
    lowConfidence: 1,
    limitsRelaxed: 1,
  });
});

test("pin warnings are counted inside the window, with how many ran anyway", () => {
  const entries = statsEntries([session()], window, null);
  const stats = statsReport({
    entries,
    window,
    quota: null,
    pinWarnings: [
      { ts: new Date(NOW - 1_000).toISOString(), ran: true },
      { ts: new Date(NOW - 2_000).toISOString(), ran: false },
      { ts: "2020-01-01T00:00:00Z", ran: true },
      { ran: true },
    ],
    guardDecisions: [],
    externalCostUsd: { claude: 0, codex: null },
  });
  expect(stats.pickSources).toMatchObject({
    pinWarningsIssued: 2,
    pinWarningsRanAnyway: 1,
  });
  expect(stats.spendShare).toEqual({
    claude: {
      pricedSessions: 0,
      sessions: 0,
      lowerBound: false,
      smartRouterCostUsd: 0,
      totalListCostUsd: 0,
      sharePercent: null,
    },
  });
});

test("warns when one model takes 90% of enough routed picks", () => {
  const collapsed = [
    ...Array.from({ length: COLLAPSE_MINIMUM_ROUTED - 1 }, () => session()),
    session({ harness: "claude", model: "opus" }),
  ];
  const stats = report(collapsed);
  expect(stats.collapse).toEqual({
    model: "codex:sol",
    sharePercent: 90,
    routed: COLLAPSE_MINIMUM_ROUTED,
  });
  expect(formatStats(stats)).toContain(
    "WARNING: codex:sol took 90% of 10 routed picks; the router is not choosing",
  );
  // Too few routed picks to call it a collapse.
  expect(report(collapsed.slice(0, 5)).collapse).toBeNull();
  // Enough picks, but spread across models.
  const spread = [
    ...Array.from({ length: 5 }, () => session()),
    ...Array.from({ length: 5 }, () =>
      session({ harness: "claude", model: "opus" }),
    ),
  ];
  expect(report(spread).collapse).toBeNull();
  // Pins do not count as the router's choices.
  const pinned = Array.from({ length: 12 }, () =>
    session({ route: routeRecord({ kind: "pinned" }) }),
  );
  expect(report(pinned).collapse).toBeNull();
});

test("the text report and the export cover an empty window", () => {
  const stats = report([]);
  const text = formatStats(stats);
  expect(text).toContain(
    "0 sessions, $0.00 cost (no cost; at most $0.00 if every list-priced request was billed at the highest context rate)",
  );
  expect(text).toContain("paceTilt fired: 0 sessions, failed n/a");
  expect(text).not.toContain("WARNING");
  expect(exportLines([])).toBe("");
  const [line] = exportLines(
    statsEntries([session({ route: null })], window, null),
  )
    .trim()
    .split("\n")
    .map((entry) => JSON.parse(entry));
  expect(line).toMatchObject({
    label: null,
    phase: null,
    retryOf: null,
    retriedBy: [],
    escalated: false,
    usage: null,
    route: null,
    costUsd: null,
    costSource: null,
    listCostUsd: null,
  });
});

test("a retry counts under the first attempt's label and phase unless it has its own", () => {
  const original = session({ label: "wave:a", phase: "build" });
  const retry = session({ retryOf: original.handle });
  const retryOfRetry = session({ retryOf: retry.handle, phase: "fixes" });
  const orphan = session({ retryOf: "pruned" });
  const stats = report([original, retry, retryOfRetry, orphan]);
  expect(stats.labels).toMatchObject({
    "wave:a": { runs: 3 },
    "(none)": { runs: 1 },
  });
  expect(stats.phases).toMatchObject({
    build: { runs: 2 },
    fixes: { runs: 1 },
    "(none)": { runs: 1 },
  });
  const exported = exportLines(statsEntries([original, retry], window, null))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(exported.map(({ label, phase }) => [label, phase])).toEqual([
    ["wave:a", "build"],
    ["wave:a", "build"],
  ]);
});

test("shadow policies and experiment arms are audited against outcomes", () => {
  const shadow = {
    rawJev: "codex:sol@high",
    weighted: "codex:sol@high",
    fixedDefault: "codex:terra@high",
    judgments: null,
  };
  const agreeing = session({
    route: routeRecord({
      shadow,
      experiments: { repoContext: "on", outcomeFeedback: "off" },
    }),
  });
  const disagreeing = session({
    harness: "claude",
    model: "opus",
    status: "failed",
    route: routeRecord({
      policy: "judgments",
      tiltChanged: true,
      shadow: { ...shadow, judgments: "claude:opus@high" },
      experiments: { repoContext: "off" },
    }),
  });
  const unshadowed = session({ route: routeRecord() });
  const stats = report([agreeing, disagreeing, unshadowed]);
  const feature = (name: string) =>
    stats.features.find((candidate) => candidate.name === name);
  expect(feature("shadowAgrees:rawJev")).toMatchObject({
    fired: { sessions: 1, failedPercent: 0 },
    notFired: { sessions: 1, failedPercent: 100 },
  });
  expect(feature("shadowAgrees:fixedDefault")).toMatchObject({
    fired: { sessions: 0 },
    notFired: { sessions: 2 },
  });
  expect(feature("shadowAgrees:judgments")).toMatchObject({
    fired: { sessions: 1, failedPercent: 100 },
    notFired: { sessions: 0 },
  });
  expect(feature("experiment:repoContext")).toMatchObject({
    fired: { sessions: 1, failedPercent: 0 },
    notFired: { sessions: 1, failedPercent: 100 },
  });
  expect(feature("experiment:outcomeFeedback")).toMatchObject({
    fired: { sessions: 0 },
    notFired: { sessions: 1 },
  });
  // The tilt did not decide a pick made by the judgment policy.
  expect(feature("paceTilt")).toMatchObject({
    fired: { sessions: 0 },
    notFired: { sessions: 2 },
  });
});

test("guard decisions are counted per harness and list cost has a long-context upper bound", () => {
  const pricing = {
    openai: {
      models: {
        sol: {
          cost: {
            input: 2,
            output: 10,
            context_over_200k: { input: 4, output: 15 },
          },
        },
      },
    },
  };
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
  };
  const entries = statsEntries([session({ usage })], window, pricing);
  const stats = statsReport({
    entries,
    window,
    quota: null,
    pinWarnings: [],
    guardDecisions: [
      {
        ts: new Date(NOW - 1_000).toISOString(),
        harness: "claude",
        decision: "deny",
      },
      {
        ts: new Date(NOW - 2_000).toISOString(),
        harness: "claude",
        decision: "allow",
      },
      {
        ts: new Date(NOW - 3_000).toISOString(),
        harness: "codex",
        decision: "warn",
      },
      {
        ts: new Date(NOW - 4_000).toISOString(),
        harness: "codex",
        decision: "odd",
      },
      { ts: "2020-01-01T00:00:00Z", harness: "claude", decision: "deny" },
    ],
    externalCostUsd: {},
  });
  expect(stats.nativeSubagentGuard).toEqual({
    claude: { allow: 1, warn: 0, deny: 1 },
    codex: { allow: 0, warn: 1, deny: 0 },
  });
  expect(stats).toMatchObject({
    costUsd: 12,
    costSource: "listPrice",
    costUpperBoundUsd: 19,
  });
  const text = formatStats(stats);
  expect(text).toContain("claude: allowed 1, warned 0, denied 1");
  expect(text).toContain("$12.00 cost (list price; at most $19.00");
});

test("a harness-reported cost is preferred over the computed list cost, and each row names its source", () => {
  const pricing = {
    openai: { models: { sol: { cost: { input: 2, output: 10 } } } },
    anthropic: { models: { opus: { cost: { input: 4, output: 20 } } } },
  };
  const tokens = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cachedInputTokens: null,
    cacheWriteTokens: null,
  };
  const claude = session({
    harness: "claude",
    model: "opus",
    label: "mixed",
    // The harness says 30; list price would say 24.
    usage: { ...tokens, costUsd: 30 },
  });
  const codex = session({
    label: "mixed",
    usage: { ...tokens, costUsd: null },
  });
  const unpriced = session({
    model: "unknown",
    usage: { ...tokens, costUsd: null },
  });
  const entries = statsEntries([claude, codex, unpriced], window, pricing);
  expect(
    entries.map(({ costUsd, costSource, costUpperBoundUsd, listCostUsd }) => [
      costUsd,
      costSource,
      costUpperBoundUsd,
      listCostUsd,
    ]),
  ).toEqual([
    [30, "harness", 30, 24],
    [12, "listPrice", 12, 12],
    [null, null, null, null],
  ]);
  const stats = statsReport({
    entries,
    window,
    quota: null,
    pinWarnings: [],
    guardDecisions: [],
    externalCostUsd: { claude: 60 },
  });
  expect(stats).toMatchObject({
    costUsd: 42,
    costSource: "mixed",
    unpricedSessions: 1,
    pools: {
      claude: { costUsd: 30, costSource: "harness" },
      codex: { costUsd: 12, costSource: "listPrice" },
    },
    models: {
      "claude:opus": { costUsd: 30, costSource: "harness", unpriced: 0 },
      "codex:sol": { costUsd: 12, costSource: "listPrice" },
      "codex:unknown": { costUsd: 0, costSource: "none", unpriced: 1 },
    },
    labels: { mixed: { costUsd: 42, costSource: "mixed" } },
    spendShare: { claude: { smartRouterCostUsd: 24, sharePercent: 40 } },
  });
  const text = formatStats(stats);
  expect(text).toContain("claude:opus: 1 runs");
  expect(text).toContain(
    "$30.00 (harness-reported; cost coverage 1/1 sessions)",
  );
  expect(text).toContain("$12.00 (list price; cost coverage 1/1 sessions)");
  expect(text).toContain(
    "mixed: 2 runs, $42.00 (harness-reported and list price; cost coverage 2/2 sessions)",
  );
  expect(text).toContain("$0.00 (no cost; cost coverage 0/1 sessions)");
  const exported = exportLines(entries)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(exported[0]).toMatchObject({
    costUsd: 30,
    costSource: "harness",
    listCostUsd: 24,
  });
});

test("unknown costs show coverage and list-spend lower bounds in text, JSON and export", () => {
  const sessions = [
    session({ harness: "claude", model: "opus" }),
    session({
      harness: "claude",
      model: "opus",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 2,
        costSource: "listPrice",
      },
    }),
  ];
  const entries = statsEntries(sessions, window, {
    anthropic: {
      models: {
        opus: {
          cost: {
            input: 2,
            output: 10,
            context_over_200k: { input: 4, output: 10 },
          },
        },
      },
    },
  });
  const stats = statsReport({
    entries,
    window,
    quota: null,
    pinWarnings: [],
    guardDecisions: [],
    externalCostUsd: { claude: 20 },
  });
  expect(stats.costUpperBoundUsd).toBe(4);
  expect(stats.pools.claude).toMatchObject({
    runs: 2,
    pricedSessions: 1,
    costSource: "listPrice",
  });
  expect(stats.models["claude:opus"]).toMatchObject({
    runs: 2,
    pricedSessions: 1,
  });
  expect(JSON.parse(JSON.stringify(stats)).spendShare.claude).toMatchObject({
    pricedSessions: 1,
    sessions: 2,
    lowerBound: true,
    smartRouterCostUsd: 2,
    sharePercent: 10,
  });
  expect(formatStats(stats)).toContain("cost coverage 1/2 sessions");
  expect(formatStats(stats)).toContain("(10%; lower bound)");
  const exported = exportLines(entries)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(exported[0]).toMatchObject({
    costUsd: null,
  });
  expect(exported[1]).toMatchObject({
    costUsd: 2,
    listCostUsd: 2,
  });
});
