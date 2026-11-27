import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { guardInputFromHook, guardSubagent, hookOutput } from "../src/guard.ts";
import type { QuotaProvider, QuotaResult } from "../src/quota.ts";

const STATE_DIRECTORY_ENV = "SMART_ROUTER_STATE_DIR";
const NOW = Date.parse("2026-11-27T12:00:00Z");
let directory: string;
let previousState: string | undefined;

beforeEach(async () => {
  previousState = process.env[STATE_DIRECTORY_ENV];
  directory = await mkdtemp(join(tmpdir(), "smart-router-guard-"));
  process.env[STATE_DIRECTORY_ENV] = directory;
});

afterEach(async () => {
  if (previousState === undefined) delete process.env[STATE_DIRECTORY_ENV];
  else process.env[STATE_DIRECTORY_ENV] = previousState;
  await rm(directory, { recursive: true, force: true });
});

function pool(paceGap: number): QuotaProvider {
  return {
    weeklyUsedPercent: 50,
    weeklyResetsAt: "soon",
    fiveHourUsedPercent: null,
    pace: "",
    paceGap,
    modelWindows: [],
  };
}

const config: Config = {
  ...DEFAULT_CONFIG,
  harnesses: { claude: { enabled: true }, codex: { enabled: true } },
};
const overPace: QuotaResult = { claude: pool(-21), codex: pool(61) };

function deps(quota: QuotaResult = overPace, rules: Config["rules"] = {}) {
  return {
    loadConfig: async () => ({
      ...config,
      rules: { ...config.rules, ...rules },
    }),
    readQuota: async () => ({ quota, ageMs: 0 }),
    now: () => NOW,
  };
}

async function logged(): Promise<Record<string, unknown>[]> {
  return (await readFile(join(directory, "native-subagents.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("denies a native subagent when its pool is over pace and another has reserve", async () => {
  const decision = await guardSubagent(
    {
      harness: "claude",
      subagentType: "general-purpose",
      model: "opus",
      sessionId: "session-1",
      cwd: "/repo",
    },
    deps(),
  );
  expect(decision.decision).toBe("deny");
  expect(decision.message).toContain(
    "claude is 21 pts over its weekly pace while codex has 61 in reserve",
  );
  expect(decision.message).toContain(
    'smart-router spawn "<task>" --cwd <repo>',
  );
  expect(decision.message).toContain("--launch");
  expect(await logged()).toEqual([
    {
      ts: "2026-11-27T12:00:00.000Z",
      harness: "claude",
      subagentType: "general-purpose",
      model: "opus",
      decision: "deny",
      reason: "guarded pool over pace while another has reserve",
      guardedGap: -21,
      otherGap: 61,
      cwd: "/repo",
      sessionId: "session-1",
    },
  ]);
});

test("warn mode warns, off mode allows, and allowed types always pass", async () => {
  const input = { harness: "claude" };
  expect(
    await guardSubagent(input, deps(overPace, { nativeSubagentGuard: "warn" })),
  ).toMatchObject({ decision: "warn" });
  expect(
    await guardSubagent(input, deps(overPace, { nativeSubagentGuard: "off" })),
  ).toEqual({ decision: "allow", message: "" });
  expect(
    await guardSubagent(
      { ...input, subagentType: "claude-code-guide" },
      deps(),
    ),
  ).toEqual({ decision: "allow", message: "" });
  expect(
    await guardSubagent(
      { ...input, subagentType: "reviewer" },
      deps(overPace, { nativeSubagentAllowTypes: ["reviewer"] }),
    ),
  ).toEqual({ decision: "allow", message: "" });
  // The rule file may leave both guard settings out: the defaults apply.
  expect(
    await guardSubagent(input, {
      ...deps(),
      loadConfig: async () => ({ ...config, rules: {} }),
    }),
  ).toMatchObject({ decision: "deny" });
  expect((await logged()).map(({ reason }) => reason)).toEqual([
    "guarded pool over pace while another has reserve",
    "guard off",
    "subagent type is always allowed",
    "subagent type is always allowed",
    "guarded pool over pace while another has reserve",
  ]);
});

test("allows when the pools are in balance or the other pool has no reserve", async () => {
  for (const quota of [
    { claude: pool(-10), codex: pool(61) },
    { claude: pool(-21), codex: pool(10) },
    { claude: pool(5), codex: pool(-40) },
    { claude: pool(-21), codex: null },
  ])
    expect(await guardSubagent({ harness: "claude" }, deps(quota))).toEqual({
      decision: "allow",
      message: "",
    });
  // The guard watches the harness it is called for: Codex is the pool with reserve here.
  expect(await guardSubagent({ harness: "codex" }, deps())).toMatchObject({
    decision: "allow",
  });
  expect(await guardSubagent({ harness: "unknown" }, deps())).toMatchObject({
    decision: "allow",
  });
});

test("fails open without quota, on errors and when the quota read is slow", async () => {
  expect(
    await guardSubagent(
      { harness: "claude" },
      deps({ error: "codexbar not installed" }),
    ),
  ).toEqual({ decision: "allow", message: "" });
  expect(
    await guardSubagent(
      { harness: "claude" },
      {
        ...deps(),
        loadConfig: async () => {
          throw new Error("config unreadable");
        },
      },
    ),
  ).toEqual({ decision: "allow", message: "" });
  expect(
    await guardSubagent(
      { harness: "claude" },
      {
        ...deps(),
        readQuota: () => Promise.reject("codexbar crashed"),
      },
    ),
  ).toEqual({ decision: "allow", message: "" });
  expect(
    await guardSubagent(
      { harness: "claude" },
      {
        ...deps(),
        timeoutMs: 10,
        readQuota: async () => {
          await Bun.sleep(200);
          return { quota: overPace, ageMs: 0 };
        },
      },
    ),
  ).toEqual({ decision: "allow", message: "" });
  expect((await logged()).map(({ reason }) => reason)).toEqual([
    "no quota: codexbar not installed",
    "guard error: config unreadable",
    "guard error: codexbar crashed",
    "guard timed out",
  ]);
});

test("a log that cannot be written does not change the decision", async () => {
  await mkdir(join(directory, "native-subagents.jsonl"));
  expect(await guardSubagent({ harness: "claude" }, deps())).toMatchObject({
    decision: "deny",
  });
});

test("reads Claude Code and Codex hook payloads", () => {
  expect(
    guardInputFromHook(
      "claude",
      JSON.stringify({
        session_id: "s1",
        cwd: "/a path",
        tool_name: "Agent",
        tool_input: { subagent_type: "Explore", model: "opus", prompt: "x" },
      }),
    ),
  ).toEqual({
    harness: "claude",
    subagentType: "Explore",
    model: "opus",
    sessionId: "s1",
    cwd: "/a path",
  });
  expect(
    guardInputFromHook(
      "codex",
      JSON.stringify({
        session_id: "s2",
        cwd: "/repo",
        tool_name: "spawn_agent",
        tool_input: { agent_type: "reviewer", model: "" },
      }),
    ),
  ).toEqual({
    harness: "codex",
    subagentType: "reviewer",
    model: undefined,
    sessionId: "s2",
    cwd: "/repo",
  });
  expect(guardInputFromHook("codex", "{}")).toEqual({
    harness: "codex",
    subagentType: undefined,
    model: undefined,
    sessionId: undefined,
    cwd: undefined,
  });
  expect(() => guardInputFromHook("codex", "not json")).toThrow();
});

test("prints the PreToolUse output both harnesses accept", () => {
  expect(
    JSON.parse(hookOutput({ decision: "deny", message: "route it" })),
  ).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "route it",
    },
  });
  // No permissionDecision on a warning: "allow" would skip Claude Code's prompt and fail Codex's parser.
  expect(
    JSON.parse(hookOutput({ decision: "warn", message: "route it" })),
  ).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "route it",
    },
  });
  expect(hookOutput({ decision: "allow", message: "" })).toBe("");
});
