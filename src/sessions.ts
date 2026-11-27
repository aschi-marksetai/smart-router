import { refreshT3Sessions } from "./t3.ts";
import {
  claimWake,
  recoverWakes,
  cancelPendingWakes,
  hasUnsettledWakes,
  type Wake,
} from "./wakes.ts";
import { sampleActivity, type ActivitySample } from "./activity.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { HarnessName } from "./config.ts";
import type { RouteRecord } from "./route.ts";
import { getAdapter } from "./harness/index.ts";
import { sessionsDir } from "./paths.ts";
import {
  parseJsonLines,
  record,
  usageFrom,
  turnUsage,
  type ParsedOutput,
  type Usage,
} from "./harness/types.ts";

const HANDLE_BYTES = 3;
const PROMPT_PREVIEW_LENGTH = 160;
const SESSION_FILE_SUFFIX = ".json";
const PROMPT_FILE_SUFFIX = ".prompt.md";
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
export const LOCK_RECLAIM_STALE_TIMEOUT_MS = 5_000;
export const CHILD_EXIT_OWNER_GRACE_MS = 2 * 60 * 1_000;
export const LOCK_ARTIFACT_MAX_AGE_MS = 10 * 60 * 1_000;
let lockOwnerStartTime: string | undefined;
const PROCESS_STOP_POLL_INTERVAL_MS = 50;
export const PROCESS_STOP_GRACE_PERIOD_MS = 5_000;
export const DELEGATE_EXIT_ERROR =
  "delegate process exited without reporting (killed; likely out of memory or the pids limit)";

export const SESSION_STATUS = {
  launched: "launched",
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

export type SessionTurn = {
  kind: "routed" | "pinned" | "resumed";
  startedAt: string;
  endedAt: string | null;
  idleSeconds: number | null;
  usage: Usage | null;
};

export type SessionRating = {
  value: "good" | "bad";
  note: string | null;
  at: string;
};

export type Session = {
  handle: string;
  runner?: "t3";
  t3ThreadId?: string;
  t3Revision?: number;
  t3LatestRunId?: string;
  t3ExpectedRunId?: string;
  t3BaselineRunCount?: number;
  t3UpdatedAt?: string;
  t3ResultKey?: string;
  t3UsageKey?: string;
  warning?: string;
  needsInput?: boolean;
  harness: HarnessName;
  model: string;
  effort: string;
  browser?: boolean;
  confined?: boolean;
  disallowedTools?: string[];
  allowedTools?: string;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  sandbox?: string;
  usesNetworkAccess?: boolean;
  // Set only when the caller chose a Claude permission mode; resume and retry keep it.
  permissionMode?: string;
  cwd: string;
  owner: string;
  sessionId?: string;
  createdAt: string;
  promptPreview: string;
  label?: string;
  phase?: string;
  status: SessionStatus;
  pid?: number;
  childExitedAt?: string;
  supervisorPid?: number;
  supervisorProcessStartTime?: string;
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
  turns?: SessionTurn[];
  turnLogOffset?: number;
  // Sessions saved before route record v2 hold an older shape or null; read it with isRouteRecord.
  route?: RouteRecord | null;
  promptSha256?: string;
  // The only stored retry link; the reverse direction is derived (see retriedBy in outcomes.ts).
  retryOf?: string;
  escalated?: boolean;
  rating?: SessionRating;
  wakes?: Wake[];
  activity?: {
    runtimeSeconds: number;
    silentSeconds: number;
    cpuSeconds: number | null;
  };
  activitySample?: ActivitySample;
  stuck?: { reason: string; since: string } | null;
};

export type CreateSessionOptions = Omit<
  Session,
  "handle" | "owner" | "createdAt" | "promptPreview"
> & {
  prompt: string;
  // The caller's task as given, before guardrails and delegation context; defaults to prompt.
  taskPrompt?: string;
  handle?: string;
  turnKind?: SessionTurn["kind"];
};

export function createSessionHandle(): string {
  return randomBytes(HANDLE_BYTES).toString("hex");
}

export function sessionPath(handle: string): string {
  return join(sessionsDir(), `${handle}${SESSION_FILE_SUFFIX}`);
}

export function sessionLogPath(handle: string): string {
  return join(sessionsDir(), `${handle}${LOG_FILE_SUFFIX}`);
}

export function sessionPromptPath(handle: string): string {
  return join(sessionsDir(), `${handle}${PROMPT_FILE_SUFFIX}`);
}

export function sessionMcpPath(handle: string): string {
  return join(sessionsDir(), `${handle}.mcp`);
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
  const taskPrompt = options.taskPrompt ?? options.prompt;
  const session: Session = {
    handle,
    runner: options.runner,
    t3ThreadId: options.t3ThreadId,
    t3Revision: options.runner === "t3" ? 0 : undefined,
    harness: options.harness,
    model: options.model,
    effort: options.effort,
    browser: options.browser,
    confined: options.confined,
    disallowedTools: options.disallowedTools,
    allowedTools: options.allowedTools,
    mcpConfig: options.mcpConfig,
    strictMcpConfig: options.strictMcpConfig,
    sandbox: options.sandbox,
    usesNetworkAccess: options.usesNetworkAccess,
    permissionMode: options.permissionMode,
    cwd: options.cwd,
    owner: sessionOwner(),
    sessionId: options.sessionId,
    createdAt: new Date().toISOString(),
    promptPreview: options.prompt.slice(0, PROMPT_PREVIEW_LENGTH),
    label: options.label,
    phase: options.phase,
    status: options.status,
    pid: options.pid,
    supervisorPid: options.supervisorPid,
    supervisorProcessStartTime: options.supervisorProcessStartTime,
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
    turns: options.turns,
    turnLogOffset: options.turnLogOffset,
    route: options.route,
    promptSha256: createHash("sha256").update(taskPrompt).digest("hex"),
    retryOf: options.retryOf,
    escalated: options.escalated,
  };
  if (options.turnKind) await startSessionTurn(session, options.turnKind);
  await writeFile(sessionPromptPath(handle), taskPrompt);
  await saveSession(session);
  return session;
}

export async function loadSession(handle: string): Promise<Session> {
  return JSON.parse(await readFile(sessionPath(handle), "utf8"));
}

export async function saveSession(
  session: Session,
  write:
    | "session"
    | "wakes"
    | "activity"
    | "claim"
    | "terminal"
    | "owner-terminal" = "session",
): Promise<void> {
  const replaceWakes = write === "wakes" || write === "claim";
  const metadataOnly = write === "wakes" || write === "activity";
  return withSessionsLock(
    async () => {
      const stored = await loadSession(session.handle).catch(() => undefined);
      if (write === "terminal" || write === "owner-terminal") {
        if (!stored) return;
        if (
          stored.status !== SESSION_STATUS.running ||
          !sameTurn(stored, session, write === "owner-terminal")
        ) {
          Object.assign(session, stored);
          return;
        }
      }
      if (metadataOnly && !stored) return;
      if (
        write === "activity" &&
        stored &&
        (stored.status !== SESSION_STATUS.running || !sameTurn(stored, session))
      ) {
        Object.assign(session, stored);
        return;
      }
      if (metadataOnly && stored) {
        const metadata = replaceWakes
          ? { wakes: session.wakes }
          : {
              childExitedAt: session.childExitedAt,
              activity: session.activity,
              activitySample: session.activitySample,
              stuck: session.stuck,
            };
        Object.assign(session, stored, metadata);
      }
      if (!replaceWakes) session.wakes = stored?.wakes ?? session.wakes;
      // rate annotates a session from another process; keep what it stored.
      session.rating = stored?.rating ?? session.rating;
      await writeSession(session);
    },
    stat,
    `.session-${session.handle}.lock`,
  );
}

// Changes one stored session under its lock, for annotations made by a process that does not own the run.
export async function updateSession(
  handle: string,
  change: (session: Session) => void,
): Promise<Session> {
  return withSessionsLock(
    async () => {
      const session = await loadSession(handle);
      change(session);
      // Makes a concurrent T3 refresh reload instead of writing its older copy back.
      if (session.runner === "t3")
        session.t3Revision = (session.t3Revision ?? 0) + 1;
      await writeSession(session);
      return session;
    },
    stat,
    `.session-${handle}.lock`,
  );
}

export async function readSessionPrompt(handle: string): Promise<string> {
  return readFile(sessionPromptPath(handle), "utf8");
}

async function writeSession(session: Session): Promise<void> {
  const destinationPath = sessionPath(session.handle);
  // Every terminal transition (done, failed, stopped, swept) saves here, so close an open turn once.
  const turn = session.turns?.at(-1);
  if (session.status !== SESSION_STATUS.running && turn?.endedAt === null) {
    const output = await readTurnLog(session).catch(() => "");
    let usage: Usage | null = null;
    for (const value of parseJsonLines(output)) {
      const event = record(value);
      usage =
        usageFrom(
          event?.usage ?? record(event?.message)?.usage,
          typeof event?.total_cost_usd === "number"
            ? event.total_cost_usd
            : null,
        ) ?? usage;
    }
    usage = turnUsage(usage, session);
    session.usage = addUsage(session.usage, usage);
    finishSessionTurn(session, usage);
  }
  if (session.confined && session.status !== SESSION_STATUS.running)
    await rm(sessionMcpPath(session.handle), { force: true });
  const temporaryPath = `${destinationPath}.${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`);
    await rename(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function startSessionTurn(
  session: Session,
  kind: SessionTurn["kind"],
): Promise<void> {
  const previousTurn = session.turns?.at(-1);
  const startedAt = new Date().toISOString();
  session.turnLogOffset = await stat(
    session.logPath ?? sessionLogPath(session.handle),
  )
    .then(({ size }) => size)
    .catch(() => 0);
  session.turns ??= [];
  session.turns.push({
    kind,
    startedAt,
    endedAt: null,
    idleSeconds: previousTurn?.endedAt
      ? Math.max(
          0,
          (Date.parse(startedAt) - Date.parse(previousTurn.endedAt)) / 1_000,
        )
      : null,
    usage: null,
  });
}

export function finishSessionTurn(session: Session, usage: Usage | null): void {
  const turn = session.turns?.at(-1);
  if (!turn || turn.endedAt !== null) return;
  turn.endedAt = new Date().toISOString();
  turn.usage = usage;
}

async function readTurnLog(session: Session): Promise<string> {
  const output = await readFile(
    session.logPath ?? sessionLogPath(session.handle),
  );
  return output.subarray(session.turnLogOffset ?? 0).toString("utf8");
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
      sessionMcpPath(handle),
      sessionPromptPath(handle),
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
    ...(current.cacheWrite5mTokens !== undefined &&
    next.cacheWrite5mTokens !== undefined
      ? {
          cacheWrite5mTokens:
            current.cacheWrite5mTokens + next.cacheWrite5mTokens,
          cacheWrite1hTokens:
            (current.cacheWrite1hTokens ?? 0) + (next.cacheWrite1hTokens ?? 0),
        }
      : {}),
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
  requestedHandles: string[] = [],
): Promise<Session[]> {
  await cleanupLockArtifacts();
  const sessions = await refreshT3Sessions(
    await listSessions(),
    new Set(requestedHandles),
  );
  for (const session of sessions) {
    if (hasUnsettledWakes(session))
      await withSessionsLock(async () => {
        const stored = await loadSession(session.handle).catch(() => undefined);
        if (stored) {
          await recoverWakes(stored);
          Object.assign(session, stored);
        }
      });
    if (session.runner === "t3") continue;
    if (session.status !== SESSION_STATUS.running) {
      session.stuck = null;
      continue;
    }

    const orphaned =
      session.wrapperPid &&
      !isTrackedProcessRunning(
        session.wrapperPid,
        session.wrapperProcessStartTime,
        getProcessStartTime,
      );
    if (orphaned && !session.pid) {
      session.status = SESSION_STATUS.failed;
      session.error =
        "calling smart-router process exited before registering its child pid";
      await saveTerminalSession(session);
      continue;
    }
    if (orphaned) {
      session.error =
        "stopped: its calling smart-router process exited (likely killed by the caller)";
      const output = await readFile(
        session.logPath ?? sessionLogPath(session.handle),
        "utf8",
      ).catch(() => "");
      Object.assign(session, logActivity(output));
      await stopSession(session, "SIGTERM", sessions);
      continue;
    }
    if (!session.pid) continue;
    const childRunning = isTrackedProcessRunning(
      session.pid,
      session.processStartTime,
      getProcessStartTime,
    );
    if (childRunning) {
      session.childExitedAt = undefined;
      await sampleActivity(session);
      await saveSession(session, "activity");
      continue;
    }
    const ownerRunning = isTrackedProcessRunning(
      session.wrapperPid,
      session.wrapperProcessStartTime,
      getProcessStartTime,
    );
    if (ownerRunning) {
      const observed = { ...session };
      const childExitedAt = session.childExitedAt ?? new Date().toISOString();
      session.childExitedAt = childExitedAt;
      await sampleActivity(session);
      session.stuck = {
        reason: "child exited; owner still finishing",
        since: session.childExitedAt,
      };
      await saveSession(session, "activity");
      if (
        !sameTurn(session, observed) ||
        session.status !== SESSION_STATUS.running
      )
        continue;
      if (Date.now() - Date.parse(childExitedAt) < CHILD_EXIT_OWNER_GRACE_MS)
        continue;
    }
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
  lockName = SPAWN_LOCK_DIRECTORY,
): Promise<T> {
  await mkdir(sessionsDir(), { recursive: true });
  const lockPath = join(sessionsDir(), lockName);
  const owner = newLockOwner();
  const readOwner = () => readLockOwner(lockPath);
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await publishLockOwner(lockPath, owner);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "ENOTEMPTY")
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
      const holder = await readOwner().catch(() => undefined);
      const deadOwner = lockOwnerDead(holder);
      if (
        deadOwner ||
        (!holder && Date.now() - lockStat.mtimeMs > LOCK_STALE_TIMEOUT_MS)
      )
        await reclaimSessionLock(lockPath, holder?.token);
      await Bun.sleep(LOCK_RETRY_INTERVAL_MS);
    }
  }
  try {
    return await action();
  } finally {
    await releaseLock(lockPath, owner.token);
  }
}

function newLockOwner() {
  return {
    pid: process.pid,
    startTime: (lockOwnerStartTime ??= processStartTime(process.pid)),
    token: randomUUID(),
  };
}
async function readLockOwner(path: string) {
  return record(JSON.parse(await readFile(join(path, "owner.json"), "utf8")));
}
function lockOwnerDead(owner: Record<string, unknown> | undefined): boolean {
  return (
    typeof owner?.pid === "number" &&
    (!isProcessRunning(owner.pid) ||
      (typeof owner.startTime === "string" &&
        !!processStartTime(owner.pid) &&
        processStartTime(owner.pid) !== owner.startTime))
  );
}
async function publishLockOwner(
  path: string,
  owner: ReturnType<typeof newLockOwner>,
): Promise<void> {
  const temporaryPath = join(path, `owner.${owner.token}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(owner));
  await rename(temporaryPath, join(path, "owner.json"));
}
async function releaseLock(path: string, token: string): Promise<void> {
  if ((await readLockOwner(path).catch(() => undefined))?.token !== token)
    return;
  const trash = `${path}.${token}.release`;
  try {
    await rename(path, trash);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  await rm(trash, { recursive: true, force: true });
}
async function cleanupLockArtifacts(): Promise<void> {
  const entries = await readdir(sessionsDir(), { withFileTypes: true }).catch(
    () => [],
  );
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (/^\.spawn\.lock\..+\.(acquire|trash|release)$/.test(entry.name) ||
            /^\.session-.+\.lock\.(?!reclaim$).+/.test(entry.name)),
      )
      .map(async (entry) => {
        const path = join(sessionsDir(), entry.name);
        const modified = await stat(path).catch(() => undefined);
        if (
          modified &&
          Date.now() - modified.mtimeMs >= LOCK_ARTIFACT_MAX_AGE_MS
        )
          await rm(path, { recursive: true, force: true });
      }),
  );
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
  if (session.turns?.at(-1)?.endedAt) return session;
  let output = "";
  let parseError: unknown;
  try {
    output = await readTurnLog(session);
    const parsed = parseOutput(output);
    parsed.usage = turnUsage(parsed.usage, session);
    session.sessionId = parsed.sessionId || session.sessionId;
    session.result = parsed.result;
    session.lastResult = parsed.result;
    session.usage = addUsage(session.usage, parsed.usage);
    finishSessionTurn(session, parsed.usage);
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
  await saveTerminalSession(session);
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
  // A watched job may share the delegate process group after its parent exits.
  const group = (pid: number) => {
    try {
      return execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    } catch {
      return undefined;
    }
  };
  const watchedGroup = session.wakes?.some(
    (wake) =>
      wake.state === "pending" &&
      isTrackedProcessRunning(wake.pid, wake.startTime) &&
      group(wake.pid) === String(session.pid),
  );
  let target = watchedGroup ? session.pid : -session.pid;
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
    const running = descendant.status === SESSION_STATUS.running;
    if (running && descendant.runner !== "t3")
      descendant.error = `stopped because ancestor ${handle} stopped`;
    if (!(await markStopped(descendant, running && descendant.runner !== "t3")))
      continue;
    if (!running || descendant.runner === "t3") continue;
    await terminateSessionProcess(descendant);
  }
}

export async function stopSession(
  session: Session,
  signal: NodeJS.Signals = "SIGTERM",
  knownSessions?: Session[],
): Promise<Session> {
  if (!(await markStopped(session))) return session;
  await stopDescendants(session.handle, knownSessions);
  await terminateSessionProcess(session, signal);
  return session;
}

function sameTurn(left: Session, right: Session, ownerWrite = false): boolean {
  return (
    (ownerWrite || left.pid === right.pid) &&
    left.turns?.at(-1)?.startedAt === right.turns?.at(-1)?.startedAt
  );
}

export async function saveTerminalSession(
  session: Session,
  match: "pid-and-turn" | "owner-turn" = "pid-and-turn",
): Promise<void> {
  await withSessionsLock(() =>
    saveSession(
      session,
      match === "owner-turn" ? "owner-terminal" : "terminal",
    ),
  );
}

async function markStopped(session: Session, stop = true): Promise<boolean> {
  return withSessionsLock(() =>
    withSessionsLock(
      async () => {
        const stored = await loadSession(session.handle).catch(() => undefined);
        if (!stored) return false;
        if (!sameTurn(stored, session) || stored.status !== session.status) {
          Object.assign(session, stored);
          return false;
        }
        cancelPendingWakes(stored);
        if (stop) stored.status = SESSION_STATUS.stopped;
        stored.sessionId = session.sessionId ?? stored.sessionId;
        stored.error = session.error ?? stored.error;
        stored.lastMessage = session.lastMessage ?? stored.lastMessage;
        stored.lastAction = session.lastAction ?? stored.lastAction;
        await writeSession(stored);
        Object.assign(session, stored);
        return true;
      },
      stat,
      `.session-${session.handle}.lock`,
    ),
  );
}

export async function reclaimSessionLock(
  lockPath: string,
  expectedToken: unknown,
): Promise<boolean> {
  const mutexPath = `${lockPath}.reclaim`;
  const owner = newLockOwner();
  try {
    await mkdir(mutexPath);
    await publishLockOwner(mutexPath, owner);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    const holder = await readLockOwner(mutexPath).catch(() => undefined);
    const mutexStat = await stat(mutexPath).catch(() => undefined);
    if (
      lockOwnerDead(holder) ||
      (!holder &&
        mutexStat &&
        Date.now() - mutexStat.mtimeMs >= LOCK_RECLAIM_STALE_TIMEOUT_MS)
    ) {
      const trash = `${mutexPath}.${randomUUID()}.trash`;
      try {
        await rename(mutexPath, trash);
        const moved = await readLockOwner(trash).catch(() => undefined);
        if (moved?.token === holder?.token)
          await rm(trash, { recursive: true, force: true });
      } catch {}
    }
    return false;
  }
  try {
    const holder = await readFile(join(lockPath, "owner.json"), "utf8")
      .then((value) => record(JSON.parse(value)))
      .catch(() => undefined);
    if (holder?.token !== expectedToken) return false;
    if (expectedToken === undefined) {
      const current = await stat(lockPath).catch(() => undefined);
      if (!current || Date.now() - current.mtimeMs < LOCK_STALE_TIMEOUT_MS)
        return false;
    }
    const trashPath = `${lockPath}.${randomUUID()}.trash`;
    try {
      await rename(lockPath, trashPath);
    } catch {
      return false;
    }
    await rm(trashPath, { recursive: true });
    return true;
  } finally {
    await releaseLock(mutexPath, owner.token);
  }
}

export async function saveT3Session(
  next: Session,
  expected: Session,
  wakeId?: string,
): Promise<boolean> {
  return withSessionsLock(() =>
    withSessionsLock(
      async () => {
        const stored = await loadSession(next.handle).catch(() => undefined);
        if (
          !stored ||
          stored.runner !== "t3" ||
          stored.t3Revision !== expected.t3Revision ||
          stored.t3ThreadId !== expected.t3ThreadId
        ) {
          if (stored) Object.assign(next, stored);
          return false;
        }
        next.wakes = structuredClone(stored.wakes);
        if (wakeId) claimWake(next, wakeId);
        if (JSON.stringify(next) === JSON.stringify(stored)) {
          Object.assign(expected, next);
          return true;
        }
        next.t3Revision = (stored.t3Revision ?? 0) + 1;
        await writeSession(next);
        Object.assign(expected, next);
        return true;
      },
      stat,
      `.session-${next.handle}.lock`,
    ),
  );
}

export async function expireT3Launch(session: Session): Promise<boolean> {
  return withSessionsLock(() =>
    withSessionsLock(
      async () => {
        const stored = await loadSession(session.handle).catch(() => undefined);
        if (!stored) return true;
        if (
          stored.runner !== "t3" ||
          stored.status !== "launched" ||
          stored.t3ThreadId ||
          stored.t3Revision !== session.t3Revision
        ) {
          Object.assign(session, stored);
          return false;
        }
        await removeSession(session.handle);
        return true;
      },
      stat,
      `.session-${session.handle}.lock`,
    ),
  );
}
