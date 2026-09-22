import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessName } from "./config.ts";
import { sessionsDir } from "./paths.ts";
import type { ParsedOutput, Usage } from "./harness/types.ts";

const HANDLE_BYTES = 3;
const PROMPT_PREVIEW_LENGTH = 160;
const SESSION_FILE_SUFFIX = ".json";
const LOG_FILE_SUFFIX = ".log";
const ERR_FILE_SUFFIX = ".err";
const STDERR_LINE_LIMIT = 20;
const OWNER_ENVIRONMENT_VARIABLE = "SMART_ROUTER_OWNER";
const CLAUDE_SESSION_ENVIRONMENT_VARIABLE = "CLAUDE_CODE_SESSION_ID";
const DAY_MS = 24 * 60 * 60 * 1_000;

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
  logPath?: string;
  errPath?: string;
  result?: string;
  lastResult?: string;
  error?: string;
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
    logPath: options.logPath,
    errPath: options.errPath,
    result: options.result,
    lastResult: options.lastResult ?? options.result,
    error: options.error,
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
): Promise<Session> {
  try {
    const output = await readFile(
      session.logPath ?? sessionLogPath(session.handle),
      "utf8",
    );
    const parsed = parseOutput(output);
    session.sessionId = parsed.sessionId || session.sessionId;
    session.result = parsed.result;
    session.lastResult = parsed.result;
    session.usage = addUsage(session.usage, parsed.usage);
    if (parsed.result) session.status = SESSION_STATUS.done;
    else {
      session.status = SESSION_STATUS.failed;
      session.error = await failureMessage(session);
    }
  } catch (error) {
    session.status = SESSION_STATUS.failed;
    session.error = await failureMessage(session, error);
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
