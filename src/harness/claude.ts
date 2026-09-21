import { randomUUID } from "node:crypto";
import { DEFAULT_CLAUDE_PERMISSION_MODE } from "../config.ts";
import {
  record,
  usageFrom,
  type HarnessOptions,
  type ParsedOutput,
  type SpawnCommand,
} from "./types.ts";

const CLAUDE_BINARY = "claude";
const PRINT_FLAG = "-p";
const JSON_OUTPUT_FLAG = "--output-format";
const JSON_OUTPUT_FORMAT = "json";
const MODEL_FLAG = "--model";
const SESSION_ID_FLAG = "--session-id";
const PERMISSION_MODE_FLAG = "--permission-mode";
const WORKTREE_FLAG = "--worktree";
const RESUME_FLAG = "--resume";
const EFFORT_FLAG = "--effort";
const ALLOWED_TOOLS_FLAG = "--allowedTools";
const JSON_SCHEMA_FLAG = "--json-schema";

export function buildSpawn(
  prompt: string,
  options: HarnessOptions,
): SpawnCommand {
  const sessionId = randomUUID();
  const argv = [
    options.binary ?? CLAUDE_BINARY,
    PRINT_FLAG,
    prompt,
    JSON_OUTPUT_FLAG,
    JSON_OUTPUT_FORMAT,
    MODEL_FLAG,
    options.model,
    SESSION_ID_FLAG,
    sessionId,
    PERMISSION_MODE_FLAG,
    options.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
  ];
  if (options.worktree) argv.push(WORKTREE_FLAG);
  if (options.effort) argv.push(EFFORT_FLAG, options.effort);
  if (options.allowedTools) argv.push(ALLOWED_TOOLS_FLAG, options.allowedTools);
  if (options.schema) argv.push(JSON_SCHEMA_FLAG, options.schema.content);
  return { argv, sessionId };
}

export function parseSpawnOutput(stdout: string): ParsedOutput {
  const output = record(JSON.parse(stdout));
  const result = output?.result;
  const sessionId = output?.session_id;
  const costUsd = output?.total_cost_usd;
  return {
    sessionId: typeof sessionId === "string" ? sessionId : "",
    result: typeof result === "string" ? result : "",
    usage: usageFrom(
      output?.usage,
      typeof costUsd === "number" ? costUsd : null,
    ),
  };
}

export function buildResume(
  sessionId: string,
  message: string,
  options: HarnessOptions,
): SpawnCommand {
  const argv = [
    options.binary ?? CLAUDE_BINARY,
    PRINT_FLAG,
    RESUME_FLAG,
    sessionId,
    message,
    JSON_OUTPUT_FLAG,
    JSON_OUTPUT_FORMAT,
    PERMISSION_MODE_FLAG,
    options.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
  ];
  if (options.allowedTools) argv.push(ALLOWED_TOOLS_FLAG, options.allowedTools);
  if (options.schema) argv.push(JSON_SCHEMA_FLAG, options.schema.content);
  return { argv, sessionId };
}

export function parseResumeOutput(stdout: string): ParsedOutput {
  return parseSpawnOutput(stdout);
}
