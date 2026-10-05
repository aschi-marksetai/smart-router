import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { createInterface } from "node:readline";
import {
  isReplayedUserMessage,
  isResultEvent,
  streamInterruptRequest,
  streamUserMessage,
} from "./harness/claude.ts";
import { parseJsonLines, record } from "./harness/types.ts";
import { loadSession, sessionLogPath, sessionSocketPath } from "./sessions.ts";

export const SUPERVISE_COMMAND = "__supervise";
const OPERANDS_SEPARATOR = "--";
const COMPILED_ENTRY_PREFIX = "/$bunfs/";
const STOP_SIGNAL = "SIGTERM";
const FAILED_EXIT_CODE = 1;

export type SteerRequest = { message: string; interrupt: boolean };
type SteerReply = { steered: true } | { error: string };

export function notRunningError(handle: string): string {
  return `session ${handle} is not running; use send`;
}

export function supervisorCommand(
  handle: string,
  prompt: string,
  claudeArgv: string[],
): string[] {
  const isCompiled = Bun.main.startsWith(COMPILED_ENTRY_PREFIX);
  const selfCommand = isCompiled
    ? [process.execPath]
    : [process.execPath, Bun.main];
  return [
    ...selfCommand,
    SUPERVISE_COMMAND,
    OPERANDS_SEPARATOR,
    handle,
    prompt,
    ...claudeArgv,
  ];
}

function parseSteerRequest(line: string): SteerRequest | undefined {
  const request = record(parseJsonLines(line)[0]);
  if (typeof request?.message !== "string") return undefined;
  return { message: request.message, interrupt: request.interrupt === true };
}

export async function superviseSession(
  handle: string,
  prompt: string,
  claudeArgv: string[],
): Promise<number> {
  const session = await loadSession(handle);
  const socketPath = sessionSocketPath(handle);
  const log = createWriteStream(session.logPath ?? sessionLogPath(handle), {
    flags: "a",
  });
  const claude = spawn(claudeArgv[0], claudeArgv.slice(1), {
    cwd: session.cwd,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let pendingMessages = 0;
  let stdinClosed = false;
  claude.stdin.on("error", () => {
    stdinClosed = true;
  });
  const writeUserMessage = (text: string) => {
    claude.stdin.write(streamUserMessage(text));
    pendingMessages += 1;
  };
  const steer = (request: SteerRequest | undefined): SteerReply => {
    if (!request) return { error: "steer request needs a message" };
    if (stdinClosed) return { error: notRunningError(handle) };
    if (request.interrupt) claude.stdin.write(streamInterruptRequest());
    writeUserMessage(request.message);
    return { steered: true };
  };
  const server = createServer((connection) => {
    const requestLines = createInterface({ input: connection });
    requestLines.once("error", () => connection.destroy());
    requestLines.once("line", (line) => {
      connection.end(`${JSON.stringify(steer(parseSteerRequest(line)))}\n`);
    });
  });
  const forwardStop = () => claude.kill(STOP_SIGNAL);
  process.once(STOP_SIGNAL, forwardStop);
  try {
    await rm(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    writeUserMessage(prompt);
    createInterface({ input: claude.stdout }).on("line", (line) => {
      log.write(`${line}\n`);
      const event = parseJsonLines(line)[0];
      if (isReplayedUserMessage(event)) pendingMessages -= 1;
      if (!isResultEvent(event) || pendingMessages > 0) return;
      stdinClosed = true;
      claude.stdin.end();
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      claude.once("error", reject);
      claude.once("close", resolve);
    });
    return exitCode ?? FAILED_EXIT_CODE;
  } finally {
    process.removeListener(STOP_SIGNAL, forwardStop);
    server.close();
    await rm(socketPath, { force: true });
    await new Promise((resolve) => log.end(resolve));
  }
}

export async function steerSupervisedSession(
  handle: string,
  request: SteerRequest,
): Promise<void> {
  const connection = createConnection(sessionSocketPath(handle));
  const replyLines = createInterface({ input: connection });
  const replyLine = new Promise<SteerReply>((resolve, reject) => {
    replyLines.once("error", reject);
    replyLines.once("line", (line) => resolve(JSON.parse(line)));
  });
  connection.write(`${JSON.stringify(request)}\n`);
  const reply = await replyLine;
  connection.end();
  if ("error" in reply) throw new Error(reply.error);
}
