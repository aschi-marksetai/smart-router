import { constants } from "node:os";
import {
  processStartTime,
  saveSession,
  SESSION_STATUS,
  terminateSessionProcess,
  type Session,
} from "./sessions.ts";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const IGNORE = "ignore";
const STDERR_LINE_LIMIT = 20;
const ERROR_LOG_EXTENSION = ".err";
const SIGNAL_EXIT_CODE_OFFSET = 128;
const FOREGROUND_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export async function forwardForegroundSignal(
  session: Session,
  signal: (typeof FOREGROUND_SIGNALS)[number],
  exit: (code: number) => void = process.exit,
): Promise<void> {
  session.status = SESSION_STATUS.stopped;
  await terminateSessionProcess(session, signal);
  session.error = `stopped because the calling smart-router process received ${signal}`;
  await saveSession(session);
  exit(SIGNAL_EXIT_CODE_OFFSET + constants.signals[signal]);
}

function lastLines(output: string): string {
  return output.trimEnd().split("\n").slice(-STDERR_LINE_LIMIT).join("\n");
}

export async function runForeground(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  session?: Session,
  exit: (code: number) => void = process.exit,
): Promise<string> {
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    stdio: [IGNORE, "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (session && child.pid) {
    session.pid = child.pid;
    session.processStartTime = processStartTime(child.pid);
  }
  const registration = session ? saveSession(session) : Promise.resolve();
  let stopping: Promise<void> | undefined;
  const handlers = FOREGROUND_SIGNALS.map((signal) => {
    const handler = () => {
      if (!session || stopping) return;
      stopping = registration.then(() =>
        forwardForegroundSignal(session, signal, exit),
      );
    };
    if (session) process.on(signal, handler);
    return { signal, handler };
  });
  let exitCode: number | null;
  try {
    await registration;
    exitCode = await completion;
    await stopping;
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
  if (exitCode !== 0) {
    const stdoutTail = lastLines(stdout);
    const stderrTail = lastLines(stderr);
    throw new Error(
      `Command ${argv[0]} exited with code ${exitCode}: stdout:\n${stdoutTail}\nstderr:\n${stderrTail}`,
    );
  }
  return stdout;
}

export async function runDetached(
  argv: string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ pid: number; errPath: string }> {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFile = openSync(logPath, "a");
  const errPath = join(
    dirname(logPath),
    `${basename(logPath, extname(logPath))}${ERROR_LOG_EXTENSION}`,
  );
  const errFile = openSync(errPath, "a");
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: [IGNORE, logFile, errFile],
  });
  closeSync(logFile);
  closeSync(errFile);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error(`Could not start: ${argv[0]}`);
  child.unref();
  return { pid: child.pid, errPath };
}
