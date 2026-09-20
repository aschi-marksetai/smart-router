import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { DoctorResult } from "../src/doctor.ts";
import {
  needsStoppingPoint,
  route,
  type JevClient,
  type RouteDeps,
} from "../src/route.ts";

const detection: DoctorResult = {
  harnesses: {
    claude: { installed: true, version: "1", authed: true },
    codex: { installed: true, version: "1", authed: true },
    pi: { installed: true, version: "1", authed: true },
  },
  providers: {},
  codexbar: { installed: true },
  candidates: [
    "claude:opus@high",
    "codex:terra@high",
    "pi:openrouter/model@medium",
  ],
};

const config: Config = {
  ...DEFAULT_CONFIG,
  harnesses: {
    claude: { enabled: true, auth: "subscription" },
    codex: { enabled: true, auth: "subscription" },
    pi: { enabled: true },
  },
  models: [
    { id: "claude:opus", harness: "claude", model: "opus", efforts: ["high"] },
    {
      id: "codex:terra",
      harness: "codex",
      model: "terra",
      efforts: ["low", "high"],
    },
    {
      id: "pi:openrouter/model",
      harness: "pi",
      model: "openrouter/model",
      efforts: ["medium"],
    },
  ],
  defaultModelId: "codex:terra",
  defaultEffort: "high",
};

function deps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const client: JevClient = {
    systemOne: async () => ({
      answers: {
        model: {
          choice: "claude:opus",
          confidence: 0.9,
          probabilities: {},
        },
        effort: { choice: "high", probabilities: {} },
        needsBrowser: { noul: 0.2 },
        statesStoppingPoint: { noul: 0.8 },
      },
    }),
  };
  return {
    config,
    client,
    doctor: async () => detection,
    getQuota: async () => ({
      claude: {
        weeklyUsedPercent: 90,
        weeklyResetsAt: "soon",
        fiveHourUsedPercent: 1,
        pace: "fast",
      },
      codex: {
        weeklyUsedPercent: 10,
        weeklyResetsAt: "soon",
        fiveHourUsedPercent: 1,
        pace: "fine",
      },
    }),
    preferences: "prefer subscriptions",
    ...overrides,
  };
}

test("applies quota and confidential rules", async () => {
  const result = await route(
    "task",
    { confidential: true },
    deps({
      config: { ...config, rules: { quotaCutoffPercent: { claude: 85 } } },
    }),
  );
  expect("candidates" in result && result.candidates).toEqual(["codex:terra"]);
});

test("falls back below the confidence floor", async () => {
  const result = await route(
    "task",
    {},
    deps({
      config: { ...config, rules: { confidenceFloor: 0.8 } },
      client: {
        systemOne: async () => ({
          answers: {
            model: {
              choice: "claude:opus",
              confidence: 0.7,
              probabilities: {},
            },
            effort: { choice: "high", probabilities: {} },
            needsBrowser: { noul: 0 },
            statesStoppingPoint: { noul: 0.8 },
          },
        }),
      },
    }),
  );
  expect("fellBack" in result && result.fellBack).toBe(true);
  expect("pick" in result && result.pick).toBe("codex:terra@high");
});

test("clamps the selected effort to the model's supported efforts", async () => {
  const result = await route(
    "task",
    {},
    deps({
      client: {
        systemOne: async () => ({
          answers: {
            model: {
              choice: "codex:terra",
              confidence: 0.9,
              probabilities: { "codex:terra": 0.9 },
            },
            effort: { choice: "xhigh", probabilities: { xhigh: 1 } },
            needsBrowser: { noul: 0.1 },
            statesStoppingPoint: { noul: 0.8 },
          },
        }),
      },
    }),
  );
  expect("pick" in result && result.pick).toBe("codex:terra@high");
});

test("returns state without calling Jev when dry-running", async () => {
  let called = false;
  const result = await route(
    "task",
    { dryRun: true },
    deps({
      client: {
        systemOne: async () => {
          called = true;
          throw new Error("Jev should not be called during a dry run");
        },
      },
    }),
  );
  expect(called).toBe(false);
  expect("task" in result && result.task).toBe("task");
});

test("falls back when Jev throws", async () => {
  const result = await route(
    "task",
    {},
    deps({
      client: { systemOne: async () => Promise.reject(new Error("offline")) },
    }),
  );
  expect(result).toMatchObject({
    pick: "codex:terra@high",
    fellBack: true,
    reason: "offline",
    needsBrowser: null,
    statesStoppingPoint: null,
  });
});

test("passes through Jev's stopping-point score", async () => {
  const result = await route("task", {}, deps());
  expect("statesStoppingPoint" in result && result.statesStoppingPoint).toBe(
    0.8,
  );
});

test("requires a stopping point only for configured Jev picks", () => {
  const result = {
    pick: "codex:terra@high",
    fellBack: false,
    statesStoppingPoint: 0.4,
  };
  expect(
    needsStoppingPoint(
      { ...config, rules: { stoppingPointRequiredFor: ["codex:terra"] } },
      result,
    ),
  ).toBe(true);
  expect(needsStoppingPoint(config, result)).toBe(false);
  expect(needsStoppingPoint(config, { ...result, fellBack: true })).toBe(false);
});
