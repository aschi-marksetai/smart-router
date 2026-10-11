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
const SOCKET_FILE_SUFFIX = ".sock";
const STDERR_LINE_LIMIT = 20;
const OWNER_ENVIRONMENT_VARIABLE = "SMART_ROUTER_OWNER";
const CLAUDE_SESSION_ENVIRONMENT_VARIABLE = "CLAUDE_CODE_SESSION_ID";
const DAY_MS = 24 * 60 * 60 * 1_000;
const SPAWN_LOCK_DIRECTORY = ".spawn.lock";
const LOCK_RETRY_INTERVAL_MS = 20;
const LOCK_STALE_TIMEOUT_MS = 30_000;
const PROCESS_STOP_POLL_INTERVAL_MS = 50;
export const PROCESS_STOP_GRACE_PERIOD_MS = 5_000;
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
  supervisorPid?: number;
  wrapperPid?: number;
  wrapperProcessStartTime?: string;
  processStartTime?: string;
  depth?: number;
  parentHandle?: string;
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

export function sessionSocketPath(handle: string): string {
  return join(sessionsDir(), `${handle}${SOCKET_FILE_SUFFIX}`);
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
    wrapperPid: options.wrapperPid,
    wrapperProcessStartTime: options.wrapperProcessStartTime,
    processStartTime: options.processStartTime,
    depth: options.depth,
    parentHandle: options.parentHandle,
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
    [
      sessionPath(handle),
      sessionLogPath(handle),
      sessionErrPath(handle),
      sessionSocketPath(handle),
    ].map((path) => rm(path, { force: true })),
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

function addNullableTokens(
  current: number | null,
  next: number | null,
): number | null {
  if (typeof current !== "number" || typeof next !== "number") return null;
  return current + next;
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
    cachedInputTokens: addNullableTokens(
      current.cachedInputTokens,
      next.cachedInputTokens,
    ),
    cacheWriteTokens: addNullableTokens(
      current.cacheWriteTokens,
      next.cacheWriteTokens,
    ),
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

function isTrackedProcessRunning(
  pid: number | undefined,
  startTime: string | undefined,
  getProcessStartTime = processStartTime,
): boolean {
  if (!pid || !isProcessRunning(pid)) return false;
  const currentStartTime = getProcessStartTime(pid);
  if (!startTime || !currentStartTime) return true;
  return startTime === currentStartTime;
}

export function logActivity(
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
    if (session.status !== SESSION_STATUS.running || !session.pid) continue;
    const childRunning = isTrackedProcessRunning(
      session.pid,
      session.processStartTime,
      getProcessStartTime,
    );
    const orphaned =
      session.wrapperPid &&
      !isTrackedProcessRunning(
        session.wrapperPid,
        session.wrapperProcessStartTime,
        getProcessStartTime,
      );
    if (orphaned) {
      await stopSession(session, "SIGTERM", sessions);
      session.error =
        "stopped: its calling smart-router process exited (likely killed by the caller)";
      const output = await readFile(
        session.logPath ?? sessionLogPath(session.handle),
        "utf8",
      ).catch(() => "");
      Object.assign(session, logActivity(output));
      await saveSession(session);
      continue;
    }
    if (childRunning) continue;
    if (!isProcessRunning(session.pid)) await terminateSessionProcess(session);
    const completed = await completeSessionFromLog(
      session,
      getAdapter(session.harness).parseSpawnOutput,
      true,
    );
    if (completed.status === SESSION_STATUS.failed)
      await stopDescendants(session.handle, sessions);
  }
  return sessions;
}

export async function withSessionsLock<T>(
  action: () => Promise<T>,
  getLockStat: (path: string) => Promise<{ mtimeMs: number }> = stat,
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
      const lockStat = await getLockStat(lockPath).catch(
        (statError: unknown) => {
          if (
            statError instanceof Error &&
            "code" in statError &&
            statError.code === "ENOENT"
          )
            return undefined;
          throw statError;
        },
      );
      if (!lockStat) continue;
      const lockAge = Date.now() - lockStat.mtimeMs;
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
    session.error =
      delegateExited && !parseError
        ? DELEGATE_EXIT_ERROR
        : await failureMessage(session, parseError);
    Object.assign(session, logActivity(output));
  }
  await saveSession(session);
  return session;
}

export async function terminateSessionProcess(
  session: Session,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (!session.pid) return;
  const processRunning = isProcessRunning(session.pid);
  if (
    processRunning &&
    !isTrackedProcessRunning(session.pid, session.processStartTime)
  )
    return;
  let target = -session.pid;
  if (!isProcessRunning(target)) target = session.pid;
  if (!isProcessRunning(target)) return;
  const sendSignal = (nextSignal: NodeJS.Signals) => {
    try {
      process.kill(target, nextSignal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return;
      throw error;
    }
  };
  sendSignal(signal);
  const deadline = Date.now() + PROCESS_STOP_GRACE_PERIOD_MS;
  while (isProcessRunning(target)) {
    if (Date.now() >= deadline) sendSignal("SIGKILL");
    await Bun.sleep(PROCESS_STOP_POLL_INTERVAL_MS);
  }
}

async function stopDescendants(
  handle: string,
  knownSessions?: Session[],
): Promise<void> {
  const sessions = knownSessions ?? (await listSessions());
  const visited = new Set([handle]);
  const ancestorHandles = [handle];
  const descendants: Session[] = [];
  for (const parentHandle of ancestorHandles) {
    for (const descendant of sessions) {
      if (
        descendant.parentHandle !== parentHandle ||
        visited.has(descendant.handle)
      )
        continue;
      visited.add(descendant.handle);
      ancestorHandles.push(descendant.handle);
      descendants.push(descendant);
    }
  }
  for (const descendant of descendants.reverse()) {
    if (descendant.status !== SESSION_STATUS.running) continue;
    await terminateSessionProcess(descendant);
    descendant.status = SESSION_STATUS.stopped;
    descendant.error = `stopped because ancestor ${handle} stopped`;
    await saveSession(descendant);
  }
}

export async function stopSession(
  session: Session,
  signal: NodeJS.Signals = "SIGTERM",
  knownSessions?: Session[],
): Promise<Session> {
  await stopDescendants(session.handle, knownSessions);
  await terminateSessionProcess(session, signal);
  session.status = SESSION_STATUS.stopped;
  await saveSession(session);
  return session;
}
