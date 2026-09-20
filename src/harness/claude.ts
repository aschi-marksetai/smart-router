import { randomUUID } from "node:crypto";
import { DEFAULT_CLAUDE_PERMISSION_MODE } from "../config.ts";
import { run, type HarnessOptions } from "./types.ts";

const CLAUDE_BINARY = "claude";
const PRINT_FLAG = "-p";
const JSON_OUTPUT_FLAG = "--output-format";
const JSON_OUTPUT_FORMAT = "json";
const MODEL_FLAG = "--model";
const SESSION_ID_FLAG = "--session-id";
const PERMISSION_MODE_FLAG = "--permission-mode";
const WORKTREE_FLAG = "--worktree";
const APPEND_SYSTEM_PROMPT_FLAG = "--append-system-prompt";
const RESUME_FLAG = "--resume";
const EFFORT_PROMPT_PREFIX = "Reasoning effort: ";

function resultFrom(output: string): string {
  return JSON.parse(output).result;
}

export async function spawn(prompt: string, options: HarnessOptions) {
  const sessionId = randomUUID();
  const argv = [
    CLAUDE_BINARY,
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
  if (options.effort)
    argv.push(
      APPEND_SYSTEM_PROMPT_FLAG,
      `${EFFORT_PROMPT_PREFIX}${options.effort}`,
    );
  return {
    sessionId,
    result: resultFrom(await run(argv, options)),
    resumeCommand: `${CLAUDE_BINARY} ${PRINT_FLAG} ${RESUME_FLAG} ${sessionId} \"<msg>\" ${JSON_OUTPUT_FLAG} ${JSON_OUTPUT_FORMAT}`,
  };
}

export async function resume(
  sessionId: string,
  message: string,
  options: HarnessOptions,
) {
  const argv = [
    CLAUDE_BINARY,
    PRINT_FLAG,
    RESUME_FLAG,
    sessionId,
    message,
    JSON_OUTPUT_FLAG,
    JSON_OUTPUT_FORMAT,
  ];
  return { result: resultFrom(await run(argv, options)) };
}
