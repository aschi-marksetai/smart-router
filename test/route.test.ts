import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { DoctorResult } from "../src/doctor.ts";
import {
  CODEX_DANGER_FULL_ACCESS_SANDBOX,
  CODEX_WORKSPACE_WRITE_SANDBOX,
  chooseCodexSandbox,
  defaultRouteDeps,
  needsStoppingPoint,
  route,
  shouldUseClaudeBrowser,
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
  availableModels: [],
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

function deps(
  overrides: Partial<RouteDeps> = {},
  modelChoice = "claude:opus",
): RouteDeps {
  const client: JevClient = {
    systemOne: async () => ({
      answers: {
        model: {
          choice: modelChoice,
          confidence: 0.9,
          probabilities: {},
        },
        effort: { choice: "high", probabilities: {} },
        needsBrowser: { noul: 0.2 },
        statesStoppingPoint: { noul: 0.8 },
        needsNetwork: { noul: 0.1 },
        needsFullAccess: { noul: 0.1 },
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

test("reads route preferences and treats a missing file as empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-route-"));
  const previous = process.env.SMART_ROUTER_CONFIG_DIR;
  process.env.SMART_ROUTER_CONFIG_DIR = directory;
  try {
    const preferences = defaultRouteDeps(config).preferences;
    if (typeof preferences !== "function")
      throw new Error("missing preferences loader");
    expect(await preferences()).toBe("");
    await writeFile(join(directory, "preferences.md"), "prefer Codex");
    expect(await preferences()).toBe("prefer Codex");
    await rm(join(directory, "preferences.md"));
    await mkdir(join(directory, "preferences.md"));
    await expect(preferences()).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.SMART_ROUTER_CONFIG_DIR;
    else process.env.SMART_ROUTER_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("matches confidential path globs", async () => {
  const result = await route(
    "task",
    { cwd: "/work/secret/task", dryRun: true },
    deps({
      config: { ...config, rules: { confidentialPathGlobs: ["**/secret/**"] } },
    }),
  );
  expect(
    "preferences" in result && result.candidates.map(({ id }) => id),
  ).toEqual(["claude:opus", "codex:terra"]);
});

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

test("uses configured confidential provider exclusions", async () => {
  const result = await route(
    "task",
    { confidential: true },
    deps({
      config: {
        ...config,
        rules: { confidentialExcludedProviders: ["different-provider"] },
      },
    }),
  );
  expect("candidates" in result && result.candidates).toContain(
    "pi:openrouter/model",
  );
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
            needsNetwork: { noul: 0 },
            needsFullAccess: { noul: 0 },
          },
        }),
      },
    }),
  );
  expect("fellBack" in result && result.fellBack).toBe(true);
  expect("pick" in result && result.pick).toBe("codex:terra@high");
});

test("falls back when Jev picks a model outside the candidates", async () => {
  const result = await route("task", {}, deps({}, "codex:unknown"));
  expect(result).toMatchObject({
    pick: "codex:terra@high",
    fellBack: true,
    reason: "Jev picked codex:unknown, which is not a candidate",
  });
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
            needsNetwork: { noul: 0 },
            needsFullAccess: { noul: 0 },
          },
        }),
      },
    }),
  );
  expect("pick" in result && result.pick).toBe("codex:terra@high");
});

test("clamps by known effort rank regardless of declaration order", async () => {
  const result = await route(
    "task",
    {},
    deps({
      config: {
        ...config,
        models: [
          {
            id: "codex:terra",
            harness: "codex",
            model: "terra",
            efforts: ["high", "low"],
          },
        ],
      },
      doctor: async () => ({
        ...detection,
        candidates: ["codex:terra@high", "codex:terra@low"],
      }),
      client: {
        systemOne: async () => ({
          answers: {
            model: {
              choice: "codex:terra",
              confidence: 0.9,
              probabilities: {},
            },
            effort: { choice: "xhigh", probabilities: {} },
            needsBrowser: { noul: 0 },
            statesStoppingPoint: { noul: 1 },
            needsNetwork: { noul: 0 },
            needsFullAccess: { noul: 0 },
          },
        }),
      },
    }),
  );
  expect("pick" in result && result.pick).toBe("codex:terra@high");
});

test("clamps using the model's configured effort order", async () => {
  const result = await route(
    "task",
    {},
    deps({
      config: {
        ...config,
        models: [
          {
            id: "codex:terra",
            harness: "codex",
            model: "terra",
            efforts: ["minimal", "standard", "deep"],
          },
        ],
      },
      doctor: async () => ({
        ...detection,
        candidates: [
          "codex:terra@minimal",
          "codex:terra@standard",
          "codex:terra@deep",
        ],
      }),
      client: {
        systemOne: async () => ({
          answers: {
            model: {
              choice: "codex:terra",
              confidence: 0.9,
              probabilities: {},
            },
            effort: { choice: "custom", probabilities: {} },
            needsBrowser: { noul: 0 },
            statesStoppingPoint: { noul: 1 },
            needsNetwork: { noul: 0 },
            needsFullAccess: { noul: 0 },
          },
        }),
      },
    }),
  );
  expect("pick" in result && result.pick).toBe("codex:terra@standard");
});

test("uses the first eligible candidate when the default is unavailable", async () => {
  const result = await route(
    "task",
    {},
    deps({
      config: { ...config, defaultModelId: "", rules: { confidenceFloor: 1 } },
    }),
  );
  expect(result).toMatchObject({
    pick: "claude:opus@high",
    fellBack: true,
    reason: "default model unavailable; using claude:opus",
  });
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
    needsNetwork: null,
    needsFullAccess: null,
  });
});

test("passes through Jev's stopping-point score", async () => {
  const result = await route("task", {}, deps());
  expect("statesStoppingPoint" in result && result.statesStoppingPoint).toBe(
    0.8,
  );
});

test("includes capabilities in Jev candidate descriptions", async () => {
  const client = deps().client;
  await route(
    "task",
    {},
    deps({
      client: {
        systemOne: async (request) => {
          expect(request.questions.model.criteria["claude:opus"]).toContain(
            "logged-in Chrome",
          );
          expect(request.questions.model.criteria["codex:terra"]).toContain(
            "no browser or screenshots",
          );
          return client.systemOne(request);
        },
      },
    }),
  );
});

test("enables Chrome for requested or routed Claude browser work", () => {
  expect(shouldUseClaudeBrowser("claude", undefined, 0.6)).toBe(true);
  expect(shouldUseClaudeBrowser("claude", true, null)).toBe(true);
  expect(shouldUseClaudeBrowser("claude", undefined, 0.5)).toBe(false);
  expect(shouldUseClaudeBrowser("codex", true, 0.9)).toBe(false);
});

test("chooses Codex sandboxes from route scores", () => {
  const defaults = {
    configuredSandbox: CODEX_WORKSPACE_WRITE_SANDBOX,
    autoSandbox: true,
    allowFullAccess: true,
    routingRan: true,
    needsNetwork: 0,
    needsBrowser: 0,
    needsFullAccess: 0,
  };
  const cases = [
    [{ needsFullAccess: 0.6 }, CODEX_DANGER_FULL_ACCESS_SANDBOX, false],
    [{ needsBrowser: 0.6 }, CODEX_DANGER_FULL_ACCESS_SANDBOX, false],
    [{ needsNetwork: 0.6 }, CODEX_WORKSPACE_WRITE_SANDBOX, true],
    [{ autoSandbox: false }, CODEX_WORKSPACE_WRITE_SANDBOX, false],
    [
      { needsNetwork: null, needsFullAccess: null },
      CODEX_WORKSPACE_WRITE_SANDBOX,
      false,
    ],
    [{ callerSandbox: "read-only", needsFullAccess: 0.6 }, "read-only", false],
  ] as const;
  for (const [options, sandbox, usesNetworkAccess] of cases)
    expect(chooseCodexSandbox({ ...defaults, ...options })).toEqual({
      sandbox,
      usesNetworkAccess,
    });
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

test("a missing TypeSafe key falls back instead of throwing at startup", async () => {
  const { defaultRouteDeps } = await import("../src/route.ts");
  const savedKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const config = {
      ...(await import("../src/config.ts")).DEFAULT_CONFIG,
      harnesses: { codex: { enabled: true, auth: "subscription" as const } },
      models: [
        {
          id: "codex:m",
          harness: "codex" as const,
          model: "m",
          efforts: ["medium"],
        },
      ],
      defaultModelId: "codex:m",
    };
    const deps = {
      ...defaultRouteDeps(config),
      doctor: async () => ({
        harnesses: {
          claude: { installed: false, version: null, authed: false },
          codex: { installed: true, version: "1", authed: true },
          pi: { installed: false, version: null, authed: false },
        },
        providers: {},
        codexbar: { installed: false },
        candidates: ["codex:m@medium"],
        availableModels: [],
      }),
      getQuota: async () => ({ error: "codexbar not installed" as const }),
      preferences: "",
    };
    const result = await route("task", {}, deps);
    expect("pick" in result && result.fellBack).toBe(true);
    expect("pick" in result && result.reason).toMatch(/key|API/i);
  } finally {
    if (savedKey !== undefined) process.env.TYPESAFE_API_KEY = savedKey;
  }
});
