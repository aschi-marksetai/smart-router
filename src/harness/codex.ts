import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CODEX_SANDBOX } from "../config.ts";
import { record } from "../files.ts";
import { parseJsonLines, run, type HarnessOptions } from "./types.ts";

const CODEX_BINARY = "codex";
const EXEC_COMMAND = "exec";
const RESUME_COMMAND = "resume";
const JSON_FLAG = "--json";
const CHANGE_DIRECTORY_FLAG = "-C";
const MODEL_FLAG = "-m";
const CONFIG_FLAG = "-c";
const SANDBOX_FLAG = "-s";
const WORKTREE_FLAG = "--worktree";
const SKIP_GIT_REPOSITORY_CHECK_FLAG = "--skip-git-repo-check";
const THREAD_STARTED_EVENT_TYPE = "thread.started";
const ITEM_COMPLETED_EVENT_TYPE = "item.completed";
const AGENT_MESSAGE_ITEM_TYPE = "agent_message";

function isInsideGitRepository(cwd: string): boolean {
  let directory = resolve(cwd);
  while (true) {
    if (existsSync(join(directory, ".git"))) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function completedMessageText(output: string, requireSessionId = true) {
  let sessionId = "";
  let result = "";
  for (const event of parseJsonLines(output)) {
    const eventRecord = record(event);
    if (!eventRecord) continue;
    const type = eventRecord.type;
    const threadId = eventRecord.thread_id;
    const item = record(eventRecord.item);
    if (type === THREAD_STARTED_EVENT_TYPE && typeof threadId === "string")
      sessionId = threadId;
    if (
      type === ITEM_COMPLETED_EVENT_TYPE &&
      item?.type === AGENT_MESSAGE_ITEM_TYPE &&
      typeof item.text === "string"
    )
      result = item.text;
  }
  if (requireSessionId && !sessionId)
    throw new Error("Codex output did not contain a thread id");
  return { sessionId, result };
}

export async function spawn(prompt: string, options: HarnessOptions) {
  const argv = [
    CODEX_BINARY,
    EXEC_COMMAND,
    JSON_FLAG,
    CHANGE_DIRECTORY_FLAG,
    options.cwd,
    MODEL_FLAG,
    options.model,
  ];
  if (options.effort)
    argv.push(CONFIG_FLAG, `model_reasoning_effort=\"${options.effort}\"`);
  argv.push(SANDBOX_FLAG, options.codexSandbox ?? DEFAULT_CODEX_SANDBOX);
  if (options.worktree) argv.push(WORKTREE_FLAG);
  if (!isInsideGitRepository(options.cwd))
    argv.push(SKIP_GIT_REPOSITORY_CHECK_FLAG);
  argv.push(prompt);
  const parsed = completedMessageText(await run(argv, options));
  return {
    ...parsed,
    resumeCommand: `${CODEX_BINARY} ${EXEC_COMMAND} ${RESUME_COMMAND} ${parsed.sessionId} ${JSON_FLAG} \"<msg>\"`,
  };
}

export async function resume(
  sessionId: string,
  message: string,
  options: HarnessOptions,
) {
  const argv = [
    CODEX_BINARY,
    EXEC_COMMAND,
    RESUME_COMMAND,
    sessionId,
    JSON_FLAG,
    message,
  ];
  return {
    result: completedMessageText(await run(argv, options), false).result,
  };
}
