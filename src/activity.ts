import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { sessionLogPath, type Session } from "./sessions.ts";

export const STUCK_SILENCE_SECONDS = 30 * 60;
export type ActivitySample = {
  logSize: number;
  silentSince: string;
  cpuSeconds: number;
  cpuChangedAt: string;
  startedAt: string;
};
export function processTreeCpuSeconds(pid: number): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const [processId, parentId, time = "0"] = line.trim().split(/\s+/);
      const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
      const seconds = (clock ?? "0")
        .split(":")
        .reduce((total, part) => total * 60 + Number(part), 0);
      return {
        pid: Number(processId),
        parent: Number(parentId),
        seconds: Number(days) * 86400 + seconds,
      };
    });
  const descendants = new Set([pid]);
  let previousSize = 0;
  while (previousSize !== descendants.size) {
    previousSize = descendants.size;
    for (const row of rows)
      if (descendants.has(row.parent)) descendants.add(row.pid);
  }
  return rows.reduce(
    (total, row) => total + (descendants.has(row.pid) ? row.seconds : 0),
    0,
  );
}
export async function sampleActivity(
  session: Session,
  now = Date.now(),
  cpu = processTreeCpuSeconds,
): Promise<void> {
  const startedAt = session.turns?.at(-1)?.startedAt ?? session.createdAt;
  const log = await stat(
    session.logPath ?? sessionLogPath(session.handle),
  ).catch(() => undefined);
  const previous =
    session.activitySample?.startedAt === startedAt
      ? session.activitySample
      : undefined;
  const logSize = log?.size ?? 0;
  let silentSince =
    previous?.silentSince ??
    new Date(Math.max(Date.parse(startedAt), log?.mtimeMs ?? 0)).toISOString();
  if (previous && previous.logSize !== logSize)
    silentSince = new Date(now).toISOString();
  let cpuSeconds: number;
  try {
    cpuSeconds = cpu(session.pid!);
  } catch {
    session.stuck = null;
    return;
  }
  const silentSeconds = Math.max(0, (now - Date.parse(silentSince)) / 1000);
  session.activity = {
    runtimeSeconds: Math.max(0, (now - Date.parse(startedAt)) / 1000),
    silentSeconds,
    cpuSeconds,
  };
  const cpuChangedAt =
    previous?.cpuSeconds === cpuSeconds
      ? (previous.cpuChangedAt ?? new Date(now).toISOString())
      : new Date(now).toISOString();
  const stalled =
    silentSeconds >= STUCK_SILENCE_SECONDS &&
    (now - Date.parse(cpuChangedAt)) / 1000 >= STUCK_SILENCE_SECONDS;
  session.stuck = stalled
    ? (session.stuck ?? {
        reason: "log silent and process-tree CPU unchanged",
        since: new Date(now).toISOString(),
      })
    : null;
  session.activitySample = {
    logSize,
    silentSince,
    cpuSeconds,
    startedAt,
    cpuChangedAt,
  };
}
