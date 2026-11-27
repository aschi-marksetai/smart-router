import { restoreEnvironmentVariable } from "./environment.ts";
const previousTestEnvironment = { ...process.env };
import { armWake } from "../src/wakes.ts";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../src/assets.ts";
import { buildProgram, runCli, type CliDeps } from "../src/cli.ts";
import { DEFAULT_CONFIG, saveConfig, type Config } from "../src/config.ts";
import { startDashboard } from "../src/dashboard.ts";
import {
  createSession,
  completeSessionFromLog,
  listSessions,
  loadSession,
  processStartTime,
  saveSession,
  sweepSessions,
  sessionLogPath,
  sessionPath,
  sessionPromptPath,
  sessionSocketPath,
  SESSION_STATUS,
  terminateSessionProcess,
  type Session,
} from "../src/sessions.ts";
import type { DoctorResult } from "../src/doctor.ts";
import type { RouteDeps } from "../src/route.ts";
import { runForeground } from "../src/runner.ts";
import { getQuota, runCodexbar, type QuotaProvider } from "../src/quota.ts";
import { getAdapter } from "../src/harness/index.ts";

const TEST_T3_THREAD_ID =
  "thread:delegated-task:command%3Amcp%3A88e0911f-136c-4cff-a770-b45d4445e762%3Adelegate-task%3A6d558d53-1fee-496d-8fd6-80a6c093db42";
const OWNER = "cli-test-owner";
const PREVIOUS_CODEX_HOME = process.env.CODEX_HOME;
const foregroundChildren = new Set<Session>();
const foregroundChildPids: number[] = [];
const OTHER_OWNER = "someone-else";
const CLAUDE_OUTPUT = JSON.stringify({
  session_id: "claude-session",
  result: "finished work",
  // prettier-ignore
  usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 },
  total_cost_usd: 0.02,
});
const CODEX_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }),
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "codex done" },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 7, output_tokens: 9 },
  }),
].join("\n");
const CODEX_FAILED_OUTPUT = [
  '{"type":"thread.started","thread_id":"codex-thread"}',
  '{"type":"item.completed","item":{"type":"command_execution","command":"bun test"}}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"Still working"}}',
  '{"type":"turn.failed"}',
].join("\n");
const RELEASE_VERSION = "99.0.0";
const RELEASE_ASSET = `smart-router-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const DETACHED_PID = 999_999_999;
const INVALID_MODEL_ERROR =
  "codex:unknown is not an enabled model; enabled: claude:opus, codex:terra; run smart-router init --section models";
const INVALID_EFFORT_ERROR =
  "low is not supported by codex:terra; supported: high; run smart-router init --section models";
const DIRECT_MODEL_DENIED_ERROR =
  'direct model picks are disabled by rules.directModel; let the router choose and pass escalation context with --hint, for example --hint "escalate: previous attempt on codex:gpt-6-luna failed: <why>"';

let directory: string;
let config: Config;
let runnerOutput = CLAUDE_OUTPUT;
let runnerArguments: string[][];
let runnerEnvironments: NodeJS.ProcessEnv[];
let routeResponse: "success" | "offline" | "stopping" = "success";
let quotaEnabled = true;

const detection: DoctorResult = {
  jev: { provider: "typesafe", keyEnv: "TYPESAFE_API_KEY", keySet: false },
  harnesses: {
    claude: { installed: true, version: "1", authed: true },
    codex: { installed: true, version: "1", authed: true },
    pi: { installed: false, version: null, authed: false },
  },
  providers: {},
  codexbar: { installed: false },
  candidates: ["claude:opus@high", "codex:terra@high"],
  availableModels: [],
};

type JevStub = {
  choice?: string;
  effort?: string;
  needsNetwork?: number;
  needsFullAccess?: number;
};

function routeDeps(config: Config, stub: JevStub = {}): RouteDeps {
  const choice = stub.choice ?? "codex:terra";
  // prettier-ignore
  return {
    config, doctor: async () => detection, getQuota: async () => ({ quota: { error: "quota disabled" }, ageMs: 0 }), preferences: "prefer Claude",
    random: () => 0.99, repoContext: async () => null, recentOutcomes: async () => ({}), savePreferences: async () => {},
    client: { systemOne: async () => {
      if (routeResponse === "offline") throw new Error("mock returned 500");
      return { answers: {
        model: { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
        effort: { choice: stub.effort ?? "high", probabilities: { high: 1 } },
        needsBrowser: { noul: 0 }, needsNetwork: { noul: stub.needsNetwork ?? 0 }, needsFullAccess: { noul: stub.needsFullAccess ?? 0 },
        statesStoppingPoint: { noul: routeResponse === "stopping" ? 0.1 : 0.9 },
      } };
    } },
  };
}

type CliResult = {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  json: any;
};

async function cli(
  args: string[],
  overrides: Partial<CliDeps> = {},
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  // Match process.exit: the first exit code is final.
  // prettier-ignore
  const deps: CliDeps = {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, exit: (code) => { exitCode ??= code; },
    runForeground: async (argv, _cwd, env) => {
      runnerArguments.push(argv); runnerEnvironments.push(env ?? {}); return runnerOutput;
    },
    runDetached: async (_argv, _cwd, logPath) => {
      const errPath = logPath.replace(/\.log$/, ".err");
      await mkdir(join(directory, "state", "sessions"), { recursive: true });
      await writeFile(logPath, runnerOutput);
      await writeFile(errPath, "delegate warning\n");
      return { pid: DETACHED_PID, errPath };
    },
    fetch: async () => new Response(JSON.stringify({ tag_name: `v${RELEASE_VERSION}`, assets: [
      { name: RELEASE_ASSET, browser_download_url: "https://example.invalid/asset" },
    ] })),
    verifyConfinedCodex: () => { throw new Error("test binary not verified"); },
    now: Date.now, execPath: "/opt/homebrew/Cellar/smart-router/bin/smart-router", routeDeps: (configuration) => routeDeps(configuration),
    doctor: async () => detection,
    getQuota: (config) => getQuota(
      { ...(config ?? DEFAULT_CONFIG), quota: { ...(config ?? DEFAULT_CONFIG).quota, enabled: quotaEnabled } },
      { which: () => "/fake/codexbar", runCodexbar: (provider) => runCodexbar(provider, async () => JSON.stringify({
        usage: { primary: { usedPercent: 3 }, secondary: { usedPercent: 12, resetsAt: "tomorrow" } },
        pace: { secondary: { summary: "ok" } },
      })) },
    ),
    runInit: async () => {}, ...overrides,
  };
  await runCli(args, deps);
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {}
  return { stdout, stderr, exitCode, json };
}

function expectJson(result: CliResult, expected: object, exitCode = 0): void {
  expect(result.exitCode).toBe(exitCode);
  expect(result.json).toMatchObject(expected);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "smart-router-cli-"));
  process.env.SMART_ROUTER_CONFIG_DIR = join(directory, "config");
  process.env.SMART_ROUTER_STATE_DIR = join(directory, "state");
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
  // install writes Codex's skill and hooks file; keep it out of the real ~/.codex.
  process.env.CODEX_HOME = join(directory, "codex");
  process.env.SMART_ROUTER_OWNER = OWNER;
  process.env.SMART_ROUTER_NO_UPDATE_CHECK = "1";
  runnerArguments = [];
  runnerEnvironments = [];
  runnerOutput = CLAUDE_OUTPUT;
  routeResponse = "success";
  quotaEnabled = true;
  // prettier-ignore
  config = {
    ...DEFAULT_CONFIG,
    harnesses: { claude: { enabled: true }, codex: { enabled: true } },
    models: [
      { id: "claude:opus", harness: "claude", model: "opus", efforts: ["high"] },
      { id: "codex:terra", harness: "codex", model: "terra", efforts: ["high"] },
    ],
    defaultModelId: "claude:opus", defaultEffort: "high",
    quota: { enabled: false, providers: { claude: "claude" } }, updates: { check: false },
    rules: { stoppingPointRequiredFor: ["codex:terra"] },
  };
  await saveConfig(config);
});

afterEach(async () => {
  for (const session of foregroundChildren)
    await terminateSessionProcess(session);
  foregroundChildren.clear();
  await rm(directory, { recursive: true, force: true });
  // prettier-ignore
  for (const name of ["SMART_ROUTER_CONFIG_DIR", "SMART_ROUTER_STATE_DIR", "CLAUDE_CONFIG_DIR", "SMART_ROUTER_OWNER", "SMART_ROUTER_DEPTH", "SMART_ROUTER_HANDLE", "SMART_ROUTER_ANCESTORS", "SMART_ROUTER_NO_UPDATE_CHECK"]) {
    restoreEnvironmentVariable(name, previousTestEnvironment[name]);
  }
  restoreEnvironmentVariable("CODEX_HOME", PREVIOUS_CODEX_HOME);
});

afterAll(() => {
  const survivors = foregroundChildPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  expect(survivors).toEqual([]);
});

test("version, doctor, and install-skill run in-process", async () => {
  const versionResult = await cli(["--version"]);
  expect(versionResult).toMatchObject({ stdout: `${version}\n`, exitCode: 0 });
  const doctorResult = await cli(["doctor"]);
  expectJson(doctorResult, detection);
  expect(doctorResult.stderr).toContain("Doctor completed");
  const installed = await cli(["install"]);
  expect(installed.exitCode).toBe(0);
  expect(installed.json).toMatchObject({
    codexSkillPath: join(directory, "codex", "skills/smart-router/SKILL.md"),
    codexHookAdded: true,
  });
  expectJson(await cli(["install-skill"]), { codexHookAdded: false });
  expect(installed.json.skillPath).toBe(
    join(directory, "claude", "skills/smart-router/SKILL.md"),
  );
  expect(await readFile(installed.json.skillPath, "utf8")).toContain(
    "smart-router",
  );
  let initOptions: { section?: string; reset?: boolean } = {};
  await cli(["init", "--section", "rules", "--reset"], {
    runInit: async (options) => {
      initOptions = options;
    },
  });
  expect(initOptions).toEqual({ section: "rules", reset: true });
});

test("default program writes version and command errors", async () => {
  await expect(
    buildProgram().parseAsync(["--version"], { from: "user" }),
  ).rejects.toThrow();
  await expect(
    buildProgram().parseAsync(["--unknown"], { from: "user" }),
  ).rejects.toThrow();
});

test("route selects, dry-runs, and falls back after a Jev failure", async () => {
  const selected = await cli(["route", "task", "--hint", "code"]);
  expectJson(selected, { pick: "codex:terra@high", fellBack: false });
  const dryRun = await cli(["route", "task", "--dry-run", "--confidential"]);
  expectJson(dryRun, { task: "task", quota: null });
  expect(dryRun.json.candidates).toHaveLength(2);
  routeResponse = "offline";
  const fallback = await cli(["route", "task"]);
  expectJson(fallback, { pick: "claude:opus@high", fellBack: true });
  expect(fallback.json.reason).toContain("mock returned 500");
});

test.each([
  ["codex", 0, 0, "workspace-write"],
  ["codex", 1, 0, "workspace-write+network"],
  ["codex", 0, 1, "danger-full-access"],
  ["claude", 0, 0, null],
] as const)(
  "route --launch matches %s spawn (network %s, full %s)",
  async (harness, network, fullAccess, sandbox) => {
    const prompt = "Finish task; stop when verified";
    await writeFile(
      join(directory, "config", "guardrails.md"),
      `## ${harness}\nVerify the result.\n## ${harness}:${harness === "codex" ? "terra" : "opus"}\nStop after verification.\n`,
    );
    await writeFile(
      join(directory, "Package.swift"),
      "// swift-tools-version: 6.0",
    );
    execFileSync("git", ["init", directory], { stdio: "pipe" });
    execFileSync("git", ["-C", directory, "config", "commit.gpgsign", "true"]);
    const overrides: Partial<CliDeps> = {
      routeDeps: (configuration) =>
        routeDeps(configuration, {
          choice: `${harness}:${harness === "codex" ? "terra" : "opus"}`,
          needsNetwork: network,
          needsFullAccess: fullAccess,
        }),
    };
    const args = [
      prompt,
      "--cwd",
      directory,
      "--hint",
      "bounded task",
      "--model",
      `${harness}:auto`,
    ];
    const plain = await cli(["route", ...args], overrides);
    const launched = await cli(["route", ...args, "--launch"], overrides);
    expect(launched.exitCode).toBe(0);
    const { launch, ...decision } = launched.json;
    // Routing latency differs between the two runs; everything else must match.
    expect(decision).toEqual({
      ...plain.json,
      inputs: { ...plain.json.inputs, routingLatencyMs: expect.any(Number) },
    });
    expect(plain.json).not.toHaveProperty("launch");
    expect(launch).toMatchObject({
      harness,
      model: harness === "codex" ? "terra" : "opus",
      effort: "high",
      sandbox,
    });
    expect(launch.prompt).toContain(
      "## Operating rules\n\nVerify the result.\n\nStop after verification.",
    );
    if (harness === "codex" && sandbox?.startsWith("workspace-write")) {
      expect(launch.prompt).toContain("--disable-sandbox");
      expect(launch.prompt).toContain("commit not signed: needs overseer");
    }
    expect(runnerArguments).toHaveLength(0);
    expect((await loadSession(launch.handle)).status).toBe("launched");
    runnerOutput = harness === "codex" ? CODEX_OUTPUT : CLAUDE_OUTPUT;
    const spawned = await cli(["spawn", ...args], overrides);
    expect(spawned.exitCode).toBe(0);
    const spawnPrompt = runnerArguments[0]?.find((argument) =>
      argument.startsWith(prompt),
    );
    expect(spawnPrompt).toContain(
      harness === "codex"
        ? "Processes you start in the background are stopped"
        : 'smart-router wake "$SMART_ROUTER_HANDLE"',
    );
    // T3 owns the child identity; only spawn adds smart-router session context.
    const sessionContext = /\n\n## Delegation context\n\n[^\n]+/;
    expect(launch.prompt.split("\n\nYour smart-router handle is")[0]).toBe(
      spawnPrompt
        ?.replace(sessionContext, "")
        .replace(
          /\n\n(?:Work that must outlive|Processes you start in the background)[^\n]+/,
          "",
        ),
    );
    expect(launch.sandbox).toBe(spawned.json.sandbox ?? null);
  },
);

test("route --launch rejects a dry-run without launching", async () => {
  const result = await cli(["route", "task", "--launch", "--dry-run"]);
  expectJson(
    result,
    { error: "--launch cannot be combined with --dry-run" },
    1,
  );
  expect(runnerArguments).toHaveLength(0);
});

test("route --launch refuses a pick that needs a stated stopping point, like spawn", async () => {
  routeResponse = "stopping";
  const refused = await cli(["route", "task", "--launch"]);
  expectJson(
    refused,
    {
      error:
        "codex:terra needs a stated stopping point: add success criteria and where to stop to the prompt, then call route --launch again",
    },
    1,
  );
  expect(runnerArguments).toHaveLength(0);
});

test("spawn parses Claude and Codex output, flags, and stopping-point refusal", async () => {
  process.env.SMART_ROUTER_DEPTH = "1";
  process.env.SMART_ROUTER_HANDLE = "parent-handle";
  process.env.SMART_ROUTER_ANCESTORS = "root-handle";
  // prettier-ignore
  const claude = await cli(["spawn", "finish task", "--model", "claude:opus", "--no-guardrails", "--result-limit", "4"]);
  expectJson(claude, {
    harness: "claude",
    result: "fini",
    resultTruncated: true,
    resultChars: 13,
  });
  expect(claude.stderr).toContain(
    "Routed to claude:opus@high (caller override)",
  );
  expect(
    runnerArguments[0].some((argument) => argument.startsWith("finish task\n")),
  ).toBe(true);
  expect(runnerArguments[0].join(" ")).not.toContain("## Operating rules");
  expect(runnerArguments[0].join(" ")).not.toContain("## Delegation context");
  expect(runnerEnvironments[0]).toMatchObject({
    SMART_ROUTER_OWNER: OWNER,
    SMART_ROUTER_DEPTH: "2",
    SMART_ROUTER_ANCESTORS: "root-handle,parent-handle",
  });
  expect(runnerEnvironments[0].SMART_ROUTER_HANDLE).toBe(claude.json.handle);
  expect(await loadSession(claude.json.handle)).toMatchObject({
    depth: 2,
    parentHandle: "parent-handle",
    logPath: sessionLogPath(claude.json.handle),
  });
  delete process.env.SMART_ROUTER_DEPTH;
  delete process.env.SMART_ROUTER_HANDLE;
  delete process.env.SMART_ROUTER_ANCESTORS;
  runnerOutput = CODEX_OUTPUT;
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  // prettier-ignore
  const codex = await cli(["spawn", "finish task", "--model", "codex:terra", "--effort", "high", "--schema", schemaPath, "--permission-mode", "default", "--allowed-tools", "Read"]);
  expectJson(codex, {
    harness: "codex",
    result: "codex done",
    usage: { inputTokens: 7, outputTokens: 9, costUsd: null },
  });
  expect(codex.json.resumeCommand).toContain("codex-thread");
  expect(codex.stderr).toContain("--permission-mode, --allowed-tools");
  expect(runnerArguments[1]).toContain(schemaPath);
  expect(runnerArguments[1].at(-1)).toContain(
    `## Delegation context\n\nYour smart-router handle is ${codex.json.handle} at depth 1 of max 2`,
  );
  routeResponse = "stopping";
  const refused = await cli(["spawn", "task"]);
  expectJson(
    refused,
    {
      error:
        "codex:terra needs a stated stopping point: add success criteria and where to stop to the prompt, then call spawn again",
    },
    1,
  );
});

test("Codex spawn includes the signing note for a repository requiring signed commits", async () => {
  execFileSync("git", ["init", directory], { stdio: "pipe" });
  execFileSync("git", ["-C", directory, "config", "commit.gpgsign", "true"]);
  runnerOutput = CODEX_OUTPUT;
  const result = await cli([
    "spawn",
    "task",
    "--model",
    "codex:terra",
    "--cwd",
    directory,
  ]);
  expect(result.exitCode).toBe(0);
  expect(runnerArguments[0]?.at(-1)).toContain(
    "Commit signing is unavailable in this sandbox.",
  );
});

test("spawn includes configured harness and model guardrails", async () => {
  await writeFile(
    join(directory, "config", "guardrails.md"),
    "## claude\nVerify the result.\n## claude:opus\nStop after verification.\n",
  );
  const result = await cli(["spawn", "task", "--model", "claude:opus"]);
  expect(result.exitCode).toBe(0);
  expect(runnerArguments[0]?.join(" ")).toContain(
    "## Operating rules\n\nVerify the result.\n\nStop after verification.",
  );
});

test("spawn and send preserve the configured Codex localhost network access", async () => {
  config.spawn = { ...config.spawn, codexLocalhostNeedsNetwork: true };
  await saveConfig(config);
  runnerOutput = CODEX_OUTPUT;
  const spawned = await cli(["spawn", "task", "--model", "codex:terra"]);
  expectJson(spawned, { sandbox: "workspace-write+network" });
  expect(await loadSession(spawned.json.handle)).toMatchObject({
    sandbox: "workspace-write",
    usesNetworkAccess: true,
  });
  expect((await cli(["send", spawned.json.handle, "again"])).exitCode).toBe(0);
  expect(runnerArguments).toHaveLength(2);
  for (const argv of runnerArguments)
    expect(argv).toContain("sandbox_workspace_write.network_access=true");
});

test("spawn dry-run reports the decision without launching a harness", async () => {
  expectJson(await cli(["spawn", "task", "--dry-run"]), {
    pick: "codex:terra@high",
    fellBack: false,
  });
  expect(runnerArguments).toHaveLength(0);
  expect(await listSessions(OWNER)).toEqual([]);
});

test("harness:auto routes under directModel deny and stores the concrete model on send", async () => {
  config.rules.directModel = "deny";
  config.models[1].efforts = ["low", "high"];
  await saveConfig(config);
  runnerOutput = CODEX_OUTPUT;
  const scopedRouteDeps = (configuration: Config): RouteDeps =>
    routeDeps(configuration, { effort: "low" });
  const spawned = await cli(["spawn", "review", "--model", "codex:auto"], {
    routeDeps: scopedRouteDeps,
  });
  expectJson(spawned, {
    harness: "codex",
    model: "terra",
    effort: "low",
    route: { pick: "codex:terra@low", fellBack: false },
  });
  expect(await loadSession(spawned.json.handle)).toMatchObject({
    harness: "codex",
    model: "terra",
    effort: "low",
    route: { pick: "codex:terra@low" },
  });
  expectJson(
    await cli(["send", spawned.json.handle, "again"], {
      routeDeps: () => {
        throw new Error("must not reroute a resume");
      },
    }),
    { result: "codex done" },
  );
  expect(await loadSession(spawned.json.handle)).toMatchObject({
    harness: "codex",
    model: "terra",
    effort: "low",
  });
  expectJson(
    await cli(["spawn", "review", "--model", "codex:auto", "--effort", "high"]),
    { error: DIRECT_MODEL_DENIED_ERROR },
    1,
  );
  expectJson(
    await cli(["spawn", "review", "--model", "codex:terra"]),
    { error: DIRECT_MODEL_DENIED_ERROR },
    1,
  );
});

test("harness:auto supports effort overrides, scoped route inspection and dry-run", async () => {
  config.models[1].efforts = ["low", "high"];
  await saveConfig(config);
  runnerOutput = CODEX_OUTPUT;
  const args = ["spawn", "review", "--model", "codex:auto", "--effort", "low"];
  expectJson(await cli([...args, "--dry-run"]), {
    pick: "codex:terra@low",
    candidates: ["codex:terra"],
  });
  expect(runnerArguments).toHaveLength(0);
  expect(await listSessions(OWNER)).toEqual([]);
  expectJson(await cli(args), {
    model: "terra",
    effort: "low",
    route: { pick: "codex:terra@low" },
  });
  expectJson(await cli(["route", "review", "--model", "codex:auto"]), {
    pick: "codex:terra@high",
    candidates: ["codex:terra"],
    fellBack: false,
  });
  const state = await cli([
    "route",
    "review",
    "--model",
    "codex:auto",
    "--dry-run",
  ]);
  expectJson(state, { candidates: [{ harness: "codex", model: "terra" }] });
  expectJson(
    await cli(["route", "review", "--model", "codex:terra"]),
    { error: "route --model must be harness:auto" },
    1,
  );
  config.harnesses.codex!.enabled = false;
  await saveConfig(config);
  expectJson(
    await cli(["spawn", "review", "--model", "codex:auto"]),
    { error: "No route candidates available for harness codex" },
    1,
  );
});

test("send refuses a failed session without a harness session id", async () => {
  const session = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: SESSION_STATUS.failed,
  });
  expectJson(
    await cli(["send", session.handle, "again"]),
    { error: `session ${session.handle} has no session id` },
    1,
  );
  expect(runnerArguments).toHaveLength(0);
});

test("spawn rejects disabled overrides and accepts enabled overrides", async () => {
  expectJson(
    await cli(["spawn", "task", "--model", "codex:unknown"]),
    { error: INVALID_MODEL_ERROR },
    1,
  );
  config.rules.directModel = "deny";
  await saveConfig(config);
  expectJson(
    await cli(["spawn", "task", "--effort", "high"]),
    { error: DIRECT_MODEL_DENIED_ERROR },
    1,
  );
  config.rules.directModel = "allow";
  await saveConfig(config);
  expectJson(
    await cli(["spawn", "task", "--model", "codex:terra", "--effort", "low"]),
    { error: INVALID_EFFORT_ERROR },
    1,
  );
  expectJson(
    await cli(["spawn", "task", "--model", "claude:opus", "--effort", "high"]),
    { harness: "claude", model: "opus", effort: "high" },
  );
});

test("MCP translation, strict mode and paths persist on send without storing bearer tokens", async () => {
  const configPath = join(directory, "mcp.json");
  const replacementPath = join(directory, "replacement.json");
  process.env.MCP_TEST_TOKEN = "secret-mcp-token";
  process.env.MCP_TEST_VALUE = "expanded";
  try {
    // prettier-ignore
    await writeFile(configPath, JSON.stringify({ mcpServers: {
      local: { type: "stdio", command: "node", args: ["server.js"], env: { VALUE: "${MCP_TEST_VALUE}" } },
      remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${MCP_TEST_TOKEN}", "X-Test": "${MCP_TEST_VALUE}" } },
    } }));
    await writeFile(replacementPath, '{"mcpServers":{}}');
    runnerOutput = CODEX_OUTPUT;
    // prettier-ignore
    const spawned = await cli(["spawn", "task", "--model", "codex:terra", "--mcp-config", configPath, "--mcp-config", replacementPath, "--strict-mcp-config"]);
    expect(spawned.exitCode).toBe(0);
    const handle = spawned.json.handle;
    expect((await cli(["send", handle, "again"])).exitCode).toBe(0);
    const expectedOverrides = [
      "--ignore-user-config",
      'mcp_servers.local.command="node"',
      'mcp_servers.local.args=["server.js"]',
      'mcp_servers.local.env={"VALUE"="expanded"}',
      'mcp_servers.remote.url="https://example.com/mcp"',
      'mcp_servers.remote.bearer_token_env_var="MCP_TEST_TOKEN"',
      'mcp_servers.remote.http_headers={"X-Test"="expanded"}',
    ];
    for (const argv of runnerArguments) {
      expect(argv).toEqual(expect.arrayContaining(expectedOverrides));
      expect(argv.join(" ")).not.toContain(process.env.MCP_TEST_TOKEN);
    }
    // prettier-ignore
    expect(await loadSession(handle)).toMatchObject({ mcpConfig: [configPath, replacementPath], strictMcpConfig: true });
    const sessionFile = await readFile(sessionPath(handle), "utf8");
    expect(sessionFile).not.toContain(process.env.MCP_TEST_TOKEN);
    // prettier-ignore
    const replacement = ["send", handle, "replace", "--mcp-config", replacementPath];
    expect((await cli(replacement)).exitCode).toBe(0);
    expect((await cli(["send", handle, "reuse"])).exitCode).toBe(0);
    // prettier-ignore
    expect(await loadSession(handle)).toMatchObject({ mcpConfig: [replacementPath], strictMcpConfig: true });
    expect(runnerArguments.at(-1)?.join(" ")).not.toContain(
      "mcp_servers.local",
    );
  } finally {
    delete process.env.MCP_TEST_TOKEN;
    delete process.env.MCP_TEST_VALUE;
  }
});

test("pi ignores persisted MCP flags with a stderr note", async () => {
  // prettier-ignore
  const session = await createSession({ harness: "pi", model: "test", effort: "high", cwd: directory, prompt: "task", status: SESSION_STATUS.done, sessionId: "pi.json", mcpConfig: ["missing.json"], strictMcpConfig: true });
  runnerOutput =
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}';
  const result = await cli(["send", session.handle, "again"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain(
    "Ignored for pi: --mcp-config, --strict-mcp-config",
  );
});

test("each concurrency limit exits 3 with capacity JSON", async () => {
  const spawn = ["spawn", "task", "--model", "claude:opus"];
  const running = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: directory,
    prompt: "existing task",
    status: SESSION_STATUS.running,
    pid: process.pid,
  });
  config.rules.concurrency = { maxRunning: 1, maxPerCaller: 3, maxDepth: 2 };
  await saveConfig(config);
  const global = await cli([...spawn, "--wait-for-slot", "0.01"]);
  expectJson(global, { error: "capacity", limit: "maxRunning" }, 3);
  expect(global.json.running[0].handle).toBe(running.handle);
  expect(global.json.otherOwnersRunning).toBe(0);
  expect(global.json.next).toBe(
    "wait on one of these handles with smart-router wait <handle>, or stop one",
  );
  config.rules.concurrency = { maxRunning: 6, maxPerCaller: 1, maxDepth: 2 };
  await saveConfig(config);
  expectJson(await cli(spawn), { error: "capacity", limit: "maxPerCaller" }, 3);
  process.env.SMART_ROUTER_DEPTH = "2";
  config.rules.concurrency = { maxRunning: 6, maxPerCaller: 3, maxDepth: 2 };
  await saveConfig(config);
  const depth = await cli(spawn);
  expectJson(depth, { error: "capacity", limit: "maxDepth" }, 3);
  expect(depth.json.next).toContain("do the work themselves");
  delete process.env.SMART_ROUTER_DEPTH;
});

test("global capacity reports other owners without exposing their sessions", async () => {
  config.rules.concurrency = { maxRunning: 1, maxPerCaller: 3, maxDepth: 2 };
  await saveConfig(config);
  // prettier-ignore
  const blocker = await createSession({ harness: "claude", model: "opus", effort: "high", cwd: directory, prompt: "private task", status: SESSION_STATUS.running, pid: process.pid });
  blocker.owner = OTHER_OWNER;
  await saveSession(blocker);
  const result = await cli(["spawn", "task", "--model", "claude:opus"]);
  expectJson(
    result,
    {
      error: "capacity",
      limit: "maxRunning",
      running: [],
      otherOwnersRunning: 1,
      next: "global slots are held by other sessions; retry later or pass --wait-for-slot <seconds>",
    },
    3,
  );
  expect(result.stdout).not.toContain(blocker.handle);
  expect(result.stdout).not.toContain(blocker.promptPreview);
  expect(runnerArguments).toHaveLength(0);
});

test("send waits for capacity and resumes the same handle and session id", async () => {
  const spawned = await cli(["spawn", "task", "--model", "claude:opus"]);
  const original = await loadSession(spawned.json.handle);
  config.rules.concurrency = { maxRunning: 1, maxPerCaller: 3, maxDepth: 2 };
  await saveConfig(config);
  // prettier-ignore
  const blocker = await createSession({ harness: "claude", model: "opus", effort: "high", cwd: directory, prompt: "blocker", status: SESSION_STATUS.running, pid: process.pid });
  const release = (async () => {
    await Bun.sleep(20);
    blocker.status = SESSION_STATUS.done;
    await saveSession(blocker);
  })();
  const result = await cli([
    "send",
    original.handle,
    "again",
    "--wait-for-slot",
    "1",
  ]);
  await release;
  expectJson(result, { handle: original.handle, result: "finished work" });
  expect(await loadSession(original.handle)).toMatchObject({
    sessionId: original.sessionId,
    status: SESSION_STATUS.done,
  });
  expect(runnerArguments.at(-1)).toEqual(
    expect.arrayContaining(["--resume", original.sessionId]),
  );
  expect(await listSessions()).toHaveLength(2);
});

test("send capacity timeout launches nothing and leaves the session intact", async () => {
  const spawned = await cli(["spawn", "task", "--model", "claude:opus"]);
  const original = await loadSession(spawned.json.handle);
  config.rules.concurrency = { maxRunning: 1, maxPerCaller: 3, maxDepth: 2 };
  await saveConfig(config);
  // prettier-ignore
  await createSession({ harness: "claude", model: "opus", effort: "high", cwd: directory, prompt: "blocker", status: SESSION_STATUS.running, pid: process.pid });
  const result = await cli([
    "send",
    original.handle,
    "again",
    "--wait-for-slot",
    "0.01",
  ]);
  expectJson(result, { error: "capacity", limit: "maxRunning" }, 3);
  expect(runnerArguments).toHaveLength(1);
  expect(await loadSession(original.handle)).toEqual(original);
  expect(await listSessions()).toHaveLength(2);
});

test.each(["-1", "NaN", "Infinity"])(
  "send validates wait-for-slot like spawn: %s",
  async (value) => {
    const spawned = await cli(["spawn", "task", "--model", "claude:opus"]);
    for (const command of [
      ["spawn", "task", "--model", "claude:opus"],
      ["send", spawned.json.handle, "again"],
    ]) {
      expectJson(
        await cli([...command, "--wait-for-slot", value]),
        { error: "--wait-for-slot must be a non-negative number" },
        1,
      );
    }
    expect(runnerArguments).toHaveLength(1);
  },
);

test("concurrent sends cannot reserve the same available slot", async () => {
  const first = await cli(["spawn", "first", "--model", "claude:opus"]);
  const second = await cli(["spawn", "second", "--model", "claude:opus"]);
  config.rules.concurrency = { maxRunning: 1, maxPerCaller: 3, maxDepth: 2 };
  await saveConfig(config);
  let launches = 0;
  const run: CliDeps["runForeground"] = async () => {
    launches += 1;
    await Bun.sleep(150);
    return CLAUDE_OUTPUT;
  };
  const results = await Promise.all(
    [first, second].map(({ json }) =>
      cli(["send", json.handle, "again", "--wait-for-slot", "0.01"], {
        runForeground: run,
      }),
    ),
  );
  expect(results.map(({ exitCode }) => exitCode).sort()).toEqual([0, 3]);
  expect(launches).toBe(1);
});

test("foreground spawn and send register children and count toward both caps", async () => {
  const releaseFlag = join(directory, "release-foreground-child");
  const waitForRelease = `while [ -d '${directory}' ] && [ ! -e '${releaseFlag}' ]; do sleep 0.05; done`;
  const spawned = await cli(["spawn", "task", "--model", "claude:opus"]);
  // prettier-ignore
  const commands = [["spawn", "task", "--model", "claude:opus"], ["send", spawned.json.handle, "again"]];
  for (const [index, limit] of ["maxRunning", "maxPerCaller"].entries()) {
    // prettier-ignore
    config.rules.concurrency = { maxRunning: 6, maxPerCaller: 3, maxDepth: 2, [limit]: 1 };
    await saveConfig(config);
    // prettier-ignore
    const foregroundRunner: CliDeps["runForeground"] = async (_argv, cwd, env, session) => {
      if (!session) throw new Error("missing foreground session");
      await rm(releaseFlag, { force: true });
      foregroundChildren.add(session);
      const running = runForeground(["sh", "-c", waitForRelease], cwd, env, session);
      try {
        while (!(await loadSession(session.handle)).pid) await Bun.sleep(5);
        foregroundChildPids.push((await loadSession(session.handle)).pid!);
        const active = await loadSession(session.handle);
        expect(active.status).toBe(SESSION_STATUS.running);
        expect(active.wrapperPid).toBe(process.pid);
        expect(active.wrapperProcessStartTime).toBe(processStartTime(process.pid));
        expect(active.processStartTime).toBe(processStartTime(session.pid!));
        const blockedCommand = index === 0 ? commands[1] : commands[0];
        expectJson(await cli(blockedCommand), { error: "capacity", limit }, 3);
      } finally {
        await writeFile(releaseFlag, "");
        await running;
        foregroundChildren.delete(session);
      }
      return CLAUDE_OUTPUT;
    };
    const completed = await cli(commands[index], {
      runForeground: foregroundRunner,
    });
    expect(completed.exitCode).toBe(0);
    expect((await loadSession(completed.json.handle)).status).toBe(
      SESSION_STATUS.done,
    );
  }
});

test("spawn lock enforces maxRunning and wait-for-slot polls", async () => {
  config.rules.concurrency = { maxRunning: 1, maxPerCaller: 3, maxDepth: 2 };
  await saveConfig(config);
  const detached = async (_argv: string[], _cwd: string, logPath: string) => ({
    pid: process.pid,
    errPath: logPath.replace(/\.log$/, ".err"),
  });
  const spawnDetached = (prompt: string) =>
    cli(["spawn", prompt, "--model", "claude:opus", "--detach"], {
      runDetached: detached,
    });
  const results = await Promise.all([
    spawnDetached("one"),
    spawnDetached("two"),
  ]);
  expect(results.map(({ exitCode }) => exitCode).sort()).toEqual([0, 3]);
  const successfulSpawn = results.find(({ exitCode }) => exitCode === 0);
  if (!successfulSpawn) throw new Error("expected one successful spawn");
  const active = await loadSession(successfulSpawn.json.handle);
  setTimeout(async () => {
    active.status = SESSION_STATUS.done;
    await saveSession(active);
  }, 20);
  const waitArgs = ["spawn", "waiting", "--model", "claude:opus"];
  expectJson(await cli([...waitArgs, "--wait-for-slot", "1"]), {
    result: "finished work",
  });
});

test("records detached launch failures and reports failed waits", async () => {
  const failedSpawn = await cli(
    ["spawn", "task", "--model", "claude:opus", "--detach"],
    {
      runDetached: async () => {
        throw new Error("launch denied");
      },
    },
  );
  expectJson(failedSpawn, { error: "launch denied" }, 1);
  const sessions = (await cli(["sessions"])).json;
  expect(sessions).toHaveLength(1);
  expect(sessions[0].status).toBe("failed");
  expectJson(
    await cli(["wait", sessions[0].handle]),
    {
      handle: sessions[0].handle,
      error: `session ${sessions[0].handle} was failed: launch denied`,
      lastMessage: null,
      lastAction: null,
    },
    1,
  );
});

test("wait polls a running session until it completes", async () => {
  const session = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: SESSION_STATUS.running,
    pid: process.pid,
  });
  const changed = new Promise<void>((resolve) =>
    setTimeout(async () => {
      await saveSession({
        ...session,
        status: SESSION_STATUS.done,
        result: "done",
      });
      resolve();
    }, 20),
  );
  expectJson(await cli(["wait", session.handle]), { result: "done" });
  await changed;
});

test("wait reports stopped and failed sessions and times out while running", async () => {
  for (const status of [SESSION_STATUS.stopped, SESSION_STATUS.failed]) {
    const session = await createSession({
      harness: "claude",
      model: "opus",
      effort: "high",
      cwd: directory,
      prompt: "task",
      status,
      error: "delegate ended",
      lastMessage: "progress",
      lastAction: "bun test",
    });
    expectJson(
      await cli(["wait", session.handle]),
      {
        handle: session.handle,
        error: `session ${session.handle} was ${status}: delegate ended`,
        lastMessage: "progress",
        lastAction: "bun test",
      },
      1,
    );
    expectJson(await cli(["status", session.handle]), {
      outcome: status,
      error: `session ${session.handle} was ${status}: delegate ended`,
    });
  }
  const running = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: SESSION_STATUS.running,
    pid: process.pid,
  });
  expectJson(
    await cli(["wait", running.handle, "--timeout", "0.01"]),
    {
      handle: running.handle,
      error: "timeout",
      status: "running",
      next: `poll with smart-router status ${running.handle} or wait again; do not start another wait in parallel`,
    },
    124,
  );
});

test("foreground Codex failures report and persist their last activity", async () => {
  const activity = { lastMessage: "Still working", lastAction: "bun test" };
  runnerOutput = CODEX_FAILED_OUTPUT;
  const failedSpawn = await cli(["spawn", "task", "--model", "codex:terra"]);
  // prettier-ignore
  expectJson(failedSpawn, { error: "Codex turn did not complete successfully", ...activity }, 1);
  // prettier-ignore
  const failed = (await listSessions(OWNER)).find(({ status }) => status === "failed");
  if (!failed) throw new Error("failed spawn session was not saved");
  // prettier-ignore
  expect(await loadSession(failed.handle)).toMatchObject({ status: "failed", ...activity });

  runnerOutput = CODEX_OUTPUT;
  const spawned = await cli(["spawn", "task", "--model", "codex:terra"]);
  runnerOutput = CODEX_FAILED_OUTPUT;
  // prettier-ignore
  expectJson(await cli(["send", spawned.json.handle, "again"]), { error: "Codex turn did not complete successfully", ...activity }, 1);
  // prettier-ignore
  expect(await loadSession(spawned.json.handle)).toMatchObject({ status: "failed", ...activity });
});

test("wait, stop, send and steer refuse own and ancestor handles", async () => {
  process.env.SMART_ROUTER_HANDLE = "self-handle";
  process.env.SMART_ROUTER_ANCESTORS = "ancestor-handle";
  const commands = ["wait", "stop", "send", "steer"];
  for (const command of commands) {
    for (const handle of ["self-handle", "ancestor-handle"]) {
      const args =
        command === "wait" || command === "stop"
          ? [command, handle]
          : [command, handle, "message"];
      expectJson(
        await cli(args),
        {
          error: `refusing to ${command} ${handle}: it is your own session or an ancestor; report your result instead`,
        },
        1,
      );
    }
  }
});

test("detached spawn supports status, logs, wait, stop, and send refusal", async () => {
  // prettier-ignore
  const detached = await cli(["spawn", "finish task", "--model", "claude:opus", "--detach"]);
  expectJson(detached, { harness: "claude", logPath: expect.any(String) });
  const handle = detached.json.handle;
  const running = await loadSession(handle);
  expect(running.status).toBe(SESSION_STATUS.running);
  const refused = await cli(["send", handle, "again"]);
  expectJson(
    refused,
    { error: `session ${handle} is still running; wait or stop it first` },
    1,
  );
  expect((await cli(["logs", handle, "--tail", "1"])).stdout).toBe(
    CLAUDE_OUTPUT,
  );
  expect((await cli(["logs", handle, "--err"])).stdout).toBe(
    "delegate warning\n",
  );
  const status = await cli(["status", handle]);
  expectJson(status, {
    status: "done",
    running: false,
    result: "finished work",
  });
  const waited = await cli(["wait", handle, "--result-limit", "6"]);
  expectJson(waited, { result: "finish", resultTruncated: true });
  expectJson(waited, { usage: { cachedInputTokens: 6, cacheWriteTokens: 2 } });
  expectJson(status, { usage: { cachedInputTokens: 6, cacheWriteTokens: 2 } });
  const stopped = await cli(["stop", handle]);
  expectJson(stopped, { status: "stopped", running: false });
});

test("spawn --label and --phase are trimmed, validated and shown by sessions and status", async () => {
  // prettier-ignore
  const spawned = await cli(["spawn", "finish task", "--model", "claude:opus", "--label", "  research:dji-mic ", "--phase", "Research"]);
  const handle = spawned.json.handle;
  expect(await loadSession(handle)).toMatchObject({
    label: "research:dji-mic",
    phase: "Research",
  });
  const listed = (await cli(["sessions"])).json.find(
    (session: { handle: string }) => session.handle === handle,
  );
  expect(listed).toMatchObject({
    label: "research:dji-mic",
    phase: "Research",
    resultPreview: "finished work",
    startedAt: expect.any(String),
    endedAt: expect.any(String),
  });
  expectJson(await cli(["status", handle]), {
    label: "research:dji-mic",
    phase: "Research",
    startedAt: listed.startedAt,
    endedAt: listed.endedAt,
  });
  const before = (await cli(["sessions"])).json.length;
  for (const [flag, value, error] of [
    ["--label", "   ", "--label must not be empty"],
    [
      "--phase",
      "one\ntwo",
      "--phase must be one line without control characters",
    ],
    ["--label", "x".repeat(81), "--label must be at most 80 characters"],
  ])
    expectJson(
      await cli(["spawn", "task", "--model", "claude:opus", flag, value]),
      { error },
      1,
    );
  expect((await cli(["sessions"])).json).toHaveLength(before);
});

test("send updates done sessions; sessions, rm, and prune honor ownership", async () => {
  const handle = (await cli(["spawn", "finish task", "--model", "claude:opus"]))
    .json.handle;
  runnerOutput = JSON.stringify({
    session_id: "claude-session",
    result: "follow-up answer",
    usage: { input_tokens: 2, output_tokens: 4 },
  });
  const sent = await cli(["send", handle, "follow up", "--result-limit", "6"]);
  expectJson(sent, { handle, result: "follow", resultTruncated: true });
  expectJson(sent, {
    usage: { cachedInputTokens: null, cacheWriteTokens: null },
  });
  expect((await loadSession(handle)).lastResult).toBe("follow-up answer");
  const sessionOptions = {
    harness: "claude" as const,
    model: "opus",
    effort: "high",
    cwd: directory,
    prompt: "old",
    status: SESSION_STATUS.done,
  };
  const other = await createSession(sessionOptions);
  other.owner = OTHER_OWNER;
  await saveSession(other);
  expect(
    (await cli(["sessions"])).json.map(
      (session: { handle: string }) => session.handle,
    ),
  ).toEqual([handle]);
  expect((await cli(["sessions", "--all"])).json).toHaveLength(2);
  expect((await cli(["rm", handle])).json).toEqual({ removed: [handle] });
  const old = await createSession(sessionOptions);
  old.createdAt = "2000-01-01T00:00:00.000Z";
  await saveSession(old);
  expect((await cli(["prune", "--older-than", "1"])).json).toEqual({
    removed: [old.handle],
  });
});

test.each(["routed", "pinned", "fallback"])(
  "records %s spawn and resumed turn usage with an idle gap",
  async (kind) => {
    runnerOutput = kind === "fallback" ? CLAUDE_OUTPUT : CODEX_OUTPUT;
    if (kind === "fallback") routeResponse = "offline";
    const args = ["spawn", "finish task"];
    if (kind === "pinned") args.push("--model", "codex:terra");
    const spawned = await cli(args);
    expect(spawned.exitCode).toBe(0);
    const session = await loadSession(spawned.json.handle);
    expect(session.turns).toEqual([
      {
        kind: kind === "pinned" ? "pinned" : "routed",
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        idleSeconds: null,
        usage: session.usage ?? null,
      },
    ]);
    const previousTurn = session.turns?.[0];
    if (!previousTurn) throw new Error("spawn did not record a turn");
    previousTurn.endedAt = new Date(Date.now() - 10_000).toISOString();
    await saveSession(session);
    runnerOutput = JSON.stringify({
      type: "turn.completed",
      session_id: "claude-session",
      result: "follow up",
      usage: {
        input_tokens: kind === "fallback" ? 10 : 17,
        cached_input_tokens: 6,
        output_tokens: kind === "fallback" ? 2 : 11,
      },
    });
    const sent = await cli(["send", session.handle, "follow up"]);
    expect(sent.exitCode).toBe(0);
    const completed = await loadSession(session.handle);
    expect(completed.turns).toHaveLength(2);
    const resumed = completed.turns?.[1];
    expect(resumed).toMatchObject({
      kind: "resumed",
      endedAt: expect.any(String),
      usage: { inputTokens: 4, cachedInputTokens: 6, outputTokens: 2 },
    });
    expect(resumed?.idleSeconds).toBe(
      (Date.parse(resumed?.startedAt ?? "") -
        Date.parse(previousTurn.endedAt)) /
        1_000,
    );
    expect(resumed?.idleSeconds).toBeGreaterThanOrEqual(10);
    const firstInputTokens = kind === "fallback" ? 3 : 7;
    expect(completed.usage?.inputTokens).toBe(firstInputTokens + 4);
    expect(completed.turns?.[0].usage?.inputTokens).toBe(firstInputTokens);
    expect(runnerArguments).toHaveLength(2);
  },
);

// Captured from real spawn/resume runs: Codex totals are cumulative; Claude's are not.
const resumeUsageCases = [
  {
    harness: "codex",
    model: "codex:terra",
    events: [
      {
        type: "turn.completed",
        usage: {
          input_tokens: 23967,
          cached_input_tokens: 7168,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 54594,
          cached_input_tokens: 15232,
          cache_write_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    ],
    first: {
      inputTokens: 16799,
      cachedInputTokens: 7168,
      cacheWriteTokens: 0,
      outputTokens: 5,
      costUsd: null,
    },
    resumed: {
      inputTokens: 22563,
      cachedInputTokens: 8064,
      cacheWriteTokens: 0,
      outputTokens: 5,
      costUsd: null,
    },
    total: {
      inputTokens: 39362,
      cachedInputTokens: 15232,
      cacheWriteTokens: 0,
      outputTokens: 10,
      costUsd: null,
    },
  },
  {
    harness: "claude",
    model: "claude:opus",
    events: [
      {
        type: "result",
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 23618,
          cache_creation_input_tokens: 22829,
          output_tokens: 4,
        },
        total_cost_usd: 0.00494978,
      },
      {
        type: "result",
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 31810,
          cache_creation_input_tokens: 20616,
          output_tokens: 4,
        },
        total_cost_usd: 0.00939328,
      },
    ],
    first: {
      inputTokens: 2,
      cachedInputTokens: 23618,
      cacheWriteTokens: 22829,
      outputTokens: 4,
      costUsd: 0.00494978,
    },
    resumed: {
      inputTokens: 2,
      cachedInputTokens: 31810,
      cacheWriteTokens: 20616,
      outputTokens: 4,
      costUsd: 0.00939328,
    },
    total: {
      inputTokens: 4,
      cachedInputTokens: 55428,
      cacheWriteTokens: 43445,
      outputTokens: 8,
      costUsd: 0.00494978 + 0.00939328,
    },
  },
];

test.each(resumeUsageCases)(
  "accounts for real $harness resume usage in results, logs, and events",
  async (fixture) => {
    const outputs = fixture.events.map((event) =>
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "OK" },
        }),
        JSON.stringify({ ...event, session_id: "thread", result: "OK" }),
        "",
      ].join("\n"),
    );
    runnerOutput = outputs[0];
    const spawned = await cli([
      "spawn",
      "Reply with OK",
      "--model",
      fixture.model,
      "--detach",
    ]);
    await cli(["wait", spawned.json.handle]);
    const session = await loadSession(spawned.json.handle);
    expect(session.usage).toEqual(fixture.first);
    const sent = await cli(
      ["send", session.handle, "Reply with OK again", "--events"],
      {
        runForeground: async (_argv, _cwd, _env, _session, _exit, onLine) => {
          await writeFile(sessionLogPath(session.handle), outputs.join(""));
          for (const line of outputs[1].split("\n")) onLine?.(line);
          return outputs[1];
        },
      },
    );
    expect(sent.exitCode).toBe(0);
    const completed = await loadSession(session.handle);
    expect(completed.turnLogOffset).toBe(Buffer.byteLength(outputs[0]));
    expect(completed.turns?.map((turn) => turn.usage)).toEqual([
      fixture.first,
      fixture.resumed,
    ]);
    expect(completed.usage).toEqual(fixture.total);
    const events = sent.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === "usage")).toMatchObject(
      fixture.resumed,
    );
    expect(events.find((event) => event.type === "result").usage).toEqual(
      fixture.resumed,
    );
    const replay = await cli(["logs", session.handle, "--events"]);
    const replayEvents = replay.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      replayEvents.filter((event) => event.type === "usage"),
    ).toMatchObject([fixture.first, fixture.resumed]);
    expect(replayEvents.at(-1).usage).toEqual(fixture.resumed);
    const tailed = await cli([
      "logs",
      session.handle,
      "--events",
      "--tail",
      "1",
    ]);
    const tailEvents = tailed.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(tailEvents.find((event) => event.type === "usage")).toMatchObject(
      fixture.resumed,
    );

    for (const status of [SESSION_STATUS.running, SESSION_STATUS.failed]) {
      const recovering = structuredClone(completed);
      recovering.status = status;
      recovering.usage = fixture.first;
      const turn = recovering.turns?.at(-1);
      if (!turn) throw new Error("missing resumed turn");
      turn.endedAt = null;
      turn.usage = null;
      if (status === SESSION_STATUS.running) {
        await completeSessionFromLog(
          recovering,
          getAdapter(recovering.harness).parseSpawnOutput,
        );
        await completeSessionFromLog(
          recovering,
          getAdapter(recovering.harness).parseSpawnOutput,
        );
      } else {
        await saveSession(recovering);
        await saveSession(recovering);
      }
      expect(
        (await loadSession(recovering.handle)).turns?.at(-1)?.usage,
      ).toEqual(fixture.resumed);
      expect(recovering.usage).toEqual(fixture.total);
    }
  },
);

test("closes detached and failed turns without reusing previous log usage", async () => {
  const detached = await cli([
    "spawn",
    "task",
    "--model",
    "claude:opus",
    "--detach",
  ]);
  const pending = await loadSession(detached.json.handle);
  expect(pending.turns?.[0]).toMatchObject({
    kind: "pinned",
    endedAt: null,
    usage: null,
  });
  await cli(["status", pending.handle]);
  const completed = await loadSession(pending.handle);
  expect(completed.turns?.[0]).toMatchObject({
    endedAt: expect.any(String),
    usage: { inputTokens: 3, cachedInputTokens: 6 },
  });
  const failed = await cli(["send", pending.handle, "again"], {
    runForeground: async () => {
      throw new Error("could not launch");
    },
  });
  expect(failed.exitCode).toBe(1);
  const resumed = await loadSession(pending.handle);
  expect(resumed.turns?.[1]).toMatchObject({
    kind: "resumed",
    endedAt: expect.any(String),
    usage: null,
  });
  expect(resumed.usage).toEqual(completed.usage);
  await cli(["send", pending.handle, "again"], {
    runForeground: async (_argv, _cwd, _env, session) => {
      await writeFile(
        sessionLogPath(pending.handle),
        `${CLAUDE_OUTPUT}\n${JSON.stringify({ type: "result", is_error: true, usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 8 } })}\n`,
      );
      throw new Error("turn failed");
    },
  });
  expect((await loadSession(pending.handle)).turns?.[2]).toMatchObject({
    kind: "resumed",
    endedAt: expect.any(String),
    usage: { inputTokens: 4, cachedInputTokens: 8 },
  });
  const launchFailed = await cli(
    ["spawn", "task", "--model", "claude:opus", "--detach"],
    {
      runDetached: async () => {
        throw new Error("could not launch detached");
      },
    },
  );
  expect(launchFailed.exitCode).toBe(1);
  const failedSession = (await listSessions()).find(
    (session) => session.error === "could not launch detached",
  );
  expect(failedSession?.turns?.[0]).toMatchObject({
    kind: "pinned",
    endedAt: expect.any(String),
    usage: null,
  });
});

test("sessions --all writes complete JSON to a slow pipe reader", async () => {
  const sessionCount = 4_096;
  const pipeCapacityBytes = 128 * 1_024;
  const readerDelayMilliseconds = 1_000;
  const writes = await Promise.allSettled(
    Array.from({ length: sessionCount }, (_, index) =>
      createSession({
        handle: index.toString(16).padStart(6, "0"),
        harness: "claude",
        model: "opus",
        effort: "high",
        cwd: directory,
        prompt: "x".repeat(160),
        status: SESSION_STATUS.done,
      }),
    ),
  );
  expect(writes.every((write) => write.status === "fulfilled")).toBe(true);
  const child = Bun.spawn(
    [process.execPath, "src/cli.ts", "sessions", "--all"],
    {
      env: { ...process.env, SMART_ROUTER_STATE_DIR: join(directory, "state") },
      lazy: true,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await Bun.sleep(readerDelayMilliseconds);
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(stdout)).toHaveLength(sessionCount);
  expect(Buffer.byteLength(stdout)).toBeGreaterThan(pipeCapacityBytes);
}, 30_000);

test("quota and update return JSON with success and refusal codes", async () => {
  const quota = await cli(["quota"]);
  expectJson(quota, { claude: { weeklyUsedPercent: 12, pace: "ok" } });
  quotaEnabled = false;
  expectJson(await cli(["quota"]), { error: "quota disabled" }, 1);
  const checked = await cli(["update", "--check"]);
  expectJson(checked, {
    current: version,
    latest: RELEASE_VERSION,
    updated: false,
  });
  const refused = await cli(["update"]);
  expectJson(
    refused,
    { error: "installed by Homebrew; run brew upgrade smart-router" },
    1,
  );
  const executablePath = join(directory, "smart-router");
  const binary = "updated binary";
  const checksum = createHash("sha256").update(binary).digest("hex");
  const updated = await cli(["update"], {
    execPath: executablePath,
    fetch: async (url) => {
      if (url.endsWith(".sha256")) return new Response(checksum);
      if (url.endsWith("/asset")) return new Response(binary);
      return new Response(
        JSON.stringify({
          tag_name: `v${RELEASE_VERSION}`,
          assets: [
            {
              name: RELEASE_ASSET,
              browser_download_url: "https://example.invalid/asset",
            },
          ],
        }),
      );
    },
  });
  expectJson(updated, { updated: true, latest: RELEASE_VERSION });
  expect(await readFile(executablePath, "utf8")).toBe(binary);
});

test.each([{ args: ["update"] }, { args: ["update", "--check"] }])(
  "explicit $args refreshes a cached release",
  async ({ args }) => {
    const cachePath = join(directory, "state", "update.json");
    await mkdir(join(directory, "state"), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        latestVersion: "0.8.16",
        isNewer: false,
        assetUrl: "old",
        checksumUrl: "old.sha256",
      }),
    );
    let requests = 0;
    const checked = await cli([...args], {
      fetch: async () => {
        requests++;
        return new Response(
          JSON.stringify({
            tag_name: "v0.8.17",
            assets: [{ name: RELEASE_ASSET, browser_download_url: "new" }],
          }),
        );
      },
    });
    expectJson(checked, { latest: "0.8.17", updated: false });
    expect(requests).toBe(1);
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({
      latestVersion: "0.8.17",
      isNewer: false,
      assetUrl: "new",
    });
  },
);

test("spawn prints update and model notices when checks are enabled", async () => {
  config.updates = { check: true };
  await saveConfig(config);
  delete process.env.SMART_ROUTER_NO_UPDATE_CHECK;
  runnerOutput = CODEX_OUTPUT;
  const spawned = await cli(["spawn", "task"], {
    routeDeps: (loaded) => ({
      ...routeDeps(loaded),
      doctor: async () => ({ ...detection, availableModels: ["codex:new"] }),
    }),
  });
  expect(spawned.stderr).toContain(
    `smart-router ${RELEASE_VERSION} is available`,
  );
  expect(spawned.stderr).toContain("New models available: codex:new");
});

test("update check reports a failed release request", async () => {
  expectJson(
    await cli(["update", "--check"], {
      fetch: async () => new Response(null, { status: 503 }),
    }),
    { error: "Could not check for updates" },
    1,
  );
});

test("--version exits 0 without an error payload", async () => {
  const result = await cli(["--version"]);
  expect(result.exitCode).toBe(0);
  expect(result.json).toBeUndefined();
});

const RESUME_PREFIX = ["codex", "exec", "resume", "codex-thread"];

async function runningCodexSession(pid: number) {
  const logPath = join(directory, "codex.log");
  await writeFile(logPath, CODEX_OUTPUT.split("\n")[0]);
  // prettier-ignore
  return createSession({ harness: "codex", model: "terra", effort: "high", cwd: directory, prompt: "count", status: SESSION_STATUS.running, pid, logPath });
}

test("steer on codex always interrupts: stops the session, then resumes it with send", async () => {
  const child = Bun.spawn(["sleep", "30"]);
  const { handle } = await runningCodexSession(child.pid);
  runnerOutput = CODEX_OUTPUT;
  // prettier-ignore
  expectJson(await cli(["steer", handle, "go"]), { handle, result: "codex done" });
  expect(await child.exited).not.toBe(0);
  expect((await loadSession(handle)).status).toBe("done");
  expect(runnerArguments[0].slice(0, 4)).toEqual(RESUME_PREFIX);
  expect(runnerArguments[0].at(-1)).toBe("go");
});

test("send resumes a stopped codex session", async () => {
  // prettier-ignore
  const { handle } = await createSession({ harness: "codex", model: "terra", effort: "high", cwd: directory, sessionId: "codex-thread", prompt: "count", status: SESSION_STATUS.stopped });
  runnerOutput = CODEX_OUTPUT;
  expectJson(await cli(["send", handle, "go"]), { result: "codex done" });
  expect(runnerArguments[0].slice(0, 4)).toEqual(RESUME_PREFIX);
});

test("steer refuses finished, stopped, unsupervised, legacy foreground, and threadless sessions", async () => {
  // prettier-ignore
  const options = { harness: "claude" as const, model: "opus", effort: "high", cwd: directory, prompt: "task", status: SESSION_STATUS.running };
  const emptyLogPath = join(directory, "empty.log");
  await writeFile(emptyLogPath, "");
  // prettier-ignore
  const refusals: [{ handle: string }, string][] = [
    [await createSession(options), "cannot be steered"],
    [await createSession({ ...options, status: SESSION_STATUS.done, pid: process.pid }), "is not running; use send"],
    [await createSession({ ...options, status: SESSION_STATUS.stopped, wrapperPid: process.pid }), "is not running; use send"],
    [await createSession({ ...options, pid: process.pid }), "cannot be steered"],
    [await createSession({ ...options, harness: "codex", pid: process.pid, wrapperPid: process.pid }), "has no steering socket"],
    [await createSession({ ...options, harness: "codex", pid: process.pid, logPath: emptyLogPath }), "has not started a codex thread"],
  ];
  for (const [{ handle }, error] of refusals)
    // prettier-ignore
    expectJson(await cli(["steer", handle, "go"]), { error: expect.stringContaining(`session ${handle} ${error}`) }, 1);
});

test.each([false, true])(
  "foreground steer preserves the caller's result (interrupt=%s)",
  async (interrupt) => {
    for (const harness of ["claude", "codex"] as const) {
      const fakeHarness = join(directory, `fake-${harness}`);
      const receivedPath = join(directory, `${harness}-received.jsonl`);
      await writeFile(
        fakeHarness,
        `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const emit = (event) => console.log(JSON.stringify(event));
if (${JSON.stringify(harness)} === "codex") {
  emit({type:"thread.started", thread_id:"codex-thread"});
  if (!process.argv.includes("resume")) await new Promise(() => setInterval(() => {}, 1000));
  emit({type:"item.completed", item:{type:"agent_message", text:process.argv.at(-1)}});
  emit({type:"turn.completed", usage:{input_tokens:7, output_tokens:9}});
} else for await (const line of console) {
  if (!line) continue;
  const event = JSON.parse(line);
  await appendFile(${JSON.stringify(receivedPath)}, line + "\\n");
  if (event.type === "control_request") continue;
  emit({type:"user", message:event.message, isReplay:true});
  if (event.message.content.startsWith("wait")) continue;
  emit({type:"result", result:event.message.content, session_id:"claude-session"});
}
`,
      );
      await chmod(fakeHarness, 0o755);
      config.harnesses[harness] = { enabled: true, binary: fakeHarness };
      await saveConfig(config);
      let handle = "";
      const spawning = cli(
        [
          "spawn",
          "wait",
          "--model",
          `${harness}:${harness === "claude" ? "opus" : "terra"}`,
          "--no-guardrails",
        ],
        {
          runForeground: async (argv, cwd, env, session, exit, onLine) => {
            if (!session) throw new Error("missing session");
            handle = session.handle;
            foregroundChildren.add(session);
            const actualArgv = argv.includes("__supervise")
              ? [
                  argv[0],
                  join(import.meta.dir, "../src/cli.ts"),
                  ...argv.slice(2),
                ]
              : argv;
            return runForeground(actualArgv, cwd, env, session, exit, onLine);
          },
        },
      );
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const log = handle
          ? await readFile(sessionLogPath(handle), "utf8").catch(() => "")
          : "";
        if (log.includes(harness === "codex" ? "thread.started" : "isReplay"))
          break;
        await Bun.sleep(10);
      }
      expect(handle).not.toBe("");
      expectJson(
        await cli(["send", handle, "refused"]),
        { error: expect.stringContaining("is still running") },
        1,
      );
      expectJson(
        await cli([
          "steer",
          handle,
          "redirected",
          ...(interrupt ? ["--interrupt"] : []),
        ]),
        {
          handle,
          steered: true,
          interrupted: harness === "codex" || interrupt,
        },
      );
      const result = await spawning;
      expectJson(result, {
        handle,
        harness,
        result: "redirected",
        resumeCommand: expect.any(String),
      });
      expect((await loadSession(handle)).status).toBe("done");
      expect(await Bun.file(sessionSocketPath(handle)).exists()).toBe(false);
      if (harness === "claude") {
        const received = (await readFile(receivedPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(received.map((event) => event.type)).toEqual(
          interrupt ? ["user", "control_request", "user"] : ["user", "user"],
        );
        const log = await readFile(sessionLogPath(handle), "utf8");
        expect(log.match(/"isReplay":true/g)).toHaveLength(2);
      }
    }
  },
);

test("detached claude spawns run under the supervisor", async () => {
  let detachedArgv: string[] = [];
  // prettier-ignore
  const { json } = await cli(["spawn", "count", "--model", "claude:opus", "--detach", "--no-guardrails"], {
    runDetached: async (argv, _cwd, logPath) => {
      detachedArgv = argv;
      return { pid: DETACHED_PID, errPath: logPath.replace(/\.log$/, ".err") };
    },
  });
  expect(detachedArgv.slice(2, 6)).toEqual([
    "__supervise",
    "--",
    json.handle,
    expect.stringContaining("count\n\nWork that must outlive"),
  ]);
  expect(detachedArgv).toContain("--input-format");
  expect((await loadSession(json.handle)).supervisorPid).toBe(DETACHED_PID);
});

const eventTypes = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).type);
const orderedEvents =
  "session.started tool.started tool.finished message usage result".split(" ");
const eventFixture = (harness: string) =>
  Bun.file(`${import.meta.dir}/fixtures/events/${harness}.jsonl`).text();
test("spawn --events streams ordered events and one terminal event", async () => {
  const raw = await eventFixture("claude");
  const result = await cli(
    ["spawn", "list then done", "--model", "claude:opus", "--events"],
    {
      runForeground: async (_argv, _cwd, _env, _session, _exit, onLine) => {
        for (const line of raw.trim().split("\n")) onLine?.(line);
        return raw;
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Routed to claude:opus");
  expect(eventTypes(result.stdout)).toEqual(orderedEvents);
});
test("logs --follow --events waits for an appended log and completion", async () => {
  const session = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: directory,
    prompt: "work",
    status: "running",
  });
  const raw = await eventFixture("codex");
  const following = cli(["logs", session.handle, "--follow", "--events"]);
  await Bun.sleep(150);
  await writeFile(
    sessionLogPath(session.handle),
    raw.split("\n").slice(0, 3).join("\n") + "\n",
  );
  await Bun.sleep(150);
  await writeFile(sessionLogPath(session.handle), raw);
  session.status = "done";
  session.result = "done";
  await saveSession(session);
  const result = await following;
  expect(result.exitCode).toBe(0);
  expect(eventTypes(result.stdout)).toEqual(orderedEvents);
});

test.each([SESSION_STATUS.failed, SESSION_STATUS.stopped])(
  "logs --events reports a %s session with one terminal error",
  async (status) => {
    const session = await createSession({
      harness: "codex",
      model: "terra",
      effort: "high",
      cwd: directory,
      prompt: "task",
      status,
      lastAction: "bun test",
    });
    await writeFile(sessionLogPath(session.handle), "");
    const result = await cli(["logs", session.handle, "--events"]);
    expect(result.exitCode).toBe(1);
    expect(eventTypes(result.stdout)).toEqual(["error"]);
    expect(result.json).toMatchObject({
      message: status,
      lastAction: "bun test",
    });
  },
);

test("CLI rejects invalid numeric flags and reports log and state errors", async () => {
  const spawned = await cli(["spawn", "task", "--model", "claude:opus"]);
  const handle = spawned.json.handle;
  const invalidCommands = [
    {
      args: ["wait", handle, "--result-limit", "-1"],
      flag: "--result-limit",
      kind: "integer",
    },
    {
      args: ["wait", handle, "--timeout", "NaN"],
      flag: "--timeout",
      kind: "number",
    },
    {
      args: ["logs", handle, "--tail", "0.5"],
      flag: "--tail",
      kind: "integer",
    },
  ];
  for (const { args, flag, kind } of invalidCommands)
    expectJson(
      await cli(args),
      { error: `${flag} must be a non-negative ${kind}` },
      1,
    );
  expectJson(
    await cli(["prune"]),
    { error: "--older-than <days> is required" },
    1,
  );
  await rm(sessionLogPath(handle), { force: true });
  expectJson(
    await cli(["logs", handle]),
    { error: expect.stringContaining("ENOENT") },
    1,
  );
  await rm(join(directory, "state"), { recursive: true });
  await writeFile(join(directory, "state"), "not a directory");
  expectJson(
    await cli(["sessions"]),
    { error: expect.stringContaining("ENOTDIR") },
    1,
  );
});

test("dashboard prints a compact startup record and stops on SIGINT", async () => {
  const result = await cli(["dashboard", "--port", "0"]);
  expect(result.exitCode).toBeUndefined();
  expect(result.stdout.split("\n")).toHaveLength(2);
  expect(result.json).toMatchObject({ owner: OWNER });
  expect(result.json.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  try {
    expect((await fetch(result.json.url)).status).toBe(200);
  } finally {
    process.emit("SIGINT");
  }
});

test("dashboard reuses an occupied dashboard port without stopping its server", async () => {
  const server = startDashboard({ port: 0 });
  try {
    const result = await cli(["dashboard", "--port", String(server.port)]);
    expect(result.json).toEqual({
      url: server.url.origin,
      owner: OWNER,
      reused: true,
    });
    expect(result.exitCode).toBeUndefined();
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "dashboard",
        "--port",
        String(server.port),
      ],
      { env: process.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      url: server.url.origin,
      owner: OWNER,
      reused: true,
    });
    expect((await fetch(server.url)).status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test.each([JSON.stringify({ service: "other" }), "not JSON"])(
  "dashboard rejects a port occupied by another service returning %s",
  async (body) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(body),
    });
    try {
      const result = await cli(["dashboard", "--port", String(server.port)]);
      expect(result.exitCode).toBe(1);
      expect(result.json.error).toContain("port");
      expect(result.json.reused).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  },
);

test.each(["invalid", "65536"])(
  "dashboard rejects invalid port %s",
  async (port) => {
    expect((await cli(["dashboard", "--port", port])).exitCode).toBe(1);
  },
);

test("confined MCP filtering is private, turn-scoped, and persists with deny union on send", async () => {
  const first = join(directory, "first.json");
  const second = join(directory, "second.json");
  await writeFile(
    first,
    JSON.stringify({ mcpServers: { other: { command: "other" } } }),
  );
  await writeFile(
    second,
    JSON.stringify({
      mcpServers: {
        openclaw: { type: "http", url: "http://127.0.0.1:9999/mcp" },
        other: { command: "other" },
      },
    }),
  );
  const filtered: string[] = [];
  const inspect: Partial<CliDeps> = {
    runForeground: async (argv) => {
      runnerArguments.push(argv);
      const path = argv[argv.indexOf("--mcp-config") + 1]!;
      filtered.push(path);
      expect(path.startsWith(join(directory, "state", "sessions"))).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await listSessions()).toHaveLength(1);
      expect(
        Object.keys(JSON.parse(await readFile(path, "utf8")).mcpServers),
      ).toEqual(["openclaw"]);
      return CLAUDE_OUTPUT;
    },
  };
  const spawned = await cli(
    [
      "spawn",
      "task",
      "--confined",
      "--model",
      "claude:opus",
      "--browser",
      "--mcp-config",
      first,
      "--mcp-config",
      second,
      "--disallowedTools",
      "WebSearch,mcp__openclaw__pay",
      "--disallowedTools",
      "WebSearch",
    ],
    inspect,
  );
  expect(spawned.exitCode).toBe(0);
  const handle = spawned.json.handle;
  expect(await loadSession(handle)).toMatchObject({
    confined: true,
    disallowedTools: ["WebSearch", "mcp__openclaw__pay"],
  });
  expect(
    (
      await cli(
        [
          "send",
          handle,
          "again",
          "--disallowedTools",
          "mcp__openclaw__send,WebSearch",
        ],
        inspect,
      )
    ).exitCode,
  ).toBe(0);
  expect((await cli(["send", handle, "again"], inspect)).exitCode).toBe(0);
  expect(await loadSession(handle)).toMatchObject({
    confined: true,
    disallowedTools: ["WebSearch", "mcp__openclaw__pay", "mcp__openclaw__send"],
  });
  expect(runnerArguments.at(-1)).toContain(
    "WebSearch,mcp__openclaw__pay,mcp__openclaw__send",
  );
  for (const argv of runnerArguments) {
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).not.toContain("--chrome");
  }
  for (const path of filtered)
    expect(await Bun.file(path).exists()).toBe(false);
});

test("tool restrictions filter routing before Jev and reject pinned Codex", async () => {
  for (const flags of [
    ["--confined"],
    ["--disallowedTools", "WebSearch"],
    ["--tools", "Read"],
  ]) {
    const result = await cli(["spawn", "task", ...flags], {
      routeDeps: (configuration) => ({
        ...routeDeps(configuration),
        client: {
          systemOne: async ({ state }) => {
            expect(state.candidates.map(({ harness }) => harness)).toEqual([
              "claude",
            ]);
            throw new Error("use eligible fallback");
          },
        },
      }),
    });
    expectJson(result, { harness: "claude" });
    expect(
      (await cli(["spawn", "task", "--model", "codex:terra", ...flags]))
        .exitCode,
    ).toBe(1);
  }
  config.harnesses.claude!.enabled = false;
  await saveConfig(config);
  expectJson(
    await cli(["spawn", "task", "--confined"]),
    {
      error: "confined mode needs Claude or verified Codex; none is available",
    },
    1,
  );
});

test("native tools cannot widen confined sessions; comma parsing preserves patterns with spaces", async () => {
  expectJson(
    await cli(["spawn", "task", "--confined", "--tools", "Read"]),
    { error: "native tools are disabled in confined mode" },
    1,
  );
  const result = await cli([
    "spawn",
    "task",
    "--model",
    "claude:opus",
    "--allowed-tools",
    "Read",
    "--allowedTools",
    "Bash(git commit:*), Read",
    "--tools",
    "Read",
    "--tools",
    "Edit,Read",
    "--disallowedTools",
    " Bash(git push:*),WebSearch ",
  ]);
  expect(result.exitCode).toBe(0);
  expect(runnerArguments[0]).toContain("Read,Bash(git commit:*)");
  expect(runnerArguments[0]).toContain("Read,Edit");
  expect(runnerArguments[0]).toContain("Bash(git push:*),WebSearch");
  const confined = await cli([
    "spawn",
    "task",
    "--model",
    "claude:opus",
    "--confined",
    "--tools",
    "",
  ]);
  expect(confined.exitCode).toBe(0);
  expect(confined.stderr).toContain("no openclaw MCP server");
  expectJson(
    await cli(["send", confined.json.handle, "again", "--tools", "Bash"]),
    { error: "native tools are disabled in confined mode" },
    1,
  );
});

test("system prompt files reach Claude and Codex without entering Jev state", async () => {
  const path = join(directory, "system.txt");
  await writeFile(path, "private system instructions");
  const spawned = await cli([
    "spawn",
    "task",
    "--model",
    "claude:opus",
    "--append-system-prompt-file",
    path,
  ]);
  expect(spawned.exitCode).toBe(0);
  expect(runnerArguments[0]).toContain("--append-system-prompt-file");
  expect(
    (
      await cli([
        "send",
        spawned.json.handle,
        "again",
        "--append-system-prompt-file",
        path,
      ])
    ).exitCode,
  ).toBe(0);
  expect(runnerArguments.at(-1)).toContain(path);
  runnerOutput = CODEX_OUTPUT;
  expect(
    (
      await cli([
        "spawn",
        "task",
        "--model",
        "codex:terra",
        "--append-system-prompt-file",
        path,
      ])
    ).exitCode,
  ).toBe(0);
  expect(runnerArguments.at(-1)).toContain(
    `model_instructions_file=${JSON.stringify(path)}`,
  );
});

test("verified confined Codex remains confined on send without the flag", async () => {
  runnerOutput = CODEX_OUTPUT;
  const verified = {
    verifyConfinedCodex: () => [
      "features.shell_tool=false",
      'sandbox_mode="read-only"',
      'approval_policy="never"',
    ],
  };
  const spawned = await cli(
    [
      "spawn",
      "task",
      "--confined",
      "--model",
      "codex:terra",
      "--disallowedTools",
      "WebSearch",
    ],
    verified,
  );
  expect(spawned.exitCode).toBe(0);
  expect(await loadSession(spawned.json.handle)).toMatchObject({
    confined: true,
    disallowedTools: ["WebSearch"],
  });
  expect(
    (await cli(["send", spawned.json.handle, "again"], verified)).exitCode,
  ).toBe(0);
  for (const argv of runnerArguments) {
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain('sandbox_mode="read-only"');
    expect(argv).toContain("features.shell_tool=false");
  }
  runnerOutput = CLAUDE_OUTPUT;
  const routed = await cli(["spawn", "task", "--confined"], {
    ...verified,
    routeDeps: (configuration) => ({
      ...routeDeps(configuration),
      client: {
        systemOne: async ({ state }) => {
          expect(state.candidates.map(({ harness }) => harness)).toEqual([
            "claude",
            "codex",
          ]);
          throw new Error("fallback");
        },
      },
    }),
  });
  expect(routed.json.harness).toBe("claude");
  expect((await cli(["send", spawned.json.handle, "again"])).exitCode).toBe(1);
});

test("stored denials cannot be dropped on unconfined resumes or unsupported harnesses", async () => {
  const spawned = await cli([
    "spawn",
    "task",
    "--model",
    "claude:opus",
    "--disallowedTools",
    "WebSearch",
  ]);
  expect(spawned.exitCode).toBe(0);
  const resumed = await cli([
    "send",
    spawned.json.handle,
    "again",
    "--disallowedTools",
    "Bash(git push:*)",
  ]);
  expect(resumed.exitCode).toBe(0);
  expect((await cli(["send", spawned.json.handle, "again"])).exitCode).toBe(0);
  expect(runnerArguments.at(-1)).toContain("WebSearch,Bash(git push:*)");
  const unsupported = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: directory,
    prompt: "task",
    sessionId: "thread",
    status: SESSION_STATUS.done,
    disallowedTools: ["WebSearch"],
  });
  expect((await cli(["send", unsupported.handle, "again"])).exitCode).toBe(1);
});

test("routing never receives system prompt contents", async () => {
  const path = join(directory, "private-system.txt");
  await writeFile(path, "private system instructions");
  const result = await cli(
    ["spawn", "public task", "--append-system-prompt-file", path],
    {
      routeDeps: (configuration) => ({
        ...routeDeps(configuration),
        client: {
          systemOne: async ({ state }) => {
            expect(JSON.stringify(state)).not.toContain(
              "private system instructions",
            );
            expect(state.task).toBe("public task");
            throw new Error("fallback");
          },
        },
      }),
    },
  );
  expect(result.exitCode).toBe(0);
  expect(runnerArguments.at(-1)).toContain(path);
});

test("Jev can select verified Codex from the confined candidate set", async () => {
  runnerOutput = CODEX_OUTPUT;
  const result = await cli(["spawn", "task", "--confined"], {
    verifyConfinedCodex: () => [
      "features.shell_tool=false",
      'sandbox_mode="read-only"',
      'approval_policy="never"',
    ],
    routeDeps: (configuration) => {
      const deps = routeDeps(configuration);
      return {
        ...deps,
        client: {
          systemOne: async (request) => {
            expect(request.state.candidates.map(({ id }) => id)).toContain(
              "codex:terra",
            );
            return deps.client.systemOne(request);
          },
        },
      };
    },
  });
  expectJson(result, {
    harness: "codex",
    route: {
      pick: "codex:terra@high",
      candidates: ["claude:opus", "codex:terra"],
    },
  });
});

test("Codex tripwire names the failed override, warns to upgrade, and records the route exclusion", async () => {
  const failed = {
    verifyConfinedCodex: () => {
      throw new Error("features.shell_tool=false was not resolved");
    },
  };
  const routed = await cli(["spawn", "task", "--confined"], failed);
  expectJson(routed, { harness: "claude" });
  expect(routed.stderr).toContain("WARNING");
  expect(routed.stderr).toContain("features.shell_tool=false");
  expect(routed.stderr).toContain("upgrade codex");
  expect(routed.json.route.reason).toContain("features.shell_tool=false");
  expect(routed.json.route.reason).toContain("upgrade codex");
  for (const model of ["codex:terra", "codex:auto"]) {
    const pinned = await cli(
      ["spawn", "task", "--confined", "--model", model],
      failed,
    );
    expectJson(
      pinned,
      { error: "features.shell_tool=false was not resolved; upgrade codex" },
      1,
    );
  }
});

test("confined allowlists persist and intersect on unflagged resumes for Claude and Codex", async () => {
  const bridge = join(directory, "loopback.json");
  await writeFile(
    bridge,
    JSON.stringify({
      mcpServers: {
        openclaw: { type: "http", url: "http://127.0.0.1:9999/mcp" },
      },
    }),
  );
  const verified = {
    verifyConfinedCodex: () => [
      "features.shell_tool=false",
      'sandbox_mode="read-only"',
      'approval_policy="never"',
    ],
  };
  for (const harness of ["claude", "codex"] as const) {
    runnerOutput = harness === "claude" ? CLAUDE_OUTPUT : CODEX_OUTPUT;
    const spawned = await cli(
      [
        "spawn",
        "task",
        "--confined",
        "--model",
        harness === "claude" ? "claude:opus" : "codex:terra",
        "--mcp-config",
        bridge,
        "--allowedTools",
        "mcp__openclaw__safe_ping",
      ],
      verified,
    );
    expect(spawned.exitCode).toBe(0);
    const handle = spawned.json.handle;
    expect((await loadSession(handle)).allowedTools).toBe(
      "mcp__openclaw__safe_ping",
    );
    for (const flags of [
      [],
      ["--allowedTools", "mcp__openclaw__*"],
      ["--allowedTools", "mcp__openclaw__safe_ping mcp__openclaw__pay"],
    ]) {
      expect(
        (await cli(["send", handle, "again", ...flags], verified)).exitCode,
      ).toBe(0);
      const argv = runnerArguments.at(-1)!;
      expect(argv).toContain(
        harness === "claude"
          ? "mcp__openclaw__safe_ping"
          : 'mcp_servers.openclaw.enabled_tools=["safe_ping"]',
      );
    }
    expect(
      (
        await cli(
          ["send", handle, "none", "--allowedTools", "mcp__openclaw__pay"],
          verified,
        )
      ).exitCode,
    ).toBe(0);
    expect((await loadSession(handle)).allowedTools).toBe("");
    expect((await cli(["send", handle, "stay empty"], verified)).exitCode).toBe(
      0,
    );
    expect((await loadSession(handle)).allowedTools).toBe("");
  }
});

test("foreground confined Codex steer rebuilds resume while retaining the filtered MCP file", async () => {
  const fake = join(directory, "confined-codex"),
    bridge = join(directory, "loopback.json"),
    received = join(directory, "resume-argv.json");
  await writeFile(
    bridge,
    JSON.stringify({
      mcpServers: {
        openclaw: { type: "http", url: "http://127.0.0.1:9999/mcp" },
      },
    }),
  );
  await writeFile(
    fake,
    `#!/usr/bin/env bun
import {writeFileSync} from "node:fs";
const emit=e=>console.log(JSON.stringify(e));emit({type:"thread.started",thread_id:"confined-thread"});
if(!process.argv.includes("resume"))await new Promise(()=>setInterval(()=>{},1000));
writeFileSync(${JSON.stringify(received)},JSON.stringify(process.argv));
emit({type:"item.completed",item:{type:"agent_message",text:"redirected"}});emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}});
`,
  );
  await chmod(fake, 0o755);
  config.harnesses.codex = { enabled: true, binary: fake };
  await saveConfig(config);
  let handle = "",
    filtered = "";
  const spawning = cli(
    [
      "spawn",
      "wait",
      "--confined",
      "--model",
      "codex:terra",
      "--mcp-config",
      bridge,
      "--allowedTools",
      "mcp__openclaw__safe_ping",
      "--no-guardrails",
    ],
    {
      verifyConfinedCodex: () => [
        "features.shell_tool=false",
        'sandbox_mode="read-only"',
        'approval_policy="never"',
      ],
      runForeground: async (argv, cwd, env, session, exit, onLine) => {
        if (!session) throw new Error("missing session");
        handle = session.handle;
        filtered = join(directory, "state/sessions", handle + ".mcp");
        foregroundChildren.add(session);
        return runForeground(argv, cwd, env, session, exit, onLine);
      },
    },
  );
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (
      handle &&
      (await readFile(sessionLogPath(handle), "utf8").catch(() => "")).includes(
        "thread.started",
      )
    )
      break;
    await Bun.sleep(10);
  }
  try {
    expect(await Bun.file(filtered).exists()).toBe(true);
    expectJson(await cli(["steer", handle, "redirected"]), { steered: true });
    expectJson(await spawning, { result: "redirected" });
    const argv = JSON.parse(await readFile(received, "utf8"));
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain('sandbox_mode="read-only"');
    expect(argv).toContain('mcp_servers.openclaw.enabled_tools=["safe_ping"]');
    expect(await Bun.file(filtered).exists()).toBe(false);
  } finally {
    if (handle) await terminateSessionProcess(await loadSession(handle));
    await spawning;
  }
});

test("confined resumes reject legacy missing allowlists and intersect the latest locked policy", async () => {
  const legacy = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: SESSION_STATUS.done,
    sessionId: "old",
    confined: true,
  });
  expectJson(
    await cli(["send", legacy.handle, "again"]),
    { error: "confined session has no stored allowlist; start a new session" },
    1,
  );
  const current = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: SESSION_STATUS.done,
    sessionId: "current",
    confined: true,
    allowedTools: "mcp__openclaw__*",
  });
  const result = await cli(
    ["send", current.handle, "again", "--allowedTools", "mcp__openclaw__*"],
    {
      now: () => {
        writeFileSync(
          sessionPath(current.handle),
          JSON.stringify({
            ...current,
            allowedTools: "mcp__openclaw__safe_ping",
          }),
        );
        return Date.now();
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(runnerArguments.at(-1)).toContain("mcp__openclaw__safe_ping");
  expect((await loadSession(current.handle)).allowedTools).toBe(
    "mcp__openclaw__safe_ping",
  );
});

test("OpenClaw variadic denials retain the automatic routed model and confined resume", async () => {
  runnerOutput = CODEX_OUTPUT;
  const verified = {
    verifyConfinedCodex: () => [
      'sandbox_mode="read-only"',
      'approval_policy="never"',
    ],
  };
  const bridge = join(directory, "bridge.json");
  await writeFile(
    bridge,
    JSON.stringify({
      mcpServers: {
        openclaw: { type: "http", url: "http://127.0.0.1:9999/mcp" },
      },
    }),
  );
  const spawned = await cli(
    [
      "spawn",
      "task",
      "--confined",
      "--mcp-config",
      bridge,
      "--disallowedTools",
      "WebSearch",
      "mcp__openclaw__pay",
      "mcp__openclaw__send",
    ],
    verified,
  );
  expectJson(spawned, {
    harness: "codex",
    model: "terra",
    route: { pick: "codex:terra@high" },
  });
  expect((await loadSession(spawned.json.handle)).disallowedTools).toEqual([
    "WebSearch",
    "mcp__openclaw__pay",
    "mcp__openclaw__send",
  ]);
  expect(
    (
      await cli(
        [
          "send",
          spawned.json.handle,
          "again",
          "--disallowedTools",
          "mcp__openclaw__delete",
          "WebFetch",
        ],
        verified,
      )
    ).exitCode,
  ).toBe(0);
  for (const argv of runnerArguments) {
    expect(argv[argv.indexOf("-m") + 1]).toBe("terra");
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toContain('sandbox_mode="read-only"');
  }
  expect(runnerArguments[0]).toContain(
    'mcp_servers.openclaw.disabled_tools=["pay","send"]',
  );
  expect(runnerArguments[1]).toContain(
    'mcp_servers.openclaw.disabled_tools=["pay","send","delete"]',
  );
});

test("wake CLI survives watcher crash, sends through resume once, and supports cancel", async () => {
  const fake = join(directory, "wake-codex"),
    received = join(directory, "received-wakes");
  await writeFile(
    fake,
    `#!/usr/bin/env bun
import {appendFileSync} from "node:fs";
appendFileSync(${JSON.stringify(received)}, process.env.SMART_ROUTER_HANDLE + "\\n");
console.log(${JSON.stringify(CODEX_OUTPUT)});
`,
  );
  await chmod(fake, 0o755);
  config.harnesses.codex = { enabled: true, binary: fake };
  await saveConfig(config);
  const session = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: "done",
    sessionId: "codex-thread",
  });
  const job = Bun.spawn(["sleep", "30"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const invoke = (args: string[]) =>
    Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
      { env: process.env },
    );
  let watcherPid: number | undefined;
  try {
    const armed = invoke([
      "wake",
      session.handle,
      "--after-pid",
      String(job.pid),
    ]);
    expect(armed.exitCode).toBe(0);
    const value = JSON.parse(armed.stdout.toString());
    watcherPid = value.watcherPid;
    process.kill(watcherPid!, "SIGKILL");
    await Bun.sleep(100);
    await cli(["status", session.handle]);
    const recovered = (await loadSession(session.handle)).wakes![0];
    watcherPid = recovered.watcherPid;
    expect(watcherPid).not.toBe(value.watcherPid);
    job.kill();
    await job.exited;
    const waited = await cli(["wait", session.handle, "--timeout", "8"]);
    expect(waited.exitCode).toBe(0);
    expect((await loadSession(session.handle)).wakes![0].state).toBe("sent");
    expect(await readFile(received, "utf8")).toBe(`${session.handle}\n`);
    await cli(["status", session.handle]);
    expect(await readFile(received, "utf8")).toBe(`${session.handle}\n`);
    expect(
      (await cli(["wake", session.handle, "--cancel", value.id])).exitCode,
    ).toBe(0);
    const cancelled = invoke([
      "wake",
      session.handle,
      "--after-pid",
      String(process.pid),
      "--message",
      "custom",
    ]);
    expect(cancelled.exitCode).toBe(0);
    const pending = JSON.parse(cancelled.stdout.toString());
    watcherPid = pending.watcherPid;
    expect(
      (await cli(["wait", session.handle, "--timeout", "0"])).exitCode,
    ).toBe(124);
    await cli(["wake", session.handle, "--cancel"]);
    expect(
      (await cli(["wait", session.handle, session.handle])).json,
    ).toHaveLength(2);
    for (const args of [
      ["--after-pid", "-1"],
      ["--after-pid", "999999"],
      [],
      ["--cancel", "--after-pid", "1"],
      ["--cancel", "missing"],
    ])
      expect((await cli(["wake", session.handle, ...args])).exitCode).toBe(1);
  } finally {
    job.kill();
    await job.exited;
    if (watcherPid) {
      try {
        process.kill(watcherPid, "SIGTERM");
      } catch {}
    }
  }
}, 15000);

test("internal wake delivers with capacity reservation and handle environment, failing safely after claim", async () => {
  for (const fail of [false, true]) {
    const session = await createSession({
      harness: "codex",
      model: "terra",
      effort: "high",
      cwd: directory,
      prompt: "task",
      status: "done",
      sessionId: "codex-thread",
    });
    session.wakes = [
      {
        id: "internal",
        pid: 999999,
        startTime: "gone",
        command: "job",
        armedAt: new Date().toISOString(),
        watcherPid: process.pid,
        watcherStartTime: processStartTime(process.pid),
        state: "pending",
      },
    ];
    await saveSession(session, "claim");
    const result = await cli(["__wake", session.handle, "internal"], {
      runForeground: async (_argv, _cwd, env) => {
        expect(env?.SMART_ROUTER_HANDLE).toBe(session.handle);
        expect((await loadSession(session.handle)).wakes![0].state).toBe(
          "sending",
        );
        if (fail) throw new Error("launch failed");
        return CODEX_OUTPUT;
      },
    });
    expect(result.exitCode).toBe(fail ? 1 : 0);
    expect((await loadSession(session.handle)).wakes![0].state).toBe(
      fail ? "failed" : "sent",
    );
  }
});

test("wake arm reports failure with exit 1", async () => {
  const session = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: "done",
  });
  const result = await cli(
    ["wake", session.handle, "--after-pid", String(process.pid)],
    {
      armWake: (handle, pid, message) =>
        armWake(handle, pid, message, async () => {
          throw new Error("launch failed");
        }),
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.json.state).toBe("failed");
});
test("maxDepth capacity exhausts delivery attempts instead of waiting forever", async () => {
  config.rules.concurrency = { maxRunning: 1, maxPerCaller: 1, maxDepth: 0 };
  await saveConfig(config);
  const session = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: "done",
    depth: 1,
    sessionId: "thread",
  });
  session.wakes = [
    {
      id: "depth",
      pid: 999999,
      startTime: "gone",
      command: "job",
      armedAt: new Date().toISOString(),
      watcherPid: process.pid,
      watcherStartTime: processStartTime(process.pid),
      state: "pending",
    },
  ];
  await saveSession(session, "claim");
  const result = await cli(["__wake", session.handle, "depth"]);
  expect(result.exitCode).toBe(1);
  expect((await loadSession(session.handle)).wakes![0].state).toBe("failed");
}, 45000);

test("T3 route registration, handle commands and capacity exclusion", async () => {
  const fake = join(directory, "fake-t3");
  await writeFile(
    fake,
    `#!/usr/bin/env bun
const args=process.argv.slice(2);await Bun.stdin.text();
console.log(JSON.stringify(args[1]==="send"?{runId:"run"}:{thread:{status:"completed",updatedAt:"2026-01-01T00:00:00Z",latestRunId:"run"},messages:args.at(-1)==="1"?[{role:"assistant",runId:"run",text:"T3 done"}]:[]}));
`,
  );
  await chmod(fake, 0o755);
  process.env.SMART_ROUTER_T3_CLI = fake;
  try {
    const routed = await cli([
      "route",
      "task",
      "--launch",
      "--label",
      "child",
      "--phase",
      "review",
    ]);
    const handle = routed.json.launch.handle;
    expect(await loadSession(handle)).toMatchObject({
      runner: "t3",
      status: "launched",
      t3ThreadId: "",
      label: "child",
      phase: "review",
    });
    expect(routed.json.launch.prompt).toContain(
      `Your smart-router handle is ${handle}`,
    );
    expect(
      (await cli(["attach", handle, "--t3-thread", TEST_T3_THREAD_ID]))
        .exitCode,
    ).toBe(0);
    expectJson(await cli(["status", handle]), { result: "T3 done" });
    expectJson(await cli(["send", handle, "follow up"]), { sent: true });
    config.rules.concurrency = { maxRunning: 1, maxPerCaller: 1, maxDepth: 2 };
    await saveConfig(config);
    expect(
      (await cli(["spawn", "local", "--model", "claude:opus"])).exitCode,
    ).toBe(0);
    expectJson(await cli(["wait", handle]), {
      result: "T3 done",
      resumeCommand: `smart-router send ${handle} "<msg>"`,
    });
    expectJson(await cli(["stop", handle]), { error: "stop it in T3" }, 1);
  } finally {
    delete process.env.SMART_ROUTER_T3_CLI;
  }
});

test("failed pid registration still records the owner's failure", async () => {
  const result = await cli(["spawn", "task", "--model", "codex:terra"], {
    runForeground: async (_argv, _cwd, _env, session) => {
      if (!session) throw new Error("missing session");
      session.pid = 999999;
      throw new Error("pid registration failed");
    },
  });
  expect(result.exitCode).toBe(1);
  expect((await listSessions()).at(0)).toMatchObject({
    status: "failed",
    error: "pid registration failed",
  });
});

test("a sweep cannot parse a foreground wrapper's partially drained output", async () => {
  const result = await cli(["spawn", "task", "--model", "claude:opus"], {
    runForeground: async (_argv, _cwd, _env, session) => {
      if (!session) throw new Error("missing session");
      session.pid = 999999;
      await saveSession(session);
      await writeFile(sessionLogPath(session.handle), '{"type":');
      await sweepSessions();
      expect((await loadSession(session.handle)).status).toBe("running");
      return CLAUDE_OUTPUT;
    },
  });
  expect(result.exitCode).toBe(0);
  expect((await loadSession(result.json.handle)).status).toBe("done");
});

test("route launch does not register a session when prompt construction fails", async () => {
  await mkdir(join(directory, "config", "guardrails.md"));
  expect((await cli(["route", "task", "--launch"])).exitCode).toBe(1);
  expect(await listSessions()).toHaveLength(0);
});
test("T3 logs explain how to open the thread", async () => {
  const session = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: directory,
    prompt: "T3",
    runner: "t3",
    status: "launched",
    t3ThreadId: "",
  });
  expectJson(
    await cli(["logs", session.handle]),
    { error: "T3 sessions have no smart-router log; open the thread in T3" },
    1,
  );
});

test("wait exits 2 when a T3 thread needs a human answer", async () => {
  const fake = join(directory, "input-t3");
  await writeFile(
    fake,
    `#!/usr/bin/env bun
await Bun.stdin.text();console.log(JSON.stringify({thread:{status:"waiting",updatedAt:new Date().toISOString(),pendingRequestCount:1,latestRunId:"run"},messages:[]}));
`,
  );
  await chmod(fake, 0o755);
  process.env.SMART_ROUTER_T3_CLI = fake;
  try {
    const session = await createSession({
      harness: "claude",
      model: "opus",
      effort: "high",
      cwd: directory,
      prompt: "T3",
      runner: "t3",
      status: "running",
      t3ThreadId: TEST_T3_THREAD_ID,
    });
    expectJson(
      await cli(["wait", session.handle]),
      { needsInput: true, warning: "waiting for an answer in T3" },
      2,
    );
  } finally {
    delete process.env.SMART_ROUTER_T3_CLI;
  }
});

function pool(weeklyUsedPercent: number, paceGap: number): QuotaProvider {
  return {
    weeklyUsedPercent,
    weeklyResetsAt: "2026-11-30T10:00:00Z",
    fiveHourUsedPercent: null,
    pace: "test",
    paceGap,
    modelWindows: [],
  };
}

function quotaRouteDeps(
  quota: Record<string, QuotaProvider | null>,
  stub: JevStub = {},
) {
  return (configuration: Config): RouteDeps => ({
    ...routeDeps(configuration, stub),
    getQuota: async () => ({ quota, ageMs: 0 }),
  });
}

async function enableQuota(): Promise<void> {
  config.quota = {
    enabled: true,
    providers: { claude: "claude", codex: "codex" },
  };
  await saveConfig(config);
}

test("a pinned spawn records a pinned route and warns when it works against the balance", async () => {
  await enableQuota();
  const overPace = quotaRouteDeps({
    claude: pool(80, -21),
    codex: pool(5, 61),
  });
  const warning =
    "Claude is 21 pts over pace while Codex has 61 in reserve; let the router choose instead of pinning";
  const dryRun = await cli(
    ["spawn", "task", "--model", "claude:opus", "--dry-run"],
    { routeDeps: overPace },
  );
  expectJson(dryRun, {
    kind: "pinned",
    pick: "claude:opus@high",
    warnings: [warning],
  });
  expect(dryRun.stderr).toContain(`Warning: ${warning}`);
  const spawned = await cli(["spawn", "task", "--model", "claude:opus"], {
    routeDeps: overPace,
  });
  expectJson(spawned, {
    harness: "claude",
    route: {
      version: 2,
      kind: "pinned",
      pick: "claude:opus@high",
      reason: `pinned by caller · ${warning}`,
      warnings: [warning],
    },
  });
  expect(spawned.stderr).toContain("Route: pinned by caller");
  expect(spawned.stderr).toContain(`Warning: ${warning}`);
  const session = await loadSession(spawned.json.handle);
  expect(session.route).toMatchObject({ kind: "pinned", warnings: [warning] });
  expect(session.turns?.[0].kind).toBe("pinned");
  const log = (
    await readFile(join(directory, "state", "pin-warnings.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(log).toMatchObject([
    { model: "claude:opus", warnings: [warning], ran: false },
    { model: "claude:opus", warnings: [warning], ran: true },
  ]);
  const balanced = await cli(["spawn", "task", "--model", "claude:opus"], {
    routeDeps: quotaRouteDeps({ claude: pool(50, 5), codex: pool(50, 5) }),
  });
  expectJson(balanced, { route: { kind: "pinned", warnings: [] } });
  expect(balanced.stderr).not.toContain("Warning:");
});

test("a pin to a model excluded for confidential work is refused", async () => {
  config.rules.confidentialExcludedModels = ["codex:*"];
  await saveConfig(config);
  runnerOutput = CODEX_OUTPUT;
  expectJson(
    await cli(["spawn", "task", "--model", "codex:terra", "--confidential"]),
    {
      error:
        "codex:terra cannot be pinned for confidential work: excluded for confidential work",
    },
    1,
  );
  expect(runnerArguments).toHaveLength(0);
  expectJson(await cli(["spawn", "task", "--model", "codex:terra"]), {
    harness: "codex",
  });
});

test("route --launch saves the sandbox, network and browser it chose", async () => {
  const launched = await cli(
    ["route", "Finish; stop when verified", "--launch"],
    {
      routeDeps: (configuration) =>
        routeDeps(configuration, { needsNetwork: 1 }),
    },
  );
  expectJson(launched, {
    version: 2,
    kind: "routed",
    launch: { sandbox: "workspace-write+network", browser: false },
  });
  expect(launched.stderr).toContain("Route: Jev: codex:terra 0.90");
  const session = await loadSession(launched.json.launch.handle);
  expect(session).toMatchObject({
    sandbox: "workspace-write",
    usesNetworkAccess: true,
    browser: false,
    route: { kind: "routed", pick: "codex:terra@high" },
  });
  expect(await readFile(sessionPromptPath(session.handle), "utf8")).toBe(
    "Finish; stop when verified",
  );
});

test("sessions save the task prompt and its hash, and rm removes the prompt", async () => {
  const prompt = "finish task; stop when tests pass";
  const spawned = await cli(["spawn", prompt, "--model", "claude:opus"]);
  const session = await loadSession(spawned.json.handle);
  expect(session.promptSha256).toBe(
    createHash("sha256").update(prompt).digest("hex"),
  );
  const promptPath = sessionPromptPath(session.handle);
  // The task as given, without the delegation context the delegate also received.
  expect(await readFile(promptPath, "utf8")).toBe(prompt);
  expect((await stat(promptPath)).mode).toBe(
    (await stat(sessionPath(session.handle))).mode,
  );
  expect((await cli(["rm", session.handle])).exitCode).toBe(0);
  await expect(stat(promptPath)).rejects.toThrow();
});

test("retry reruns the saved prompt, escalates with --up and links the sessions", async () => {
  runnerOutput = CODEX_OUTPUT;
  const prompt = "fix the parser; stop when tests pass";
  const first = await cli([
    "spawn",
    prompt,
    "--model",
    "codex:terra",
    "--cwd",
    directory,
  ]);
  const original = first.json.handle;
  runnerOutput = CLAUDE_OUTPUT;
  let sentState: any;
  const escalating = (configuration: Config): RouteDeps => {
    const dependencies = routeDeps(configuration, { choice: "claude:opus" });
    return {
      ...dependencies,
      client: {
        systemOne: async (request) => {
          sentState = request.state;
          return dependencies.client.systemOne(request);
        },
      },
    };
  };
  const escalated = await cli(
    ["retry", original, "--up", "--note", "missed the edge case"],
    { routeDeps: escalating },
  );
  expectJson(escalated, {
    harness: "claude",
    model: "opus",
    route: { kind: "routed", pick: "claude:opus@high" },
  });
  expect(sentState.previousAttempt).toEqual({
    model: "codex:terra",
    effort: "high",
    status: "done",
    error: null,
    resultTail: "codex done",
    note: "missed the edge case",
  });
  expect(sentState.candidates.map(({ id }: { id: string }) => id)).toEqual([
    "claude:opus",
  ]);
  const retried = await loadSession(escalated.json.handle);
  expect(retried).toMatchObject({
    retryOf: original,
    escalated: true,
    cwd: directory,
    promptSha256: (await loadSession(original)).promptSha256,
  });
  expect(await readFile(sessionPromptPath(retried.handle), "utf8")).toBe(
    prompt,
  );
  runnerOutput = CODEX_OUTPUT;
  const plain = await cli(["retry", original]);
  expectJson(plain, { harness: "codex", route: { kind: "routed" } });
  const plainSession = await loadSession(plain.json.handle);
  expect(plainSession.retryOf).toBe(original);
  expect(plainSession.escalated).toBeUndefined();
  // retryOf on each retry is the only stored link; status and sessions derive the reverse.
  expect(await loadSession(original)).not.toHaveProperty("retriedBy");
  expectJson(await cli(["status", original]), {
    retriedBy: [escalated.json.handle, plain.json.handle],
  });
  const listed = await cli(["sessions"]);
  expect(
    listed.json.find(({ handle }: { handle: string }) => handle === original)
      .retriedBy,
  ).toEqual([escalated.json.handle, plain.json.handle]);
  expect(
    listed.json.find(
      ({ handle }: { handle: string }) => handle === plain.json.handle,
    ),
  ).toMatchObject({ retryOf: original, retriedBy: [] });
  const launched = await cli(["retry", original, "--up", "--launch"], {
    routeDeps: escalating,
  });
  expectJson(launched, {
    kind: "routed",
    launch: { harness: "claude", model: "opus" },
  });
  expect(await loadSession(launched.json.launch.handle)).toMatchObject({
    status: "launched",
    retryOf: original,
    escalated: true,
  });
  expect((await cli(["status", original])).json.retriedBy).toHaveLength(3);
  // A retriedBy written by an older version is ignored: only retryOf links count.
  const untouched = await cli([
    "spawn",
    "another task",
    "--model",
    "codex:terra",
  ]);
  const legacy = await loadSession(untouched.json.handle);
  await writeFile(
    sessionPath(legacy.handle),
    JSON.stringify({ ...legacy, retriedBy: ["stale-handle"] }),
  );
  expectJson(await cli(["status", legacy.handle]), { retriedBy: [] });
  const legacyStats = await cli(["stats", "--json"], {
    loadPricing: async () => null,
    codexbarCostUsd: async () => null,
  });
  expect(legacyStats.json.models["codex:terra"]).toMatchObject({
    runs: 3,
    // Only the first attempt was retried: 1 of 3.
    retriedPercent: 33.3,
  });
  expectJson(
    await cli(["retry", escalated.json.handle, "--up"]),
    {
      error:
        "no available candidate is stronger than claude:opus@high; give models a higher tier in config or drop --up",
    },
    1,
  );
  expectJson(
    await cli(["retry", original, "--up", "--model", "claude:opus"]),
    {
      error:
        "--up lets the router pick a stronger model; drop the --model pin or use harness:auto",
    },
    1,
  );
  process.env.SMART_ROUTER_HANDLE = original;
  expectJson(
    await cli(["retry", original]),
    {
      error: `refusing to retry ${original}: it is your own session or an ancestor; report your result instead`,
    },
    1,
  );
  delete process.env.SMART_ROUTER_HANDLE;
  await rm(sessionPromptPath(original));
  expectJson(
    await cli(["retry", original]),
    {
      error: `session ${original} has no saved prompt (it was started before retry existed); spawn the task again`,
    },
    1,
  );
  await mkdir(sessionPromptPath(original));
  expect((await cli(["retry", original])).exitCode).toBe(1);
  const running = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: directory,
    prompt: "still going",
    status: SESSION_STATUS.running,
    pid: process.pid,
    processStartTime: processStartTime(process.pid),
  });
  expectJson(
    await cli(["retry", running.handle]),
    {
      error: `session ${running.handle} is still running; wait or stop it first`,
    },
    1,
  );
});

test("rate records a rating that later turns keep", async () => {
  runnerOutput = CODEX_OUTPUT;
  const spawned = await cli(["spawn", "task", "--model", "codex:terra"]);
  const handle = spawned.json.handle;
  const rated = await cli([
    "rate",
    handle,
    "bad",
    "--note",
    "ignored the spec",
  ]);
  expectJson(rated, {
    handle,
    rating: { value: "bad", note: "ignored the spec" },
  });
  expect(Date.parse(rated.json.rating.at)).not.toBeNaN();
  expectJson(await cli(["rate", handle, "good"]), {
    rating: { value: "good", note: null },
  });
  expectJson(
    await cli(["rate", handle, "meh"]),
    { error: "rating must be good or bad" },
    1,
  );
  expect((await cli(["send", handle, "again"])).exitCode).toBe(0);
  expectJson(await cli(["status", handle]), { rating: { value: "good" } });
  const launched = await cli([
    "route",
    "Finish; stop when verified",
    "--launch",
  ]);
  const launchHandle = launched.json.launch.handle;
  expectJson(await cli(["rate", launchHandle, "good"]), {
    rating: { value: "good" },
  });
  // The revision bump makes a concurrent T3 refresh reload instead of dropping the rating.
  expect((await loadSession(launchHandle)).t3Revision).toBe(1);
});

test("stats reports balance, pick sources, outcomes and list cost, as text, JSON and an export", async () => {
  await enableQuota();
  const quota = { claude: pool(80, -21), codex: pool(5, 61) };
  runnerOutput = CODEX_OUTPUT;
  const routed = await cli(
    [
      "spawn",
      "task one; stop when done",
      "--label",
      "wave:a",
      "--phase",
      "build",
    ],
    {
      routeDeps: quotaRouteDeps(quota),
    },
  );
  runnerOutput = CLAUDE_OUTPUT;
  const pinned = await cli(["spawn", "task two", "--model", "claude:opus"], {
    routeDeps: quotaRouteDeps(quota),
  });
  await cli(["rate", routed.json.handle, "bad"]);
  await cli(["retry", routed.json.handle, "--up"], {
    routeDeps: quotaRouteDeps(quota, { choice: "claude:opus" }),
  });
  const statsDeps: Partial<CliDeps> = {
    getQuota: async () => quota,
    loadPricing: async () => ({
      anthropic: {
        models: {
          opus: {
            cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
          },
        },
      },
    }),
    codexbarCostUsd: async (provider) => (provider === "claude" ? 1 : null),
  };
  const json = await cli(["stats", "--json"], statsDeps);
  expect(json.exitCode).toBe(0);
  expect(json.stderr).toContain("Stats computed");
  // 3 input, 5 output, 6 cache-read and 2 cache-write tokens at the prices above, per Claude run.
  const claudeRunCost = (3 * 4 + 5 * 20 + 6 * 0.2 + 2 * 5) / 1_000_000;
  expect(json.json).toMatchObject({
    window: { label: "last 7 days", rollingDays: 7 },
    sessions: 3,
    unpricedSessions: 1,
    pools: {
      claude: {
        runs: 2,
        sessionSharePercent: 66.7,
        // Claude reports its own cost (0.02 a run); Codex reports none and has no list price here.
        costSharePercent: 100,
        costSource: "harness",
        weeklyUsedPercent: 80,
        paceGap: -21,
      },
      codex: {
        runs: 1,
        sessionSharePercent: 33.3,
        weeklyUsedPercent: 5,
        paceGap: 61,
      },
    },
    pickSources: {
      routed: 2,
      pinned: 1,
      fallback: 0,
      unrecorded: 0,
      pinWarningsIssued: 1,
      pinWarningsRanAnyway: 1,
    },
    models: {
      "codex:terra": {
        runs: 1,
        retriedPercent: 100,
        escalatedFromPercent: 100,
        ratedBad: 1,
        unpriced: 1,
      },
      "claude:opus": {
        runs: 2,
        failedPercent: 0,
        retriedPercent: 0,
        ratedGood: 0,
        unpriced: 0,
      },
    },
    callers: { [OWNER]: { runs: 3 } },
    // The retry carries no label of its own and counts under the original's.
    labels: { "wave:a": { runs: 2 }, "(none)": { runs: 1 } },
    phases: { build: { runs: 2 } },
    nativeSubagentGuard: {},
    collapse: null,
    spendShare: { claude: { totalListCostUsd: 1 } },
  });
  expect(json.json).toMatchObject({ costUsd: 0.04, costSource: "harness" });
  expect(json.json.pools.codex.costSource).toBe("none");
  expect(json.json.spendShare.claude.smartRouterCostUsd).toBe(
    claudeRunCost * 2,
  );
  expect(json.json.spendShare).not.toHaveProperty("codex");
  const features = Object.fromEntries(
    json.json.features.map((feature: { name: string }) => [
      feature.name,
      feature,
    ]),
  );
  expect(features.pinWarnings).toMatchObject({
    fired: { sessions: 1 },
    notFired: { sessions: 0, failedPercent: null },
  });
  expect(features.retryUp).toMatchObject({
    fired: { sessions: 1 },
    notFired: { sessions: 2, retriedPercent: 50, ratedBadPercent: 50 },
  });
  expect(features.paceTilt.notFired.sessions).toBe(2);
  const exportPath = join(directory, "export.jsonl");
  const text = await cli(
    ["stats", "--days", "1", "--export", exportPath],
    statsDeps,
  );
  expect(text.stdout).toContain("smart-router stats: last 1 days");
  expect(text.stdout).toContain("claude: 66.7% of sessions");
  expect(text.stdout).toContain("pin warnings issued 1, ran anyway 1");
  expect(text.stdout).toContain("retryUp fired: 1 sessions");
  expect(text.stdout).toContain(
    "(100%) went through smart-router".replace(
      "100%",
      `${json.json.spendShare.claude.sharePercent}%`,
    ),
  );
  const exported = (await readFile(exportPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(exported).toHaveLength(3);
  expect(
    exported.find(({ handle }) => handle === routed.json.handle),
  ).toMatchObject({
    harness: "codex",
    label: "wave:a",
    costUsd: null,
    costSource: null,
    listCostUsd: null,
    route: { version: 2, kind: "routed" },
    outcome: {
      status: "done",
      failed: false,
      retried: true,
      rating: "bad",
      rerun: false,
    },
    retriedBy: [expect.any(String)],
  });
  expect(
    exported.find(({ handle }) => handle === pinned.json.handle),
  ).toMatchObject({
    costUsd: 0.02,
    costSource: "harness",
    // The computed list cost is exported too, so replay compares models on one basis.
    listCostUsd: expect.closeTo(claudeRunCost, 10),
    route: { kind: "pinned" },
    escalated: false,
    retryOf: null,
  });
  const current = await cli(
    ["stats", "--window", "current", "--json"],
    statsDeps,
  );
  expect(current.json.window).toMatchObject({
    label: "current quota window",
    from: "2026-11-23T10:00:00.000Z",
  });
  const previous = await cli(
    ["stats", "--window", "previous", "--json"],
    statsDeps,
  );
  expect(previous.json).toMatchObject({
    window: {
      label: "previous quota window",
      to: "2026-11-23T10:00:00.000Z",
      rollingDays: null,
    },
    sessions: 0,
    costUsd: 0,
    costSource: "none",
    spendShare: {},
    pools: { claude: { runs: 0, sessionSharePercent: null } },
  });
  expectJson(
    await cli(["stats", "--window", "current"], {
      getQuota: async () => ({ error: "codexbar not installed" }),
    }),
    {
      error:
        "--window needs the quota reset times from codexbar; use --days instead",
    },
    1,
  );
  expectJson(
    await cli(["stats", "--window", "soon"]),
    { error: "--window must be current or previous" },
    1,
  );
  expectJson(
    await cli(["stats", "--window", "current", "--days", "3"]),
    { error: "use --days or --window, not both" },
    1,
  );
  const defaults = await cli(["stats", "--json"], {
    ...statsDeps,
    getQuota: async () => ({ error: "codexbar not installed" }),
  });
  expect(defaults.json).toMatchObject({
    sessions: 3,
    pools: { claude: { weeklyUsedPercent: null } },
  });
  const running = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: directory,
    prompt: "read only",
    status: "running",
    pid: DETACHED_PID,
  });
  const beforeStats = await stat(sessionPath(running.handle));
  await cli(["stats", "--json"], statsDeps);
  expect((await loadSession(running.handle)).status).toBe("running");
  expect((await stat(sessionPath(running.handle))).mtimeMs).toBe(
    beforeStats.mtimeMs,
  );
});

test("guard subagent decides, logs, and prints each harness's hook output", async () => {
  await enableQuota();
  let quotaReads = 0;
  const overPace = {
    getQuota: async () => {
      quotaReads += 1;
      return { claude: pool(80, -21), codex: pool(5, 61) };
    },
  };
  const plain = await cli(
    // prettier-ignore
    ["guard", "subagent", "--harness", "claude", "--subagent-type", "Explore", "--model", "opus", "--session", "s1", "--cwd", "/repo"],
    overPace,
  );
  expectJson(plain, { decision: "deny" });
  expect(plain.json.message).toContain("smart-router spawn");
  const event = (tool: object) =>
    JSON.stringify({ session_id: "s2", cwd: "/repo", tool_input: tool });
  const claudeHook = await cli(["guard", "subagent", "--hook", "claude"], {
    ...overPace,
    readStdin: async () => event({ subagent_type: "Explore", model: "opus" }),
  });
  expect(claudeHook.exitCode).toBe(0);
  expect(claudeHook.json.hookSpecificOutput).toMatchObject({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: plain.json.message,
  });
  // Claude is the pool over pace, so a Codex subagent is allowed: no output at all.
  const codexAllowed = await cli(["guard", "subagent", "--hook", "codex"], {
    ...overPace,
    readStdin: async () => event({ agent_type: "reviewer" }),
  });
  expect(codexAllowed).toMatchObject({ stdout: "", exitCode: 0 });
  // One codexbar read served all three decisions from the shared cache.
  expect(quotaReads).toBe(1);
  config.rules.nativeSubagentGuard = "warn";
  await saveConfig(config);
  const warned = await cli(["guard", "subagent", "--hook", "claude"], {
    ...overPace,
    readStdin: async () => event({ subagent_type: "Explore" }),
  });
  expect(warned.json.hookSpecificOutput).toEqual({
    hookEventName: "PreToolUse",
    additionalContext: plain.json.message,
  });
  const allowedType = await cli(["guard", "subagent", "--hook", "claude"], {
    ...overPace,
    readStdin: async () => event({ subagent_type: "statusline-setup" }),
  });
  expect(allowedType).toMatchObject({ stdout: "", exitCode: 0 });
  const unreadable = await cli(["guard", "subagent", "--hook", "claude"], {
    ...overPace,
    readStdin: async () => "not json",
  });
  expect(unreadable).toMatchObject({ stdout: "", exitCode: 0 });
  const log = (
    await readFile(join(directory, "state", "native-subagents.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    log.map(({ harness, subagentType, decision }) => [
      harness,
      subagentType,
      decision,
    ]),
  ).toEqual([
    ["claude", "Explore", "deny"],
    ["claude", "Explore", "deny"],
    ["codex", "reviewer", "allow"],
    ["claude", "Explore", "warn"],
    ["claude", "statusline-setup", "allow"],
  ]);
  expect(log[0]).toMatchObject({
    model: "opus",
    sessionId: "s1",
    cwd: "/repo",
    guardedGap: -21,
    otherGap: 61,
  });
  const stats = await cli(["stats", "--json"], {
    ...overPace,
    loadPricing: async () => null,
    codexbarCostUsd: async () => null,
  });
  expect(stats.json.nativeSubagentGuard).toEqual({
    claude: { allow: 1, warn: 1, deny: 2 },
    codex: { allow: 1, warn: 0, deny: 0 },
  });
});

test("guard subagent allows when no harness is given or quota is off", async () => {
  expectJson(await cli(["guard", "subagent"]), {
    decision: "allow",
    message: "",
  });
  expectJson(await cli(["guard", "subagent", "--harness", "claude"]), {
    decision: "allow",
    message: "",
  });
});

test("routed spawns pass the route summary on the started event and in session lists", async () => {
  runnerOutput = CODEX_OUTPUT;
  const spawned = await cli(["spawn", "task; stop when done", "--detach"]);
  const events = await cli(["logs", spawned.json.handle, "--events"]);
  const started = events.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find(({ type }) => type === "session.started");
  expect(started.route).toMatchObject({
    kind: "routed",
    pick: "codex:terra@high",
    warnings: [],
    tiltChanged: false,
    lowConfidence: false,
  });
  expect(started.route.reason).toContain("Jev: codex:terra 0.90");
  const listed = await cli(["sessions"]);
  expect(listed.json[0]).toMatchObject({
    route: { kind: "routed", pick: "codex:terra@high" },
  });
  expect(listed.json[0].route).not.toHaveProperty("inputs");
});

async function openclawBridge(): Promise<string> {
  const bridge = join(directory, "bridge.json");
  await writeFile(
    bridge,
    JSON.stringify({
      mcpServers: {
        openclaw: { type: "http", url: "http://127.0.0.1:9999/mcp" },
      },
    }),
  );
  return bridge;
}

test("a retry inherits the original's confinement, tool limits, permission mode and MCP config", async () => {
  const bridge = await openclawBridge();
  const claudePick = (configuration: Config) =>
    routeDeps(configuration, { choice: "claude:opus" });
  const original = await cli(
    // prettier-ignore
    ["spawn", "task; stop when done", "--confined", "--model", "claude:opus", "--mcp-config", bridge, "--disallowedTools", "Bash", "--permission-mode", "default"],
  );
  expect(original.exitCode).toBe(0);
  const saved = await loadSession(original.json.handle);
  expect(saved).toMatchObject({
    confined: true,
    disallowedTools: ["Bash"],
    permissionMode: "default",
  });
  const retried = await cli(["retry", saved.handle], { routeDeps: claudePick });
  expect(retried.exitCode).toBe(0);
  // Never less restricted than the original: same confinement, denials, allow-list, MCP bridge and mode.
  expect(await loadSession(retried.json.handle)).toMatchObject({
    retryOf: saved.handle,
    confined: true,
    disallowedTools: ["Bash"],
    allowedTools: saved.allowedTools,
    mcpConfig: saved.mcpConfig,
    permissionMode: "default",
  });
  const retryArguments = runnerArguments.at(-1) ?? [];
  expect(retryArguments[retryArguments.indexOf("--permission-mode") + 1]).toBe(
    "default",
  );
  expect(retryArguments.join(" ")).not.toContain("bypassPermissions");
  // The caller can only add restrictions.
  const stricter = await cli(
    ["retry", saved.handle, "--disallowedTools", "mcp__openclaw__send"],
    { routeDeps: claudePick },
  );
  expect((await loadSession(stricter.json.handle)).disallowedTools).toEqual([
    "Bash",
    "mcp__openclaw__send",
  ]);
  expectJson(
    await cli(
      ["retry", saved.handle, "--permission-mode", "bypassPermissions"],
      { routeDeps: claudePick },
    ),
    {
      error: `session ${saved.handle} ran with --permission-mode default; a retry cannot broaden it to bypassPermissions`,
    },
    1,
  );
  expectJson(
    await cli(["retry", saved.handle, "--launch"], { routeDeps: claudePick }),
    {
      error: `session ${saved.handle} ran with confinement, tool limits or a permission mode that a T3 launch cannot carry; retry without --launch`,
    },
    1,
  );
  // A resume keeps the permission mode too, instead of falling back to the configured default.
  expect((await cli(["send", saved.handle, "again"])).exitCode).toBe(0);
  const resumeArguments = runnerArguments.at(-1) ?? [];
  expect(
    resumeArguments[resumeArguments.indexOf("--permission-mode") + 1],
  ).toBe("default");
});

test("a retry keeps an inherited allow-list on Claude and intersects the caller's", async () => {
  const original = await cli(
    // prettier-ignore
    ["spawn", "task; stop when done", "--model", "claude:opus", "--allowed-tools", "Read,Grep", "--browser"],
  );
  runnerOutput = CLAUDE_OUTPUT;
  // Jev prefers Codex, which cannot enforce an allow-list, so the retry stays on Claude.
  const retried = await cli([
    "retry",
    original.json.handle,
    "--allowed-tools",
    "Read,Write",
  ]);
  expectJson(retried, { harness: "claude" });
  expect(await loadSession(retried.json.handle)).toMatchObject({
    harness: "claude",
    allowedTools: "Read",
    browser: true,
  });
});

test("a retry on Codex runs in the original's sandbox and network setting", async () => {
  runnerOutput = CODEX_OUTPUT;
  const networked = await cli(["spawn", "task; stop when done"], {
    routeDeps: (configuration) => routeDeps(configuration, { needsNetwork: 1 }),
  });
  expect(await loadSession(networked.json.handle)).toMatchObject({
    sandbox: "workspace-write",
    usesNetworkAccess: true,
  });
  // The retry's own task scores say "no network"; the original's setting still applies.
  const retried = await cli(["retry", networked.json.handle]);
  expectJson(retried, { sandbox: "workspace-write+network" });
  expect(await loadSession(retried.json.handle)).toMatchObject({
    sandbox: "workspace-write",
    usesNetworkAccess: true,
  });
  const readOnly = await cli(
    // prettier-ignore
    ["spawn", "task; stop when done", "--model", "codex:terra", "--sandbox", "read-only"],
  );
  const readOnlyRetry = await cli(["retry", readOnly.json.handle], {
    // Scores that would otherwise pick full access.
    routeDeps: (configuration) =>
      routeDeps(configuration, { needsFullAccess: 1 }),
  });
  expectJson(readOnlyRetry, { sandbox: "read-only" });
  // As on a resume, an explicit --sandbox from the caller is the one override.
  const overridden = await cli([
    "retry",
    readOnly.json.handle,
    "--sandbox",
    "workspace-write",
  ]);
  expectJson(overridden, { sandbox: "workspace-write" });
});

test("retry --up rejects an --effort that is not stronger on the same model", async () => {
  config.models[0].efforts = ["low", "high"];
  config.models[1].efforts = ["low", "high", "xhigh"];
  await saveConfig(config);
  runnerOutput = CODEX_OUTPUT;
  const original = await cli(
    // prettier-ignore
    ["spawn", "task; stop when done", "--model", "codex:terra", "--effort", "high"],
  );
  const handle = original.json.handle;
  const sessionsBefore = (await listSessions()).length;
  for (const effort of ["low", "high"])
    expectJson(
      await cli(["retry", handle, "--up", "--effort", effort]),
      {
        error: `--effort ${effort} is not stronger than the previous attempt (codex:terra@high); pass a higher effort or drop --effort`,
      },
      1,
    );
  // Nothing ran and nothing was recorded as an escalation.
  expect(await listSessions()).toHaveLength(sessionsBefore);
  const stronger = await cli(["retry", handle, "--up", "--effort", "xhigh"]);
  expectJson(stronger, { model: "terra", effort: "xhigh" });
  expect(await loadSession(stronger.json.handle)).toMatchObject({
    effort: "xhigh",
    escalated: true,
  });
  // A higher-tier model is an escalation at any effort.
  runnerOutput = CLAUDE_OUTPUT;
  const higherTier = await cli(["retry", handle, "--up", "--effort", "low"], {
    routeDeps: (configuration) =>
      routeDeps(configuration, { choice: "claude:opus" }),
  });
  expectJson(higherTier, { model: "opus", effort: "low" });
  // Without --up an effort override is a plain rerun and is not checked.
  runnerOutput = CODEX_OUTPUT;
  expectJson(await cli(["retry", handle, "--effort", "low"]), {
    model: "terra",
    effort: "low",
  });
});

test("a retry may narrow the saved permission mode but never broaden it", async () => {
  const original = await cli(
    // prettier-ignore
    ["spawn", "task; stop when done", "--model", "claude:opus", "--permission-mode", "default"],
  );
  const handle = original.json.handle;
  const claudePick = {
    routeDeps: (configuration: Config) =>
      routeDeps(configuration, { choice: "claude:opus" }),
  };
  const sessionsBefore = (await listSessions()).length;
  // plan < default < acceptEdits < bypassPermissions; an unlisted mode cannot be ranked, so it is refused too.
  for (const broader of ["acceptEdits", "bypassPermissions", "customMode"])
    expectJson(
      await cli(["retry", handle, "--permission-mode", broader], claudePick),
      {
        error: `session ${handle} ran with --permission-mode default; a retry cannot broaden it to ${broader}`,
      },
      1,
    );
  expect(await listSessions()).toHaveLength(sessionsBefore);
  const narrowed = await cli(
    ["retry", handle, "--permission-mode", "plan"],
    claudePick,
  );
  expect((await loadSession(narrowed.json.handle)).permissionMode).toBe("plan");
  // The narrowed retry is the new ceiling: its own retry cannot go back up to the first attempt's mode.
  for (const broader of ["default", "acceptEdits"])
    expect(
      (
        await cli(
          ["retry", narrowed.json.handle, "--permission-mode", broader],
          claudePick,
        )
      ).exitCode,
    ).toBe(1);
  const same = await cli(
    ["retry", handle, "--permission-mode", "default"],
    claudePick,
  );
  expect((await loadSession(same.json.handle)).permissionMode).toBe("default");
  // An original with no saved mode ran under the configured default, so any mode may be chosen.
  const unsaved = await cli([
    "spawn",
    "another task",
    "--model",
    "claude:opus",
  ]);
  expect(
    (
      await cli(
        ["retry", unsaved.json.handle, "--permission-mode", "acceptEdits"],
        claudePick,
      )
    ).exitCode,
  ).toBe(0);
});
