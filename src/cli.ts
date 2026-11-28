#!/usr/bin/env bun
import { attachT3Session, sendT3Session, t3Result, T3_NO_LOG } from "./t3.ts";
import {
  armWake,
  cancelWakes,
  watchWake,
  claimWake,
  hasUnsettledWakes,
  WAKE_COMMAND,
  WAIT_POLL_INTERVAL_MS,
  WakeCapacityError,
  sessionEnvironment,
} from "./wakes.ts";
import { LOG_FOLLOW_INTERVAL_MS } from "./events.ts";
import {
  createSessionEventStream,
  sessionStatus,
  sessionSummary,
} from "./session-view.ts";
import { existingDashboard, startDashboard } from "./dashboard.ts";
import { Command, CommanderError } from "commander";
import { existsSync, writeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { version } from "./assets.ts";
import { installSkill } from "./install.ts";
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PER_CALLER,
  DEFAULT_MAX_RUNNING,
  DIRECT_MODEL_DENY,
  harnessBinary,
  type Config,
  type HarnessName,
  loadConfig,
} from "./config.ts";
import { doctor } from "./doctor.ts";
import { loadDotEnv } from "./env.ts";
import * as codex from "./harness/codex.ts";
import { verifyConfinedCodex } from "./harness/codex-confined.ts";
import {
  confinedCodexToolPolicy,
  confinedAllowedTools,
  intersectAllowedTools,
  parseToolList,
  writeConfinedMcpConfig,
} from "./harness/mcp.ts";
import { getAdapter } from "./harness/index.ts";
import {
  record,
  ProviderRefusalError,
  turnUsage,
  type HarnessOptions,
  type ParsedOutput,
} from "./harness/types.ts";
import { runInit } from "./init.ts";
import {
  codexbarCostUsd,
  getQuota,
  GUARD_QUOTA_MAX_AGE_MS,
  readCachedQuota,
} from "./quota.ts";
import {
  guardInputFromHook,
  guardSubagent,
  hookOutput,
  NATIVE_SUBAGENT_LOG,
  type GuardInput,
} from "./guard.ts";
import { isMissingFile } from "./files.ts";
import { retriesByOriginal } from "./outcomes.ts";
import { loadPricing } from "./pricing.ts";
import {
  exportLines,
  formatStats,
  statsEntries,
  statsReport,
  statsWindow,
} from "./stats.ts";
import {
  appendAuditLine,
  PIN_WARNINGS_LOG,
  readAuditLines,
} from "./audit-log.ts";
import { configDir } from "./paths.ts";
import {
  readUpdateNotice,
  refreshUpdateNotice,
  updateExecutable,
  updateRefusal,
} from "./update.ts";
import { guardrailsFor, loadGuardrails } from "./guardrails.ts";
import {
  CODEX_NETWORK_ACCESS_OVERRIDE,
  CODEX_WORKSPACE_WRITE_SANDBOX,
  chooseCodexSandbox,
  defaultRouteDeps,
  isStrongerEffort,
  needsStoppingPoint,
  pinnedRoute,
  previousAttemptFrom,
  route,
  shouldUseClaudeBrowser,
  type RouteOptions,
  type RouteRecord,
} from "./route.ts";
import { runDetached, runForeground } from "./runner.ts";
import {
  listenForSteer,
  notRunningError,
  steerSupervisedSession,
  SUPERVISE_COMMAND,
  superviseSession,
  supervisorCommand,
  workerCommand,
} from "./supervisor.ts";
import {
  addUsage,
  createSessionHandle,
  createSession,
  logActivity,
  listSessions,
  loadSession,
  pruneSessions,
  removeSession,
  saveSession,
  saveTerminalSession,
  recordSessionFailure,
  startSessionTurn,
  finishSessionTurn,
  finishSessionTurnFromLog,
  sessionLogPath,
  sessionMcpPath,
  sessionSocketPath,
  sessionOwner,
  SESSION_STATUS,
  stopSession,
  updateSession,
  readSessionPrompt,
  terminateSessionProcess,
  sweepSessions,
  processStartTime,
  withSessionsLock,
  type Session,
} from "./sessions.ts";

const SPAWN_TURN_COMMAND = "__spawn-turn";
const ERROR_EXIT_CODE = 1;
const CAPACITY_EXIT_CODE = 3;
const SUCCESS_EXIT_CODE = 0;
const TIMEOUT_EXIT_CODE = 124;
const HARNESS_NAMES: HarnessName[] = ["claude", "codex", "pi"];

type SpawnOptions = RouteOptions & {
  model?: string;
  effort?: string;
  worktree?: boolean;
  guardrails?: boolean;
  detach?: boolean;
  permissionMode?: string;
  browser?: boolean;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  sandbox?: string;
  allowedTools?: string;
  disallowedTools?: string[];
  tools?: string;
  confined?: boolean;
  appendSystemPromptFile?: string;
  schema?: string;
  resultLimit?: string;
  waitForSlot?: string;
  events?: boolean;
  label?: string;
  phase?: string;
};
type PassthroughOptions = {
  events?: boolean;
  permissionMode?: string;
  browser?: boolean;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  sandbox?: string;
  allowedTools?: string;
  disallowedTools?: string[];
  tools?: string;
  confined?: boolean;
  appendSystemPromptFile?: string;
  schema?: string;
  resultLimit?: string;
  codexSandbox?: string;
  codexConfigOverrides?: string[];
};
type Pick = { harness: HarnessName; model: string; effort: string };
const MISSING_CONFINED_ALLOWLIST_ERROR =
  "confined session has no stored allowlist; start a new session";
const RUNNING_SESSION_ERROR = "is still running; wait or stop it first";
const DEFAULT_RESULT_LIMIT: number | undefined = undefined;
const RESULT_LIMIT_FLAG = "--result-limit";
const RESULT_LIMIT_OPTION = `${RESULT_LIMIT_FLAG} <chars>`;
const ALL_OPTION = "--all";
const OLDER_THAN_FLAG = "--older-than";
const OLDER_THAN_OPTION = `${OLDER_THAN_FLAG} <days>`;
const NEW_MODELS_NOTICE = "New models available:";
const SLOT_POLL_INTERVAL_MS = 50;
const OWNER_ENVIRONMENT_VARIABLE = "SMART_ROUTER_OWNER";
const DEPTH_ENVIRONMENT_VARIABLE = "SMART_ROUTER_DEPTH";
const HANDLE_ENVIRONMENT_VARIABLE = "SMART_ROUTER_HANDLE";
const ANCESTORS_ENVIRONMENT_VARIABLE = "SMART_ROUTER_ANCESTORS";
const WAIT_TIMEOUT_OPTION = "--timeout <seconds>";
const DELEGATE_WAIT_TIMEOUT_SECONDS = 90;
const MCP_CONFIG_FLAG = "--mcp-config";
const MCP_CONFIG_OPTION = `${MCP_CONFIG_FLAG} <file>`;
const STRICT_MCP_CONFIG_FLAG = "--strict-mcp-config";
const OUTPUT_RETRY_INTERVAL_MS = 1;
const LABEL_FLAG = "--label";
const PHASE_FLAG = "--phase";
const DISPLAY_NAME_MAX_LENGTH = 80;
// Claude Code permission modes from the one that allows least to the one that allows most.
const PERMISSION_MODES_NARROWEST_FIRST = [
  "plan",
  "default",
  "acceptEdits",
  "bypassPermissions",
];

function writeOutput(descriptor: number, text: string): void {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(descriptor, buffer, offset);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EAGAIN"
      )
        throw error;
      // Bun makes stdout/stderr nonblocking when their streams are initialized.
      Bun.sleepSync(OUTPUT_RETRY_INTERVAL_MS);
    }
  }
}

function collectMcpConfig(path: string, paths: string[] = []): string[] {
  return [...paths, resolve(path)];
}

function collectToolList(value: string, previous = ""): string {
  return [
    ...new Set([...parseToolList(previous), ...parseToolList(value)]),
  ].join(",");
}

function collectDeniedTools(value: string, previous: string[] = []): string[] {
  return parseToolList(collectToolList(value, previous.join(",")));
}

function validateToolPolicy(
  harness: HarnessName | undefined,
  options: PassthroughOptions,
): void {
  if (options.confined && options.tools)
    throw new Error("native tools are disabled in confined mode");
  if (!harness || harness === "claude") return;
  if (options.confined && harness === "codex") {
    confinedCodexToolPolicy(
      options.disallowedTools ?? [],
      options.allowedTools,
    );
    return;
  }
  if (options.confined)
    throw new Error("confined mode needs Claude or verified Codex");
  if (options.disallowedTools?.length)
    throw new Error("--disallowedTools needs a Claude model");
  if (options.tools !== undefined)
    throw new Error("--tools needs a Claude model");
  if (options.appendSystemPromptFile && harness === "pi")
    throw new Error("--append-system-prompt-file is not supported by pi");
}

function checkedConfinedCodex(
  config: Config,
  deps: CliDeps,
  cwd: string,
): string[] {
  try {
    return (deps.verifyConfinedCodex ?? verifyConfinedCodex)(
      harnessBinary(config, "codex"),
      cwd,
    );
  } catch (error) {
    const failure =
      error instanceof Error ? error.message : "Codex confinement probe failed";
    const reason = failure.includes("upgrade codex")
      ? failure
      : `${failure}; upgrade codex`;
    deps.stderr(`WARNING: Codex confined-mode tripwire: ${reason}\n`);
    throw new Error(reason);
  }
}

async function prepareConfinedMcp(
  session: Session,
  harnessOptions: HarnessOptions,
  deps: CliDeps,
): Promise<void> {
  if (!session.confined) return;
  const path = sessionMcpPath(session.handle);
  const dropBridge =
    session.harness === "codex" &&
    confinedCodexToolPolicy(session.disallowedTools ?? [], session.allowedTools)
      .dropServer;
  const hasServer = await writeConfinedMcpConfig(
    session.mcpConfig ?? [],
    path,
    dropBridge,
  );
  if (!hasServer)
    deps.stderr(
      "Warning: no openclaw MCP server; confined child has no tools\n",
    );
  harnessOptions.mcpConfig = [path];
}

type CapacityLimit = "maxRunning" | "maxPerCaller" | "maxDepth";

export type CliDeps = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
  runForeground: typeof runForeground;
  verifyConfinedCodex?: typeof verifyConfinedCodex;
  armWake?: typeof armWake;
  runDetached: typeof runDetached;
  which?: (binary: string) => string | null;
  fetch: (url: string) => Promise<Response>;
  now: () => number;
  execPath: string;
  routeDeps: typeof defaultRouteDeps;
  doctor: typeof doctor;
  getQuota: typeof getQuota;
  readStdin?: () => Promise<string>;
  loadPricing?: typeof loadPricing;
  codexbarCostUsd?: typeof codexbarCostUsd;
  runInit: (options: Parameters<typeof runInit>[0]) => Promise<void>;
};

const DEFAULT_DEPS: CliDeps = {
  stdout: (text) => writeOutput(1, text),
  stderr: (text) => writeOutput(2, text),
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

function parseDisplayName(
  value: string | undefined,
  flag: string,
): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (!name) throw new Error(`${flag} must not be empty`);
  if (/[\p{Cc}]/u.test(name))
    throw new Error(`${flag} must be one line without control characters`);
  if (name.length > DISPLAY_NAME_MAX_LENGTH)
    throw new Error(
      `${flag} must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
    );
  return name;
}

function currentDepth(): number {
  const depth = Number(process.env[DEPTH_ENVIRONMENT_VARIABLE] ?? 0);
  return Number.isSafeInteger(depth) && depth >= 0 ? depth : 0;
}

function capacityOutput(
  limit: CapacityLimit,
  callerSessions: Session[],
  otherOwnersRunning: number,
) {
  let next =
    "wait on one of these handles with smart-router wait <handle>, or stop one";
  if (limit === "maxDepth")
    next = "delegates at this depth must do the work themselves";
  else if (limit === "maxRunning" && callerSessions.length === 0)
    next =
      "global slots are held by other sessions; retry later or pass --wait-for-slot <seconds>";
  return {
    error: "capacity" as const,
    limit,
    otherOwnersRunning,
    running: callerSessions.map(
      ({ handle, model, createdAt, promptPreview }) => ({
        handle,
        model,
        createdAt,
        promptPreview,
      }),
    ),
    next,
  };
}

async function reserveSpawnSession(
  options: Omit<Parameters<typeof createSession>[0], "status" | "depth">,
  config: Config,
  waitForSlot: string | undefined,
  deps: CliDeps,
  existingSession?: Session,
  wakeId?: string,
): Promise<Session | ReturnType<typeof capacityOutput>> {
  const owner = existingSession?.owner ?? sessionOwner();
  const depth = existingSession?.depth ?? currentDepth() + 1;
  const limits = config.rules.concurrency ?? {
    maxRunning: DEFAULT_MAX_RUNNING,
    maxPerCaller: DEFAULT_MAX_PER_CALLER,
    maxDepth: DEFAULT_MAX_DEPTH,
  };
  const waitSeconds =
    waitForSlot === undefined ? undefined : Number(waitForSlot);
  if (
    waitSeconds !== undefined &&
    (!Number.isFinite(waitSeconds) || waitSeconds < 0)
  )
    throw new Error("--wait-for-slot must be a non-negative number");
  const deadline = deps.now() + (waitSeconds ?? 0) * 1_000;
  while (true) {
    let capacity: ReturnType<typeof capacityOutput> | undefined;
    await sweepSessions();
    const session = await withSessionsLock(async () => {
      if (existingSession) {
        const stored = await loadSession(existingSession.handle);
        if (stored.status === SESSION_STATUS.running)
          throw new Error(
            `session ${existingSession.handle} ${RUNNING_SESSION_ERROR}`,
          );
        if (stored.confined && stored.allowedTools === undefined)
          throw new Error(MISSING_CONFINED_ALLOWLIST_ERROR);
        existingSession.allowedTools = intersectAllowedTools(
          stored.allowedTools,
          existingSession.allowedTools,
        );
        existingSession.confined =
          stored.confined || existingSession.confined || options.confined;
        existingSession.disallowedTools = [
          ...new Set([
            ...(stored.disallowedTools ?? []),
            ...(existingSession.disallowedTools ?? []),
            ...(options.disallowedTools ?? []),
          ]),
        ];
      }
      const running = (await listSessions()).filter(
        ({ status, runner }) =>
          runner !== "t3" && status === SESSION_STATUS.running,
      );
      const callerSessions = running.filter(
        (session) => session.owner === owner,
      );
      let limit: CapacityLimit | undefined;
      if (depth > limits.maxDepth) limit = "maxDepth";
      else if (running.length >= limits.maxRunning) limit = "maxRunning";
      else if (callerSessions.length >= limits.maxPerCaller)
        limit = "maxPerCaller";
      if (limit) {
        capacity = capacityOutput(
          limit,
          callerSessions,
          running.length - callerSessions.length,
        );
        return undefined;
      }
      if (existingSession) {
        existingSession.wakes = (
          await loadSession(existingSession.handle)
        ).wakes;
        if (wakeId) claimWake(existingSession, wakeId);
        await startSessionTurn(existingSession, "resumed");
        existingSession.status = SESSION_STATUS.running;
        existingSession.error = undefined;
        existingSession.failureKind = undefined;
        existingSession.next = undefined;
        existingSession.hasFollowUp = true;
        existingSession.pid = undefined;
        existingSession.childExitedAt = undefined;
        existingSession.supervisorPid = undefined;
        existingSession.supervisorProcessStartTime = undefined;
        existingSession.processStartTime = undefined;
        existingSession.wrapperPid = process.pid;
        existingSession.wrapperProcessStartTime = processStartTime(process.pid);
        await saveSession(existingSession, wakeId ? "claim" : "session");
        return existingSession;
      }
      return createSession({
        ...options,
        status: SESSION_STATUS.running,
        depth,
      });
    });
    if (session) return session;
    if (!capacity) throw new Error("Capacity check failed");
    const shouldWait =
      capacity.limit !== "maxDepth" &&
      waitSeconds !== undefined &&
      deps.now() < deadline;
    if (!shouldWait) return capacity;
    await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_INTERVAL_MS));
  }
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

function rejectOwnOrAncestor(command: string, handle: string): void {
  const ancestors = (process.env[ANCESTORS_ENVIRONMENT_VARIABLE] ?? "")
    .split(",")
    .filter(Boolean);
  if (
    handle === process.env[HANDLE_ENVIRONMENT_VARIABLE] ||
    ancestors.includes(handle)
  )
    throw new Error(
      `refusing to ${command} ${handle}: it is your own session or an ancestor; report your result instead`,
    );
}

function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const details = record(error);
  return {
    error: error.message,
    failureKind: details?.failureKind,
    next: details?.next,
    handle: details?.handle,
    lastMessage:
      typeof details?.lastMessage === "string" ? details.lastMessage : null,
    lastAction:
      typeof details?.lastAction === "string" ? details.lastAction : null,
  };
}

function parseForegroundOutput(
  output: string,
  parseOutput: (output: string) => ParsedOutput,
): ParsedOutput {
  try {
    return parseOutput(output);
  } catch (error) {
    const existingDetails = record(error);
    const activity = logActivity(output);
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      {
        lastMessage:
          (typeof existingDetails?.lastMessage === "string" &&
            existingDetails.lastMessage) ||
          activity.lastMessage,
        lastAction:
          (typeof existingDetails?.lastAction === "string" &&
            existingDetails.lastAction) ||
          activity.lastAction,
      },
    );
  }
}

function storeFailureActivity(session: Session, error: unknown): void {
  recordSessionFailure(session, error);
  const details = record(error);
  if (typeof details?.lastMessage === "string")
    session.lastMessage = details.lastMessage;
  if (typeof details?.lastAction === "string")
    session.lastAction = details.lastAction;
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

function autoHarness(modelId?: string): HarnessName | undefined {
  if (!modelId) return undefined;
  const [harness, model] = parseHarness(modelId);
  return model === "auto" ? harness : undefined;
}

function enabledModel(modelId: string, effort: string, config: Config) {
  parseHarness(modelId);
  const enabledModels = config.models.filter(
    (candidate) => config.harnesses[candidate.harness]?.enabled,
  );
  const selectedModel = enabledModels.find(({ id }) => id === modelId);
  if (!selectedModel)
    throw new Error(
      `${modelId} is not an enabled model; enabled: ${enabledModels.map(({ id }) => id).join(", ")}; run smart-router init --section models`,
    );
  if (!selectedModel.efforts.includes(effort))
    throw new Error(
      `${effort} is not supported by ${modelId}; supported: ${selectedModel.efforts.join(", ")}; run smart-router init --section models`,
    );
  return selectedModel;
}

function directPick(modelId: string, effort: string, config: Config): Pick {
  const { harness, model } = enabledModel(modelId, effort, config);
  return { harness, model, effort };
}

async function buildLaunch(
  prompt: string,
  selected: Pick,
  options: SpawnOptions,
  config: Config,
  routeRecord: RouteRecord,
  retry?: RetryContext,
) {
  const cwd = options.cwd ?? process.cwd();
  const guardrails =
    options.guardrails === false
      ? ""
      : guardrailsFor(
          await loadGuardrails(),
          `${selected.harness}:${selected.model}`,
        );
  const promptWithGuardrails = guardrails
    ? `${prompt}\n\n## Operating rules\n\n${guardrails}`
    : prompt;
  const original = retry?.original;
  // A retry runs in the sandbox its original ran in unless the caller names one or it is confined;
  // the task scores are not asked again, so a retry cannot drift into a wider sandbox.
  const inheritedSandbox =
    original?.sandbox && !options.sandbox && !options.confined
      ? {
          sandbox: original.sandbox,
          usesNetworkAccess: original.usesNetworkAccess ?? false,
        }
      : undefined;
  const chosenSandbox = () =>
    inheritedSandbox ??
    chooseCodexSandbox({
      configuredSandbox: config.spawn.codexSandbox,
      callerSandbox: options.confined ? "read-only" : options.sandbox,
      autoSandbox: config.spawn.autoSandbox,
      allowFullAccess: config.spawn.allowFullAccess,
      codexLocalhostNeedsNetwork: config.spawn.codexLocalhostNeedsNetwork,
      routingRan: routeRecord.kind !== "pinned",
      needsNetwork: routeRecord.needsNetwork,
      needsBrowser: routeRecord.needsBrowser,
      needsFullAccess: routeRecord.needsFullAccess,
    });
  const sandboxChoice = selected.harness === "codex" ? chosenSandbox() : null;
  const sandbox = sandboxChoice?.usesNetworkAccess
    ? `${sandboxChoice.sandbox}+network`
    : sandboxChoice?.sandbox;
  const toolchainNote = sandboxChoice
    ? [
        codex.codexToolchainNote(cwd, sandboxChoice.sandbox),
        codex.codexGpgSigningNote(cwd, sandboxChoice.sandbox),
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const spawnPrompt = toolchainNote
    ? `${promptWithGuardrails}\n\n${toolchainNote}`
    : promptWithGuardrails;
  const browser =
    !options.confined &&
    shouldUseClaudeBrowser(
      selected.harness,
      options.browser,
      routeRecord.needsBrowser,
    );
  return {
    prompt: spawnPrompt,
    sandbox,
    sandboxChoice,
    // What the run was given, saved on the session so a resume or an audit can read it back.
    sessionSettings: {
      browser,
      sandbox: sandboxChoice?.sandbox,
      usesNetworkAccess: sandboxChoice?.usesNetworkAccess,
    },
  };
}

type RetryContext = { original: Session; up: boolean; note?: string };

function retryRouteOptions(
  retry: RetryContext | undefined,
): Partial<RouteOptions> {
  if (!retry) return {};
  const { original } = retry;
  return {
    previousAttempt: previousAttemptFrom(original, retry.note),
    strongerThan: retry.up
      ? {
          modelId: `${original.harness}:${original.model}`,
          effort: original.effort,
        }
      : undefined,
  };
}

function retrySessionFields(retry: RetryContext | undefined) {
  if (!retry) return {};
  return {
    retryOf: retry.original.handle,
    escalated: retry.up ? true : undefined,
  };
}

function printRouteNotes(routeRecord: RouteRecord, deps: CliDeps): void {
  deps.stderr(`Route: ${routeRecord.reason}\n`);
  for (const warning of routeRecord.warnings)
    deps.stderr(`Warning: ${warning}\n`);
}

function delegateWaitingNote(
  harness: HarnessName,
  handle = '"$SMART_ROUTER_HANDLE"',
): string {
  return harness === "codex"
    ? "Processes you start in the background are stopped when the command that started them ends, so you can't leave work running past your turn. Run long work in the foreground; if it can't finish within your turn, say so in your final message."
    : `Work that must outlive your turn should, where possible, run as a background task that your harness waits for. If work must be detached (nohup or setsid), run \`smart-router wake ${handle} --after-pid <pid>\` before ending your turn, and say in your final message that a wake is armed.`;
}

async function routeCommand(
  prompt: string,
  options: RouteOptions & {
    model?: string;
    launch?: boolean;
    label?: string;
    phase?: string;
  },
  deps: CliDeps,
  retry?: RetryContext,
): Promise<void> {
  const config = await loadConfig();
  const harnessOnly = autoHarness(options.model);
  if (options.model && !harnessOnly)
    throw new Error("route --model must be harness:auto");
  const result = await route(
    prompt,
    { ...options, harnessOnly, ...retryRouteOptions(retry) },
    deps.routeDeps(config),
  );
  let output: unknown = result;
  if (options.launch) {
    if (!("pick" in result))
      throw new Error("--launch cannot be combined with --dry-run");
    if (needsStoppingPoint(config, result))
      throw new Error(
        `${result.pick.split("@", 1)[0]} needs a stated stopping point: add success criteria and where to stop to the prompt, then call route --launch again`,
      );
    const selected = parsePick(result.pick);
    const launch = await buildLaunch(
      prompt,
      selected,
      options,
      config,
      result,
      retry,
    );
    const session = await withSessionsLock(() =>
      createSession({
        ...selected,
        ...launch.sessionSettings,
        ...retrySessionFields(retry),
        runner: "t3",
        t3ThreadId: "",
        status: SESSION_STATUS.launched,
        cwd: resolve(options.cwd ?? process.cwd()),
        prompt,
        label: parseDisplayName(options.label, LABEL_FLAG),
        phase: parseDisplayName(options.phase, PHASE_FLAG),
        parentHandle: process.env[HANDLE_ENVIRONMENT_VARIABLE],
        depth: currentDepth() + 1,
        route: result,
      }),
    );
    launch.prompt += `\n\nYour smart-router handle is ${session.handle}.\n${delegateWaitingNote(selected.harness, session.handle)}`;
    output = {
      ...result,
      launch: {
        ...selected,
        handle: session.handle,
        prompt: launch.prompt,
        sandbox: launch.sandbox ?? null,
        browser: launch.sessionSettings.browser,
      },
    };
  }
  deps.stdout(`${JSON.stringify(output)}\n`);
  if ("pick" in result) printRouteNotes(result, deps);
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
  retry?: RetryContext,
): Promise<void> {
  const label = parseDisplayName(options.label, LABEL_FLAG);
  const phase = parseDisplayName(options.phase, PHASE_FLAG);
  await sweepSessions();
  const config = await loadConfig();
  const harnessOnly = autoHarness(options.model);
  const directModel = options.model && !harnessOnly;
  if (
    config.rules.directModel === DIRECT_MODEL_DENY &&
    (directModel || options.effort)
  )
    throw new Error(
      'direct model picks are disabled by rules.directModel; let the router choose and pass escalation context with --hint, for example --hint "escalate: previous attempt on codex:gpt-6-luna failed: <why>"',
    );
  validateToolPolicy(
    options.model ? parseHarness(options.model)[0] : undefined,
    options,
  );
  // Only Claude enforces an allow-list, so a retry that inherited one must stay on Claude.
  const inheritsAllowList =
    retry !== undefined && options.allowedTools !== undefined;
  const claudeOnly =
    !options.confined &&
    (Boolean(options.disallowedTools?.length) ||
      options.tools !== undefined ||
      inheritsAllowList);
  const cwd = options.cwd ?? process.cwd();
  let confinedCodexAvailable = false;
  let confinedCodexFailure: string | undefined;
  if (options.confined && config.harnesses.codex?.enabled) {
    try {
      validateToolPolicy("codex", options);
      checkedConfinedCodex(config, deps, cwd);
      confinedCodexAvailable = true;
    } catch (error) {
      confinedCodexFailure =
        error instanceof Error
          ? error.message
          : "Codex confinement probe failed; upgrade codex";
      if (options.model?.startsWith("codex:")) throw error;
    }
  }
  const routeDeps = deps.routeDeps(config);
  let routeResult: RouteRecord;
  let selected: Pick;
  if (options.model && directModel) {
    const effort = options.effort ?? config.defaultEffort;
    const pinnedModel = enabledModel(options.model, effort, config);
    selected = {
      harness: pinnedModel.harness,
      model: pinnedModel.model,
      effort,
    };
    routeResult = await pinnedRoute(pinnedModel, effort, options, routeDeps);
    if (routeResult.warnings.length)
      await appendAuditLine(PIN_WARNINGS_LOG, {
        ts: new Date(deps.now()).toISOString(),
        model: options.model,
        warnings: routeResult.warnings,
        ran: !options.dryRun,
      });
  } else {
    const routed = await route(
      prompt,
      {
        ...options,
        dryRun: false,
        claudeOnly,
        harnessOnly,
        confinedCodexAvailable,
        confinedCodexFailure,
        ...retryRouteOptions(retry),
      },
      routeDeps,
    );
    if (!("pick" in routed))
      throw new Error("Cannot spawn from a dry-run route");
    routeResult = routed;
    selected = parsePick(routeResult.pick);
    if (options.effort) {
      const sameModelAsOriginal =
        retry?.original.harness === selected.harness &&
        retry.original.model === selected.model;
      // On the same model only a higher effort is an escalation; a higher-tier model is stronger at any effort.
      if (
        retry?.up &&
        sameModelAsOriginal &&
        !isStrongerEffort(options.effort, retry.original.effort)
      )
        throw new Error(
          `--effort ${options.effort} is not stronger than the previous attempt (${selected.harness}:${selected.model}@${retry.original.effort}); pass a higher effort or drop --effort`,
        );
      selected = directPick(
        `${selected.harness}:${selected.model}`,
        options.effort,
        config,
      );
      routeResult.pick = `${selected.harness}:${selected.model}@${selected.effort}`;
    }
  }
  if (needsStoppingPoint(config, routeResult)) {
    const modelId = routeResult.pick.split("@", 1)[0];
    throw new Error(
      `${modelId} needs a stated stopping point: add success criteria and where to stop to the prompt, then call spawn again`,
    );
  }
  if (options.dryRun) {
    printRouteNotes(routeResult, deps);
    return printResult(deps, routeResult, "Spawn dry run completed");
  }
  const handle = createSessionHandle();
  const depth = currentDepth() + 1;
  const context =
    options.guardrails === false
      ? ""
      : `## Delegation context\n\nYour smart-router handle is ${handle} at depth ${depth} of max ${config.rules.concurrency?.maxDepth ?? DEFAULT_MAX_DEPTH}; if that depth equals the maximum you cannot spawn and must do the work yourself. Never wait on, stop, send to or steer your own handle or an ancestor. If you spawn a helper, use --detach and then \`smart-router wait <child> --timeout ${DELEGATE_WAIT_TIMEOUT_SECONDS}\` in a loop, polling, and report what you have if it is still running. A shell command returning early (a yield) is not completion; check status instead.`;
  const waitingNote = delegateWaitingNote(selected.harness);
  const promptWithContext = [prompt, context, waitingNote]
    .filter(Boolean)
    .join("\n\n");
  const {
    prompt: spawnPrompt,
    sandbox,
    sandboxChoice,
    sessionSettings: launchSettings,
  } = await buildLaunch(
    promptWithContext,
    selected,
    options,
    config,
    routeResult,
    retry,
  );
  const pinned = routeResult.kind === "pinned";
  const confidenceNote = pinned
    ? " (caller override)"
    : ` (confidence ${routeResult.confidence})`;
  const sandboxNote = sandbox ? ` sandbox ${sandbox}` : "";
  const browser = launchSettings.browser;
  const sessionSettings = {
    ...launchSettings,
    confined: options.confined,
    confidential: options.confidential,
    disallowedTools: options.disallowedTools,
    mcpConfig: options.mcpConfig,
    strictMcpConfig: options.strictMcpConfig,
    permissionMode: options.permissionMode,
  };
  deps.stderr(
    `Routed to ${selected.harness}:${selected.model}@${selected.effort}${confidenceNote}${sandboxNote}\n`,
  );
  printRouteNotes(routeResult, deps);
  printPassthroughNotes(selected.harness, options, deps);
  const harnessOptions = await harnessOptionsFor(
    selected,
    cwd,
    config,
    {
      ...options,
      browser,
      codexSandbox: sandboxChoice?.sandbox,
      codexConfigOverrides: sandboxChoice?.usesNetworkAccess
        ? [CODEX_NETWORK_ACCESS_OVERRIDE]
        : undefined,
    },
    deps,
  );
  const logPath = sessionLogPath(handle);
  const reservation = await reserveSpawnSession(
    {
      ...selected,
      ...sessionSettings,
      ...retrySessionFields(retry),
      allowedTools: harnessOptions.allowedTools,
      cwd,
      prompt: spawnPrompt,
      taskPrompt: prompt,
      handle,
      label,
      phase,
      parentHandle: process.env[HANDLE_ENVIRONMENT_VARIABLE],
      logPath,
      wrapperPid: options.detach ? undefined : process.pid,
      wrapperProcessStartTime: options.detach
        ? undefined
        : processStartTime(process.pid),
      usage: null,
      turnKind: pinned ? "pinned" : "routed",
      route: routeResult,
    },
    config,
    options.waitForSlot,
    deps,
  );
  if ("limit" in reservation)
    return printResult(
      deps,
      reservation,
      `Capacity limit reached: ${reservation.limit}`,
      CAPACITY_EXIT_CODE,
    );
  const session = reservation;
  const environment = {
    ...process.env,
    [OWNER_ENVIRONMENT_VARIABLE]: session.owner,
    [DEPTH_ENVIRONMENT_VARIABLE]: String(session.depth ?? 1),
    [HANDLE_ENVIRONMENT_VARIABLE]: handle,
    [ANCESTORS_ENVIRONMENT_VARIABLE]: [
      ...(process.env[ANCESTORS_ENVIRONMENT_VARIABLE]?.split(",") ?? []),
      process.env[HANDLE_ENVIRONMENT_VARIABLE],
    ]
      .filter((ancestor): ancestor is string => Boolean(ancestor))
      .join(","),
  };
  if (options.detach) {
    try {
      const binary = harnessOptions.binary ?? selected.harness;
      if (!(deps.which ?? Bun.which)(binary))
        throw new Error(`Could not start: ${binary}`);
      // The worker takes the same lock before loading, so registration cannot overwrite its child pid.
      await withSessionsLock(async () => {
        const detached = await deps.runDetached(
          workerCommand(
            SPAWN_TURN_COMMAND,
            handle,
            spawnPrompt,
            JSON.stringify(options),
          ),
          cwd,
          logPath,
          environment,
        );
        session.pid = detached.pid;
        session.processStartTime = processStartTime(detached.pid);
        session.errPath = detached.errPath;
        await saveSession(session);
      });
    } catch (error) {
      session.status = SESSION_STATUS.failed;
      session.error = error instanceof Error ? error.message : String(error);
      await saveTerminalSession(session, "owner-turn");
      throw error;
    }
    if (options.events)
      return logsCommand(handle, { follow: true, events: true }, deps);
    deps.stdout(
      `${JSON.stringify({ handle, ...selected, sandbox, route: routeResult, logPath })}\n`,
    );
    await printUpdateNotice(config, routeResult.availableModels, deps);
    deps.stderr("Spawn detached\n");
    deps.exit(SUCCESS_EXIT_CODE);
    return;
  }
  const stream = eventStream(session, deps);
  let parsed: ParsedOutput;
  try {
    parsed = await runSpawnTurn(
      session,
      spawnPrompt,
      options,
      config,
      deps,
      environment,
      options.events ? stream.line : undefined,
    );
  } catch (error) {
    if (options.events) return stream.finish(session);
    throw error;
  }
  if (options.events) return stream.finish(session);
  deps.stdout(
    `${JSON.stringify({
      handle: session.handle,
      harness: session.harness,
      model: session.model,
      effort: session.effort,
      sandbox: session.usesNetworkAccess
        ? `${session.sandbox}+network`
        : session.sandbox,
      route: session.route,
      resumeCommand: session.confined
        ? `smart-router send ${handle} "<msg>"`
        : getAdapter(session.harness)
            .buildResume(
              session.sessionId ?? "",
              '"<msg>"',
              await harnessOptionsFor(session, cwd, config, options, deps),
            )
            .argv.join(" "),
      ...resultOutput(parsed.result, resultLimit(options)),
      usage: parsed.usage,
    })}\n`,
  );
  await printUpdateNotice(config, routeResult.availableModels, deps);
  deps.stderr("Spawn completed\n");
  deps.exit(SUCCESS_EXIT_CODE);
}

async function runSpawnTurn(
  session: Session,
  prompt: string,
  options: SpawnOptions,
  config: Config,
  deps: CliDeps,
  environment: NodeJS.ProcessEnv = process.env,
  onLine?: (line: string) => void,
): Promise<ParsedOutput> {
  while (true) {
    try {
      const adapter = getAdapter(session.harness);
      const harnessOptions = await harnessOptionsFor(
        session,
        session.cwd,
        config,
        options,
        deps,
      );
      await prepareConfinedMcp(session, harnessOptions, deps);
      const supervised = session.harness === "claude";
      const command = adapter.buildSpawn(prompt, {
        ...harnessOptions,
        streamInput: supervised,
      });
      session.sessionId = command.sessionId;
      await saveSession(session);
      const parsed = parseForegroundOutput(
        await runSteerableForeground(
          supervised
            ? supervisorCommand(session.handle, prompt, command.argv)
            : command.argv,
          session,
          harnessOptions,
          deps,
          { ...environment, ...command.env },
          onLine,
        ),
        adapter.parseSpawnOutput,
      );
      session.sessionId = parsed.sessionId || command.sessionId;
      if (!session.sessionId)
        throw new Error("Harness output did not contain a session id");
      session.status = SESSION_STATUS.done;
      session.result = parsed.result;
      session.lastResult = parsed.result;
      session.usage = addUsage(session.usage, parsed.usage);
      finishSessionTurn(session, parsed.usage);
      await saveTerminalSession(session);
      return parsed;
    } catch (error) {
      const stored = await loadSession(session.handle);
      recordSessionFailure(session, error);
      session.hasFollowUp ||= stored.hasFollowUp;
      const otherFamily = session.harness === "codex" ? "claude" : "codex";
      const canFallback =
        error instanceof ProviderRefusalError &&
        session.harness !== "pi" &&
        !session.hasFollowUp &&
        session.turns?.length === 1 &&
        session.route?.kind !== "refusal_fallback" &&
        stored.status === SESSION_STATUS.running;
      if (canFallback) {
        try {
          let confinedCodexAvailable = false;
          if (options.confined && otherFamily === "codex") {
            checkedConfinedCodex(config, deps, session.cwd);
            confinedCodexAvailable = true;
          }
          const claudeOnly =
            !options.confined &&
            Boolean(
              options.allowedTools !== undefined ||
              options.disallowedTools?.length ||
              options.tools !== undefined ||
              options.permissionMode !== undefined,
            );
          const routed = await route(
            await readSessionPrompt(session.handle),
            {
              ...options,
              cwd: session.cwd,
              dryRun: false,
              harnessOnly: otherFamily,
              claudeOnly,
              confinedCodexAvailable,
            },
            deps.routeDeps(config),
          );
          if (!("pick" in routed))
            throw new Error("Cannot spawn from a dry-run route");
          const selected = parsePick(routed.pick);
          const launch = await buildLaunch(
            prompt,
            selected,
            options,
            config,
            routed,
          );
          // Rebuild the harness settings, but send exactly the prompt the refused attempt received.
          await harnessOptionsFor(
            { ...session, ...selected, ...launch.sessionSettings },
            session.cwd,
            config,
            options,
            deps,
          );
          await withSessionsLock(async () => {
            const latest = await loadSession(session.handle);
            if (latest.status !== SESSION_STATUS.running || latest.hasFollowUp)
              throw new Error(
                "session stopped or received a follow-up during fallback routing",
              );
            await finishSessionTurnFromLog(session);
            await startSessionTurn(session, "routed");
            session.failureKind = undefined;
            session.next = undefined;
            Object.assign(session, selected, launch.sessionSettings);
            session.route = {
              ...routed,
              kind: "refusal_fallback",
              fellBack: true,
              reason: `provider refusal on ${stored.harness}:${stored.model}; ${routed.reason}`,
            };
            session.pid = undefined;
            session.processStartTime = undefined;
            session.supervisorPid = undefined;
            session.supervisorProcessStartTime = undefined;
            session.sessionId = undefined;
            await saveSession(session);
          });
          if (session.route) printRouteNotes(session.route, deps);
          continue;
        } catch (fallbackError) {
          deps.stderr(
            `Refusal fallback unavailable: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`,
          );
        }
      }
      session.status = SESSION_STATUS.failed;
      session.error = error instanceof Error ? error.message : String(error);
      storeFailureActivity(session, error);
      await saveTerminalSession(session, "owner-turn");
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        {
          handle: session.handle,
          failureKind: session.failureKind,
          next: session.next,
        },
      );
    }
  }
}

async function retryCommand(
  handle: string,
  options: SpawnOptions & { up?: boolean; note?: string; launch?: boolean },
  deps: CliDeps,
): Promise<void> {
  rejectOwnOrAncestor("retry", handle);
  const original = await t3Result(await refreshSession(handle));
  if (
    original.status === SESSION_STATUS.running ||
    original.status === SESSION_STATUS.launched
  )
    throw new Error(`session ${handle} ${RUNNING_SESSION_ERROR}`);
  if (options.up && options.model && !autoHarness(options.model))
    throw new Error(
      "--up lets the router pick a stronger model; drop the --model pin or use harness:auto",
    );
  const prompt = await readSessionPrompt(handle).catch((error: unknown) => {
    if (isMissingFile(error))
      throw new Error(
        `session ${handle} has no saved prompt (it was started before retry existed); spawn the task again`,
      );
    throw error;
  });
  const retry = { original, up: Boolean(options.up), note: options.note };
  const retryOptions = {
    ...options,
    ...inheritedRestrictions(original, options),
    cwd: options.cwd ?? original.cwd,
  };
  const carriesRestrictions =
    retryOptions.confined ||
    retryOptions.disallowedTools.length > 0 ||
    retryOptions.allowedTools !== undefined ||
    retryOptions.permissionMode !== undefined;
  // A T3 thread is run by T3, which cannot apply smart-router's confinement or tool limits.
  if (options.launch && carriesRestrictions)
    throw new Error(
      `session ${handle} ran with confinement, tool limits or a permission mode that a T3 launch cannot carry; retry without --launch`,
    );
  if (options.launch) return routeCommand(prompt, retryOptions, deps, retry);
  return spawnCommand(prompt, retryOptions, deps, retry);
}

// What the original was restricted by, merged with the caller's flags the way a resume merges them:
// confinement sticks, denied tools add up, allowed tools intersect. A retry is never less restricted.
function inheritedRestrictions(original: Session, options: SpawnOptions) {
  const savedMode = original.permissionMode;
  const requestedMode = options.permissionMode;
  // Both ranks must be known to call an override "not broader": an unlisted mode is refused, not guessed at.
  const keepsWithinSavedMode =
    savedMode === undefined ||
    requestedMode === undefined ||
    requestedMode === savedMode ||
    (PERMISSION_MODES_NARROWEST_FIRST.includes(savedMode) &&
      PERMISSION_MODES_NARROWEST_FIRST.includes(requestedMode) &&
      PERMISSION_MODES_NARROWEST_FIRST.indexOf(requestedMode) <
        PERMISSION_MODES_NARROWEST_FIRST.indexOf(savedMode));
  if (!keepsWithinSavedMode)
    throw new Error(
      `session ${original.handle} ran with --permission-mode ${savedMode}; a retry cannot broaden it to ${requestedMode}`,
    );
  return {
    confined: original.confined || options.confined,
    confidential: original.confidential || options.confidential,
    disallowedTools: [
      ...new Set([
        ...(original.disallowedTools ?? []),
        ...(options.disallowedTools ?? []),
      ]),
    ],
    allowedTools: intersectAllowedTools(
      original.allowedTools,
      options.allowedTools,
    ),
    mcpConfig: options.mcpConfig ?? original.mcpConfig,
    strictMcpConfig: options.strictMcpConfig ?? original.strictMcpConfig,
    browser: options.browser || original.browser,
    permissionMode: options.permissionMode ?? original.permissionMode,
  };
}

async function guardSubagentCommand(
  options: {
    harness?: string;
    hook?: string;
    subagentType?: string;
    model?: string;
    session?: string;
    cwd?: string;
  },
  deps: CliDeps,
): Promise<void> {
  // Exit 0 on every path: both harnesses block a tool call only on exit 2 or an explicit deny.
  let input: GuardInput = {
    harness: options.harness ?? "",
    subagentType: options.subagentType,
    model: options.model,
    sessionId: options.session,
    cwd: options.cwd,
  };
  if (options.hook) {
    try {
      input = guardInputFromHook(
        options.hook,
        await (deps.readStdin ?? (() => Bun.stdin.text()))(),
      );
    } catch {
      // An unreadable hook payload allows the call, like every other guard failure.
      return deps.exit(SUCCESS_EXIT_CODE);
    }
  }
  const decision = await guardSubagent(input, {
    loadConfig,
    readQuota: (config) =>
      readCachedQuota(config, GUARD_QUOTA_MAX_AGE_MS, {
        getQuota: deps.getQuota,
        now: deps.now,
      }),
    now: deps.now,
  });
  deps.stdout(
    options.hook ? hookOutput(decision) : `${JSON.stringify(decision)}\n`,
  );
  deps.exit(SUCCESS_EXIT_CODE);
}

async function rateCommand(
  handle: string,
  value: string,
  options: { note?: string },
  deps: CliDeps,
): Promise<void> {
  if (value !== "good" && value !== "bad")
    throw new Error("rating must be good or bad");
  const session = await updateSession(handle, (stored) => {
    stored.rating = {
      value,
      note: options.note ?? null,
      at: new Date(deps.now()).toISOString(),
    };
  });
  return printResult(deps, { handle, rating: session.rating }, "Session rated");
}

async function statsCommand(
  options: { days?: string; window?: string; json?: boolean; export?: string },
  deps: CliDeps,
): Promise<void> {
  if (options.days !== undefined && options.window !== undefined)
    throw new Error("use --days or --window, not both");
  if (
    options.window !== undefined &&
    options.window !== "current" &&
    options.window !== "previous"
  )
    throw new Error("--window must be current or previous");
  const config = await loadConfig();
  const quotaResult = await deps.getQuota(config);
  const quota = "error" in quotaResult ? null : quotaResult;
  const window = statsWindow(
    {
      days:
        options.days === undefined
          ? undefined
          : parseNonNegativeInteger(options.days, "--days"),
      window: options.window,
    },
    quota,
    deps.now(),
  );
  const entries = statsEntries(
    await listSessions(),
    window,
    await (deps.loadPricing ?? loadPricing)(),
  );
  const rollingDays = window.rollingDays;
  const externalCostUsd = Object.fromEntries(
    rollingDays === null
      ? []
      : await Promise.all(
          Object.entries(config.quota.providers).map(
            async ([harness, provider]) =>
              [
                harness,
                await (deps.codexbarCostUsd ?? codexbarCostUsd)(
                  provider,
                  rollingDays,
                ),
              ] as const,
          ),
        ),
  );
  const report = statsReport({
    entries,
    window,
    quota,
    pinWarnings: await readAuditLines(PIN_WARNINGS_LOG),
    guardDecisions: await readAuditLines(NATIVE_SUBAGENT_LOG),
    externalCostUsd,
  });
  if (options.export)
    await writeFile(resolve(options.export), exportLines(entries));
  deps.stdout(
    options.json ? `${JSON.stringify(report)}\n` : formatStats(report),
  );
  deps.stderr("Stats computed\n");
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
  const result = await refreshUpdateNotice(version, deps.fetch);
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
  options: PassthroughOptions & { waitForSlot?: string; wakeId?: string },
  deps: CliDeps,
): Promise<void> {
  if (!options.wakeId) rejectOwnOrAncestor("send", handle);
  const [config, session] = await Promise.all([
    loadConfig(),
    loadSession(handle),
  ]);
  if (session.runner === "t3") {
    await sendT3Session(session, message, options.wakeId);
    return printResult(deps, { handle, sent: true }, "Message queued in T3");
  }
  if (session.status === SESSION_STATUS.running)
    throw new Error(`session ${handle} ${RUNNING_SESSION_ERROR}`);
  if (!session.sessionId)
    throw new Error(`session ${handle} has no session id`);
  const adapter = getAdapter(session.harness);
  let harnessOptions = await harnessOptionsFor(
    session,
    session.cwd,
    config,
    options,
    deps,
  );
  printPassthroughNotes(
    session.harness,
    { ...options, ...harnessOptions, schema: options.schema },
    deps,
  );
  const signingNote =
    session.harness === "codex"
      ? codex.codexGpgSigningNote(
          session.cwd,
          harnessOptions.codexSandbox ?? config.spawn.codexSandbox,
        )
      : "";
  const resumePrompt = signingNote ? `${message}\n\n${signingNote}` : message;
  session.confined = harnessOptions.confined;
  session.disallowedTools = harnessOptions.disallowedTools;
  session.allowedTools = harnessOptions.allowedTools;
  session.mcpConfig = harnessOptions.mcpConfig;
  session.strictMcpConfig = harnessOptions.strictMcpConfig;
  const reservation = await reserveSpawnSession(
    { ...session, prompt: resumePrompt },
    config,
    options.waitForSlot,
    deps,
    session,
    options.wakeId,
  );
  if ("limit" in reservation)
    return printResult(
      deps,
      reservation,
      `Capacity limit reached: ${reservation.limit}`,
      CAPACITY_EXIT_CODE,
    );
  const stream = eventStream(session, deps);
  let parsed: ReturnType<typeof adapter.parseResumeOutput>;
  try {
    harnessOptions = await harnessOptionsFor(
      session,
      session.cwd,
      config,
      options,
      deps,
    );
    await prepareConfinedMcp(session, harnessOptions, deps);
    const command = adapter.buildResume(
      session.sessionId,
      resumePrompt,
      harnessOptions,
    );
    parsed = parseForegroundOutput(
      await runSteerableForeground(
        command.argv,
        session,
        harnessOptions,
        deps,
        {
          ...(await sessionEnvironment(session)),
          ...command.env,
        },
        options.events ? stream.line : undefined,
      ),
      adapter.parseResumeOutput,
    );
    parsed.usage = turnUsage(parsed.usage, session);
    session.status = SESSION_STATUS.done;
    session.result = parsed.result;
    session.lastResult = parsed.result;
    session.usage = addUsage(session.usage, parsed.usage);
    finishSessionTurn(session, parsed.usage);
  } catch (error) {
    session.status = SESSION_STATUS.failed;
    session.error = error instanceof Error ? error.message : String(error);
    storeFailureActivity(session, error);
    await saveTerminalSession(session, "owner-turn");
    if (options.events) return stream.finish(session);
    if (session.failureKind)
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { handle, failureKind: session.failureKind, next: session.next },
      );
    throw error;
  }
  if (options.browser && session.harness === "claude") session.browser = true;
  await saveTerminalSession(session);
  if (options.events) return stream.finish(session, parsed.usage);
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

async function steerCommand(
  handle: string,
  message: string,
  options: { interrupt?: boolean },
  deps: CliDeps,
): Promise<void> {
  rejectOwnOrAncestor("steer", handle);
  const session = await refreshSession(handle);
  if (session.status !== SESSION_STATUS.running)
    throw new Error(notRunningError(handle));
  const interrupted = session.harness === "codex" || Boolean(options.interrupt);
  if (session.harness === "codex" && !session.wrapperPid)
    return steerCodexSession(session, message, deps);
  if (!session.supervisorPid && session.harness !== "codex")
    throw new Error(
      `session ${handle} cannot be steered; only codex sessions and claude sessions started under the supervisor support steer`,
    );
  if (!existsSync(sessionSocketPath(handle)))
    throw new Error(
      `session ${handle} has no steering socket; retry shortly (older foreground runners do not support steer)`,
    );
  await steerSupervisedSession(handle, { message, interrupt: interrupted });
  return printResult(
    deps,
    { handle, steered: true, interrupted },
    "Session steered",
  );
}

// codex exec only reads a queued message after its current turn ends, so a
// mid-run steer is always an interrupt: stop the run, then resume with the message.
async function steerCodexSession(
  session: Session,
  message: string,
  deps: CliDeps,
): Promise<void> {
  await interruptCodexSession(session);
  return sendCommand(session.handle, message, {}, deps);
}

async function interruptCodexSession(
  session: Session,
  options: { preserveTurn?: boolean } = {},
): Promise<string> {
  const log = await readFile(
    session.logPath ?? sessionLogPath(session.handle),
    "utf8",
  );
  const threadId = codex.parseThreadId(log);
  if (!threadId)
    throw new Error(
      `session ${session.handle} has not started a codex thread yet; retry shortly`,
    );
  session.sessionId = threadId;
  if (options.preserveTurn) await terminateSessionProcess(session);
  else await stopSession(session);
  return threadId;
}

async function runSteerableForeground(
  argv: string[],
  session: Session,
  harnessOptions: HarnessOptions,
  deps: CliDeps,
  environment: NodeJS.ProcessEnv,
  onLine?: (line: string) => void,
): Promise<string> {
  const run = () =>
    deps.runForeground(
      argv,
      session.cwd,
      environment,
      session,
      deps.exit,
      onLine,
    );
  if (session.harness !== "codex") return run();
  let steering: Promise<string[]> | undefined;
  let running = true;
  const server = await listenForSteer(session.handle, async ({ message }) => {
    if (!running) return { error: notRunningError(session.handle) };
    if (steering)
      return {
        error: `session ${session.handle} is already being steered; retry shortly`,
      };
    session.hasFollowUp = true;
    steering = updateSession(session.handle, (stored) => {
      stored.hasFollowUp = true;
    })
      .then(() =>
        interruptCodexSession(session, { preserveTurn: session.confined }),
      )
      .then(
        (threadId) => codex.buildResume(threadId, message, harnessOptions).argv,
      );
    try {
      await steering;
    } catch (error) {
      steering = undefined;
      throw error;
    }
    return { steered: true };
  });
  try {
    while (true) {
      let output = "";
      try {
        output = await run();
      } catch (error) {
        if (!steering) throw error;
      }
      running = false;
      if (!steering) return output;
      argv = await steering;
      steering = undefined;
      session.status = SESSION_STATUS.running;
      running = true;
    }
  } finally {
    running = false;
    server.close();
  }
}

async function harnessOptionsFor(
  selected: Pick | Session,
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: PassthroughOptions & { worktree?: boolean },
  deps: CliDeps,
): Promise<HarnessOptions> {
  const confined =
    options.confined ||
    ("confined" in selected && selected.confined) ||
    undefined;
  if (
    "handle" in selected &&
    selected.confined &&
    selected.allowedTools === undefined
  )
    throw new Error(MISSING_CONFINED_ALLOWLIST_ERROR);
  const storedAllowed =
    "allowedTools" in selected ? selected.allowedTools : undefined;
  const combinedAllowed = intersectAllowedTools(
    storedAllowed,
    options.allowedTools,
  );
  const allowedTools = confined
    ? confinedAllowedTools(combinedAllowed)
    : combinedAllowed;
  const disallowedTools = [
    ...new Set(
      [
        ...("disallowedTools" in selected
          ? (selected.disallowedTools ?? [])
          : []),
        ...(options.disallowedTools ?? []),
      ].flatMap(parseToolList),
    ),
  ];
  validateToolPolicy(selected.harness, {
    ...options,
    confined,
    disallowedTools,
  });
  const codexSandbox =
    options.codexSandbox ??
    options.sandbox ??
    ("sandbox" in selected ? selected.sandbox : undefined) ??
    config.spawn.codexSandbox;
  const localhostNeedsNetwork =
    codexSandbox === CODEX_WORKSPACE_WRITE_SANDBOX &&
    config.spawn.codexLocalhostNeedsNetwork;
  const schema =
    options.schema && selected.harness !== "pi"
      ? {
          path: options.schema,
          content: await readFile(options.schema, "utf8"),
        }
      : undefined;
  return {
    cwd,
    confined,
    codexConfinedOverrides:
      confined && selected.harness === "codex"
        ? checkedConfinedCodex(config, deps, cwd)
        : undefined,
    disallowedTools,
    tools: options.tools,
    appendSystemPromptFile: options.appendSystemPromptFile,
    events: options.events,
    model: selected.model,
    effort: selected.effort,
    worktree: options.worktree,
    claudePermissionMode:
      options.permissionMode ??
      ("permissionMode" in selected ? selected.permissionMode : undefined) ??
      config.spawn.claudePermissionMode,
    browser: options.browser || ("browser" in selected && selected.browser),
    mcpConfig:
      options.mcpConfig ??
      ("mcpConfig" in selected ? selected.mcpConfig : undefined),
    strictMcpConfig:
      options.strictMcpConfig ??
      ("strictMcpConfig" in selected ? selected.strictMcpConfig : undefined),
    codexSandbox,
    codexConfigOverrides:
      options.codexConfigOverrides ??
      (localhostNeedsNetwork ||
      (!options.sandbox &&
        "usesNetworkAccess" in selected &&
        selected.usesNetworkAccess)
        ? [CODEX_NETWORK_ACCESS_OVERRIDE]
        : undefined),
    codexExtraWritableRoots: config.spawn.codexExtraWritableRoots,
    allowedTools,
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
  if (options.mcpConfig?.length && harness === "pi")
    ignored.push(MCP_CONFIG_FLAG);
  if (options.strictMcpConfig && harness === "pi")
    ignored.push(STRICT_MCP_CONFIG_FLAG);
  if (ignored.length)
    deps.stderr(`Ignored for ${harness}: ${ignored.join(", ")}\n`);
}

async function refreshSession(handle: string): Promise<Session> {
  await sweepSessions(undefined, [handle]);
  return loadSession(handle);
}

async function statusCommand(handle: string, deps: CliDeps): Promise<void> {
  const session = await t3Result(await refreshSession(handle));
  return printResult(
    deps,
    sessionStatus(session, retriesByOriginal(await listSessions()).get(handle)),
    "Session status retrieved",
  );
}

function eventStream(session: Session, deps: CliDeps) {
  const stream = createSessionEventStream(session, (event) =>
    deps.stdout(`${JSON.stringify(event)}\n`),
  );
  return {
    line: stream.line,
    finish(completed: Session, usage?: ParsedOutput["usage"]) {
      stream.finish(completed, usage);
      deps.exit(
        completed.status === SESSION_STATUS.done
          ? SUCCESS_EXIT_CODE
          : ERROR_EXIT_CODE,
      );
    },
  };
}

async function followLog(
  session: Session,
  logPath: string,
  options: { tail?: string; follow?: boolean; events?: boolean },
  deps: CliDeps,
) {
  const tail =
    options.tail === undefined
      ? undefined
      : parseNonNegativeInteger(options.tail, "--tail");
  const stream = eventStream({ ...session, usage: null }, deps);
  let offset = 0;
  let pending = "";
  let initial = true;
  while (true) {
    const completed = await refreshSession(session.handle);
    const output = await readFile(logPath, "utf8").catch((error: unknown) => {
      if (options.follow && record(error)?.code === "ENOENT") return "";
      throw error;
    });
    const appended = output.slice(offset);
    offset = output.length;
    pending += appended;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const finalRead =
      !options.follow || completed.status !== SESSION_STATUS.running;
    if (pending && finalRead) lines.push(pending);
    if (finalRead) pending = "";
    const selected =
      initial && tail !== undefined
        ? lines.slice(Math.max(0, lines.length - tail))
        : lines;
    if (!options.follow && !options.events) {
      deps.stdout(tail === undefined ? output : selected.join("\n"));
      deps.stderr("Session log retrieved\n");
      deps.exit(SUCCESS_EXIT_CODE);
      return;
    }
    if (output) initial = false;
    if (options.events)
      for (const line of lines.slice(0, lines.length - selected.length))
        stream.line(line, false);
    for (const line of selected) {
      if (options.events) stream.line(line);
      else deps.stdout(`${line}\n`);
    }
    if (completed.status !== SESSION_STATUS.running || !options.follow) {
      if (pending && options.events) stream.line(pending);
      if (pending && !options.events) deps.stdout(pending);
      if (options.events && completed.status !== SESSION_STATUS.running)
        stream.finish(completed);
      deps.exit(SUCCESS_EXIT_CODE);
      return;
    }
    await Bun.sleep(LOG_FOLLOW_INTERVAL_MS);
  }
}

async function logsCommand(
  handle: string,
  options: { tail?: string; err?: boolean; follow?: boolean; events?: boolean },
  deps: CliDeps,
): Promise<void> {
  const session = await loadSession(handle);
  if (session.runner === "t3") throw new Error(T3_NO_LOG);
  const logPath = options.err
    ? session.errPath
    : (session.logPath ?? sessionLogPath(handle));
  if (!logPath) throw new Error(`session ${handle} has no stderr log`);
  return followLog(session, logPath, options, deps);
}

async function waitCommand(
  handles: string[],
  options: { timeout?: string; resultLimit?: string },
  deps: CliDeps,
): Promise<void> {
  resultLimit(options);
  for (const handle of handles) rejectOwnOrAncestor("wait", handle);
  const seconds =
    options.timeout === undefined ? Infinity : Number(options.timeout);
  if (
    seconds < 0 ||
    Number.isNaN(seconds) ||
    (options.timeout !== undefined && !Number.isFinite(seconds))
  )
    throw new Error("--timeout must be a non-negative number");
  const deadline = Date.now() + seconds * 1_000;
  while (true) {
    await sweepSessions(undefined, handles);
    const sessions = await Promise.all(handles.map(loadSession));
    const isSettled = () =>
      sessions.every(
        (session) =>
          session.status !== SESSION_STATUS.running &&
          session.status !== SESSION_STATUS.launched &&
          !hasUnsettledWakes(session),
      );
    let settled = isSettled();
    if (settled)
      await Promise.all(
        sessions.map(async (session, index) => {
          sessions[index] = await t3Result(session);
        }),
      );
    settled =
      isSettled() &&
      !sessions.some(
        (session) =>
          session.runner === "t3" &&
          session.status === "done" &&
          session.warning &&
          session.t3ResultKey !== session.t3LatestRunId,
      );
    if (sessions.some((session) => session.needsInput)) {
      const retries = retriesByOriginal(await listSessions());
      const states = sessions.map((session) =>
        sessionStatus(session, retries.get(session.handle)),
      );
      return printResult(
        deps,
        states.length === 1 ? states[0] : states,
        "waiting for an answer in T3",
        2,
      );
    }
    if (settled || Date.now() >= deadline) {
      const outcomes = await Promise.all(
        sessions.map(async (session) => {
          const handle = session.handle;
          if (!settled)
            return {
              handle,
              error: "timeout",
              status: session.status,
              ...(session.runner === "t3" ? { warning: session.warning } : {}),
              next: `poll with smart-router status ${handle} or wait again; do not start another wait in parallel`,
            };
          if (
            session.status === SESSION_STATUS.failed ||
            session.status === SESSION_STATUS.stopped
          )
            return {
              handle,
              error: `session ${handle} was ${session.status}: ${session.error ?? session.status}`,
              failureKind: session.failureKind,
              next: session.next,
              lastMessage: session.lastMessage ?? null,
              lastAction: session.lastAction ?? null,
            };
          const config = await loadConfig();
          const resumeCommand =
            session.runner === "t3" || session.confined
              ? `smart-router send ${handle} "<msg>"`
              : session.sessionId
                ? getAdapter(session.harness)
                    .buildResume(
                      session.sessionId,
                      '"<msg>"',
                      await harnessOptionsFor(
                        session,
                        session.cwd,
                        config,
                        {},
                        deps,
                      ),
                    )
                    .argv.join(" ")
                : undefined;
          return {
            handle,
            harness: session.harness,
            model: session.model,
            effort: session.effort,
            route: session.route,
            ...(session.runner === "t3" ? { warning: session.warning } : {}),
            resumeCommand,
            ...resultOutput(
              session.lastResult ?? session.result ?? "",
              resultLimit(options),
            ),
            usage: session.usage,
          };
        }),
      );
      const failed = sessions.some(
        (session) =>
          session.status === SESSION_STATUS.failed ||
          session.status === SESSION_STATUS.stopped,
      );
      let exitCode = SUCCESS_EXIT_CODE;
      let message = "Spawn completed";
      if (!settled) {
        exitCode = TIMEOUT_EXIT_CODE;
        message = "Wait timed out";
      } else if (failed) {
        exitCode = ERROR_EXIT_CODE;
        message = `Spawn ${sessions.find((session) => session.status === SESSION_STATUS.failed || session.status === SESSION_STATUS.stopped)?.status}`;
      }
      return printResult(
        deps,
        outcomes.length === 1 ? outcomes[0] : outcomes,
        message,
        exitCode,
      );
    }
    await Bun.sleep(Math.min(WAIT_POLL_INTERVAL_MS, deadline - Date.now()));
  }
}

async function stopCommand(handle: string, deps: CliDeps): Promise<void> {
  rejectOwnOrAncestor("stop", handle);
  const session = await loadSession(handle);
  if (session.runner === "t3") {
    await cancelWakes(handle);
    return printResult(
      deps,
      { handle, error: "stop it in T3" },
      "stop it in T3",
      ERROR_EXIT_CODE,
    );
  }
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
  await sweepSessions();
  const sessions = await listSessions(options.all ? undefined : sessionOwner());
  const retries = retriesByOriginal(
    options.all ? sessions : await listSessions(),
  );
  return printResult(
    deps,
    sessions.map((session) =>
      sessionSummary(session, retries.get(session.handle)),
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

function withSpawnOptions(command: Command): Command {
  return command
    .option("--cwd <dir>")
    .option("--hint <text>")
    .option("--confidential")
    .option("--dry-run")
    .option("--model <model>")
    .option("--effort <effort>")
    .option("--worktree")
    .option("--detach")
    .option("--events")
    .option("--permission-mode <mode>")
    .option("--browser")
    .option(MCP_CONFIG_OPTION, "MCP config (repeatable)", collectMcpConfig)
    .option(STRICT_MCP_CONFIG_FLAG)
    .option("--sandbox <policy>")
    .option(
      "--allowed-tools <list>",
      "Allowed tools (repeatable)",
      collectToolList,
    )
    .option(
      "--allowedTools <list>",
      "Allowed tools (repeatable)",
      collectToolList,
    )
    .option(
      "--disallowedTools <list...>",
      "Denied tools (repeatable)",
      collectDeniedTools,
    )
    .option("--tools <list>", "Native tools (repeatable)", collectToolList)
    .option(
      "--confined",
      "run with no native tools: MCP tools only, for OpenClaw",
    )
    .option("--append-system-prompt-file <path>")
    .option("--schema <file>")
    .option("--wait-for-slot <seconds>")
    .option(RESULT_LIMIT_OPTION)
    .option("--no-guardrails")
    .option(`${LABEL_FLAG} <text>`, "Row label shown by the /sr pane")
    .option(`${PHASE_FLAG} <text>`, "Phase group shown by the /sr pane");
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
    .alias("install")
    .description(
      "install the skill for Claude Code and Codex, and the Codex native-subagent guard hook",
    )
    .action(async () =>
      printResult(deps, await installSkill(deps.stderr), "Skill installed"),
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
    .option("--launch")
    .option("--label <text>")
    .option("--phase <text>")
    .option("--model <harness:auto>")
    .option("--cwd <dir>")
    .option("--hint <text>")
    .option("--confidential")
    .option("--dry-run")
    .action((prompt, options) => routeCommand(prompt, options, deps));
  withSpawnOptions(program.command("spawn <prompt>")).action(
    (prompt, options) => spawnCommand(prompt, options, deps),
  );
  withSpawnOptions(program.command("retry <handle>"))
    .option("--up", "only stronger candidates: a higher tier or higher effort")
    .option("--note <why>", "what was wrong with the previous attempt")
    .option("--launch", "return a T3 launch instead of running")
    .action((handle, options) => retryCommand(handle, options, deps));
  program
    .command("rate <handle> <value>")
    .description("record a good or bad rating on a session")
    .option("--note <text>")
    .action((handle, value, options) =>
      rateCommand(handle, value, options, deps),
    );
  program
    .command("guard")
    .command("subagent")
    .description(
      "decide whether a native subagent call may run; --hook reads a PreToolUse payload on stdin",
    )
    .option("--harness <claude|codex>")
    .option("--hook <claude|codex>")
    .option("--subagent-type <type>")
    .option("--model <model>")
    .option("--session <id>")
    .option("--cwd <dir>")
    .action((options) => guardSubagentCommand(options, deps));
  program
    .command("stats")
    .description(
      "report pool balance, pick sources, outcomes, list cost and the feature audit",
    )
    .option("--days <n>", "sessions from the last n days (default 7)")
    .option(
      "--window <current|previous>",
      "the weekly quota window instead of --days. Pools reset on different days, so it starts at the earliest pool's current start and covers every pool's window; previous is the 7 days before that",
    )
    .option("--json", "print the report as JSON")
    .option(
      "--export <file>",
      "also write one JSON line per session (route record plus outcome)",
    )
    .action((options) => statsCommand(options, deps));
  program
    .command("send <handle> <message>")
    .option("--wait-for-slot <seconds>")
    .option("--events")
    .option("--permission-mode <mode>")
    .option("--browser")
    .option(MCP_CONFIG_OPTION, "MCP config (repeatable)", collectMcpConfig)
    .option(STRICT_MCP_CONFIG_FLAG)
    .option("--sandbox <policy>")
    .option(
      "--allowed-tools <list>",
      "Allowed tools (repeatable)",
      collectToolList,
    )
    .option(
      "--allowedTools <list>",
      "Allowed tools (repeatable)",
      collectToolList,
    )
    .option(
      "--disallowedTools <list...>",
      "Denied tools (repeatable)",
      collectDeniedTools,
    )
    .option("--tools <list>", "Native tools (repeatable)", collectToolList)
    .option(
      "--confined",
      "run with no native tools: MCP tools only, for OpenClaw",
    )
    .option("--append-system-prompt-file <path>")
    .option("--schema <file>")
    .option(RESULT_LIMIT_OPTION)
    .action((handle, message, options) =>
      sendCommand(handle, message, options, deps),
    );
  program
    .command("steer <handle> <message>")
    .option("--interrupt")
    .action((handle, message, options) =>
      steerCommand(handle, message, options, deps),
    );
  program
    .command(`${SPAWN_TURN_COMMAND} <handle> <prompt> <options>`, {
      hidden: true,
    })
    .action(
      async (handle: string, prompt: string, serializedOptions: string) => {
        const session = await withSessionsLock(async () => {
          const stored = await loadSession(handle);
          if (stored.status !== SESSION_STATUS.running) return stored;
          if (stored.pid !== process.pid || stored.wrapperPid)
            throw new Error("first-turn worker does not own this session");
          stored.wrapperPid = process.pid;
          stored.wrapperProcessStartTime = processStartTime(process.pid);
          await saveSession(stored);
          return stored;
        });
        if (session.status !== SESSION_STATUS.running)
          return deps.exit(ERROR_EXIT_CODE);
        try {
          await runSpawnTurn(
            session,
            prompt,
            JSON.parse(serializedOptions),
            await loadConfig(),
            deps,
          );
          deps.exit(SUCCESS_EXIT_CODE);
        } catch {
          deps.exit(ERROR_EXIT_CODE);
        }
      },
    );
  program
    .command(`${SUPERVISE_COMMAND} <handle> <prompt> <argv...>`, {
      hidden: true,
    })
    .action(async (handle, prompt, argv) =>
      deps.exit(await superviseSession(handle, prompt, argv)),
    );
  program
    .command("attach <handle>")
    .requiredOption("--t3-thread <id>")
    .action(async (handle, options) =>
      printResult(
        deps,
        await attachT3Session(handle, options.t3Thread),
        "T3 thread attached",
      ),
    );
  program
    .command("wake <handle> [wakeId]")
    .option("--after-pid <pid>")
    .option("--message <text>")
    .option("--cancel")
    .action(async (handle, wakeId, options) => {
      if (options.cancel && !options.afterPid && !options.message)
        return printResult(
          deps,
          await cancelWakes(handle, wakeId),
          "Wakes cancelled",
        );
      if (options.cancel || wakeId || !options.afterPid)
        throw new Error("use --after-pid <pid> or --cancel [wake-id]");
      const wake = await (deps.armWake ?? armWake)(
        handle,
        Number(options.afterPid),
        options.message,
      );
      return printResult(
        deps,
        wake,
        wake.state === "failed" ? "Wake failed" : "Wake armed",
        wake.state === "failed" ? ERROR_EXIT_CODE : SUCCESS_EXIT_CODE,
      );
    });
  program
    .command(`${WAKE_COMMAND} <handle> <wakeId>`, { hidden: true })
    .action(async (handle, wakeId) => {
      await watchWake(handle, wakeId, async (message) => {
        let exitCode = 0;
        let capacityLimit: unknown;
        await sendCommand(
          handle,
          message,
          { wakeId },
          {
            ...deps,
            stdout: (text) => {
              capacityLimit = record(JSON.parse(text))?.limit;
              deps.stdout(text);
            },
            exit: (code) => {
              exitCode = code;
            },
          },
        );
        if (
          exitCode === CAPACITY_EXIT_CODE &&
          (capacityLimit === "maxRunning" || capacityLimit === "maxPerCaller")
        )
          throw new WakeCapacityError();
        if (exitCode) throw new Error(`send exited ${exitCode}`);
      });
      deps.exit(SUCCESS_EXIT_CODE);
    });
  program
    .command("status <handle>")
    .action((handle) => statusCommand(handle, deps));
  program
    .command("logs <handle>")
    .option("--follow")
    .option("--events")
    .option("--tail <n>")
    .option("--err")
    .action((handle, options) => logsCommand(handle, options, deps));
  program
    .command("wait <handles...>")
    .option(WAIT_TIMEOUT_OPTION)
    .option(RESULT_LIMIT_OPTION)
    .action((handle, options) => waitCommand(handle, options, deps));
  program
    .command("stop <handle>")
    .action((handle) => stopCommand(handle, deps));
  program
    .command("sessions")
    .option(ALL_OPTION)
    .action((options) => sessionsCommand(options, deps));
  program
    .command("dashboard")
    .option("--port <n>")
    .option("--host <addr>")
    .action(async (options: { port?: string; host?: string }) => {
      const port =
        options.port === undefined
          ? undefined
          : parseNonNegativeInteger(options.port, "--port");
      let server;
      try {
        server = startDashboard({ port, host: options.host });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EADDRINUSE"
        ) {
          const existing = await existingDashboard({
            port,
            host: options.host,
          });
          if (existing) {
            deps.stdout(`${JSON.stringify(existing)}\n`);
            return;
          }
        }
        throw error;
      }
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void server.stop(true);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      deps.stdout(
        `${JSON.stringify({ url: server.url.origin, owner: sessionOwner() })}\n`,
      );
    });
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
    printResult(deps, errorFields(error), message, ERROR_EXIT_CODE);
  }
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

if (import.meta.main) void main();
