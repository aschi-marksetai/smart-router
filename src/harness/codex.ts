export { translateEvents } from "../events.ts";
import { existsSync } from "node:fs";
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

function isInsideGitRepository(cwd: string): boolean {
  let directory = resolve(cwd);
  while (true) {
    if (existsSync(join(directory, ".git"))) return true;
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
  for (const override of [
    ...(options.codexConfigOverrides ?? []),
    ...codexMcpOverrides(options.mcpConfig ?? []),
  ])
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
  for (const override of [
    ...(options.codexConfigOverrides ?? []),
    ...codexMcpOverrides(options.mcpConfig ?? []),
  ])
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
