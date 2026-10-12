export { translateEvents } from "../events.ts";
import { codexHomeDir } from "../paths.ts";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CODEX_SANDBOX } from "../config.ts";
import { codexMcpOverrides } from "./mcp.ts";
import {
  parseJsonLines,
  record,
  usageFrom,
  type HarnessOptions,
  type ParsedOutput,
  type SpawnCommand,
} from "./types.ts";

const CODEX_BINARY = "codex";
const EXEC_COMMAND = "exec";
const RESUME_COMMAND = "resume";
const JSON_FLAG = "--json";
const CHANGE_DIRECTORY_FLAG = "-C";
const MODEL_FLAG = "-m";
const CONFIG_FLAG = "-c";
const IGNORE_USER_CONFIG_FLAG = "--ignore-user-config";
const SANDBOX_FLAG = "-s";
const WORKTREE_FLAG = "--worktree";
const SKIP_GIT_REPOSITORY_CHECK_FLAG = "--skip-git-repo-check";
const OUTPUT_SCHEMA_FLAG = "--output-schema";
const THREAD_STARTED_EVENT_TYPE = "thread.started";
const ITEM_COMPLETED_EVENT_TYPE = "item.completed";
const TURN_COMPLETED_EVENT_TYPE = "turn.completed";
const TURN_STARTED_EVENT_TYPE = "turn.started";
const ERROR_EVENT_TYPE = "error";
const AGENT_MESSAGE_ITEM_TYPE = "agent_message";
const TURN_FAILED_EVENT_TYPE = "turn.failed";
const WORKSPACE_WRITE_SANDBOX = "workspace-write";
const CODEX_CONFIG_FILENAME = "config.toml";
const WORKSPACE_WRITE_CONFIG_KEY = "sandbox_workspace_write";
const WRITABLE_ROOTS_CONFIG_KEY = `${WORKSPACE_WRITE_CONFIG_KEY}.writable_roots`;
const GIT_BINARY = "git";
const GIT_MARKER_FILENAME = ".git";
const SWIFT_PACKAGE_FILENAME = "Package.swift";
const XCODE_PROJECT_SUFFIXES = [".xcodeproj", ".xcworkspace"];
const SWIFT_CACHE_ROOTS = [
  "~/Library/Caches/org.swift.swiftpm",
  "~/.cache/clang",
];
const XCODE_BUILD_ROOTS = ["~/Library/Developer/Xcode/DerivedData"];
const GIT_DIRECTORY_ARGUMENTS = [
  "rev-parse",
  "--path-format=absolute",
  "--git-dir",
  "--git-common-dir",
];

function writableRoots(configuration: unknown): string[] {
  const roots = record(
    record(configuration)?.[WORKSPACE_WRITE_CONFIG_KEY],
  )?.writable_roots;
  if (roots === undefined) return [];
  if (!Array.isArray(roots) || !roots.every((root) => typeof root === "string"))
    throw new Error(`${WRITABLE_ROOTS_CONFIG_KEY} must be an array of strings`);
  return roots;
}

function configOverrides(options: HarnessOptions): string[] {
  const overrides = [
    ...(options.codexConfigOverrides ?? []),
    ...codexMcpOverrides(options.mcpConfig ?? []),
  ];
  const sandbox = options.codexSandbox ?? DEFAULT_CODEX_SANDBOX;
  if (sandbox !== WORKSPACE_WRITE_SANDBOX) return overrides;
  let gitDirectories: string[] = [];
  try {
    gitDirectories = execFileSync(GIT_BINARY, GIT_DIRECTORY_ARGUMENTS, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n");
  } catch {}
  const configPath = join(codexHomeDir(), CODEX_CONFIG_FILENAME);
  const configuration =
    !options.strictMcpConfig && existsSync(configPath)
      ? Bun.TOML.parse(readFileSync(configPath, "utf8"))
      : {};
  const roots = writableRoots(configuration);
  for (const override of overrides) {
    const key = override.split("=", 1)[0]?.trim();
    if (key !== WRITABLE_ROOTS_CONFIG_KEY && key !== WORKSPACE_WRITE_CONFIG_KEY)
      continue;
    const settings = Bun.TOML.parse(override);
    roots.push(...writableRoots(settings));
  }
  const extraRoots = (options.codexExtraWritableRoots ?? []).map(
    expandHomePath,
  );
  const additionalRoots = [
    ...gitDirectories,
    ...swiftWritableRoots(options.cwd),
    ...extraRoots,
  ];
  if (additionalRoots.length > 0)
    overrides.push(
      `${WRITABLE_ROOTS_CONFIG_KEY}=${JSON.stringify([...new Set([...roots, ...additionalRoots])])}`,
    );
  return overrides;
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

const SWIFTPM_NESTED_SANDBOX_NOTE =
  "This Codex sandbox cannot nest SwiftPM's own sandbox: run swift build, swift test and swift run with --disable-sandbox (xcodebuild is unaffected).";

export function codexToolchainNote(cwd: string, sandbox: string): string {
  const swiftProjectInWorkspaceWrite =
    sandbox === WORKSPACE_WRITE_SANDBOX && swiftWritableRoots(cwd).length > 0;
  return swiftProjectInWorkspaceWrite ? SWIFTPM_NESTED_SANDBOX_NOTE : "";
}

function swiftWritableRoots(cwd: string): string[] {
  let directory = resolve(cwd);
  while (existsSync(directory)) {
    const hasXcodeProject = readdirSync(directory, {
      withFileTypes: true,
    }).some(
      (entry) =>
        entry.isDirectory() &&
        XCODE_PROJECT_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)),
    );
    if (hasXcodeProject)
      return [...SWIFT_CACHE_ROOTS, ...XCODE_BUILD_ROOTS].map(expandHomePath);
    if (existsSync(join(directory, SWIFT_PACKAGE_FILENAME)))
      return SWIFT_CACHE_ROOTS.map(expandHomePath);
    if (existsSync(join(directory, GIT_MARKER_FILENAME))) return [];
    const parent = dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
  return [];
}

function isInsideGitRepository(cwd: string): boolean {
  let directory = resolve(cwd);
  while (true) {
    if (existsSync(join(directory, GIT_MARKER_FILENAME))) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function parseOutput(output: string, requireSessionId: boolean): ParsedOutput {
  let sessionId = "";
  let result = "";
  let usage = null;
  let errorMessage = "";
  let currentTurnResult = "";
  let finalTurnResult = "";
  let completedFinalTurn = false;
  for (const event of parseJsonLines(output)) {
    const eventRecord = record(event);
    if (!eventRecord) continue;
    const type = eventRecord.type;
    const item = record(eventRecord.item);
    if (type === TURN_STARTED_EVENT_TYPE) {
      currentTurnResult = "";
      completedFinalTurn = false;
    }
    if (
      type === THREAD_STARTED_EVENT_TYPE &&
      typeof eventRecord.thread_id === "string"
    )
      sessionId = eventRecord.thread_id;
    if (type === TURN_COMPLETED_EVENT_TYPE) {
      usage = usageFrom(eventRecord.usage);
      finalTurnResult = currentTurnResult;
      currentTurnResult = "";
      completedFinalTurn = true;
    }
    if (type === TURN_FAILED_EVENT_TYPE || type === ERROR_EVENT_TYPE)
      completedFinalTurn = false;
    if (type === ERROR_EVENT_TYPE)
      errorMessage =
        typeof eventRecord.message === "string" && eventRecord.message
          ? eventRecord.message
          : "Codex reported an error";
    if (
      type === ITEM_COMPLETED_EVENT_TYPE &&
      item?.type === AGENT_MESSAGE_ITEM_TYPE &&
      typeof item.text === "string"
    ) {
      result = item.text;
      currentTurnResult = item.text;
      completedFinalTurn = false;
    }
  }
  if (errorMessage || !completedFinalTurn)
    throw Object.assign(
      new Error(errorMessage || "Codex turn did not complete successfully"),
      { lastMessage: result || undefined },
    );
  if (requireSessionId && !sessionId)
    throw new Error("Codex output did not contain a thread id");
  return { sessionId, result: finalTurnResult, usage };
}

export function parseThreadId(output: string): string {
  for (const event of parseJsonLines(output)) {
    const eventRecord = record(event);
    if (
      eventRecord?.type === THREAD_STARTED_EVENT_TYPE &&
      typeof eventRecord.thread_id === "string"
    )
      return eventRecord.thread_id;
  }
  return "";
}

export function buildSpawn(
  prompt: string,
  options: HarnessOptions,
): SpawnCommand {
  const argv = [
    options.binary ?? CODEX_BINARY,
    EXEC_COMMAND,
    JSON_FLAG,
    CHANGE_DIRECTORY_FLAG,
    options.cwd,
    MODEL_FLAG,
    options.model,
  ];
  if (options.effort)
    argv.push(CONFIG_FLAG, `model_reasoning_effort=\"${options.effort}\"`);
  if (options.strictMcpConfig) argv.push(IGNORE_USER_CONFIG_FLAG);
  for (const override of configOverrides(options))
    argv.push(CONFIG_FLAG, override);
  argv.push(SANDBOX_FLAG, options.codexSandbox ?? DEFAULT_CODEX_SANDBOX);
  if (options.worktree) argv.push(WORKTREE_FLAG);
  if (!isInsideGitRepository(options.cwd))
    argv.push(SKIP_GIT_REPOSITORY_CHECK_FLAG);
  if (options.schema) argv.push(OUTPUT_SCHEMA_FLAG, options.schema.path);
  argv.push(prompt);
  return { argv };
}

export function parseSpawnOutput(stdout: string): ParsedOutput {
  return parseOutput(stdout, true);
}

export function buildResume(
  sessionId: string,
  message: string,
  options: HarnessOptions,
): SpawnCommand {
  const argv = [
    options.binary ?? CODEX_BINARY,
    EXEC_COMMAND,
    RESUME_COMMAND,
    sessionId,
    JSON_FLAG,
    MODEL_FLAG,
    options.model,
  ];
  if (options.strictMcpConfig) argv.push(IGNORE_USER_CONFIG_FLAG);
  for (const override of configOverrides(options))
    argv.push(CONFIG_FLAG, override);
  argv.push(
    CONFIG_FLAG,
    `sandbox_mode="${options.codexSandbox ?? DEFAULT_CODEX_SANDBOX}"`,
  );
  if (!isInsideGitRepository(options.cwd))
    argv.push(SKIP_GIT_REPOSITORY_CHECK_FLAG);
  if (options.schema) argv.push(OUTPUT_SCHEMA_FLAG, options.schema.path);
  argv.push(message);
  return { argv, sessionId };
}

export function parseResumeOutput(stdout: string): ParsedOutput {
  return parseOutput(stdout, false);
}

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "file_change",
]);
