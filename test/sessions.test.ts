import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, loadSession } from "../src/sessions.ts";

const STATE_DIRECTORY_ENV = "SMART_ROUTER_STATE_DIR";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env[STATE_DIRECTORY_ENV];
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
  });
  expect(session.handle).toMatch(/^[a-z0-9]{6}$/);
  expect(await loadSession(session.handle)).toEqual(session);
});
