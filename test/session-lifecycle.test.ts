import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDetached } from "../src/runner.ts";
import {
  createSession,
  isProcessRunning,
  listSessions,
  loadSession,
  saveSession,
  sessionLogPath,
  stopSession,
  sweepSessions,
  withSessionsLock,
} from "../src/sessions.ts";

const PROCESS_TEST_TIMEOUT_MS = 15_000;
const LOG_READY_TIMEOUT_MS = 2_000;
const LOG_POLL_INTERVAL_MS = 10;
const PROCESS_SLEEP_SECONDS = 30;
const KILLED_CALLER_EXIT_CODE = 137;
const TERMINATED_CALLER_EXIT_CODE = 143;
const PROCESS_TREE_COMMAND = `sleep ${PROCESS_SLEEP_SECONDS} & echo $!
printf '%s\n' '{"type":"item.started","item":{"type":"agent_message","text":"Working"}}' '{"type":"item.started","item":{"type":"command_execution","command":"sleep ${PROCESS_SLEEP_SECONDS}"}}'
wait`;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "smart-router-lifecycle-"));
  process.env.SMART_ROUTER_STATE_DIR = directory;
});

afterEach(async () => {
  for (const session of await listSessions()) await stopSession(session);
  delete process.env.SMART_ROUTER_STATE_DIR;
  await rm(directory, { recursive: true, force: true });
});

async function createRunningSession(parentHandle?: string) {
  return createSession({
    harness: "codex",
    model: "test",
    effort: "high",
    cwd: directory,
    prompt: "task",
    status: "running",
    parentHandle,
  });
}

async function logReady(handle: string): Promise<string> {
  const deadline = Date.now() + LOG_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const output = await readFile(sessionLogPath(handle), "utf8").catch(
      () => "",
    );
    if (output.includes("command_execution")) return output;
    await Bun.sleep(LOG_POLL_INTERVAL_MS);
  }
  throw new Error(`session ${handle} did not write its activity log`);
}

async function detachedSession(
  parentHandle?: string,
  command = PROCESS_TREE_COMMAND,
) {
  const created = await createRunningSession(parentHandle);
  Object.assign(
    created,
    await runDetached(
      ["sh", "-c", command],
      directory,
      sessionLogPath(created.handle),
    ),
  );
  await saveSession(created);
  await logReady(created.handle);
  return created;
}

test.each(["stop", "death", "signal", "caller", "stubborn"])(
  "%s terminates session descendants and harness grandchildren",
  async (mode) => {
    const foreground = mode === "signal" || mode === "caller";
    const command =
      mode === "stubborn"
        ? `trap '' TERM\n${PROCESS_TREE_COMMAND}`
        : PROCESS_TREE_COMMAND;
    const parent = foreground
      ? await createRunningSession()
      : await detachedSession(undefined, command);
    let wrapper: ReturnType<typeof Bun.spawn> | undefined;
    try {
      if (foreground) {
        const runnerPath = join(process.cwd(), "src/runner.ts");
        const sessionsPath = join(process.cwd(), "src/sessions.ts");
        const code = `import { runForeground } from ${JSON.stringify(runnerPath)};
import { loadSession } from ${JSON.stringify(sessionsPath)};
const session = await loadSession(${JSON.stringify(parent.handle)});
session.wrapperPid = process.pid;
await runForeground(["sh", "-c", ${JSON.stringify(command)}], session.cwd, process.env, session);`;
        wrapper = Bun.spawn([process.execPath, "-e", code], {
          env: process.env,
          stdout: "ignore",
          stderr: "ignore",
        });
      }
      const output = await logReady(parent.handle);
      const activeParent = await loadSession(parent.handle);
      const child = await detachedSession(parent.handle);
      const leaf = await detachedSession(child.handle);
      const unrelated = await detachedSession();
      if (mode === "death") {
        process.kill(-activeParent.pid!, "SIGKILL");
        while (isProcessRunning(activeParent.pid!))
          await Bun.sleep(LOG_POLL_INTERVAL_MS);
      }
      if (wrapper) {
        wrapper.kill(mode === "caller" ? "SIGKILL" : "SIGTERM");
        expect(await wrapper.exited).toBe(
          mode === "caller"
            ? KILLED_CALLER_EXIT_CODE
            : TERMINATED_CALLER_EXIT_CODE,
        );
      }
      if (mode === "stop" || mode === "stubborn")
        await stopSession(activeParent);
      else await sweepSessions();
      expect(isProcessRunning(Number(output.split("\n")[0]))).toBe(false);
      for (const descendant of [child, leaf]) {
        expect(await loadSession(descendant.handle)).toMatchObject({
          status: "stopped",
          error: `stopped because ancestor ${parent.handle} stopped`,
        });
        expect(isProcessRunning(descendant.pid!)).toBe(false);
        expect(
          isProcessRunning(
            Number((await logReady(descendant.handle)).split("\n")[0]),
          ),
        ).toBe(false);
      }
      expect(isProcessRunning(-activeParent.pid!)).toBe(false);
      expect(isProcessRunning(unrelated.pid!)).toBe(true);
      if (mode === "caller" || mode === "death") {
        expect(await loadSession(parent.handle)).toMatchObject({
          lastMessage: "Working",
          lastAction: `sleep ${PROCESS_SLEEP_SECONDS}`,
          error: expect.not.stringContaining("ENOENT"),
        });
      }
      if (mode === "caller")
        expect((await loadSession(parent.handle)).error).toContain(
          "calling smart-router process exited",
        );
    } finally {
      wrapper?.kill();
      await wrapper?.exited;
    }
  },
  PROCESS_TEST_TIMEOUT_MS,
);

test("retries acquisition when the lock disappears before stat", async () => {
  const lockPath = join(directory, "sessions", ".spawn.lock");
  await mkdir(lockPath, { recursive: true });
  await withSessionsLock(
    async () => {
      expect((await stat(lockPath)).isDirectory()).toBe(true);
    },
    async (path) => {
      await rm(path, { recursive: true });
      return stat(path);
    },
  );
  await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});
