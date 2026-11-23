import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import {
  loadSession,
  saveSession,
  withSessionsLock,
  processStartTime,
  isProcessRunning,
  sweepSessions,
  sessionLogPath,
  type Session,
} from "./sessions.ts";

export const WAKE_COMMAND = "__wake";
export const WAIT_POLL_INTERVAL_MS = 1_000;
const MAX_DELIVERY_ATTEMPTS = 5;
export const MAX_WATCHER_RELAUNCHES = 5;
export class WakeCapacityError extends Error {}
const MAX_BACKOFF_MS = 30_000;
export type Wake = {
  id: string;
  pid: number;
  startTime: string;
  command: string;
  message?: string;
  armedAt: string;
  watcherPid?: number;
  watcherStartTime?: string;
  state: "pending" | "sending" | "sent" | "failed" | "cancelled";
  settledAt?: string;
  error?: string;
  exitedAt?: string;
  relaunches?: number;
};
export function hasUnsettledWakes(session: Pick<Session, "wakes">): boolean {
  return !!session.wakes?.some(
    (wake) => wake.state === "pending" || wake.state === "sending",
  );
}
export function exactProcessRunning(
  pid: number | undefined,
  startTime: string | undefined,
): boolean {
  return (
    !!pid &&
    !!startTime &&
    isProcessRunning(pid) &&
    processStartTime(pid) === startTime
  );
}
async function launchWatcher(handle: string, wake: Wake): Promise<void> {
  const entry = Bun.main.startsWith("/$bunfs/")
    ? []
    : [fileURLToPath(new URL("./cli.ts", import.meta.url))];
  const child = spawn(
    process.execPath,
    [...entry, WAKE_COMMAND, handle, wake.id],
    {
      detached: true,
      stdio: "ignore",
      env: await sessionEnvironment(await loadSession(handle)),
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  wake.watcherPid = child.pid;
  wake.watcherStartTime = child.pid ? processStartTime(child.pid) : undefined;
}
export async function armWake(
  handle: string,
  pid: number,
  message?: string,
  launch = launchWatcher,
): Promise<Wake> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("--after-pid must be a positive integer");
  return withSessionsLock(async () => {
    const session = await loadSession(handle);
    const startTime = processStartTime(pid);
    if (!startTime || !isProcessRunning(pid))
      throw new Error(`pid ${pid} is not alive or cannot be identified`);
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    if (!exactProcessRunning(pid, startTime))
      throw new Error(`pid ${pid} exited while arming`);
    const wake: Wake = {
      id: randomUUID(),
      pid,
      startTime,
      command,
      message,
      armedAt: new Date().toISOString(),
      state: "pending",
    };
    session.wakes = [...(session.wakes ?? []), wake];
    await saveSession(session, "wakes");
    try {
      await launch(handle, wake);
    } catch (error) {
      wake.state = "failed";
      wake.error = String(error);
      wake.settledAt = new Date().toISOString();
    }

    await saveSession(session, "wakes");
    return wake;
  });
}
export async function cancelWakes(
  handle: string,
  id?: string,
): Promise<Wake[]> {
  return withSessionsLock(async () => {
    const session = await loadSession(handle);
    const wakes = (session.wakes ?? []).filter((wake) => !id || wake.id === id);
    if (id && !wakes.length) throw new Error(`unknown wake ${id}`);
    cancelPendingWakes({ wakes });
    await saveSession(session, "wakes");
    return wakes;
  });
}
// Called under the sessions lock, including when the session itself is settled.
export async function recoverWakes(
  session: Session,
  launch = launchWatcher,
): Promise<void> {
  let changed = false;
  for (const wake of session.wakes ?? []) {
    if (wake.state !== "pending" && wake.state !== "sending") continue;
    if (exactProcessRunning(wake.watcherPid, wake.watcherStartTime)) continue;
    if (wake.state === "sending") {
      wake.state = "failed";
      wake.error =
        "watcher exited during delivery; outcome uncertain, not resent";
      wake.settledAt = new Date().toISOString();
    } else {
      wake.relaunches = (wake.relaunches ?? 0) + 1;
      try {
        if (wake.relaunches > MAX_WATCHER_RELAUNCHES)
          throw new Error("watcher relaunch limit exceeded");
        await launch(session.handle, wake);
      } catch (error) {
        wake.error = String(error);
        if (wake.relaunches >= MAX_WATCHER_RELAUNCHES) {
          wake.state = "failed";
          wake.settledAt = new Date().toISOString();
        }
      }
    }
    changed = true;
  }
  if (changed) await saveSession(session, "wakes");
}
export function claimWake(session: Session, id: string): void {
  const wake = session.wakes?.find((wake) => wake.id === id);
  if (
    !wake ||
    wake.state !== "pending" ||
    !exactProcessRunning(wake.watcherPid, wake.watcherStartTime) ||
    wake.watcherPid !== process.pid
  )
    throw new Error(`wake ${id} is no longer pending or owned by this watcher`);
  wake.state = "sending";
}
export async function watchWake(
  handle: string,
  id: string,
  deliver: (message: string) => Promise<void>,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
  getProcessStartTime = processStartTime,
): Promise<void> {
  await withSessionsLock(async () => {});
  let attempts = 0;
  while (true) {
    const session = await loadSession(handle);
    const wake = session.wakes?.find((wake) => wake.id === id);
    if (!wake) {
      await appendFile(
        session.logPath ?? sessionLogPath(handle),
        `smart-router: wake ${id} missing (possibly overwritten by an older binary)\n`,
      );
      return;
    }
    if (
      wake.state !== "pending" ||
      wake.watcherPid !== process.pid ||
      !exactProcessRunning(wake.watcherPid, wake.watcherStartTime)
    )
      return;
    if (session.status === "stopped") {
      await settleWake(handle, id, "cancelled");
      return;
    }
    if (isProcessRunning(wake.pid)) {
      const currentStartTime = getProcessStartTime(wake.pid);
      if (!currentStartTime || currentStartTime === wake.startTime) {
        await sleep(WAIT_POLL_INTERVAL_MS);
        continue;
      }
    }
    if (!wake.exitedAt) {
      await withSessionsLock(async () => {
        const current = await loadSession(handle);
        const stored = current.wakes?.find((item) => item.id === id);
        if (stored?.state !== "pending") return;
        stored.exitedAt = new Date().toISOString();
        await saveSession(current, "wakes");
      });
    }
    await sweepSessions();
    const latest = await loadSession(handle);
    if (latest.status === "stopped") {
      await settleWake(handle, id, "cancelled");
      return;
    }
    if (
      latest.status === "launched" ||
      (latest.runner !== "t3" && latest.status === "running")
    ) {
      await sleep(WAIT_POLL_INTERVAL_MS);
      continue;
    }
    try {
      const message =
        wake.message ??
        `Process ${wake.pid} (${wake.command}) exited at ${wake.exitedAt ?? new Date().toISOString()}. Check that work's output and continue your task.`;
      await deliver(message);
      await settleWake(handle, id, "sent");
      return;
    } catch (error) {
      const current = (await loadSession(handle)).wakes?.find(
        (item) => item.id === id,
      );
      if (error instanceof WakeCapacityError) {
        await sleep(WAIT_POLL_INTERVAL_MS);
        continue;
      }
      attempts += 1;
      if (current?.state === "sending" || attempts >= MAX_DELIVERY_ATTEMPTS) {
        await settleWake(handle, id, "failed", String(error));
        throw error;
      }
      if (current?.state !== "pending") return;
      await sleep(
        Math.min(WAIT_POLL_INTERVAL_MS * 2 ** attempts, MAX_BACKOFF_MS),
      );
    }
  }
}
async function settleWake(
  handle: string,
  id: string,
  state: "sent" | "failed" | "cancelled",
  error?: string,
): Promise<void> {
  await withSessionsLock(async () => {
    const session = await loadSession(handle);
    const wake = session.wakes?.find((wake) => wake.id === id);
    if (!wake || wake.state === "cancelled") return;
    wake.state = state;
    wake.error = error;
    wake.settledAt = new Date().toISOString();
    await saveSession(session, "wakes");
  });
}

export function cancelPendingWakes(session: Pick<Session, "wakes">): void {
  for (const wake of session.wakes ?? []) {
    if (wake.state !== "pending") continue;
    wake.state = "cancelled";
    wake.settledAt = new Date().toISOString();
  }
}
export async function sessionEnvironment(
  session: Session,
): Promise<NodeJS.ProcessEnv> {
  const ancestors: string[] = [];
  let parentHandle = session.parentHandle;
  while (parentHandle && !ancestors.includes(parentHandle)) {
    ancestors.unshift(parentHandle);
    parentHandle = (await loadSession(parentHandle).catch(() => undefined))
      ?.parentHandle;
  }
  return {
    ...process.env,
    SMART_ROUTER_OWNER: session.owner,
    SMART_ROUTER_DEPTH: String(session.depth ?? 1),
    SMART_ROUTER_HANDLE: session.handle,
    SMART_ROUTER_ANCESTORS: ancestors.join(","),
  };
}

export async function resetPendingWake(
  handle: string,
  id: string,
): Promise<void> {
  await withSessionsLock(async () => {
    const session = await loadSession(handle);
    const wake = session.wakes?.find((wake) => wake.id === id);
    if (wake?.state !== "sending" || wake.watcherPid !== process.pid) return;
    wake.state = "pending";
    await saveSession(session, "wakes");
  });
}
