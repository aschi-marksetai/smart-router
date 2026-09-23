import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as codex from "../src/harness/codex.ts";
import { DEFAULT_CONFIG, saveConfig } from "../src/config.ts";
import {
  addUsage,
  completeSessionFromLog,
  createSession,
  listSessions,
  isProcessRunning,
  loadSession,
  pruneSessions,
  removeSession,
  saveSession,
  sessionErrPath,
  sessionLogPath,
  SESSION_STATUS,
  stopSession,
} from "../src/sessions.ts";

const STATE_DIRECTORY_ENV = "SMART_ROUTER_STATE_DIR";
const CONFIG_DIRECTORY_ENV = "SMART_ROUTER_CONFIG_DIR";
const OWNER_ENVIRONMENT_VARIABLE = "SMART_ROUTER_OWNER";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env[STATE_DIRECTORY_ENV];
  delete process.env[CONFIG_DIRECTORY_ENV];
  delete process.env[OWNER_ENVIRONMENT_VARIABLE];
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

test("creates and loads a session under the configured state directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  const session = await createSession({
    harness: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
    cwd: "/project",
    sessionId: "thread-123",
    prompt: "Write a focused implementation.",
    status: SESSION_STATUS.done,
  });
  expect(session.handle).toMatch(/^[a-z0-9]{6}$/);
  expect(await loadSession(session.handle)).toEqual(session);
});

test("stamps owners and lists only the current owner's sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  process.env[OWNER_ENVIRONMENT_VARIABLE] = "first";
  const first = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: "/project",
    prompt: "First",
    status: SESSION_STATUS.done,
  });
  process.env[OWNER_ENVIRONMENT_VARIABLE] = "second";
  await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: "/project",
    prompt: "Second",
    status: SESSION_STATUS.done,
  });
  expect(first.owner).toBe("first");
  expect((await listSessions("first")).map(({ handle }) => handle)).toEqual([
    first.handle,
  ]);
});

test("removes a session and prunes only finished sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  const removable = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: "/project",
    prompt: "Remove",
    status: SESSION_STATUS.done,
  });
  await writeFile(sessionLogPath(removable.handle), "log");
  await writeFile(sessionErrPath(removable.handle), "error");
  await removeSession(removable.handle);
  await expect(loadSession(removable.handle)).rejects.toThrow();
  const old = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: "/project",
    prompt: "Old",
    status: SESSION_STATUS.done,
  });
  old.createdAt = new Date(0).toISOString();
  await saveSession(old);
  const running = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: "/project",
    prompt: "Running",
    status: SESSION_STATUS.running,
  });
  expect(await pruneSessions(1)).toEqual([old.handle]);
  expect(await loadSession(running.handle)).toMatchObject({
    status: SESSION_STATUS.running,
  });
});

test("limits CLI result output while retaining the full session result", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  const configDirectory = await mkdtemp(join(tmpdir(), "smart-router-config-"));
  temporaryDirectories.push(stateDirectory, configDirectory);
  process.env[STATE_DIRECTORY_ENV] = stateDirectory;
  process.env[CONFIG_DIRECTORY_ENV] = configDirectory;
  const binary = join(configDirectory, "claude");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf \'{"result":"abcdef","session_id":"session"}\'\n',
  );
  await chmod(binary, 0o755);
  await saveConfig({
    ...DEFAULT_CONFIG,
    harnesses: { claude: { enabled: true, binary } },
  });
  const child = Bun.spawn(
    [
      "bun",
      "src/cli.ts",
      "spawn",
      "task",
      "--model",
      "claude:test",
      "--result-limit",
      "3",
      "--no-guardrails",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [STATE_DIRECTORY_ENV]: stateDirectory,
        [CONFIG_DIRECTORY_ENV]: configDirectory,
      },
      stdout: "pipe",
    },
  );
  const output = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(output).toMatchObject({
    result: "abc",
    resultTruncated: true,
    resultChars: 6,
  });
  expect((await loadSession(output.handle)).lastResult).toBe("abcdef");
});

test("resume command restores the persisted Codex sandbox and network override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-session-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  process.env[CONFIG_DIRECTORY_ENV] = directory;
  const session = await createSession({
    harness: "codex",
    model: "terra",
    effort: "high",
    cwd: directory,
    sessionId: "thread-123",
    prompt: "Task",
    status: SESSION_STATUS.done,
    sandbox: "workspace-write",
    usesNetworkAccess: true,
  });
  const child = Bun.spawnSync(["bun", "src/cli.ts", "wait", session.handle], {
    cwd: process.cwd(),
    env: process.env,
  });
  expect(child.exitCode).toBe(0);
  const output = JSON.parse(child.stdout.toString());
  expect(output.resumeCommand).toContain(
    "-c sandbox_workspace_write.network_access=true",
  );
  expect(output.resumeCommand).toContain('-c sandbox_mode="workspace-write"');
});

test("marks a completed detached session done from its fixture log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  const logPath = join(directory, "delegate.log");
  await writeFile(
    logPath,
    [
      '{"type":"thread.started","thread_id":"thread-123"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Finished"}}',
    ].join("\n"),
  );
  const session = await createSession({
    harness: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
    cwd: "/project",
    prompt: "Write a focused implementation.",
    status: SESSION_STATUS.running,
    pid: 1,
    logPath,
  });
  const completed = await completeSessionFromLog(
    session,
    codex.parseSpawnOutput,
  );
  expect(completed).toMatchObject({
    sessionId: "thread-123",
    result: "Finished",
    status: SESSION_STATUS.done,
  });
});

test("records a failed session when a detached process cannot launch", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  const configDirectory = await mkdtemp(join(tmpdir(), "smart-router-config-"));
  temporaryDirectories.push(stateDirectory, configDirectory);
  process.env[STATE_DIRECTORY_ENV] = stateDirectory;
  process.env[CONFIG_DIRECTORY_ENV] = configDirectory;
  const missingBinary = "missing-smart-router-command";
  await saveConfig({
    ...DEFAULT_CONFIG,
    harnesses: { codex: { enabled: true, binary: missingBinary } },
  });
  const child = Bun.spawn(
    [
      "bun",
      "src/cli.ts",
      "spawn",
      "task",
      "--detach",
      "--model",
      "codex:test",
      "--no-guardrails",
    ],
    { cwd: process.cwd(), env: process.env, stdout: "pipe" },
  );
  expect(await child.exited).toBe(1);
  expect(JSON.parse(await new Response(child.stdout).text()).error).toContain(
    missingBinary,
  );
  const [sessionFile] = (
    await readdir(join(stateDirectory, "sessions"))
  ).filter((file) => file.endsWith(".json"));
  const session = JSON.parse(
    await readFile(join(stateDirectory, "sessions", sessionFile), "utf8"),
  );
  expect(session).toMatchObject({
    status: SESSION_STATUS.failed,
    error: expect.stringContaining(missingBinary),
  });
  expect(session.pid).toBeUndefined();
});

test("marks a session stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  const child = Bun.spawn(["sleep", "30"]);
  const session = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: "/project",
    sessionId: "session-123",
    prompt: "Stop.",
    status: SESSION_STATUS.running,
    pid: child.pid,
  });
  expect((await stopSession(session)).status).toBe(SESSION_STATUS.stopped);
  await child.exited;
});

test("stores Codex error events and stderr when a detached session fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  const logPath = join(directory, "delegate.log");
  const errPath = join(directory, "delegate.err");
  await writeFile(logPath, '{"type":"error","message":"Codex failed"}');
  await writeFile(errPath, "stderr failure\n");
  const session = await createSession({
    harness: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
    cwd: "/project",
    prompt: "Write a focused implementation.",
    status: SESSION_STATUS.running,
    pid: 1,
    logPath,
    errPath,
  });
  const completed = await completeSessionFromLog(
    session,
    codex.parseSpawnOutput,
  );
  expect(completed).toMatchObject({
    status: SESSION_STATUS.failed,
    error: "Codex failed\nstderr failure",
  });
});

test("handles missing state, empty results, and unreadable logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  expect(await listSessions()).toEqual([]);
  const session = await createSession({
    harness: "codex",
    model: "model",
    effort: "medium",
    cwd: directory,
    prompt: "task",
    status: SESSION_STATUS.running,
    errPath: join(directory, "missing.err"),
  });
  await writeFile(sessionLogPath(session.handle), "empty");
  expect(
    (
      await completeSessionFromLog(session, () => ({
        sessionId: "",
        result: "",
        usage: null,
      }))
    ).error,
  ).toBe("Harness output did not contain a result");
  await rm(sessionLogPath(session.handle));
  expect(
    (
      await completeSessionFromLog(session, () => {
        throw new Error("parser failed");
      })
    ).status,
  ).toBe(SESSION_STATUS.failed);
});

test("accumulates session usage and detects a missing process", () => {
  const first = { inputTokens: 2, outputTokens: 3, costUsd: 0.1 };
  const second = { inputTokens: 4, outputTokens: 5, costUsd: 0.2 };
  expect(addUsage(first, second)).toEqual({
    inputTokens: 6,
    outputTokens: 8,
    costUsd: 0.30000000000000004,
  });
  expect(addUsage(first, { ...second, costUsd: null })?.costUsd).toBeNull();
  expect(isProcessRunning(999999999)).toBe(false);
});

test("tails newline-terminated logs without an empty line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  const logPath = join(directory, "delegate.log");
  await writeFile(logPath, "first\nlast\n");
  const session = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: "/project",
    prompt: "Tail.",
    status: SESSION_STATUS.done,
    logPath,
  });
  const child = Bun.spawn(
    ["bun", "src/cli.ts", "logs", session.handle, "--tail", "1"],
    {
      cwd: process.cwd(),
      env: { ...process.env, [STATE_DIRECTORY_ENV]: directory },
      stdout: "pipe",
    },
  );
  expect(await new Response(child.stdout).text()).toBe("last");
  expect(await child.exited).toBe(0);
});

test("prints stopped sessions as not running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  const session = await createSession({
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: "/project",
    prompt: "Stop.",
    status: SESSION_STATUS.running,
  });
  const child = Bun.spawn(["bun", "src/cli.ts", "stop", session.handle], {
    cwd: process.cwd(),
    env: { ...process.env, [STATE_DIRECTORY_ENV]: directory },
    stdout: "pipe",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  expect(JSON.parse(output).running).toBe(false);
});
