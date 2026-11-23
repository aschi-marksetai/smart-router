import { resetPendingWake } from "./wakes.ts";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { record } from "./harness/types.ts";
import { STUCK_SILENCE_SECONDS } from "./activity.ts";
import {
  loadSession,
  saveT3Session,
  expireT3Launch,
  type Session,
} from "./sessions.ts";

export const T3_CLI_ENVIRONMENT_VARIABLE = "SMART_ROUTER_T3_CLI";
export const DEFAULT_T3_CLI = join(homedir(), ".t3", "bin", "t3");
export const T3_ATTACH_TIMEOUT_MS = 15 * 60 * 1_000;
const T3_CLI_TIMEOUT_MS = 30_000;
export const T3_SHOW_TIMEOUT_MS = 5_000;
export const T3_REFRESH_CONCURRENCY = 4;
export const T3_NO_LOG =
  "T3 sessions have no smart-router log; open the thread in T3";
const T3_NEEDS_INPUT = "waiting for an answer in T3";
class T3CliError extends Error {
  constructor(
    message: string,
    readonly kind: "not-sent" | "gone" | "other",
  ) {
    super(message);
  }
}
const T3_CLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
type ThreadView = {
  status: string;
  updatedAt: string;
  activeRunId?: string;
  latestRunId?: string;
  runCount?: number;
  pendingRequestCount?: number;
  messages: { role: string; text: string; runId?: string }[];
};

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Invalid T3 string field");
  return value;
}
async function t3Command(args: string[], message?: string): Promise<string> {
  const binary = process.env[T3_CLI_ENVIRONMENT_VARIABLE] ?? DEFAULT_T3_CLI;
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      {
        encoding: "utf8",
        timeout: args[1] === "show" ? T3_SHOW_TIMEOUT_MS : T3_CLI_TIMEOUT_MS,
        maxBuffer: T3_CLI_MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (error.code === "ENOENT")
          return reject(
            new T3CliError(
              `T3 CLI not found at ${binary}; set ${T3_CLI_ENVIRONMENT_VARIABLE}`,
              "not-sent",
            ),
          );
        const detail = stderr.trim() || error.message;
        let kind: "not-sent" | "gone" | "other" = "other";
        if (
          /Thread .+ (?:is no longer available|was not found)|The thread was not found|thread_not_found/i.test(
            detail,
          )
        )
          kind = "gone";
        else if (
          /No running T3 Code server/i.test(detail) ||
          (/Could not reach the T3 Code server/i.test(detail) &&
            /ECONNREFUSED|connection refused/i.test(detail))
        )
          kind = "not-sent";
        reject(new T3CliError(`T3 CLI failed: ${detail}`, kind));
      },
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(message);
  });
}
async function showThread(id: string, messages: 0 | 1): Promise<ThreadView> {
  const value = record(
    JSON.parse(
      await t3Command([
        "thread",
        "show",
        id,
        "--json",
        "--messages",
        String(messages),
      ]),
    ),
  );
  const thread = record(value?.thread);
  const status = text(thread?.status),
    updatedAt = text(thread?.updatedAt);
  if (!status || !updatedAt || !Number.isFinite(Date.parse(updatedAt)))
    throw new Error("Invalid T3 thread state");
  const entries = value?.messages ?? [];
  if (!Array.isArray(entries)) throw new Error("Invalid T3 messages");
  const pendingRequestCount = thread?.pendingRequestCount ?? 0;
  if (
    typeof pendingRequestCount !== "number" ||
    !Number.isInteger(pendingRequestCount) ||
    pendingRequestCount < 0
  )
    throw new Error("Invalid T3 pending request count");
  const runCount = thread?.runCount;
  return {
    status,
    updatedAt,
    activeRunId: text(thread?.activeRunId),
    latestRunId: text(thread?.latestRunId),
    runCount:
      typeof runCount === "number" && Number.isInteger(runCount)
        ? runCount
        : undefined,
    pendingRequestCount,
    messages: entries.map((entry) => {
      const message = record(entry);
      const role = text(message?.role),
        content = text(message?.text);
      if (!role || content === undefined) throw new Error("Invalid T3 message");
      return { role, text: content, runId: text(message?.runId) };
    }),
  };
}
export function t3State(thread: ThreadView): {
  status: Session["status"];
  warning?: string;
  needsInput?: boolean;
} {
  if ((thread.pendingRequestCount ?? 0) > 0)
    return { status: "running", warning: T3_NEEDS_INPUT, needsInput: true };
  let status: Session["status"];
  switch (thread.status) {
    case "idle":
    case "completed":
      status = "done";
      break;
    case "failed":
      status = "failed";
      break;
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      status = "stopped";
      break;
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      status = "running";
      break;
    default:
      return {
        status: "running",
        warning: `Unknown T3 status: ${thread.status}`,
      };
  }
  if (thread.activeRunId) status = "running";
  return { status, needsInput: false };
}

export async function attachT3Session(
  handle: string,
  threadId: string,
): Promise<Session> {
  if (!threadId || threadId.startsWith("-") || /[\s\p{Cc}]/u.test(threadId))
    throw new Error("invalid T3 thread id");
  const session = await loadSession(handle).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error(`unknown or expired handle ${handle}`);
    throw error;
  });
  if (session.runner !== "t3" || session.t3ThreadId)
    throw new Error("session is not an unattached T3 launch");
  const view = await showThread(threadId, 0);
  const attached = { ...session, t3ThreadId: threadId, ...t3State(view) };
  if (!(await saveT3Session(attached, session)))
    throw new Error("session changed while attaching; retry");
  return attached;
}
// A thread runs one turn at a time, so once it has had more runs than before our send, our run has
// happened, even if a later run (e.g. a message sent from T3 itself) has replaced it as the latest.
function expectedRunPending(next: Session, view: ThreadView): boolean {
  if (next.t3ExpectedRunId === view.latestRunId) return false;
  // shortcut: without a runCount on both sides, wait for the exact run id; a later run then keeps it pending.
  if (next.t3BaselineRunCount === undefined || view.runCount === undefined)
    return true;
  return view.runCount <= next.t3BaselineRunCount;
}

function applyView(next: Session, view: ThreadView): void {
  if (next.t3ExpectedRunId && expectedRunPending(next, view)) {
    next.status = "running";
    next.needsInput = false;
    next.warning = undefined;
    next.stuck = null;
    return;
  }
  next.t3ExpectedRunId = undefined;
  next.t3BaselineRunCount = undefined;
  const state = t3State(view);
  Object.assign(next, state);
  next.needsInput = state.needsInput ?? false;
  next.warning = state.warning;
  next.t3LatestRunId = view.latestRunId;
  next.t3UpdatedAt = view.updatedAt;
  const silentSeconds = Math.max(
    0,
    (Date.now() - Date.parse(view.updatedAt)) / 1000,
  );
  next.activity = {
    runtimeSeconds: Math.max(
      0,
      (Date.now() - Date.parse(next.createdAt)) / 1000,
    ),
    silentSeconds,
    cpuSeconds: null,
  };
  next.stuck = null;
  if (next.needsInput)
    next.stuck = { reason: T3_NEEDS_INPUT, since: view.updatedAt };
  else if (
    next.status === "running" &&
    silentSeconds >= STUCK_SILENCE_SECONDS
  ) {
    next.stuck = {
      reason: "T3 updatedAt silent; CPU unavailable",
      since: new Date(
        Date.parse(view.updatedAt) + STUCK_SILENCE_SECONDS * 1000,
      ).toISOString(),
    };
  }
  next.error = next.status === "failed" ? "T3 thread failed" : undefined;
}
function noteError(next: Session, error: unknown): void {
  next.warning = String(error);
  next.needsInput = false;
  if (next.stuck?.reason === T3_NEEDS_INPUT) next.stuck = null;
  if (error instanceof T3CliError && error.kind === "gone") {
    next.status = "failed";
    next.needsInput = false;
    next.stuck = null;
    next.error = error.message;
  }
}
async function persistView(next: Session, session: Session): Promise<void> {
  if (
    JSON.stringify({ ...next, activity: session.activity }) !==
    JSON.stringify(session)
  )
    await saveT3Session(next, session);
  Object.assign(session, next);
}
export async function refreshT3Session(session: Session): Promise<boolean> {
  if (!session.t3ThreadId) {
    if (
      session.status === "launched" &&
      Date.now() - Date.parse(session.createdAt) >= T3_ATTACH_TIMEOUT_MS
    )
      return !(await expireT3Launch(session));
    return true;
  }
  const next = structuredClone(session);
  try {
    applyView(next, await showThread(session.t3ThreadId, 0));
  } catch (error) {
    noteError(next, error);
  }
  await persistView(next, session);
  return true;
}
export async function refreshT3Sessions(
  sessions: Session[],
  requested: ReadonlySet<string> = new Set(),
): Promise<Session[]> {
  let cursor = 0;
  const retained = sessions.map(() => true);
  await Promise.all(
    Array.from(
      { length: Math.min(T3_REFRESH_CONCURRENCY, sessions.length) },
      async () => {
        while (cursor < sessions.length) {
          const index = cursor++,
            session = sessions[index];
          if (
            session.runner === "t3" &&
            (session.status === "running" ||
              session.status === "launched" ||
              requested.has(session.handle))
          )
            retained[index] = await refreshT3Session(session);
        }
      },
    ),
  );
  return sessions.filter((_, index) => retained[index]);
}
export async function t3Result(session: Session): Promise<Session> {
  if (
    session.runner !== "t3" ||
    !session.t3ThreadId ||
    session.status === "running" ||
    session.status === "launched"
  )
    return session;
  const next = structuredClone(session);
  try {
    const view = await showThread(session.t3ThreadId, 1);
    applyView(next, view);
    if (next.status !== "running") {
      next.result = view.latestRunId
        ? (view.messages.findLast(
            (message) =>
              message.role === "assistant" &&
              message.runId === view.latestRunId,
          )?.text ?? "")
        : "";
      next.lastResult = next.result;
      next.t3ResultKey = view.latestRunId;
    }
  } catch (error) {
    noteError(next, error);
  }
  await persistView(next, session);
  return session;
}
export async function sendT3Session(
  session: Session,
  message: string,
  wakeId?: string,
): Promise<void> {
  if (!session.t3ThreadId)
    throw new Error("attach this launch to a T3 thread before sending");
  const threadId = session.t3ThreadId;
  if (wakeId) {
    while (!(await saveT3Session({ ...session }, session, wakeId)))
      session = await loadSession(session.handle);
  }
  const baselineRunCount = (
    await showThread(threadId, 0).catch(() => undefined)
  )?.runCount;
  let sent: ReturnType<typeof record>;
  try {
    sent = record(
      JSON.parse(
        await t3Command(["thread", "send", threadId, "-", "--json"], message),
      ),
    );
  } catch (error) {
    if (wakeId && error instanceof T3CliError && error.kind === "not-sent")
      await resetPendingWake(session.handle, wakeId);
    if (error instanceof T3CliError && error.kind === "gone") {
      const current = await loadSession(session.handle),
        next = { ...current };
      noteError(next, error);
      await persistView(next, current);
    }
    throw error;
  }
  const runId = text(sent?.runId);
  if (!runId)
    throw new Error("T3 send did not return a run id; delivery uncertain");
  while (true) {
    const stored = await loadSession(session.handle);
    const next = {
      ...stored,
      status: "running" as const,
      t3LatestRunId: runId,
      t3ExpectedRunId: runId,
      t3BaselineRunCount: baselineRunCount,
      stuck: null,
    };
    if (await saveT3Session(next, stored)) return;
  }
}
