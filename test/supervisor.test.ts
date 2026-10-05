import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliDeps } from "../src/cli.ts";
import * as claude from "../src/harness/claude.ts";
import {
  createSession,
  sessionLogPath,
  sessionSocketPath,
  SESSION_STATUS,
} from "../src/sessions.ts";
import { steerSupervisedSession, superviseSession } from "../src/supervisor.ts";

const STATE_DIRECTORY_ENV = "SMART_ROUTER_STATE_DIR";
const WAIT_PROMPT = "wait for steer";
const SOCKET_POLL_INTERVAL_MS = 10;
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
    usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
  });
  await expect(
    steerSupervisedSession(handle, { message: "late", interrupt: false }),
  ).rejects.toThrow();
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
