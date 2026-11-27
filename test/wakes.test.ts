import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  createSession,
  loadSession,
  processStartTime,
  saveSession,
  sweepSessions,
  terminateSessionProcess,
  isProcessRunning,
  stopSession,
  withSessionsLock,
  sessionLogPath,
  sessionPath,
  completeSessionFromLog,
  saveTerminalSession,
  reclaimSessionLock,
  LOCK_RECLAIM_STALE_TIMEOUT_MS,
  CHILD_EXIT_OWNER_GRACE_MS,
  LOCK_ARTIFACT_MAX_AGE_MS,
  type Session,
} from "../src/sessions.ts";
import {
  armWake,
  claimWake,
  exactProcessRunning,
  hasUnsettledWakes,
  cancelWakes,
  recoverWakes,
  watchWake,
  type Wake,
  WakeCapacityError,
  MAX_WATCHER_RELAUNCHES,
  sessionEnvironment,
} from "../src/wakes.ts";
import {
  sampleActivity,
  processTreeCpuSeconds,
  STUCK_SILENCE_SECONDS,
} from "../src/activity.ts";

let directory: string;
let session: Session;
const oldState = process.env.SMART_ROUTER_STATE_DIR;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "smart-router-wakes-"));
  process.env.SMART_ROUTER_STATE_DIR = directory;
  session = await createSession({
    harness: "codex",
    model: "test",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: "done",
  });
});
afterEach(async () => {
  if (oldState === undefined) delete process.env.SMART_ROUTER_STATE_DIR;
  else process.env.SMART_ROUTER_STATE_DIR = oldState;
  await rm(directory, { recursive: true, force: true });
});
function wake(overrides: Partial<Wake> = {}): Wake {
  return {
    id: "test-wake",
    pid: 999999,
    startTime: "gone",
    command: "sessions.sh",
    armedAt: new Date().toISOString(),
    state: "pending",
    watcherPid: process.pid,
    watcherStartTime: processStartTime(process.pid),
    ...overrides,
  };
}
async function seed(value = wake()) {
  session.wakes = [value];
  await saveSession(session, "claim");
  return value;
}
test("reused pid fires for the exited original process", async () => {
  expect(exactProcessRunning(undefined, undefined)).toBe(false);
  const value = await seed(wake({ pid: process.pid, startTime: "wrong" }));
  let sent = false;
  await watchWake(session.handle, value.id, async () => {
    sent = true;
  });
  expect(sent).toBe(true);
  expect((await loadSession(session.handle)).wakes?.[0].state).toBe("sent");
});
test("delivers once after process exit, waits through a busy turn, preserves metadata", async () => {
  const child = spawn("sleep", ["0.2"]);
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const value = await seed(
    wake({ pid: child.pid!, startTime: processStartTime(child.pid!)! }),
  );
  session.status = "running";
  session.pid = process.pid;
  session.processStartTime = processStartTime(process.pid);
  await saveSession(session);
  let deliveries = 0;
  const watching = watchWake(session.handle, value.id, async (message) => {
    deliveries++;
    expect(message).toContain("sessions.sh");
    expect(message).toContain("exited at");
    const stored = await loadSession(session.handle);
    claimWake(stored, value.id);
    await saveSession(stored, "claim");
  });
  await exited;
  await Bun.sleep(1100);
  expect(deliveries).toBe(0);
  session.status = "done";
  await saveSession(session);
  await watching;
  expect(deliveries).toBe(1);
  expect((await loadSession(session.handle)).wakes?.[0].state).toBe("sent");
  await watchWake(session.handle, value.id, async () => {
    deliveries++;
  });
  expect(deliveries).toBe(1);
}, 15000);
test("cancel one or all wakes, unknown cancellation and invalid claims", async () => {
  const value = await seed();
  expect(hasUnsettledWakes(session)).toBe(true);
  await expect(cancelWakes(session.handle, "missing")).rejects.toThrow(
    "unknown wake",
  );
  expect(() => claimWake(session, "missing")).toThrow("no longer pending");
  await cancelWakes(session.handle, value.id);
  await cancelWakes(session.handle);
  expect(hasUnsettledWakes(await loadSession(session.handle))).toBe(false);
  await watchWake(session.handle, value.id, async () => {
    throw new Error("cancelled");
  });
  await watchWake(session.handle, "missing", async () => {});
});
test("recovery rearms a dead watcher once, never resends a claimed wake", async () => {
  await seed(wake({ watcherPid: 999999 }));
  let launches = 0;
  const launch = async (_handle: string, value: Wake) => {
    launches++;
    value.watcherPid = process.pid;
    value.watcherStartTime = processStartTime(process.pid);
  };
  await recoverWakes(session, launch);
  await recoverWakes(session, launch);
  expect(launches).toBe(1);
  claimWake(session, "test-wake");
  session.wakes![0].watcherStartTime = "reused";
  await saveSession(session, "claim");
  await sweepSessions();
  expect((await loadSession(session.handle)).wakes?.[0]).toMatchObject({
    state: "failed",
    error: expect.stringContaining("not resent"),
  });
});
test("delivery errors after a claim fail without retrying", async () => {
  await seed();
  let deliveries = 0;
  await expect(
    watchWake(session.handle, "test-wake", async () => {
      deliveries++;
      const stored = await loadSession(session.handle);
      claimWake(stored, "test-wake");
      await saveSession(stored, "claim");
      throw new Error("delivery uncertain");
    }),
  ).rejects.toThrow("delivery uncertain");
  expect(deliveries).toBe(1);
  expect((await loadSession(session.handle)).wakes?.[0].state).toBe("failed");
});
test("activity flags silence plus unchanged tree CPU; CPU or log progress clears", async () => {
  let now = Date.now();
  session.status = "running";
  session.pid = process.pid;
  session.createdAt = new Date(
    now - (STUCK_SILENCE_SECONDS + 10) * 1000,
  ).toISOString();
  await sampleActivity(session, now, () => 1);
  expect(session.stuck).toBeNull();
  await sampleActivity(session, now + 1000, () => 1);
  expect(session.stuck).toBeNull();
  now += STUCK_SILENCE_SECONDS * 1000;
  await sampleActivity(session, now, () => 1);
  expect(session.stuck?.reason).toContain("CPU unchanged");
  await sampleActivity(session, now + 2000, () => 1);
  await sampleActivity(session, now + 3000, () => 2);
  expect(session.stuck).toBeNull();
  await writeFile(join(directory, "log"), "first");
  session.logPath = join(directory, "log");
  await sampleActivity(session, now + 4000, () => 2);
  expect(session.activity?.silentSeconds).toBe(0);
  await appendFile(session.logPath, "more");
  await sampleActivity(session, now + 5000, () => 2);
  expect(session.stuck).toBeNull();
  await sampleActivity(session, now + 6000, () => {
    throw new Error("ps failed");
  });
  expect(session.stuck).toBeNull();
  expect(processTreeCpuSeconds(process.pid)).toBeGreaterThanOrEqual(0);
});

test("transient delivery failures back off, final failure settles, cancellation stops retries", async () => {
  await seed(wake({ message: "custom resume" }));
  let attempts = 0;
  const delays: number[] = [];
  await watchWake(
    session.handle,
    "test-wake",
    async (message) => {
      expect(message).toBe("custom resume");
      if (++attempts === 1) throw new Error("capacity");
    },
    async (delay) => {
      delays.push(delay);
    },
  );
  expect(attempts).toBe(2);
  expect(delays).toEqual([2000]);
  await seed();
  attempts = 0;
  await expect(
    watchWake(
      session.handle,
      "test-wake",
      async () => {
        attempts++;
        throw new Error("capacity unavailable");
      },
      async () => {},
    ),
  ).rejects.toThrow("capacity unavailable");
  expect(attempts).toBe(5);
  expect((await loadSession(session.handle)).wakes?.[0].state).toBe("failed");
  await seed();
  await watchWake(
    session.handle,
    "test-wake",
    async () => {
      await cancelWakes(session.handle);
      throw new Error("cancelled meanwhile");
    },
    async () => {},
  );
});

test("tree CPU counts a busy child and log mtime initializes silence", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "let end=Date.now()+1500;while(Date.now()<end){};setTimeout(()=>{},10000)",
  ]);
  try {
    const before = processTreeCpuSeconds(process.pid);
    await Bun.sleep(1800);
    expect(processTreeCpuSeconds(process.pid)).toBeGreaterThan(before);
    session.logPath = join(directory, "fresh.log");
    await writeFile(session.logPath, "output");
    await sampleActivity(session, Date.now(), () => 1);
    expect(session.activity?.silentSeconds).toBeLessThan(1);
  } finally {
    child.kill();
  }
});

test("arming validates process identity, records command and starts an isolated watcher", async () => {
  await expect(armWake(session.handle, -1)).rejects.toThrow("positive integer");
  await expect(armWake(session.handle, 999999)).rejects.toThrow("not alive");
  await expect(armWake("missing", process.pid)).rejects.toThrow();
  const armed = await armWake(session.handle, process.pid, "check output");
  try {
    expect(armed.command).toContain("bun");
    expect(processStartTime(process.pid)).toBe(armed.startTime);
    expect(exactProcessRunning(armed.watcherPid, armed.watcherStartTime)).toBe(
      true,
    );
    await cancelWakes(session.handle);
  } finally {
    if (armed.watcherPid) {
      try {
        process.kill(armed.watcherPid, "SIGTERM");
      } catch {}
    }
  }
});

test("group cleanup preserves watched detached work after the delegate exits", async () => {
  const parent = spawn("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], {
    detached: true,
  });
  const output = new Promise<string>((resolve) =>
    parent.stdout!.once("data", (chunk) => resolve(String(chunk))),
  );
  const exited = new Promise((resolve) => parent.once("exit", resolve));
  const jobPid = Number((await output).trim());
  await exited;
  try {
    session.pid = parent.pid;
    session.wakes = [
      wake({ pid: jobPid, startTime: processStartTime(jobPid)! }),
    ];
    await terminateSessionProcess(session);
    expect(isProcessRunning(jobPid)).toBe(true);
  } finally {
    process.kill(jobPid, "SIGKILL");
  }
});

test("metadata writes preserve completed turns and ordinary saves preserve newly armed wakes", async () => {
  const stale = structuredClone(session);
  await seed();
  stale.result = "completed";
  await saveSession(stale);
  expect((await loadSession(session.handle)).wakes).toHaveLength(1);
  session.status = "running";
  await saveSession(session, "wakes");
  expect((await loadSession(session.handle)).status).toBe("done");
  session.status = "running";
  session.activity = { runtimeSeconds: 10, silentSeconds: 5, cpuSeconds: 1 };
  await saveSession(session, "activity");
  expect((await loadSession(session.handle)).status).toBe("done");
});

test("capacity waits do not exhaust delivery attempts", async () => {
  await seed();
  let attempts = 0;
  await watchWake(
    session.handle,
    "test-wake",
    async () => {
      if (++attempts <= 8) throw new WakeCapacityError();
    },
    async () => {},
  );
  expect(attempts).toBe(9);
  expect((await loadSession(session.handle)).wakes![0].state).toBe("sent");
});
test("unreadable start time keeps waiting until identity can be read", async () => {
  await seed(wake({ pid: process.pid, startTime: "original" }));
  let reads = 0,
    sleeps = 0,
    sent = false;
  await watchWake(
    session.handle,
    "test-wake",
    async () => {
      sent = true;
    },
    async () => {
      sleeps++;
    },
    () => (++reads === 1 ? undefined : "replacement"),
  );
  expect(sleeps).toBe(1);
  expect(sent).toBe(true);
});
test("stop cancels wakes on settled descendants and watcher respects stopped", async () => {
  await seed();
  const child = await createSession({
    harness: "codex",
    model: "test",
    effort: "high",
    cwd: directory,
    prompt: "child",
    status: "done",
    parentHandle: session.handle,
  });
  child.wakes = [wake()];
  await saveSession(child, "claim");
  await stopSession(session);
  expect((await loadSession(session.handle)).wakes![0].state).toBe("cancelled");
  expect((await loadSession(child.handle)).wakes![0].state).toBe("cancelled");
  await seed();
  await watchWake(session.handle, "test-wake", async () => {
    throw new Error("must not send");
  });
  expect((await loadSession(session.handle)).wakes![0].state).toBe("cancelled");
});
test("watcher relaunch errors are isolated and bounded", async () => {
  await seed(wake({ watcherPid: 999999 }));
  for (let attempt = 0; attempt < MAX_WATCHER_RELAUNCHES; attempt++)
    await recoverWakes(session, async () => {
      throw new Error("launch failed");
    });
  expect(session.wakes![0]).toMatchObject({
    state: "failed",
    relaunches: MAX_WATCHER_RELAUNCHES,
  });
});
test("dead-owner lock is reclaimed immediately and displaced cleanup preserves successor", async () => {
  const path = join(directory, "sessions", ".spawn.lock");
  const { mkdir, stat } = await import("node:fs/promises");
  await mkdir(path);
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({ pid: 999999, startTime: "gone", token: "dead" }),
  );
  await withSessionsLock(async () => {
    const owner = JSON.parse(await Bun.file(join(path, "owner.json")).text());
    expect(owner.pid).toBe(process.pid);
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({ ...owner, token: "successor" }),
    );
  });
  expect((await stat(path)).isDirectory()).toBe(true);
});
test("missing wake is traced and metadata writes cannot recreate removed sessions", async () => {
  await watchWake(session.handle, "missing", async () => {});
  expect(await Bun.file(sessionLogPath(session.handle)).text()).toContain(
    "wake missing missing",
  );
  await rm(sessionPath(session.handle));
  await saveSession(session, "wakes");
  await saveSession(session, "activity");
  expect(await Bun.file(sessionPath(session.handle)).exists()).toBe(false);
});
test("watcher environment is derived from session ancestry, not the sweeping caller", async () => {
  const child = await createSession({
    harness: "codex",
    model: "test",
    effort: "high",
    cwd: directory,
    prompt: "child",
    status: "done",
    parentHandle: session.handle,
    depth: 2,
  });
  const env = await sessionEnvironment(child);
  expect(env.SMART_ROUTER_HANDLE).toBe(child.handle);
  expect(env.SMART_ROUTER_DEPTH).toBe("2");
  expect(env.SMART_ROUTER_ANCESTORS).toBe(session.handle);
});

test("initial watcher launch errors settle the wake as failed", async () => {
  const value = await armWake(
    session.handle,
    process.pid,
    undefined,
    async () => {
      throw new Error("cannot launch");
    },
  );
  expect(value.state).toBe("failed");
  expect((await loadSession(session.handle)).wakes![0].error).toContain(
    "cannot launch",
  );
});

test("unrelated pending wakes and sending wakes do not exempt the group from cleanup", async () => {
  for (const state of ["pending", "sending"] as const) {
    const parent = spawn(
      "sh",
      ["-c", "sleep 30 >/dev/null 2>&1 & echo $!; wait"],
      { detached: true },
    );
    const exited = new Promise((resolve) => parent.once("exit", resolve));
    const jobPid = Number(
      await new Promise<string>((resolve) =>
        parent.stdout!.once("data", (chunk) => resolve(String(chunk))),
      ),
    );
    try {
      session.pid = parent.pid;
      session.processStartTime = processStartTime(parent.pid!);
      session.wakes = [
        wake({ state, pid: state === "sending" ? jobPid : process.pid }),
      ];
      await terminateSessionProcess(session);
      await exited;
      expect(isProcessRunning(jobPid)).toBe(false);
    } finally {
      try {
        process.kill(-parent.pid!, "SIGKILL");
      } catch {}
    }
  }
});

test("sweep tolerates a record removed while waiting for the mutation lock", async () => {
  await seed();
  let sweeping: Promise<Session[]> | undefined;
  await withSessionsLock(async () => {
    sweeping = sweepSessions();
    await Bun.sleep(50);
    await rm(sessionPath(session.handle));
  });
  await sweeping;
  expect(await Bun.file(sessionPath(session.handle)).exists()).toBe(false);
});

test("lock reclamation tolerates disappearance and cleanup tolerates an already removed lock", async () => {
  const { mkdir } = await import("node:fs/promises");
  const path = join(directory, "sessions", ".spawn.lock");
  await mkdir(path);
  await writeFile(join(path, "owner.json"), "null");
  await withSessionsLock(
    async () => {
      await rm(path, { recursive: true });
    },
    async () => {
      await rm(path, { recursive: true });
      return { mtimeMs: 0 };
    },
  );
});

test("watcher cancels when sweep stops an orphaned delegate", async () => {
  const delegate = spawn("sleep", ["30"], { detached: true });
  const exited = new Promise((resolve) => delegate.once("exit", resolve));
  session.status = "running";
  session.pid = delegate.pid;
  session.processStartTime = processStartTime(delegate.pid!);
  session.wrapperPid = 999999;
  session.wrapperProcessStartTime = "gone";
  await seed();
  try {
    await watchWake(session.handle, "test-wake", async () => {
      throw new Error("must not send");
    });
    expect((await loadSession(session.handle)).wakes![0].state).toBe(
      "cancelled",
    );
  } finally {
    delegate.kill();
    await exited;
  }
});

test("stale completion cannot replace a newly reserved turn with the same pid", async () => {
  session.status = "running";
  session.pid = 999999;
  session.turns = [
    {
      kind: "pinned",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      idleSeconds: null,
      usage: null,
    },
  ];
  await saveSession(session);
  const stale = structuredClone(session);
  const current = structuredClone(session);
  current.turns!.push({
    kind: "resumed",
    startedAt: "2026-01-01T00:01:00Z",
    endedAt: null,
    idleSeconds: 0,
    usage: null,
  });
  await saveSession(current);
  await completeSessionFromLog(
    stale,
    () => ({ sessionId: "old", result: "old result", usage: null }),
    true,
  );
  expect(await loadSession(session.handle)).toMatchObject({
    status: "running",
    turns: current.turns,
  });
  current.pid = process.pid;
  await saveSession(current);
  stale.status = "failed";
  await saveTerminalSession(stale);
  expect((await loadSession(session.handle)).pid).toBe(process.pid);
});
test("slow reclaimer never removes a live successor that won the race", async () => {
  const { mkdir } = await import("node:fs/promises");
  const path = join(directory, "sessions", ".spawn.lock");
  await mkdir(path);
  const successor = {
    pid: process.pid,
    startTime: processStartTime(process.pid),
    token: "successor",
  };
  await writeFile(join(path, "owner.json"), JSON.stringify(successor));
  await reclaimSessionLock(path, "dead-owner");
  expect(JSON.parse(await Bun.file(join(path, "owner.json")).text())).toEqual(
    successor,
  );
});
test("stale stopped watcher leaves delivered wake unchanged and stop tolerates pruned descendants", async () => {
  await seed(wake({ state: "sent" }));
  session.status = "stopped";
  await saveSession(session);
  await watchWake(session.handle, "test-wake", async () => {});
  expect((await loadSession(session.handle)).wakes![0].state).toBe("sent");
  const descendant = {
    ...session,
    handle: "abcdef",
    parentHandle: session.handle,
    status: "running" as const,
  };
  await stopSession(session, "SIGTERM", [session, descendant]);
});

test("sweep holding an old copy cannot complete the newer turn", async () => {
  session.status = "running";
  session.pid = process.pid;
  session.processStartTime = processStartTime(process.pid);
  session.turns = [
    {
      kind: "pinned",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      idleSeconds: null,
      usage: null,
    },
  ];
  await saveSession(session);
  const newer = structuredClone(session);
  newer.pid = 999999;
  newer.turns!.push({
    kind: "resumed",
    startedAt: "2026-01-01T00:01:00Z",
    endedAt: null,
    idleSeconds: 0,
    usage: null,
  });
  await sweepSessions(() => {
    writeFileSync(sessionPath(session.handle), JSON.stringify(newer));
    return "old process exited";
  });
  expect(await loadSession(session.handle)).toMatchObject({
    status: "running",
    pid: newer.pid,
    turns: newer.turns,
  });
});

test("sweep gives a live wrapper a bounded finishing grace", async () => {
  session.status = "running";
  session.pid = 999999;
  session.processStartTime = "gone";
  session.wrapperPid = process.pid;
  session.wrapperProcessStartTime = processStartTime(process.pid);
  await saveSession(session);
  await sweepSessions();
  session = await loadSession(session.handle);
  expect(session.status).toBe("running");
  expect(session.stuck?.reason).toBe("child exited; owner still finishing");
  session.childExitedAt = new Date(
    Date.now() - CHILD_EXIT_OWNER_GRACE_MS - 1,
  ).toISOString();
  await writeFile(
    sessionLogPath(session.handle),
    [
      '{"type":"thread.started","thread_id":"thread"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"fully drained result"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join("\n"),
  );
  await saveSession(session);
  await sweepSessions();
  expect(await loadSession(session.handle)).toMatchObject({
    status: "done",
    result: "fully drained result",
  });
});
test("reserved turn with a dead wrapper fails before it has a pid", async () => {
  session.status = "running";
  session.wrapperPid = 999999;
  session.wrapperProcessStartTime = "gone";
  await saveSession(session);
  await sweepSessions();
  expect(await loadSession(session.handle)).toMatchObject({
    status: "failed",
    error: expect.stringContaining("before registering"),
  });
});
test("stopping an ancestor preserves a finished descendant's failure", async () => {
  const child = await createSession({
    harness: "codex",
    model: "test",
    effort: "high",
    cwd: directory,
    prompt: "failed child",
    status: "failed",
    parentHandle: session.handle,
    error: "real failure",
  });
  await stopSession(session);
  expect((await loadSession(child.handle)).error).toBe("real failure");
});
test("mkdir lock acquisition publishes owner atomically and excludes all contenders", async () => {
  let active = 0,
    maximum = 0;
  const path = join(directory, "sessions", ".spawn.lock", "owner.json");
  await Promise.all(
    Array.from({ length: 12 }, () =>
      withSessionsLock(async () => {
        active++;
        maximum = Math.max(maximum, active);
        expect(JSON.parse(await Bun.file(path).text()).pid).toBe(process.pid);
        await Bun.sleep(1);
        active--;
      }),
    ),
  );
  expect(maximum).toBe(1);
});
test("reclaim mutex removes a dead owner exactly once and recovers an aged mutex", async () => {
  const { mkdir, utimes } = await import("node:fs/promises");
  const path = join(directory, "sessions", ".spawn.lock");
  await mkdir(path);
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({ pid: 999999, startTime: "gone", token: "dead" }),
  );
  const results = await Promise.all([
    reclaimSessionLock(path, "dead"),
    reclaimSessionLock(path, "dead"),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await mkdir(path);
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({ pid: 999999, startTime: "gone", token: "dead" }),
  );
  const mutex = `${path}.reclaim`;
  await mkdir(mutex);
  expect(await reclaimSessionLock(path, "dead")).toBe(false);
  const old = new Date(Date.now() - LOCK_RECLAIM_STALE_TIMEOUT_MS - 1000);
  await utimes(mutex, old, old);
  expect(await reclaimSessionLock(path, "dead")).toBe(false);
  expect(await reclaimSessionLock(path, "dead")).toBe(true);
});
test("owner failure matches its turn when child registration never landed", async () => {
  session.status = "running";
  session.turns = [
    {
      kind: "pinned",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      idleSeconds: null,
      usage: null,
    },
  ];
  await saveSession(session);
  const owner = {
    ...session,
    pid: 999999,
    status: "failed" as const,
    error: "registration failed",
  };
  await saveTerminalSession(owner, "owner-turn");
  expect(await loadSession(session.handle)).toMatchObject({
    status: "failed",
    error: "registration failed",
  });
});

test("an old-style empty lock blocks a new acquirer", async () => {
  const { mkdir } = await import("node:fs/promises");
  const path = join(directory, "sessions", ".spawn.lock");
  await mkdir(path);
  let entered = false;
  const acquiring = withSessionsLock(async () => {
    entered = true;
  });
  await Bun.sleep(80);
  expect(entered).toBe(false);
  await rm(path, { recursive: true });
  await acquiring;
  expect(entered).toBe(true);
});
test("a live reclaim owner is never taken over because of age", async () => {
  const { mkdir, utimes } = await import("node:fs/promises");
  const path = join(directory, "sessions", ".spawn.lock"),
    mutex = `${path}.reclaim`;
  await mkdir(path);
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({ pid: 999999, startTime: "gone", token: "dead" }),
  );
  await mkdir(mutex);
  const owner = {
    pid: process.pid,
    startTime: processStartTime(process.pid),
    token: "live",
  };
  await writeFile(join(mutex, "owner.json"), JSON.stringify(owner));
  const old = new Date(Date.now() - LOCK_RECLAIM_STALE_TIMEOUT_MS - 1000);
  await utimes(mutex, old, old);
  expect(await reclaimSessionLock(path, "dead")).toBe(false);
  expect(JSON.parse(await Bun.file(join(mutex, "owner.json")).text())).toEqual(
    owner,
  );
  expect(
    JSON.parse(await Bun.file(join(path, "owner.json")).text()).token,
  ).toBe("dead");
});
test("sweep removes old lock artifacts while preserving recent and canonical locks", async () => {
  const { mkdir, utimes, stat } = await import("node:fs/promises");
  const root = join(directory, "sessions");
  const artifacts = [
    ".spawn.lock.old.acquire",
    ".spawn.lock.old.trash",
    ".spawn.lock.old.release",
    ".session-abcdef.lock.old",
    ".session-abcdef.lock.old.release",
  ];
  const old = new Date(Date.now() - LOCK_ARTIFACT_MAX_AGE_MS - 1000);
  for (const name of artifacts) {
    const path = join(root, name);
    await mkdir(path);
    await utimes(path, old, old);
  }
  const recent = join(root, ".spawn.lock.recent.release"),
    canonical = join(root, ".session-abcdef.lock.reclaim");
  await mkdir(recent);
  await mkdir(canonical);
  await utimes(canonical, old, old);
  await sweepSessions();
  for (const name of artifacts)
    await expect(stat(join(root, name))).rejects.toMatchObject({
      code: "ENOENT",
    });
  expect((await stat(recent)).isDirectory()).toBe(true);
  expect((await stat(canonical)).isDirectory()).toBe(true);
});

test("ownerless reclaim rechecks age under the mutex before removing a lock", async () => {
  const { mkdir, utimes, stat } = await import("node:fs/promises");
  const path = join(directory, "sessions", ".spawn.lock");
  await mkdir(path);
  expect(await reclaimSessionLock(path, undefined)).toBe(false);
  expect((await stat(path)).isDirectory()).toBe(true);
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
  expect(await reclaimSessionLock(path, undefined)).toBe(true);
  await mkdir(path);
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      startTime: processStartTime(process.pid),
      token: "new-holder",
    }),
  );
  expect(await reclaimSessionLock(path, undefined)).toBe(false);
  expect(
    JSON.parse(await Bun.file(join(path, "owner.json")).text()).token,
  ).toBe("new-holder");
});
test("activity saves cannot put stale finishing state on a terminal session", async () => {
  const stale = {
    ...session,
    status: "running" as const,
    childExitedAt: new Date().toISOString(),
    stuck: {
      reason: "child exited; owner still finishing",
      since: new Date().toISOString(),
    },
  };
  await saveSession(stale, "activity");
  expect((await loadSession(session.handle)).status).toBe("done");
  expect((await loadSession(session.handle)).stuck).toBeUndefined();
});

test("publication ENOENT retries and release ENOENT is already released", async () => {
  const originalRename = fileSystem.rename;
  let publishFailures = 0,
    releaseFailures = 0;
  const intercepted = spyOn(fileSystem, "rename").mockImplementation(
    async (...args: Parameters<typeof fileSystem.rename>) => {
      const source = String(args[0]),
        destination = String(args[1]);
      if (destination.endsWith("/owner.json") && publishFailures === 0) {
        publishFailures++;
        await rm(dirname(source), { recursive: true, force: true });
        throw Object.assign(new Error("publication disappeared"), {
          code: "ENOENT",
        });
      }
      if (
        source.endsWith("/.spawn.lock") &&
        destination.endsWith(".release") &&
        releaseFailures === 0
      ) {
        releaseFailures++;
        await rm(source, { recursive: true, force: true });
        throw Object.assign(new Error("already released"), { code: "ENOENT" });
      }
      return originalRename(...args);
    },
  );
  try {
    expect(await withSessionsLock(async () => "locked")).toBe("locked");
    expect(publishFailures).toBe(1);
    expect(releaseFailures).toBe(1);
  } finally {
    intercepted.mockRestore();
  }
});
test("non-retriable publication errors are propagated", async () => {
  const originalRename = fileSystem.rename;
  const intercepted = spyOn(fileSystem, "rename").mockImplementation(
    async (...args: Parameters<typeof fileSystem.rename>) => {
      if (String(args[1]).endsWith("/owner.json"))
        throw Object.assign(new Error("publication failed"), { code: "EIO" });
      return originalRename(...args);
    },
  );
  try {
    await expect(withSessionsLock(async () => {})).rejects.toThrow(
      "publication failed",
    );
  } finally {
    intercepted.mockRestore();
  }
});
test("a replaced reclaim owner is not deleted or used for takeover", async () => {
  const { mkdir, readdir } = fileSystem;
  const path = join(directory, "sessions", ".spawn.lock"),
    mutex = `${path}.reclaim`;
  await mkdir(path);
  await writeFile(
    join(path, "owner.json"),
    JSON.stringify({ pid: 999999, token: "dead-lock" }),
  );
  await mkdir(mutex);
  await writeFile(
    join(mutex, "owner.json"),
    JSON.stringify({ pid: 999999, token: "dead-mutex" }),
  );
  const originalRename = fileSystem.rename;
  const intercepted = spyOn(fileSystem, "rename").mockImplementation(
    async (...args: Parameters<typeof fileSystem.rename>) => {
      if (String(args[0]) === mutex)
        await writeFile(
          join(mutex, "owner.json"),
          JSON.stringify({
            pid: process.pid,
            startTime: processStartTime(process.pid),
            token: "successor",
          }),
        );
      return originalRename(...args);
    },
  );
  try {
    expect(await reclaimSessionLock(path, "dead-lock")).toBe(false);
    const moved = (await readdir(join(directory, "sessions"))).find(
      (name) =>
        name.startsWith(".spawn.lock.reclaim.") && name.endsWith(".trash"),
    );
    expect(moved).toBeDefined();
    expect(
      JSON.parse(
        await Bun.file(
          join(directory, "sessions", moved!, "owner.json"),
        ).text(),
      ).token,
    ).toBe("successor");
    expect(
      JSON.parse(await Bun.file(join(path, "owner.json")).text()).token,
    ).toBe("dead-lock");
  } finally {
    intercepted.mockRestore();
  }
});
