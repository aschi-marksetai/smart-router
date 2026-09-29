import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { HarnessName } from "./config.ts";
import { getAdapter } from "./harness/index.ts";
import { sessionsDir } from "./paths.ts";
import {
  parseJsonLines,
  record,
  type ParsedOutput,
  type Usage,
} from "./harness/types.ts";

const HANDLE_BYTES = 3;
const PROMPT_PREVIEW_LENGTH = 160;
const SESSION_FILE_SUFFIX = ".json";
const LOG_FILE_SUFFIX = ".log";
const ERR_FILE_SUFFIX = ".err";
const STDERR_LINE_LIMIT = 20;
const OWNER_ENVIRONMENT_VARIABLE = "SMART_ROUTER_OWNER";
const CLAUDE_SESSION_ENVIRONMENT_VARIABLE = "CLAUDE_CODE_SESSION_ID";
const DAY_MS = 24 * 60 * 60 * 1_000;
const SPAWN_LOCK_DIRECTORY = ".spawn.lock";
const LOCK_RETRY_INTERVAL_MS = 20;
const LOCK_STALE_TIMEOUT_MS = 30_000;
export const DELEGATE_EXIT_ERROR =
  "delegate process exited without reporting (killed; likely out of memory or the pids limit)";

export const SESSION_STATUS = {
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
} as const;
export const FINISHED_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  SESSION_STATUS.done,
  SESSION_STATUS.failed,
  SESSION_STATUS.stopped,
]);

export type SessionStatus =
  (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export type Session = {
  handle: string;
  harness: HarnessName;
  model: string;
  effort: string;
  browser?: boolean;
  sandbox?: string;
  usesNetworkAccess?: boolean;
  cwd: string;
  owner: string;
  sessionId?: string;
  createdAt: string;
  promptPreview: string;
  status: SessionStatus;
  pid?: number;
  processStartTime?: string;
  depth?: number;
  logPath?: string;
  errPath?: string;
  result?: string;
  lastResult?: string;
  error?: string;
  lastMessage?: string;
  lastAction?: string;
  usage?: Usage | null;
  route?: unknown;
};

export type CreateSessionOptions = Omit<
  Session,
  "handle" | "owner" | "createdAt" | "promptPreview"
> & { prompt: string; handle?: string };

export function createSessionHandle(): string {
  return randomBytes(HANDLE_BYTES).toString("hex");
}

export function sessionPath(handle: string): string {
  return join(sessionsDir(), `${handle}${SESSION_FILE_SUFFIX}`);
}

export function sessionLogPath(handle: string): string {
  return join(sessionsDir(), `${handle}${LOG_FILE_SUFFIX}`);
}

export function sessionErrPath(handle: string): string {
  return join(sessionsDir(), `${handle}${ERR_FILE_SUFFIX}`);
}

export function sessionOwner(): string {
  return (
    process.env[OWNER_ENVIRONMENT_VARIABLE] ??
    process.env[CLAUDE_SESSION_ENVIRONMENT_VARIABLE] ??
    String(process.ppid)
  );
}

export async function createSession(
  options: CreateSessionOptions,
): Promise<Session> {
  await mkdir(sessionsDir(), { recursive: true });
  const handle = options.handle ?? createSessionHandle();
  const session: Session = {
    handle,
    harness: options.harness,
    model: options.model,
    effort: options.effort,
    browser: options.browser,
    sandbox: options.sandbox,
    usesNetworkAccess: options.usesNetworkAccess,
    cwd: options.cwd,
    owner: sessionOwner(),
    sessionId: options.sessionId,
    createdAt: new Date().toISOString(),
    promptPreview: options.prompt.slice(0, PROMPT_PREVIEW_LENGTH),
    status: options.status,
    pid: options.pid,
    processStartTime: options.processStartTime,
    depth: options.depth,
    logPath: options.logPath,
    errPath: options.errPath,
    result: options.result,
    lastResult: options.lastResult ?? options.result,
    error: options.error,
    lastMessage: options.lastMessage,
    lastAction: options.lastAction,
    usage: options.usage,
    route: options.route,
  };
  await writeFile(sessionPath(handle), `${JSON.stringify(session, null, 2)}\n`);
  return session;
}

export async function loadSession(handle: string): Promise<Session> {
  return JSON.parse(await readFile(sessionPath(handle), "utf8"));
}

export async function saveSession(session: Session): Promise<void> {
  await writeFile(
    sessionPath(session.handle),
    `${JSON.stringify(session, null, 2)}\n`,
  );
}

export async function listSessions(owner?: string): Promise<Session[]> {
  let files: string[];
  try {
    files = await readdir(sessionsDir());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  const sessions = await Promise.all(
    files
      .filter((file) => file.endsWith(SESSION_FILE_SUFFIX))
      .map((file) => loadSession(file.slice(0, -SESSION_FILE_SUFFIX.length))),
  );
  const ownedSessions = owner
    ? sessions.filter((session) => session.owner === owner)
    : sessions;
  return ownedSessions.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function removeSession(handle: string): Promise<void> {
  await loadSession(handle);
  await Promise.all(
    [sessionPath(handle), sessionLogPath(handle), sessionErrPath(handle)].map(
      (path) => rm(path, { force: true }),
    ),
  );
}

export async function pruneSessions(olderThanDays: number): Promise<string[]> {
  const cutoff = Date.now() - olderThanDays * DAY_MS;
  const sessions = await listSessions();
  const removed: string[] = [];
  for (const session of sessions) {
    const createdAt = Date.parse(session.createdAt);
    if (
      FINISHED_SESSION_STATUSES.has(session.status) &&
      Number.isFinite(createdAt) &&
      createdAt < cutoff
    ) {
      await removeSession(session.handle);
      removed.push(session.handle);
    }
  }
  return removed;
}

export function addUsage(
  current: Usage | null | undefined,
  next: Usage | null,
): Usage | null | undefined {
  if (!next) return current;
  if (!current) return next;
  const costUsd =
    current.costUsd === null || next.costUsd === null
      ? null
      : current.costUsd + next.costUsd;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    costUsd,
  };
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

export function processStartTime(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const processStat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
    }
    if (process.platform === "darwin")
      return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
  } catch {}
  return undefined;
}

function isSessionProcessRunning(
  session: Session,
  getProcessStartTime: (pid: number) => string | undefined,
): boolean {
  if (!session.pid || !isProcessRunning(session.pid)) return false;
  const currentStartTime = getProcessStartTime(session.pid);
  if (!session.processStartTime || !currentStartTime) return true;
  return session.processStartTime === currentStartTime;
}

function logActivity(
  output: string,
): Pick<Session, "lastMessage" | "lastAction"> {
  let lastMessage: string | undefined;
  let lastAction: string | undefined;
  for (const value of parseJsonLines(output)) {
    const event = record(value);
    const item = record(event?.item);
    const message = record(event?.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const candidate of [item, ...content.map(record)]) {
      const type = candidate?.type;
      const text = candidate?.text;
      if (
        (type === "agent_message" || type === "text") &&
        typeof text === "string"
      )
        lastMessage = text;
      if (
        typeof type === "string" &&
        (type.includes("command") || type.includes("tool"))
      ) {
        const action = candidate?.command ?? candidate?.name ?? candidate?.tool;
        lastAction =
          typeof action === "string" ? action : JSON.stringify(candidate);
      }
    }
  }
  return { lastMessage, lastAction };
}

export async function sweepSessions(
  getProcessStartTime = processStartTime,
): Promise<Session[]> {
  const sessions = await listSessions();
  for (const session of sessions) {
    const shouldSweep =
      session.status === SESSION_STATUS.running &&
      !!session.pid &&
      !isSessionProcessRunning(session, getProcessStartTime);
    if (shouldSweep)
      await completeSessionFromLog(
        session,
        getAdapter(session.harness).parseSpawnOutput,
        true,
      );
  }
  return sessions;
}

export async function withSessionsLock<T>(
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(sessionsDir(), { recursive: true });
  const lockPath = join(sessionsDir(), SPAWN_LOCK_DIRECTORY);
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
      if (lockAge > LOCK_STALE_TIMEOUT_MS)
        await rm(lockPath, { recursive: true });
      await Bun.sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function failureMessage(
  session: Session,
  parseError?: unknown,
): Promise<string> {
  const messages: string[] = [];
  if (parseError instanceof Error) messages.push(parseError.message);
  if (session.errPath) {
    try {
      const stderr = await readFile(session.errPath, "utf8");
      const stderrTail = stderr
        .trimEnd()
        .split("\n")
        .slice(-STDERR_LINE_LIMIT)
        .join("\n");
      if (stderrTail) messages.push(stderrTail);
    } catch {}
  }
  return messages.join("\n") || "Harness output did not contain a result";
}

export async function completeSessionFromLog(
  session: Session,
  parseOutput: (output: string) => ParsedOutput,
  delegateExited = false,
): Promise<Session> {
  let output = "";
  let parseError: unknown;
  try {
    output = await readFile(
      session.logPath ?? sessionLogPath(session.handle),
      "utf8",
    );
    const parsed = parseOutput(output);
    session.sessionId = parsed.sessionId || session.sessionId;
    session.result = parsed.result;
    session.lastResult = parsed.result;
    session.usage = addUsage(session.usage, parsed.usage);
    session.status = parsed.result
      ? SESSION_STATUS.done
      : SESSION_STATUS.failed;
  } catch (error) {
    session.status = SESSION_STATUS.failed;
    parseError = error;
  }
  if (session.status === SESSION_STATUS.failed) {
    session.error = delegateExited
      ? DELEGATE_EXIT_ERROR
      : await failureMessage(session, parseError);
    if (delegateExited) Object.assign(session, logActivity(output));
  }
  await saveSession(session);
  return session;
}

export async function stopSession(session: Session): Promise<Session> {
  if (session.pid && isProcessRunning(session.pid))
    process.kill(session.pid, "SIGTERM");
  session.status = SESSION_STATUS.stopped;
  await saveSession(session);
  return session;
}
