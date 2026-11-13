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
  sessionLogPath,
  sessionPath,
  sessionSocketPath,
  SESSION_STATUS,
  terminateSessionProcess,
  type Session,
} from "../src/sessions.ts";
import type { DoctorResult } from "../src/doctor.ts";
import type { RouteDeps } from "../src/route.ts";
import { runForeground } from "../src/runner.ts";
import { getQuota, runCodexbar } from "../src/quota.ts";
import { getAdapter } from "../src/harness/index.ts";

const OWNER = "cli-test-owner";
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

function routeDeps(config: Config): RouteDeps {
  // prettier-ignore
  return {
    config, doctor: async () => detection, getQuota: async () => ({ error: "quota disabled" }), preferences: "prefer Claude",
    client: { systemOne: async () => {
      if (routeResponse === "offline") throw new Error("mock returned 500");
      return { answers: {
        model: { choice: "codex:terra", confidence: 0.9, probabilities: {} },
        effort: { choice: "high", probabilities: { high: 1 } },
        needsBrowser: { noul: 0 }, needsNetwork: { noul: 0 }, needsFullAccess: { noul: 0 },
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
    now: Date.now, execPath: "/opt/homebrew/Cellar/smart-router/bin/smart-router", routeDeps,
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
  for (const name of ["SMART_ROUTER_CONFIG_DIR", "SMART_ROUTER_STATE_DIR", "CLAUDE_CONFIG_DIR", "SMART_ROUTER_OWNER", "SMART_ROUTER_DEPTH", "SMART_ROUTER_HANDLE", "SMART_ROUTER_ANCESTORS", "SMART_ROUTER_NO_UPDATE_CHECK"])
    delete process.env[name];
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
  const installed = await cli(["install-skill"]);
  expect(installed.exitCode).toBe(0);
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
  expect(runnerArguments[0]).toContain("finish task");
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

test("spawn refuses a dry-run route without launching a harness", async () => {
  expectJson(
    await cli(["spawn", "task", "--dry-run"]),
    { error: "Cannot spawn from a dry-run route" },
    1,
  );
  expect(runnerArguments).toHaveLength(0);
  expect(await listSessions(OWNER)).toEqual([]);
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
  expectJson(await cli([...waitArgs, "--wait-for-slot", "0.1"]), {
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
  await Promise.all(
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
});

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
  if (event.message.content === "wait") continue;
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
    "count",
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
      { stdout: "pipe", stderr: "pipe" },
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
  const pinned = await cli(
    ["spawn", "task", "--confined", "--model", "codex:terra"],
    failed,
  );
  expect(pinned.exitCode).toBe(1);
  expect(pinned.stderr).toContain("upgrade codex");
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
