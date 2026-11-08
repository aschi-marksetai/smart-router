import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fileSystem from "node:fs/promises";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { runCli, type CliDeps } from "../src/cli.ts";
import * as claude from "../src/harness/claude.ts";
import {
  createSession,
  sessionLogPath,
  sessionSocketPath,
  SESSION_STATUS,
} from "../src/sessions.ts";
import {
  listenForSteer,
  steerSupervisedSession,
  superviseSession,
} from "../src/supervisor.ts";

const STATE_DIRECTORY_ENV = "SMART_ROUTER_STATE_DIR";
const WAIT_PROMPT = "wait for steer";
const SOCKET_POLL_INTERVAL_MS = 10;
const CLOSED_INPUT_SETTLE_MS = 150;
const FAKE_CLAUDE = `#!/usr/bin/env bun
const emit = (event) => console.log(JSON.stringify(event));
for await (const line of console) {
  if (!line) continue;
  const event = JSON.parse(line);
  emit({ type: "received", line: event });
  if (event.type === "control_request") {
    emit({ type: "result", subtype: "error_during_execution", session_id: "fake-session" });
    continue;
  }
  emit({ type: "user", message: event.message, isReplay: true });
  if (event.message.content === "${WAIT_PROMPT}") continue;
  emit({ type: "result", result: event.message.content, session_id: "fake-session", usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.01 });
}
`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env[STATE_DIRECTORY_ENV];
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function supervisedSession(): Promise<{
  handle: string;
  fakeClaude: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-supervise-"));
  temporaryDirectories.push(directory);
  process.env[STATE_DIRECTORY_ENV] = directory;
  const fakeClaude = join(directory, "fake-claude");
  await writeFile(fakeClaude, FAKE_CLAUDE);
  await chmod(fakeClaude, 0o755);
  const session = await createSession({
    harness: "claude",
    model: "haiku",
    effort: "low",
    cwd: directory,
    prompt: WAIT_PROMPT,
    status: SESSION_STATUS.running,
  });
  return { handle: session.handle, fakeClaude };
}

async function socketReady(handle: string): Promise<void> {
  while (!existsSync(sessionSocketPath(handle)))
    await Bun.sleep(SOCKET_POLL_INTERVAL_MS);
}

test("steering rejects malformed requests and reports handler errors", async () => {
  const { handle } = await supervisedSession();
  const failure = "steering failed";
  const server = await listenForSteer(handle, ({ message }) => {
    if (message === "error") throw new Error(failure);
    throw failure;
  });
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const connection = createConnection(sessionSocketPath(handle));
      connection.once("error", reject);
      connection.once("data", (data) => {
        connection.end();
        resolve(data.toString());
      });
      connection.write(`${JSON.stringify({ message: 42 })}\n`);
    });
    expect(JSON.parse(reply)).toEqual({
      error: "steer request needs a message",
    });
    for (const message of ["error", "string"])
      await expect(
        steerSupervisedSession(handle, { message, interrupt: false }),
      ).rejects.toThrow(failure);
    const accepted = new Promise<Socket>((resolve) =>
      server.once("connection", resolve),
    );
    const connection = createConnection(sessionSocketPath(handle));
    const incoming = await accepted;
    incoming.emit("error", new Error(failure));
    expect(incoming.destroyed).toBe(true);
    connection.destroy();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("supervisor delivers the prompt and an interrupting steer, then closes stdin after the result", async () => {
  const { handle, fakeClaude } = await supervisedSession();
  const supervising = superviseSession(handle, WAIT_PROMPT, [fakeClaude]);
  await socketReady(handle);
  await steerSupervisedSession(handle, { message: "steered", interrupt: true });
  expect(await supervising).toBe(0);
  expect(existsSync(sessionSocketPath(handle))).toBe(false);
  const log = await readFile(sessionLogPath(handle), "utf8");
  const received = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "received")
    .map((event) => event.line);
  expect(received).toMatchObject([
    { type: "user", message: { role: "user", content: WAIT_PROMPT } },
    { type: "control_request", request: { subtype: "interrupt" } },
    { type: "user", message: { role: "user", content: "steered" } },
  ]);
  expect(claude.parseSpawnOutput(log)).toEqual({
    sessionId: "fake-session",
    result: "steered",
    // prettier-ignore
    usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01, cachedInputTokens: null, cacheWriteTokens: null },
  });
  await expect(
    steerSupervisedSession(handle, { message: "late", interrupt: false }),
  ).rejects.toThrow();
});

test("supervisor preserves fast child output and completion during socket setup", async () => {
  const { handle } = await supervisedSession();
  const socketPath = sessionSocketPath(handle);
  const originalRemove = fileSystem.rm;
  const spawning = spyOn(childProcess, "spawn");
  const removing = spyOn(fileSystem, "rm").mockImplementationOnce(
    async (path, options) => {
      const spawned = spawning.mock.results[0];
      // Let an already-started child close while socket setup is suspended.
      if (path === socketPath && spawned?.type === "return")
        await new Promise((resolve) => spawned.value.once("close", resolve));
      await originalRemove(path, options);
    },
  );
  try {
    const result =
      '{"type":"result","result":"done","session_id":"fast-session"}';
    expect(
      await superviseSession(handle, WAIT_PROMPT, [
        "sh",
        "-c",
        `printf '%s\\n' '${result}'; exit 7`,
      ]),
    ).toBe(7);
    expect(await readFile(sessionLogPath(handle), "utf8")).toBe(`${result}\n`);
    expect(existsSync(socketPath)).toBe(false);
  } finally {
    spawning.mockRestore();
    removing.mockRestore();
  }
});

test("supervisor survives claude closing its input before a steer arrives", async () => {
  const { handle } = await supervisedSession();
  const directory = process.env[STATE_DIRECTORY_ENV] ?? "";
  const closedInputClaude = join(directory, "closed-input-claude");
  await writeFile(closedInputClaude, "#!/bin/sh\nexec 0<&-\nsleep 0.5\n");
  await chmod(closedInputClaude, 0o755);
  const supervising = superviseSession(handle, WAIT_PROMPT, [
    closedInputClaude,
  ]);
  await socketReady(handle);
  await Bun.sleep(CLOSED_INPUT_SETTLE_MS);
  await steerSupervisedSession(handle, {
    message: "too late",
    interrupt: false,
  }).catch(() => undefined);
  expect(typeof (await supervising)).toBe("number");
  expect(existsSync(sessionSocketPath(handle))).toBe(false);
});

test("the hidden supervise command forwards stop to claude and removes its socket", async () => {
  const { handle, fakeClaude } = await supervisedSession();
  let exitCode: number | undefined;
  const deps: Partial<CliDeps> = {
    exit: (code) => {
      exitCode = code;
    },
  };
  // prettier-ignore
  const supervising = runCli(["__supervise", "--", handle, WAIT_PROMPT, fakeClaude, "--fake-flag"], deps as CliDeps);
  await socketReady(handle);
  process.emit("SIGTERM");
  await supervising;
  expect(exitCode).toBe(1);
  expect(existsSync(sessionSocketPath(handle))).toBe(false);
});
