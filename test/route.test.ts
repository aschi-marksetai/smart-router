import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, type Config } from "../src/config.ts";
import type { DoctorResult } from "../src/doctor.ts";
import type { QuotaProvider } from "../src/quota.ts";
import {
  CODEX_DANGER_FULL_ACCESS_SANDBOX,
  CODEX_WORKSPACE_WRITE_SANDBOX,
  chooseCodexSandbox,
  defaultRouteDeps,
  needsStoppingPoint,
  parseJevReply,
  pinnedRoute,
  readPreferencesSnapshot,
  savePreferencesSnapshot,
  previousAttemptFrom,
  route,
  shouldUseClaudeBrowser,
  type JevClient,
  type RouteDeps,
  OPENROUTER_SYSTEM_ONE_URL,
  OPENROUTER_ZDR_URL,
  routeQuestions,
} from "../src/route.ts";

const detection: DoctorResult = {
  jev: { provider: "typesafe", keyEnv: "TYPESAFE_API_KEY", keySet: false },
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

function pool(
  weeklyUsedPercent: number,
  paceGap = 0,
  modelWindows: QuotaProvider["modelWindows"] = [],
): QuotaProvider {
  return {
    weeklyUsedPercent,
    weeklyResetsAt: "soon",
    fiveHourUsedPercent: 1,
    pace: "fine",
    paceGap,
    modelWindows,
  };
}

function jevReply(
  choice: string,
  probabilities: Record<string, number> = { [choice]: 0.9 },
  confidence = 0.9,
  effort = "high",
) {
  return {
    model: "jev-test-1",
    answers: {
      model: { choice, confidence, probabilities },
      effort: { choice: effort, probabilities: { [effort]: 1 } },
      needsBrowser: { noul: 0.2 },
      statesStoppingPoint: { noul: 0.8 },
      needsNetwork: { noul: 0.1 },
      needsFullAccess: { noul: 0.1 },
    },
  };
}

function deps(
  overrides: Partial<RouteDeps> = {},
  modelChoice = "claude:opus",
): RouteDeps {
  const client: JevClient = {
    systemOne: async () => jevReply(modelChoice),
  };
  return {
    config,
    client,
    doctor: async () => detection,
    getQuota: async () => ({
      quota: { claude: pool(90), codex: pool(10) },
      ageMs: 0,
    }),
    preferences: "prefer subscriptions",
    // 0.99 is above every experiment probability, so both arms are off unless a test says otherwise.
    random: () => 0.99,
    repoContext: async () => null,
    recentOutcomes: async () => ({}),
    savePreferences: async () => {},
    ...overrides,
  };
}

function record(result: Awaited<ReturnType<typeof route>>) {
  if (!("pick" in result)) throw new Error("expected a route record");
  return result;
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
  ).toEqual(["claude:opus", "codex:terra", "pi:openrouter/model"]);
});

test("applies quota and confidential rules", async () => {
  const result = await route(
    "task",
    { confidential: true },
    deps({
      config: { ...config, rules: { quotaCutoffPercent: { claude: 85 } } },
    }),
  );
  expect("candidates" in result && result.candidates).toEqual([
    "codex:terra",
    "pi:openrouter/model",
  ]);
});

test("matches configured confidential model patterns", async () => {
  const result = await route(
    "task",
    { confidential: true },
    deps({
      config: {
        ...config,
        rules: { confidentialExcludedModels: ["codex:*", "pi:openrouter/*"] },
      },
    }),
  );
  expect("candidates" in result && result.candidates).toEqual(["claude:opus"]);
});

function candidateIds(result: Awaited<ReturnType<typeof route>>): string[] {
  return "preferences" in result
    ? result.candidates.map(({ id }) => id)
    : result.candidates;
}

test.each([
  ["router effort", "codex:terra", 0.9, false, false],
  ["hard review", "codex:sol", 0.9, false, false],
  ["low confidence", "codex:terra", 0.1, false, false],
  ["offline", "codex:terra", 0.9, true, true],
  ["pick outside scope", "claude:opus", 0.9, false, true],
])(
  "Codex scope preserves routing and fallback: %s",
  async (name, choice, confidence, offline, fellBack) => {
    const result = await route(
      "Review the change; stop after the review.",
      { harnessOnly: "codex", hint: name },
      deps({
        config: {
          ...config,
          defaultModelId: "claude:opus",
          rules: { confidenceFloor: 0.5 },
          models: [
            ...config.models,
            { ...config.models[1], id: "codex:sol", model: "sol" },
          ],
        },
        doctor: async () => ({
          ...detection,
          candidates: [...detection.candidates, "codex:sol@high"],
        }),
        client: {
          systemOne: async (request) => {
            expect(
              request.state.candidates.map(({ harness }) => harness),
            ).toEqual(["codex", "codex"]);
            if (offline) throw new Error("offline");
            return jevReply(
              choice,
              { [choice]: 0.9 },
              confidence,
              name === "hard review" ? "high" : "low",
            );
          },
        },
      }),
    );
    expect(result).toMatchObject({
      pick: `${fellBack ? "codex:terra" : choice}@${fellBack || name === "hard review" ? "high" : "low"}`,
      candidates: ["codex:terra", "codex:sol"],
      fellBack,
      lowConfidence: name === "low confidence",
    });
  },
);

test.each([false, true])(
  "Codex scope fails without candidates (dryRun=%s)",
  async (dryRun) => {
    await expect(
      route(
        "review",
        { harnessOnly: "codex", dryRun },
        deps({
          config: {
            ...config,
            rules: {
              confidentialPathGlobs: ["**"],
              confidentialExcludedModels: ["codex:*"],
            },
          },
        }),
      ),
    ).rejects.toThrow("No route candidates available for harness codex");
  },
);

test("Claude scope and claudeOnly retain Claude candidates and fallback", async () => {
  for (const options of [
    { harnessOnly: "claude" },
    { claudeOnly: true },
  ] as const) {
    const result = await route("review", options, deps({}, "codex:terra"));
    expect(result).toMatchObject({
      pick: "claude:opus@high",
      candidates: ["claude:opus"],
      fellBack: true,
    });
  }
});

test("requires cached OpenRouter ZDR models for confidential routing", async () => {
  const previousState = process.env.SMART_ROUTER_STATE_DIR;
  const directory = await mkdtemp(join(tmpdir(), "smart-router-zdr-"));
  process.env.SMART_ROUTER_STATE_DIR = directory;
  let calls = 0;
  const mockFetch = Object.assign(
    async () => {
      calls++;
      if (calls === 2) throw new Error("offline");
      return new Response(JSON.stringify({ data: [{ model_id: "model" }] }));
    },
    { preconnect: () => {} },
  );
  const globalFetch = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
  const zdrConfig = { ...config, rules: { confidentialRequireZdr: true } };
  try {
    const routeConfig = {
      ...zdrConfig,
      models: [
        ...zdrConfig.models,
        {
          ...config.models[2],
          id: "pi:openrouter/other",
          model: "openrouter/other",
        },
      ],
    };
    const doctorWithExtra = async () => ({
      ...detection,
      candidates: [...detection.candidates, "pi:openrouter/other@medium"],
    });
    const routeDeps = deps({
      config: routeConfig,
      doctor: doctorWithExtra,
    });
    const options = { confidential: true, dryRun: true };
    const kept = ["claude:opus", "codex:terra", "pi:openrouter/model"];
    for (let attempt = 0; attempt < 2; attempt++)
      expect(candidateIds(await route("task", options, routeDeps))).toEqual(
        kept,
      );
    expect(calls).toBe(1);
    expect(globalFetch.mock.calls[0][0]).toBe(OPENROUTER_ZDR_URL);
    await rm(join(directory, "openrouter-zdr.json"));
    const failed = await route("task", { confidential: true }, routeDeps);
    expect(candidateIds(failed)).toEqual(["claude:opus", "codex:terra"]);
    expect("reason" in failed && failed.reason).toContain(
      "OpenRouter ZDR list unavailable",
    );
  } finally {
    globalFetch.mockRestore();
    if (previousState === undefined) delete process.env.SMART_ROUTER_STATE_DIR;
    else process.env.SMART_ROUTER_STATE_DIR = previousState;
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenRouter Jev ZDR client sends the direct endpoint request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-route-"));
  const previousConfigDirectory = process.env.SMART_ROUTER_CONFIG_DIR;
  process.env.SMART_ROUTER_CONFIG_DIR = directory;
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      jev: { provider: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" },
    }),
  );
  const loadedConfig = await loadConfig();
  loadedConfig.jev.provider = "openrouter";
  loadedConfig.jev.zdr = true;
  let received:
    { input: string | URL | Request; init?: RequestInit } | undefined;
  const fixture =
    '{"model":"typesafe/jev-1.13-20260917","answers":{"kind":{"type":"choice","choice":"animal","probabilities":{"animal":1,"vehicle":0},"confidence":1}},"usage":{"input_tokens":312,"output_tokens":31,"cost":0.000013104},"id":"gen-dec-1","provider":"TypeSafe"}';
  const client = defaultRouteDeps(loadedConfig, async (input, init) => {
    received = { input, init };
    return new Response(fixture);
  }).client;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    const request = {
      state: {
        preferences: "",
        task: "task",
        hint: null,
        cwd: "/",
        quota: null,
        candidates: [],
      },
      model: "typesafe/jev-1.13-20260917",
      questions: routeQuestions([]),
    };
    const response = await client.systemOne(request);
    expect(received?.input).toBe(OPENROUTER_SYSTEM_ONE_URL);
    expect(received?.init?.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(received?.init?.body));
    expect([
      body.model,
      body.state.task,
      "questions" in body,
      body.provider.zdr,
    ]).toEqual(["typesafe/jev-1.13-20260917", "task", true, true]);
    expect(JSON.stringify(response)).toBe(JSON.stringify(JSON.parse(fixture)));
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    if (previousConfigDirectory === undefined)
      delete process.env.SMART_ROUTER_CONFIG_DIR;
    else process.env.SMART_ROUTER_CONFIG_DIR = previousConfigDirectory;
    await rm(directory, { recursive: true });
  }
});

test.each([
  [true, "Jev: claude:opus 0.90 · Claude on pace, Codex on pace"],
  [
    false,
    "Jev: claude:opus 0.90 · quota disabled; quota limits and pace tilt skipped",
  ],
])("reports Jev selection with quota enabled=%s", async (enabled, reason) => {
  const result = await route(
    "task",
    { hint: "why" },
    deps({ config: { ...config, quota: { ...config.quota, enabled } } }),
  );
  expect(result).toMatchObject({
    version: 2,
    kind: "routed",
    pick: "claude:opus@high",
    fellBack: false,
    reason,
    rawPick: "claude:opus",
    tiltChanged: false,
    lowConfidence: false,
    limitsRelaxed: false,
    warnings: [],
  });
  const { inputs } = record(result);
  expect(inputs).toMatchObject({
    hint: "why",
    jevModel: config.jev.model,
    jevServedModel: "jev-test-1",
  });
  expect(inputs.preferencesSha256).toHaveLength(64);
  expect(inputs.quota === null).toBe(!enabled);
  expect(inputs.quotaLatencyMs === null).toBe(!enabled);
  expect(inputs.routingLatencyMs).toBeGreaterThanOrEqual(0);
});

test("keeps the weighted pick below the confidence floor and flags it", async () => {
  const result = await route(
    "task",
    {},
    deps({
      config: { ...config, rules: { confidenceFloor: 0.8 } },
      client: {
        systemOne: async () =>
          jevReply("claude:opus", { "claude:opus": 0.7 }, 0.7),
      },
    }),
  );
  expect(result).toMatchObject({
    kind: "routed",
    pick: "claude:opus@high",
    fellBack: false,
    lowConfidence: true,
  });
  expect(record(result).reason).toContain("low confidence 0.70 (floor 0.80)");
});

test("falls back when Jev gives no probability to an eligible candidate", async () => {
  const result = await route("task", {}, deps({}, "codex:unknown"));
  expect(result).toMatchObject({
    kind: "fallback",
    pick: "codex:terra@high",
    fellBack: true,
    rawPick: null,
    needsBrowser: null,
  });
  expect(record(result).reason).toContain(
    "fallback to codex:terra: Jev picked codex:unknown and gave no probability to an eligible candidate",
  );
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
              probabilities: { "codex:terra": 0.9 },
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
              probabilities: { "codex:terra": 0.9 },
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

test("an unavailable default no longer overrides a valid Jev pick", async () => {
  const result = await route(
    "task",
    {},
    deps({ config: { ...config, defaultModelId: "" } }, "codex:terra"),
  );
  expect(result).toMatchObject({ kind: "routed", pick: "codex:terra@high" });
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
    kind: "fallback",
    pick: "codex:terra@high",
    fellBack: true,
    reason: "fallback to codex:terra: offline · Claude on pace, Codex on pace",
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

for (const provider of ["openrouter", "typesafe"] as const) {
  for (const key of [undefined, ""]) {
    test(`${provider} falls back without a request when the key is ${String(key)}`, async () => {
      const keyEnv =
        provider === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
      const previousKey = process.env[keyEnv];
      if (key === undefined) delete process.env[keyEnv];
      else process.env[keyEnv] = key;
      const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("unexpected request"),
      );
      try {
        const routeConfig: Config = {
          ...config,
          jev: { ...config.jev, provider, apiKeyEnv: "", zdr: true },
        };
        const result = await route(
          "task",
          {},
          {
            ...deps(),
            ...defaultRouteDeps(routeConfig),
            doctor: async () => detection,
            getQuota: deps().getQuota,
            preferences: "",
          },
        );
        expect(result).toMatchObject({
          pick: "codex:terra@high",
          fellBack: true,
        });
        expect(record(result).reason).toContain(
          `${keyEnv} is not set (needed by jev.provider=${provider}; checked the environment and the smart-router .env files)`,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        if (previousKey === undefined) delete process.env[keyEnv];
        else process.env[keyEnv] = previousKey;
      }
    });
  }
}

for (const provider of ["openrouter", "typesafe"] as const) {
  test(`${provider} SDK client uses the configured Jev key when present`, async () => {
    const keyEnv = "SMART_ROUTER_TEST_JEV_KEY";
    const previousKey = process.env[keyEnv];
    process.env[keyEnv] = "test-jev-key";
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ answers: {} }),
    );
    try {
      const routeConfig: Config = {
        ...config,
        jev: { ...config.jev, provider, apiKeyEnv: keyEnv, zdr: false },
      };
      const state = await route("task", { dryRun: true }, deps());
      if (!("preferences" in state)) throw new Error("missing route state");
      const response = await defaultRouteDeps(routeConfig).client.systemOne({
        state,
        model: config.jev.model,
        questions: routeQuestions(state.candidates),
      });
      expect(JSON.stringify(response)).toBe('{"answers":{}}');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(
        new Headers(fetchSpy.mock.calls[0][1]?.headers).get("authorization"),
      ).toBe("Bearer test-jev-key");
    } finally {
      fetchSpy.mockRestore();
      if (previousKey === undefined) delete process.env[keyEnv];
      else process.env[keyEnv] = previousKey;
    }
  });
}

const balanceConfig: Config = {
  ...config,
  harnesses: {
    claude: { enabled: true, auth: "subscription" },
    codex: { enabled: true, auth: "subscription" },
  },
  // prettier-ignore
  models: [
    { id: "claude:fable", harness: "claude", model: "fable", efforts: ["medium", "high"], tier: 4, taste: true },
    { id: "claude:haiku", harness: "claude", model: "haiku", efforts: ["medium", "high"], tier: 1 },
    { id: "codex:terra", harness: "codex", model: "terra", efforts: ["low", "high", "xhigh", "ultra"], tier: 2 },
    { id: "codex:sol", harness: "codex", model: "sol", efforts: ["high"], tier: 3 },
    { id: "codex:custom", harness: "codex", model: "custom", efforts: ["high"] },
  ],
  rules: {
    quotaCutoffPercent: { claude: 95, codex: 95 },
    modelWindowCutoffPercent: 95,
    paceTilt: 1,
  },
  defaultModelId: "codex:sol",
};
const balanceDetection: DoctorResult = {
  ...detection,
  candidates: balanceConfig.models.flatMap(({ id, efforts }) =>
    efforts.map((effort) => `${id}@${effort}`),
  ),
};
const fableWindow = (usedPercent: number, paceGap = 0) => [
  {
    label: "Fable only",
    usedPercent,
    resetsAt: "soon",
    paceGap,
    models: ["claude:*fable*"],
  },
];

function balanceDeps(
  quota: Record<string, QuotaProvider | null>,
  probabilities: Record<string, number>,
  overrides: Partial<RouteDeps> = {},
): RouteDeps {
  const [choice] = Object.keys(probabilities);
  return deps({
    config: balanceConfig,
    doctor: async () => balanceDetection,
    getQuota: async () => ({ quota, ageMs: 1500 }),
    client: { systemOne: async () => jevReply(choice, probabilities) },
    ...overrides,
  });
}

test("a pool at its cutoff is excluded with a recorded reason", async () => {
  const result = record(
    await route(
      "task",
      {},
      balanceDeps(
        { claude: pool(40), codex: pool(100) },
        { "codex:sol": 0.8, "claude:haiku": 0.2 },
      ),
    ),
  );
  expect(result.pick).toBe("claude:haiku@high");
  expect(result.candidates).toEqual(["claude:fable", "claude:haiku"]);
  expect(result.excluded).toContainEqual({
    id: "codex:sol",
    reason: "codex pool at 100% (cutoff 95%)",
    kind: "quota",
  });
  expect(result.limitsRelaxed).toBe(false);
  expect(result.reason).toContain(
    "quota limits excluded 3 of 5 candidates: codex pool at 100% (cutoff 95%)",
  );
});

test("a full model window excludes only the models it covers", async () => {
  const result = record(
    await route(
      "task",
      {},
      balanceDeps(
        { claude: pool(40, 0, fableWindow(97)), codex: pool(40) },
        { "claude:fable": 0.9, "claude:haiku": 0.1 },
      ),
    ),
  );
  expect(result.candidates).not.toContain("claude:fable");
  expect(result.candidates).toContain("claude:haiku");
  expect(result.excluded).toEqual([
    {
      id: "claude:fable",
      reason: "Fable only window at 97% (cutoff 95%)",
      kind: "quota",
    },
  ]);
});

test("limits relax to the least-used pool instead of failing, and dry runs show it", async () => {
  const quota = { claude: pool(97, 0, fableWindow(99)), codex: pool(99) };
  const relaxedDeps = balanceDeps(quota, { "claude:fable": 0.9 });
  const result = record(await route("task", {}, relaxedDeps));
  expect(result).toMatchObject({
    kind: "routed",
    pick: "claude:fable@high",
    candidates: ["claude:fable", "claude:haiku"],
    limitsRelaxed: true,
  });
  expect(result.excluded.map(({ id }) => id)).toEqual([
    "codex:terra",
    "codex:sol",
    "codex:custom",
  ]);
  expect(result.reason).toContain(
    "limits relaxed to the least-used pool (claude)",
  );
  const dryRun = await route("task", { dryRun: true }, relaxedDeps);
  expect(dryRun).toMatchObject({ limitsRelaxed: true });
  expect("excluded" in dryRun && dryRun.excluded).toHaveLength(3);
});

test("relaxing quota limits never brings back a confidential exclusion", async () => {
  const result = record(
    await route(
      "task",
      { confidential: true },
      balanceDeps(
        { claude: pool(96), codex: pool(99) },
        { "codex:sol": 0.9 },
        {
          config: {
            ...balanceConfig,
            rules: {
              ...balanceConfig.rules,
              confidentialExcludedModels: ["claude:*"],
            },
          },
        },
      ),
    ),
  );
  expect(result.candidates).toEqual([
    "codex:terra",
    "codex:sol",
    "codex:custom",
  ]);
  expect(result.limitsRelaxed).toBe(true);
  expect(result.excluded).toContainEqual({
    id: "claude:fable",
    reason: "excluded for confidential work",
    kind: "confidential",
  });
});

test("the pace tilt moves the pick off a pool that is over pace", async () => {
  const quota = { claude: pool(80, -25), codex: pool(5, 50) };
  const probabilities = { "claude:fable": 0.43, "codex:sol": 0.22 };
  const tilted = record(
    await route("task", {}, balanceDeps(quota, probabilities)),
  );
  expect(tilted).toMatchObject({
    pick: "codex:sol@high",
    rawPick: "claude:fable",
    tiltChanged: true,
  });
  expect(tilted.weights["claude:fable"]).toBeCloseTo(Math.exp(-0.25));
  expect(tilted.weightedScores["codex:sol"]).toBeCloseTo(0.22 * Math.exp(0.5));
  expect(tilted.reason).toBe(
    "Jev: claude:fable 0.43, codex:sol 0.22 · Claude 25 pts over pace, Codex 50 in reserve · tilt changed pick from claude:fable",
  );
  const untilted = record(
    await route(
      "task",
      {},
      balanceDeps(quota, probabilities, {
        config: {
          ...balanceConfig,
          rules: { ...balanceConfig.rules, paceTilt: 0 },
        },
      }),
    ),
  );
  expect(untilted).toMatchObject({
    pick: "claude:fable@high",
    tiltChanged: false,
  });
});

test("a covered model is weighted by its window when that gap is tighter", async () => {
  const result = record(
    await route(
      "task",
      {},
      balanceDeps(
        { claude: pool(40, 20, fableWindow(90, -30)), codex: pool(40, 20) },
        { "claude:fable": 0.5, "claude:haiku": 0.4 },
      ),
    ),
  );
  expect(result.weights["claude:fable"]).toBeCloseTo(Math.exp(-0.3));
  expect(result.weights["claude:haiku"]).toBeCloseTo(Math.exp(0.2));
  expect(result.pick).toBe("claude:haiku@high");
});

test("a Jev failure uses the default, else the first candidate of the pool with most reserve", async () => {
  const offline = {
    client: { systemOne: async () => Promise.reject(new Error("offline")) },
  };
  const withDefault = record(
    await route(
      "task",
      {},
      balanceDeps({ claude: pool(10, 40), codex: pool(60, -10) }, {}, offline),
    ),
  );
  expect(withDefault.pick).toBe("codex:sol@high");
  const defaultExcluded = record(
    await route(
      "task",
      {},
      balanceDeps({ claude: pool(10, 40), codex: pool(100, -40) }, {}, offline),
    ),
  );
  expect(defaultExcluded).toMatchObject({
    kind: "fallback",
    pick: "claude:fable@high",
  });
  const noDefault = record(
    await route(
      "task",
      {},
      balanceDeps(
        { claude: pool(60, -10), codex: pool(10, 40) },
        {},
        {
          ...offline,
          config: {
            ...balanceConfig,
            defaultModelId: "",
            defaultEffort: "none",
          },
        },
      ),
    ),
  );
  expect(noDefault.pick).toBe("codex:terra@low");
});

test.each([
  ["no answers", {}],
  ["a non-object reply", "nope"],
  [
    "a missing model answer",
    { answers: { ...jevReply("claude:opus").answers, model: undefined } },
  ],
  [
    "a non-string choice",
    {
      answers: {
        ...jevReply("claude:opus").answers,
        model: { choice: 1, confidence: 0.5, probabilities: {} },
      },
    },
  ],
  [
    "missing probabilities",
    {
      answers: {
        ...jevReply("claude:opus").answers,
        model: { choice: "claude:opus", confidence: 0.5 },
      },
    },
  ],
  [
    "a NaN confidence",
    jevReply("claude:opus", { "claude:opus": 0.9 }, Number.NaN),
  ],
  ["a probability above 1", jevReply("claude:opus", { "claude:opus": 1.5 })],
  ["a negative probability", jevReply("claude:opus", { "claude:opus": -0.1 })],
  [
    "a missing noul",
    { answers: { ...jevReply("claude:opus").answers, needsNetwork: {} } },
  ],
  [
    "a missing effort answer",
    { answers: { ...jevReply("claude:opus").answers, effort: null } },
  ],
])("%s from Jev becomes a fallback, not a crash", async (_name, reply) => {
  expect(() => parseJevReply(reply)).toThrow("Invalid Jev reply");
  const result = record(
    await route("task", {}, deps({ client: { systemOne: async () => reply } })),
  );
  expect(result).toMatchObject({ kind: "fallback", pick: "codex:terra@high" });
  expect(result.reason).toContain("Invalid Jev reply");
});

test("parseJevReply accepts a reply without a served model", () => {
  const { model: _served, ...reply } = jevReply("claude:opus");
  expect(parseJevReply(reply)).toMatchObject({
    servedModel: null,
    model: { choice: "claude:opus", confidence: 0.9 },
    needsBrowser: 0.2,
  });
});

test("notes missing quota readings in the reason", async () => {
  const partial = record(
    await route(
      "task",
      {},
      balanceDeps({ claude: null, codex: pool(10) }, { "claude:haiku": 0.9 }),
    ),
  );
  expect(partial.reason).toContain(
    "no quota reading for claude; its limits and pace tilt skipped",
  );
  const missing = record(
    await route(
      "task",
      {},
      balanceDeps(
        {},
        { "claude:haiku": 0.9 },
        {
          getQuota: async () => ({
            quota: { error: "codexbar not installed" },
            ageMs: 0,
          }),
        },
      ),
    ),
  );
  expect(missing.reason).toContain(
    "codexbar not installed; quota limits and pace tilt skipped",
  );
  expect(missing.inputs.quota).toBeNull();
});

test("records scope exclusions for tool flags, confined mode and appended prompts", async () => {
  const exclusions = async (options: Parameters<typeof route>[1]) =>
    record(await route("task", options, deps())).excluded;
  expect(await exclusions({ claudeOnly: true })).toContainEqual({
    id: "codex:terra",
    reason: "the tool flags need a Claude model",
    kind: "scope",
  });
  expect(await exclusions({ confined: true })).toContainEqual({
    id: "codex:terra",
    reason: "not available in confined mode",
    kind: "scope",
  });
  expect(
    await exclusions({ confined: true, confinedCodexAvailable: true }),
  ).toEqual([
    {
      id: "pi:openrouter/model",
      reason: "not available in confined mode",
      kind: "scope",
    },
  ]);
  expect(await exclusions({ appendSystemPromptFile: "/tmp/prompt" })).toEqual([
    {
      id: "pi:openrouter/model",
      reason: "pi does not take an appended system prompt",
      kind: "scope",
    },
  ]);
});

test("a pin passes the confidential filters or fails with a clear error", async () => {
  const piModel = config.models[2];
  await expect(
    pinnedRoute(
      piModel,
      "medium",
      { confidential: true },
      deps({
        config: {
          ...config,
          rules: { confidentialExcludedModels: ["pi:openrouter/*"] },
        },
      }),
    ),
  ).rejects.toThrow(
    "pi:openrouter/model cannot be pinned for confidential work: excluded for confidential work",
  );
  const previousState = process.env.SMART_ROUTER_STATE_DIR;
  const directory = await mkdtemp(join(tmpdir(), "smart-router-pin-zdr-"));
  process.env.SMART_ROUTER_STATE_DIR = directory;
  const zdrDeps = (models: string[] | null) =>
    deps({
      config: { ...config, rules: { confidentialRequireZdr: true } },
      fetch: async () => {
        if (!models) throw new Error("offline");
        return Response.json({
          data: models.map((model_id) => ({ model_id })),
        });
      },
    });
  try {
    await expect(
      pinnedRoute(piModel, "medium", { confidential: true }, zdrDeps(null)),
    ).rejects.toThrow("OpenRouter ZDR list unavailable");
    await expect(
      pinnedRoute(
        piModel,
        "medium",
        { confidential: true },
        zdrDeps(["other"]),
      ),
    ).rejects.toThrow("no zero-data-retention endpoint");
    await rm(join(directory, "openrouter-zdr.json"));
    const allowed = await pinnedRoute(
      piModel,
      "medium",
      { confidential: true, hint: "why" },
      zdrDeps(["model"]),
    );
    expect(allowed).toMatchObject({
      version: 2,
      kind: "pinned",
      pick: "pi:openrouter/model@medium",
      reason: "pinned by caller",
      warnings: [],
      inputs: { hint: "why", jevModel: null, preferencesSha256: null },
    });
  } finally {
    if (previousState === undefined) delete process.env.SMART_ROUTER_STATE_DIR;
    else process.env.SMART_ROUTER_STATE_DIR = previousState;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pin warns, without blocking, when it works against the quota balance", async () => {
  const [fable] = balanceConfig.models;
  const sol = balanceConfig.models[3];
  const pin = (
    model: typeof fable,
    quota: Record<string, QuotaProvider | null>,
  ) => pinnedRoute(model, "high", {}, balanceDeps(quota, {}));
  const overCutoff = await pin(sol, { claude: pool(40), codex: pool(100) });
  expect(overCutoff.warnings).toEqual([
    "codex:sol is over its quota cutoff: codex pool at 100% (cutoff 95%)",
  ]);
  expect(overCutoff.reason).toBe(
    "pinned by caller · codex:sol is over its quota cutoff: codex pool at 100% (cutoff 95%)",
  );
  const overWindow = await pin(fable, {
    claude: pool(40, 0, fableWindow(96)),
    codex: pool(40),
  });
  expect(overWindow.warnings).toEqual([
    "claude:fable is over its quota cutoff: Fable only window at 96% (cutoff 95%)",
  ]);
  const overPace = await pin(fable, {
    claude: pool(80, -21),
    codex: pool(5, 61),
  });
  expect(overPace.warnings).toEqual([
    "Claude is 21 pts over pace while Codex has 61 in reserve; let the router choose instead of pinning",
  ]);
  for (const quota of [
    { claude: pool(80, -21), codex: pool(50, 10) },
    { claude: pool(80, -10), codex: pool(5, 61) },
    { claude: pool(80, -21), codex: null },
  ])
    expect((await pin(fable, quota)).warnings).toEqual([]);
  const disabled = await pinnedRoute(
    fable,
    "high",
    {},
    balanceDeps(
      {},
      {},
      {
        config: {
          ...balanceConfig,
          quota: { ...config.quota, enabled: false },
        },
      },
    ),
  );
  expect(disabled).toMatchObject({
    warnings: [],
    inputs: { quota: null, quotaLatencyMs: null },
  });
});

test("retry --up keeps only stronger candidates and tells Jev about the previous attempt", async () => {
  const quota = { claude: pool(10), codex: pool(10) };
  const previousAttempt = previousAttemptFrom(
    {
      harness: "codex",
      model: "terra",
      effort: "high",
      status: "failed",
      error: "tests failed",
      lastResult: `${"x".repeat(3000)}tail`,
    },
    "missed the edge case",
  );
  expect(previousAttempt).toMatchObject({
    model: "codex:terra",
    effort: "high",
    status: "failed",
    error: "tests failed",
    note: "missed the edge case",
  });
  expect(previousAttempt.resultTail).toHaveLength(2000);
  expect(previousAttempt.resultTail.endsWith("tail")).toBe(true);
  expect(
    previousAttemptFrom({
      harness: "codex",
      model: "terra",
      effort: "high",
      status: "done",
    }),
  ).toMatchObject({ error: null, resultTail: "", note: null });
  let sentState: unknown;
  const result = record(
    await route(
      "task",
      {
        previousAttempt,
        strongerThan: { modelId: "codex:terra", effort: "high" },
      },
      balanceDeps(
        quota,
        { "codex:terra": 0.6, "codex:sol": 0.3 },
        {
          client: {
            systemOne: async ({ state }) => {
              sentState = state;
              return jevReply(
                "codex:terra",
                { "codex:terra": 0.6, "codex:sol": 0.3 },
                0.9,
                "low",
              );
            },
          },
        },
      ),
    ),
  );
  expect(sentState).toMatchObject({ previousAttempt });
  expect(result.candidates).toEqual([
    "claude:fable",
    "codex:terra",
    "codex:sol",
  ]);
  // The same model stays only at efforts above the previous one.
  expect(result.pick).toBe("codex:terra@xhigh");
  expect(result.excluded).toContainEqual({
    id: "claude:haiku",
    reason: "not stronger than codex:terra@high",
    kind: "escalation",
  });
  expect(result.excluded).toContainEqual({
    id: "codex:custom",
    reason: "not stronger than codex:terra@high",
    kind: "escalation",
  });
  await expect(
    route(
      "task",
      { strongerThan: { modelId: "claude:fable", effort: "high" } },
      balanceDeps(quota, { "claude:fable": 0.9 }),
    ),
  ).rejects.toThrow(
    "no available candidate is stronger than claude:fable@high",
  );
  const fromUntiered = record(
    await route(
      "task",
      { strongerThan: { modelId: "codex:custom", effort: "low" } },
      balanceDeps(quota, { "codex:custom": 0.9 }),
    ),
  );
  expect(fromUntiered.candidates).toEqual(["codex:custom"]);
});

function judgedReply(
  choice: string,
  probabilities: Record<string, number>,
  difficulty: string,
  needsTaste: number,
) {
  const reply = jevReply(choice, probabilities);
  return {
    ...reply,
    answers: {
      ...reply.answers,
      difficulty: { choice: difficulty, probabilities: { [difficulty]: 0.8 } },
      needsTaste: { noul: needsTaste },
    },
  };
}

test("every routed decision records shadow picks and the judgments, without running them", async () => {
  const quota = { claude: pool(50, 5), codex: pool(50, 5) };
  const probabilities = { "claude:fable": 0.6, "codex:terra": 0.3 };
  const result = record(
    await route(
      "task",
      {},
      balanceDeps(quota, probabilities, {
        client: {
          systemOne: async ({ questions }) => {
            expect(Object.keys(questions.difficulty.criteria)).toEqual([
              "trivial",
              "bounded",
              "hard",
              "frontier",
            ]);
            expect(questions.needsTaste).toBeDefined();
            return judgedReply("claude:fable", probabilities, "bounded", 0.1);
          },
        },
      }),
    ),
  );
  expect(result).toMatchObject({
    kind: "routed",
    policy: "jev",
    pick: "claude:fable@high",
    judgments: {
      difficulty: "bounded",
      difficultyProbabilities: { bounded: 0.8 },
      needsTaste: 0.1,
    },
    shadow: {
      rawJev: "claude:fable@high",
      weighted: "claude:fable@high",
      fixedDefault: "codex:sol@high",
      judgments: "codex:terra@high",
    },
    warnings: [],
    inputs: { quotaAgeMs: 1500 },
  });
});

test("the judgment policy picks from difficulty and taste, and records the Jev pick as the shadow", async () => {
  const quota = { claude: pool(50, 5), codex: pool(50, 5) };
  const probabilities = { "codex:terra": 0.7, "claude:fable": 0.2 };
  const judgmentConfig = {
    ...balanceConfig,
    rules: { ...balanceConfig.rules, policy: "judgments" as const },
  };
  const judged = (difficulty: string, needsTaste: number) =>
    route(
      "task",
      {},
      balanceDeps(quota, probabilities, {
        config: judgmentConfig,
        client: {
          systemOne: async () =>
            judgedReply("codex:terra", probabilities, difficulty, needsTaste),
        },
      }),
    );
  const tasteful = record(await judged("bounded", 0.9));
  expect(tasteful).toMatchObject({
    policy: "judgments",
    pick: "claude:fable@high",
    shadow: { weighted: "codex:terra@high", judgments: "claude:fable@high" },
    warnings: [],
  });
  expect(tasteful.reason).toContain(
    "Judgments: bounded, taste 0.90 picked claude:fable",
  );
  expect(record(await judged("hard", 0.1)).pick).toBe("codex:sol@high");
  // An unknown difficulty label leaves no judgment pick: the weighted Jev pick runs, with a warning.
  const unjudged = record(await judged("impossible", 0.1));
  expect(unjudged).toMatchObject({
    policy: "jev",
    policyRelaxed: true,
    pick: "codex:terra@high",
    judgments: null,
    shadow: { judgments: null },
    warnings: [
      "Jev gave no usable difficulty or taste judgment; used the weighted Jev pick",
    ],
  });
  expect(tasteful.policyRelaxed).toBe(false);
  // A reply with a broken taste answer is still a usable routing reply.
  const reply = judgedReply("codex:terra", probabilities, "hard", 0.1);
  expect(
    parseJevReply({
      ...reply,
      answers: { ...reply.answers, needsTaste: { noul: 7 } },
    }).judgments,
  ).toBeNull();
});

test("experiment arms are drawn per route, recorded, and add state only when on", async () => {
  const quota = { claude: pool(50), codex: pool(50) };
  const probabilities = { "codex:sol": 0.9 };
  const states: any[] = [];
  const experimentDeps = (random: number, experiments?: object) =>
    balanceDeps(quota, probabilities, {
      config: {
        ...balanceConfig,
        rules: {
          ...balanceConfig.rules,
          experiments: experiments ?? {
            repoContext: 0.5,
            outcomeFeedback: 0.5,
          },
        },
      },
      random: () => random,
      repoContext: async (cwd) => {
        expect(cwd).toBe("/work/repo");
        return { trackedFiles: 12, topExtensions: [".ts"], hasTests: true };
      },
      recentOutcomes: async (modelIds) =>
        Object.fromEntries(
          modelIds.map((id) => [
            id,
            {
              runs: 1,
              failed: 0,
              retried: 0,
              escalatedFrom: 0,
              ratedGood: 1,
              ratedBad: 0,
            },
          ]),
        ),
      client: {
        systemOne: async ({ state }) => {
          states.push(state);
          return jevReply("codex:sol", probabilities);
        },
      },
    });
  const on = record(
    await route("task", { cwd: "/work/repo" }, experimentDeps(0.1)),
  );
  expect(on.experiments).toEqual({ repoContext: "on", outcomeFeedback: "on" });
  expect(states[0].repo).toEqual({
    trackedFiles: 12,
    topExtensions: [".ts"],
    hasTests: true,
  });
  expect(Object.keys(states[0].recentOutcomes)).toEqual(on.candidates);
  const off = record(
    await route("task", { cwd: "/work/repo" }, experimentDeps(0.9)),
  );
  expect(off.experiments).toEqual({
    repoContext: "off",
    outcomeFeedback: "off",
  });
  expect(states[1]).not.toHaveProperty("repo");
  expect(states[1]).not.toHaveProperty("recentOutcomes");
  const pinnedArms = record(
    await route(
      "task",
      { cwd: "/work/repo" },
      experimentDeps(0.5, { repoContext: 1, outcomeFeedback: 0 }),
    ),
  );
  expect(pinnedArms.experiments).toEqual({
    repoContext: "on",
    outcomeFeedback: "off",
  });
  const dryRun = await route(
    "task",
    { cwd: "/work/repo", dryRun: true },
    experimentDeps(0.1),
  );
  expect(dryRun).toMatchObject({
    experiments: { repoContext: "on", outcomeFeedback: "on" },
    repo: { trackedFiles: 12 },
  });
  // A fallback still records the arms that shaped the request.
  const offline = record(
    await route(
      "task",
      { cwd: "/work/repo" },
      {
        ...experimentDeps(0.1),
        client: { systemOne: async () => Promise.reject(new Error("offline")) },
      },
    ),
  );
  expect(offline).toMatchObject({
    kind: "fallback",
    experiments: { repoContext: "on", outcomeFeedback: "on" },
    shadow: null,
    judgments: null,
  });
});

test("the default dependencies read recent outcomes from saved sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-route-"));
  const previousState = process.env.SMART_ROUTER_STATE_DIR;
  process.env.SMART_ROUTER_STATE_DIR = directory;
  try {
    const defaults = defaultRouteDeps(config);
    expect(await defaults.recentOutcomes(["codex:terra"])).toEqual({
      "codex:terra": {
        runs: 0,
        failed: 0,
        retried: 0,
        escalatedFrom: 0,
        ratedGood: 0,
        ratedBad: 0,
      },
    });
    expect(defaults.random()).toBeLessThan(1);
    expect(await defaults.repoContext(directory)).toBeNull();
    expect(
      await defaultRouteDeps({
        ...config,
        quota: { ...config.quota, enabled: false },
      }).getQuota(),
    ).toEqual({ quota: { error: "quota disabled" }, ageMs: 0 });
  } finally {
    if (previousState === undefined) delete process.env.SMART_ROUTER_STATE_DIR;
    else process.env.SMART_ROUTER_STATE_DIR = previousState;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a route saves the preferences it was decided with, once per distinct text", async () => {
  const saved: [string, string][] = [];
  const recording = {
    savePreferences: async (sha256: string, text: string) => {
      saved.push([sha256, text]);
    },
  };
  const result = record(await route("task", {}, deps(recording)));
  expect(saved).toEqual([
    [result.inputs.preferencesSha256 ?? "", "prefer subscriptions"],
  ]);
  // A dry run decides nothing, so it saves nothing.
  await route("task", { dryRun: true }, deps(recording));
  expect(saved).toHaveLength(1);
  const directory = await mkdtemp(join(tmpdir(), "smart-router-route-"));
  const previousState = process.env.SMART_ROUTER_STATE_DIR;
  process.env.SMART_ROUTER_STATE_DIR = directory;
  try {
    const hash = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const first = hash("first text");
    const snapshotPath = join(directory, "preferences", `${first}.md`);
    expect(await readPreferencesSnapshot(first)).toBeNull();
    await defaultRouteDeps(config).savePreferences(first, "first text");
    expect(await readPreferencesSnapshot(first)).toBe("first text");
    // Written under a temporary name and renamed into place: nothing else is left behind.
    expect(await readdir(join(directory, "preferences"))).toEqual([
      `${first}.md`,
    ]);
    // An intact snapshot is not written again.
    const savedAt = (await stat(snapshotPath)).mtimeMs;
    await Bun.sleep(5);
    await savePreferencesSnapshot(first, "first text");
    expect((await stat(snapshotPath)).mtimeMs).toBe(savedAt);
    // A snapshot cut short by a crash does not hash to its name, so the next route rewrites it.
    await writeFile(snapshotPath, "first te");
    await savePreferencesSnapshot(first, "first text");
    expect(await readPreferencesSnapshot(first)).toBe("first text");
    await mkdir(join(directory, "preferences", "dir.md"));
    await expect(readPreferencesSnapshot("dir")).rejects.toThrow();
    // A snapshot that cannot be written is an error, and leaves no temporary file.
    await chmod(join(directory, "preferences"), 0o500);
    await expect(savePreferencesSnapshot(hash("new"), "new")).rejects.toThrow();
    await chmod(join(directory, "preferences"), 0o700);
    expect((await readdir(join(directory, "preferences"))).sort()).toEqual(
      [`${first}.md`, "dir.md"].sort(),
    );
  } finally {
    if (previousState === undefined) delete process.env.SMART_ROUTER_STATE_DIR;
    else process.env.SMART_ROUTER_STATE_DIR = previousState;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the judgment policy keeps its tier and taste requirement when quota excludes every qualifying model", async () => {
  // Claude holds the only taste model and is over its cutoff, so Jev is only asked about Codex.
  const quota = { claude: pool(99, -30), codex: pool(10, 40) };
  const probabilities = { "codex:terra": 0.7, "codex:sol": 0.2 };
  const judged = (
    difficulty: string,
    needsTaste: number,
    models = balanceConfig.models,
  ) =>
    route(
      "task",
      {},
      balanceDeps(quota, probabilities, {
        config: {
          ...balanceConfig,
          models,
          rules: { ...balanceConfig.rules, policy: "judgments" },
        },
        doctor: async () => ({
          ...balanceDetection,
          candidates: models.flatMap(({ id, efforts }) =>
            efforts.map((effort) => `${id}@${effort}`),
          ),
        }),
        client: {
          systemOne: async () =>
            judgedReply("codex:terra", probabilities, difficulty, needsTaste),
        },
      }),
    );
  const relaxed = record(await judged("frontier", 0.9));
  // Not the weighted pick (tier 2) and not a tier-1 model: quota is relaxed inside the qualifying set.
  expect(relaxed).toMatchObject({
    policy: "judgments",
    policyRelaxed: false,
    limitsRelaxed: true,
    pick: "claude:fable@high",
    shadow: { weighted: "codex:terra@high", judgments: "claude:fable@high" },
    warnings: [],
  });
  expect(relaxed.reason).toContain(
    "every model meeting the judgment requirement was over a quota cutoff; limits relaxed within those models",
  );
  // The same judgments as a shadow do not mark the Jev-policy route as relaxed.
  const shadowOnly = record(
    await route(
      "task",
      {},
      balanceDeps(quota, probabilities, {
        client: {
          systemOne: async () =>
            judgedReply("codex:terra", probabilities, "frontier", 0.9),
        },
      }),
    ),
  );
  expect(shadowOnly).toMatchObject({
    policy: "jev",
    policyRelaxed: false,
    limitsRelaxed: false,
    pick: "codex:terra@high",
    shadow: { judgments: "claude:fable@high" },
  });
  // No taste model exists at all: the weighted pick runs, and the record says the policy was relaxed.
  const withoutTasteModels = balanceConfig.models.filter(({ taste }) => !taste);
  const unmet = record(await judged("frontier", 0.9, withoutTasteModels));
  expect(unmet).toMatchObject({
    policy: "jev",
    policyRelaxed: true,
    pick: "codex:terra@high",
    shadow: { judgments: null },
    warnings: [
      "no candidate meets the judgment policy's requirement (frontier, taste 0.90) even without quota limits; used the weighted Jev pick",
    ],
  });
});

test("a pool's cutoff of null turns its limit off without touching the other pool", async () => {
  const result = record(
    await route(
      "task",
      {},
      balanceDeps(
        { claude: pool(100), codex: pool(100) },
        { "codex:sol": 0.9 },
        {
          config: {
            ...balanceConfig,
            rules: {
              ...balanceConfig.rules,
              quotaCutoffPercent: { claude: 95, codex: null },
            },
          },
        },
      ),
    ),
  );
  expect(result).toMatchObject({
    pick: "codex:sol@high",
    limitsRelaxed: false,
  });
  expect(result.excluded.every(({ id }) => id.startsWith("claude:"))).toBe(
    true,
  );
});
