import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../src/assets.ts";
import { buildProgram, runCli, type CliDeps } from "../src/cli.ts";
import { DEFAULT_CONFIG, saveConfig, type Config } from "../src/config.ts";
import {
  createSession,
  loadSession,
  saveSession,
  SESSION_STATUS,
} from "../src/sessions.ts";
import type { DoctorResult } from "../src/doctor.ts";
import type { RouteDeps } from "../src/route.ts";
import { getQuota, runCodexbar } from "../src/quota.ts";

const OWNER = "cli-test-owner";
const OTHER_OWNER = "someone-else";
const CLAUDE_OUTPUT = JSON.stringify({
  session_id: "claude-session",
  result: "finished work",
  usage: { input_tokens: 3, output_tokens: 5 },
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
const RELEASE_VERSION = "99.0.0";
const RELEASE_ASSET = `smart-router-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const DETACHED_PID = 999_999_999;

let directory: string;
let config: Config;
let runnerOutput = CLAUDE_OUTPUT;
let runnerArguments: string[][];
let routeResponse: "success" | "offline" | "stopping" = "success";
let quotaEnabled = true;

const detection: DoctorResult = {
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
  // prettier-ignore
  const deps: CliDeps = {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, exit: (code) => { exitCode = code; },
    runForeground: async (argv) => {
      runnerArguments.push(argv); return runnerOutput;
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
  await rm(directory, { recursive: true, force: true });
  // prettier-ignore
  for (const name of ["SMART_ROUTER_CONFIG_DIR", "SMART_ROUTER_STATE_DIR", "CLAUDE_CONFIG_DIR", "SMART_ROUTER_OWNER", "SMART_ROUTER_NO_UPDATE_CHECK"])
    delete process.env[name];
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
  runnerOutput = CODEX_OUTPUT;
  const schemaPath = join(directory, "schema.json");
  await writeFile(schemaPath, '{"type":"object"}');
  // prettier-ignore
  const codex = await cli(["spawn", "finish task", "--model", "codex:terra", "--effort", "high", "--schema", schemaPath]);
  expectJson(codex, {
    harness: "codex",
    result: "codex done",
    usage: { inputTokens: 7, outputTokens: 9, costUsd: null },
  });
  expect(codex.json.resumeCommand).toContain("codex-thread");
  expect(runnerArguments[1]).toContain(schemaPath);
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
    { error: "launch denied" },
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
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  expectJson(updated, { updated: true, latest: RELEASE_VERSION });
  expect(await readFile(executablePath, "utf8")).toBe(binary);
});

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
