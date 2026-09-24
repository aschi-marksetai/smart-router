#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { readFile } from "node:fs/promises";
import { version } from "./assets.ts";
import { installSkill } from "./install.ts";
import { harnessBinary, type HarnessName, loadConfig } from "./config.ts";
import { doctor } from "./doctor.ts";
import { loadDotEnv } from "./env.ts";
import { getAdapter } from "./harness/index.ts";
import type { HarnessOptions } from "./harness/types.ts";
import { runInit } from "./init.ts";
import { getQuota } from "./quota.ts";
import { configDir } from "./paths.ts";
import { readUpdateNotice, updateExecutable, updateRefusal } from "./update.ts";
import { guardrailsFor, loadGuardrails } from "./guardrails.ts";
import {
  CODEX_NETWORK_ACCESS_OVERRIDE,
  chooseCodexSandbox,
  defaultRouteDeps,
  needsStoppingPoint,
  route,
  shouldUseClaudeBrowser,
  type RouteOptions,
} from "./route.ts";
import { runDetached, runForeground } from "./runner.ts";
import {
  addUsage,
  completeSessionFromLog,
  createSessionHandle,
  createSession,
  isProcessRunning,
  listSessions,
  loadSession,
  pruneSessions,
  removeSession,
  saveSession,
  sessionLogPath,
  sessionOwner,
  SESSION_STATUS,
  stopSession,
  type Session,
} from "./sessions.ts";

const ERROR_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;
const HARNESS_NAMES: HarnessName[] = ["claude", "codex", "pi"];

type SpawnOptions = RouteOptions & {
  model?: string;
  effort?: string;
  worktree?: boolean;
  guardrails?: boolean;
  detach?: boolean;
  permissionMode?: string;
  browser?: boolean;
  sandbox?: string;
  allowedTools?: string;
  schema?: string;
  resultLimit?: string;
};
type PassthroughOptions = {
  permissionMode?: string;
  browser?: boolean;
  sandbox?: string;
  allowedTools?: string;
  schema?: string;
  resultLimit?: string;
  codexSandbox?: string;
  codexConfigOverrides?: string[];
};
type Pick = { harness: HarnessName; model: string; effort: string };
const RUNNING_SESSION_ERROR = "is still running; wait or stop it first";
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_RESULT_LIMIT: number | undefined = undefined;
const RESULT_LIMIT_FLAG = "--result-limit";
const RESULT_LIMIT_OPTION = `${RESULT_LIMIT_FLAG} <chars>`;
const ALL_OPTION = "--all";
const OLDER_THAN_FLAG = "--older-than";
const OLDER_THAN_OPTION = `${OLDER_THAN_FLAG} <days>`;
const NEW_MODELS_NOTICE = "New models available:";

export type CliDeps = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
  runForeground: typeof runForeground;
  runDetached: typeof runDetached;
  fetch: (url: string) => Promise<Response>;
  now: () => number;
  execPath: string;
  routeDeps: typeof defaultRouteDeps;
  doctor: typeof doctor;
  getQuota: typeof getQuota;
  runInit: (options: Parameters<typeof runInit>[0]) => Promise<void>;
};

const DEFAULT_DEPS: CliDeps = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
  runForeground,
  runDetached,
  fetch: (url) => globalThis.fetch(url),
  now: Date.now,
  execPath: process.execPath,
  routeDeps: defaultRouteDeps,
  doctor,
  getQuota,
  runInit,
};

function resultOutput(result: string, resultLimit: number | undefined) {
  if (resultLimit === undefined || result.length <= resultLimit)
    return { result };
  return {
    result: result.slice(0, resultLimit),
    resultTruncated: true,
    resultChars: result.length,
  };
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${flag} must be a non-negative integer`);
  return number;
}

function resultLimit(options: { resultLimit?: string }): number | undefined {
  if (options.resultLimit === undefined) return DEFAULT_RESULT_LIMIT;
  return parseNonNegativeInteger(options.resultLimit, RESULT_LIMIT_FLAG);
}

function printResult(
  deps: CliDeps,
  result: unknown,
  summary: string,
  exitCode = SUCCESS_EXIT_CODE,
): void {
  deps.stdout(`${JSON.stringify(result)}\n`);
  deps.stderr(`${summary}\n`);
  deps.exit(exitCode);
}

function printLog(deps: CliDeps, output: string): void {
  deps.stdout(output);
  deps.stderr("Session log retrieved\n");
  deps.exit(SUCCESS_EXIT_CODE);
}

function isHarness(value: string): value is HarnessName {
  return HARNESS_NAMES.some((harness) => harness === value);
}

function parseHarness(modelId: string): [HarnessName, string] {
  const modelSeparator = modelId.indexOf(":");
  if (modelSeparator < 1) throw new Error("Model must be harness:model");
  const harness = modelId.slice(0, modelSeparator);
  if (!isHarness(harness)) throw new Error(`Unknown harness: ${harness}`);
  return [harness, modelId.slice(modelSeparator + 1)];
}

function parsePick(value: string): Pick {
  const effortSeparator = value.lastIndexOf("@");
  if (effortSeparator < 1)
    throw new Error("Model must be harness:model@effort");
  const [harness, model] = parseHarness(value.slice(0, effortSeparator));
  return {
    harness,
    model,
    effort: value.slice(effortSeparator + 1),
  };
}

function directPick(modelId: string, effort: string): Pick {
  const [harness, model] = parseHarness(modelId);
  return { harness, model, effort };
}

async function routeCommand(
  prompt: string,
  options: RouteOptions,
  deps: CliDeps,
): Promise<void> {
  const config = await loadConfig();
  const result = await route(prompt, options, deps.routeDeps(config));
  deps.stdout(`${JSON.stringify(result)}\n`);
  await printUpdateNotice(
    config,
    "availableModels" in result ? result.availableModels : [],
    deps,
  );
  deps.stderr(
    `${options.dryRun ? "Route dry run completed" : "Route selected"}\n`,
  );
  deps.exit(SUCCESS_EXIT_CODE);
}

async function spawnCommand(
  prompt: string,
  options: SpawnOptions,
  deps: CliDeps,
): Promise<void> {
  const config = await loadConfig();
  const cwd = options.cwd ?? process.cwd();
  const routeResult = options.model
    ? null
    : await route(prompt, options, deps.routeDeps(config));
  if (routeResult && !("pick" in routeResult))
    throw new Error("Cannot spawn from a dry-run route");
  let selected: Pick;
  if (options.model) {
    selected = directPick(
      options.model,
      options.effort ?? config.defaultEffort,
    );
  } else {
    if (!routeResult) throw new Error("Route result is missing");
    selected = parsePick(routeResult.pick);
  }
  if (routeResult && needsStoppingPoint(config, routeResult)) {
    const modelId = routeResult.pick.split("@", 1)[0];
    throw new Error(
      `${modelId} needs a stated stopping point: add success criteria and where to stop to the prompt, then call spawn again`,
    );
  }
  const guardrails =
    options.guardrails === false
      ? ""
      : guardrailsFor(
          await loadGuardrails(),
          `${selected.harness}:${selected.model}`,
        );
  const spawnPrompt = guardrails
    ? `${prompt}\n\n## Operating rules\n\n${guardrails}`
    : prompt;
  const confidenceNote = routeResult
    ? ` (confidence ${routeResult.confidence})`
    : " (caller override)";
  const routeScores = routeResult && "pick" in routeResult ? routeResult : null;
  const sandboxChoice =
    selected.harness === "codex"
      ? chooseCodexSandbox({
          configuredSandbox: config.spawn.codexSandbox,
          callerSandbox: options.sandbox,
          autoSandbox: config.spawn.autoSandbox,
          allowFullAccess: config.spawn.allowFullAccess,
          routingRan: routeScores !== null,
          needsNetwork: routeScores?.needsNetwork ?? null,
          needsBrowser: routeScores?.needsBrowser ?? null,
          needsFullAccess: routeScores?.needsFullAccess ?? null,
        })
      : null;
  const sandbox = sandboxChoice?.usesNetworkAccess
    ? `${sandboxChoice.sandbox}+network`
    : sandboxChoice?.sandbox;
  const sandboxNote = sandbox ? ` sandbox ${sandbox}` : "";
  const browser = shouldUseClaudeBrowser(
    selected.harness,
    options.browser,
    routeScores?.needsBrowser ?? null,
  );
  const sessionSettings = {
    browser,
    sandbox: sandboxChoice?.sandbox,
    usesNetworkAccess: sandboxChoice?.usesNetworkAccess,
  };
  deps.stderr(
    `Routed to ${selected.harness}:${selected.model}@${selected.effort}${confidenceNote}${sandboxNote}\n`,
  );
  printPassthroughNotes(selected.harness, options, deps);
  const adapter = getAdapter(selected.harness);
  const harnessOptions = await harnessOptionsFor(selected, cwd, config, {
    ...options,
    browser,
    codexSandbox: sandboxChoice?.sandbox,
    codexConfigOverrides: sandboxChoice?.usesNetworkAccess
      ? [CODEX_NETWORK_ACCESS_OVERRIDE]
      : undefined,
  });
  const command = adapter.buildSpawn(spawnPrompt, harnessOptions);
  if (options.detach) {
    const handle = createSessionHandle();
    const logPath = sessionLogPath(handle);
    let pid: number;
    let errPath: string;
    try {
      ({ pid, errPath } = await deps.runDetached(command.argv, cwd, logPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await createSession({
        ...selected,
        ...sessionSettings,
        cwd,
        sessionId: command.sessionId,
        prompt: spawnPrompt,
        status: SESSION_STATUS.failed,
        error: message,
        handle,
        logPath,
        usage: null,
        route: routeResult,
      });
      throw new Error(message);
    }
    await createSession({
      ...selected,
      ...sessionSettings,
      cwd,
      sessionId: command.sessionId,
      prompt: spawnPrompt,
      status: SESSION_STATUS.running,
      handle,
      pid,
      logPath,
      errPath,
      usage: null,
      route: routeResult,
    });
    deps.stdout(
      `${JSON.stringify({
        handle,
        ...selected,
        sandbox,
        route: routeResult,
        logPath,
      })}\n`,
    );
    await printUpdateNotice(config, routeResult?.availableModels ?? [], deps);
    deps.stderr("Spawn detached\n");
    deps.exit(SUCCESS_EXIT_CODE);
    return;
  }
  const parsed = adapter.parseSpawnOutput(
    await deps.runForeground(command.argv, cwd),
  );
  const sessionId = parsed.sessionId || command.sessionId;
  if (!sessionId)
    throw new Error("Harness output did not contain a session id");
  const session = await createSession({
    ...selected,
    ...sessionSettings,
    cwd,
    sessionId,
    prompt: spawnPrompt,
    status: SESSION_STATUS.done,
    result: parsed.result,
    lastResult: parsed.result,
    usage: parsed.usage,
    route: routeResult,
  });
  deps.stdout(
    `${JSON.stringify({
      handle: session.handle,
      ...selected,
      sandbox,
      route: routeResult,
      resumeCommand: adapter
        .buildResume(sessionId, '"<msg>"', harnessOptions)
        .argv.join(" "),
      ...resultOutput(parsed.result, resultLimit(options)),
      usage: parsed.usage,
    })}\n`,
  );
  await printUpdateNotice(config, routeResult?.availableModels ?? [], deps);
  deps.stderr("Spawn completed\n");
  deps.exit(SUCCESS_EXIT_CODE);
}

async function printUpdateNotice(
  config: Awaited<ReturnType<typeof loadConfig>>,
  availableModels: string[] = [],
  deps: CliDeps,
): Promise<void> {
  if (
    config.updates?.check === false ||
    process.env.SMART_ROUTER_NO_UPDATE_CHECK !== undefined
  )
    return;
  const update = await readUpdateNotice(version, deps.fetch, deps.now);
  if (update?.isNewer)
    deps.stderr(
      `smart-router ${update.latestVersion} is available; run smart-router update\n`,
    );
  if (availableModels.length)
    deps.stderr(
      `${NEW_MODELS_NOTICE} ${availableModels.join(";")}; run smart-router init --section models\n`,
    );
}

async function updateCommand(
  options: { check?: boolean },
  deps: CliDeps,
): Promise<void> {
  const result = await readUpdateNotice(version, deps.fetch, deps.now);
  if (!result)
    return printResult(
      deps,
      { error: "Could not check for updates" },
      "Update check failed",
      ERROR_EXIT_CODE,
    );
  if (options.check || !result.isNewer)
    return printResult(
      deps,
      { current: version, latest: result.latestVersion, updated: false },
      "Update check completed",
    );
  const refusal = updateRefusal(deps.execPath);
  if (refusal)
    return printResult(
      deps,
      { error: refusal },
      "Update refused",
      ERROR_EXIT_CODE,
    );
  await updateExecutable(result, deps.execPath, deps.fetch);
  return printResult(
    deps,
    { current: version, latest: result.latestVersion, updated: true },
    "Updated",
  );
}

async function sendCommand(
  handle: string,
  message: string,
  options: PassthroughOptions,
  deps: CliDeps,
): Promise<void> {
  const [config, session] = await Promise.all([
    loadConfig(),
    loadSession(handle),
  ]);
  if (session.status === SESSION_STATUS.running)
    throw new Error(`session ${handle} ${RUNNING_SESSION_ERROR}`);
  if (!session.sessionId)
    throw new Error(`session ${handle} has no session id`);
  printPassthroughNotes(session.harness, options, deps);
  const adapter = getAdapter(session.harness);
  const harnessOptions = await harnessOptionsFor(
    session,
    session.cwd,
    config,
    options,
  );
  const command = adapter.buildResume(
    session.sessionId,
    message,
    harnessOptions,
  );
  const parsed = adapter.parseResumeOutput(
    await deps.runForeground(command.argv, session.cwd),
  );
  session.result = parsed.result;
  session.lastResult = parsed.result;
  session.usage = addUsage(session.usage, parsed.usage);
  if (options.browser && session.harness === "claude") session.browser = true;
  await saveSession(session);
  return printResult(
    deps,
    {
      handle,
      ...resultOutput(parsed.result, resultLimit(options)),
      usage: parsed.usage,
    },
    "Message sent",
  );
}

async function harnessOptionsFor(
  selected: Pick | Session,
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: PassthroughOptions & { worktree?: boolean },
): Promise<HarnessOptions> {
  const schema =
    options.schema && selected.harness !== "pi"
      ? {
          path: options.schema,
          content: await readFile(options.schema, "utf8"),
        }
      : undefined;
  return {
    cwd,
    model: selected.model,
    effort: selected.effort,
    worktree: options.worktree,
    claudePermissionMode:
      options.permissionMode ?? config.spawn.claudePermissionMode,
    browser: options.browser || ("browser" in selected && selected.browser),
    codexSandbox:
      options.codexSandbox ??
      options.sandbox ??
      ("sandbox" in selected ? selected.sandbox : undefined) ??
      config.spawn.codexSandbox,
    codexConfigOverrides:
      options.codexConfigOverrides ??
      (!options.sandbox &&
      "usesNetworkAccess" in selected &&
      selected.usesNetworkAccess
        ? [CODEX_NETWORK_ACCESS_OVERRIDE]
        : undefined),
    allowedTools: options.allowedTools,
    schema,
    binary: harnessBinary(config, selected.harness),
  };
}

function printPassthroughNotes(
  harness: HarnessName,
  options: PassthroughOptions,
  deps: CliDeps,
): void {
  const ignored: string[] = [];
  if (options.permissionMode && harness !== "claude")
    ignored.push("--permission-mode");
  if (options.sandbox && harness !== "codex") ignored.push("--sandbox");
  if (options.browser && harness !== "claude") ignored.push("--browser");
  if (options.allowedTools && harness !== "claude")
    ignored.push("--allowed-tools");
  if (options.schema && harness === "pi") ignored.push("--schema");
  if (ignored.length)
    deps.stderr(`Ignored for ${harness}: ${ignored.join(", ")}\n`);
}

async function refreshSession(handle: string): Promise<Session> {
  const session = await loadSession(handle);
  if (session.status !== SESSION_STATUS.running || !session.pid) return session;
  if (isProcessRunning(session.pid)) return session;
  return completeSessionFromLog(
    session,
    getAdapter(session.harness).parseSpawnOutput,
  );
}

async function statusCommand(handle: string, deps: CliDeps): Promise<void> {
  const session = await refreshSession(handle);
  return printResult(
    deps,
    {
      ...session,
      running:
        session.status === SESSION_STATUS.running &&
        !!session.pid &&
        isProcessRunning(session.pid),
    },
    "Session status retrieved",
  );
}

async function logsCommand(
  handle: string,
  options: { tail?: string; err?: boolean },
  deps: CliDeps,
): Promise<void> {
  const session = await loadSession(handle);
  const logPath = options.err
    ? session.errPath
    : (session.logPath ?? sessionLogPath(handle));
  if (!logPath) throw new Error(`session ${handle} has no stderr log`);
  const output = await readFile(logPath, "utf8");
  const tail = options.tail ? Number(options.tail) : null;
  if (tail !== null && (!Number.isSafeInteger(tail) || tail < 0))
    throw new Error("--tail must be a non-negative integer");
  let result = output;
  if (tail === 0) result = "";
  if (tail !== null && tail > 0) {
    const lines = output.split("\n");
    if (lines.at(-1) === "") lines.pop();
    result = lines.slice(-tail).join("\n");
  }
  return printLog(deps, result);
}

async function waitCommand(
  handle: string,
  options: { resultLimit?: string },
  deps: CliDeps,
): Promise<void> {
  let session = await refreshSession(handle);
  while (session.status === SESSION_STATUS.running) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    session = await refreshSession(handle);
  }
  if (session.status === SESSION_STATUS.failed)
    return printResult(
      deps,
      { error: session.error ?? "Detached spawn failed" },
      "Spawn failed",
      ERROR_EXIT_CODE,
    );
  const config = await loadConfig();
  const resumeCommand = session.sessionId
    ? getAdapter(session.harness)
        .buildResume(
          session.sessionId,
          '"<msg>"',
          await harnessOptionsFor(session, session.cwd, config, {}),
        )
        .argv.join(" ")
    : undefined;
  return printResult(
    deps,
    {
      handle: session.handle,
      harness: session.harness,
      model: session.model,
      effort: session.effort,
      route: session.route,
      resumeCommand,
      ...resultOutput(
        session.lastResult ?? session.result ?? "",
        resultLimit(options),
      ),
      usage: session.usage,
    },
    "Spawn completed",
  );
}

async function stopCommand(handle: string, deps: CliDeps): Promise<void> {
  const session = await loadSession(handle);
  return printResult(
    deps,
    { ...(await stopSession(session)), running: false },
    "Session stopped",
  );
}

async function sessionsCommand(
  options: { all?: boolean },
  deps: CliDeps,
): Promise<void> {
  const sessions = await listSessions(options.all ? undefined : sessionOwner());
  return printResult(
    deps,
    sessions.map(
      ({
        handle,
        owner,
        status,
        harness,
        model,
        effort,
        createdAt,
        promptPreview,
      }) => ({
        handle,
        owner,
        status,
        harness,
        model,
        effort,
        createdAt,
        promptPreview,
      }),
    ),
    "Sessions listed",
  );
}

async function rmCommand(handle: string, deps: CliDeps): Promise<void> {
  await removeSession(handle);
  return printResult(deps, { removed: [handle] }, "Session removed");
}

async function pruneCommand(
  options: { olderThan?: string },
  deps: CliDeps,
): Promise<void> {
  if (options.olderThan === undefined)
    throw new Error(`${OLDER_THAN_OPTION} is required`);
  const removed = await pruneSessions(
    parseNonNegativeInteger(options.olderThan, OLDER_THAN_FLAG),
  );
  return printResult(deps, { removed }, "Sessions pruned");
}

export function buildProgram(deps: CliDeps = DEFAULT_DEPS): Command {
  const program = new Command().name("smart-router");
  program.version(version);
  program.configureOutput({
    writeOut: deps.stdout,
    writeErr: deps.stderr,
  });
  program.exitOverride();
  program
    .command("install-skill")
    .action(async () =>
      printResult(
        deps,
        { skillPath: await installSkill(deps.stderr) },
        "Skill installed",
      ),
    );
  program
    .command("doctor")
    .action(async () =>
      printResult(
        deps,
        await deps.doctor(await loadConfig()),
        "Doctor completed",
      ),
    );
  program
    .command("init")
    .option("--section <section>")
    .option("--reset")
    .action((options) => deps.runInit(options));
  program
    .command("route <prompt>")
    .option("--cwd <dir>")
    .option("--hint <text>")
    .option("--confidential")
    .option("--dry-run")
    .action((prompt, options) => routeCommand(prompt, options, deps));
  program
    .command("spawn <prompt>")
    .option("--cwd <dir>")
    .option("--hint <text>")
    .option("--confidential")
    .option("--dry-run")
    .option("--model <model>")
    .option("--effort <effort>")
    .option("--worktree")
    .option("--detach")
    .option("--permission-mode <mode>")
    .option("--browser")
    .option("--sandbox <policy>")
    .option("--allowed-tools <list>")
    .option("--schema <file>")
    .option(RESULT_LIMIT_OPTION)
    .option("--no-guardrails")
    .action((prompt, options) => spawnCommand(prompt, options, deps));
  program
    .command("send <handle> <message>")
    .option("--permission-mode <mode>")
    .option("--browser")
    .option("--sandbox <policy>")
    .option("--allowed-tools <list>")
    .option("--schema <file>")
    .option(RESULT_LIMIT_OPTION)
    .action((handle, message, options) =>
      sendCommand(handle, message, options, deps),
    );
  program
    .command("status <handle>")
    .action((handle) => statusCommand(handle, deps));
  program
    .command("logs <handle>")
    .option("--tail <n>")
    .option("--err")
    .action((handle, options) => logsCommand(handle, options, deps));
  program
    .command("wait <handle>")
    .option(RESULT_LIMIT_OPTION)
    .action((handle, options) => waitCommand(handle, options, deps));
  program
    .command("stop <handle>")
    .action((handle) => stopCommand(handle, deps));
  program
    .command("sessions")
    .option(ALL_OPTION)
    .action((options) => sessionsCommand(options, deps));
  program.command("rm <handle>").action((handle) => rmCommand(handle, deps));
  program
    .command("prune")
    .option(OLDER_THAN_OPTION)
    .action((options) => pruneCommand(options, deps));
  program.command("quota").action(async () => {
    const result = await deps.getQuota(await loadConfig());
    return printResult(
      deps,
      result,
      "Quota retrieved",
      "error" in result ? ERROR_EXIT_CODE : SUCCESS_EXIT_CODE,
    );
  });
  program
    .command("update")
    .option("--check")
    .action((options) => updateCommand(options, deps));
  return program;
}

export async function runCli(
  argv: string[],
  deps: CliDeps = DEFAULT_DEPS,
): Promise<void> {
  try {
    await loadDotEnv(configDir());
    await loadDotEnv(process.cwd());
    await buildProgram(deps).parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      deps.exit(Number("exitCode" in error ? error.exitCode : ERROR_EXIT_CODE));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    printResult(deps, { error: message }, message, ERROR_EXIT_CODE);
  }
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

if (import.meta.main) void main();
