import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as claude from "../src/harness/claude.ts";
import * as codex from "../src/harness/codex.ts";
import * as pi from "../src/harness/pi.ts";
import type { HarnessOptions } from "../src/harness/types.ts";
import { parseJsonLines } from "../src/harness/types.ts";

test("skips non-JSON lines", () => {
  expect(parseJsonLines('banner\n{"type":"event"}')).toEqual([
    { type: "event" },
  ]);
});

test("builds Claude commands and parses result usage", () => {
  const options: HarnessOptions = {
    cwd: "/project",
    model: "opus",
    effort: "high",
    worktree: true,
    claudePermissionMode: "bypassPermissions",
    allowedTools: "Read,Write",
    schema: { path: "/tmp/schema.json", content: '{"type":"object"}' },
  };
  const spawned = claude.buildSpawn("write code", options);
  const sessionId = spawned.sessionId ?? "";
  expect(spawned.argv).toEqual([
    "claude",
    "-p",
    "write code",
    "--output-format",
    "json",
    "--model",
    "opus",
    "--session-id",
    sessionId,
    "--permission-mode",
    "bypassPermissions",
    "--worktree",
    "--effort",
    "high",
    "--allowedTools",
    "Read,Write",
    "--json-schema",
    '{"type":"object"}',
  ]);
  expect(
    claude.parseSpawnOutput(
      '{"result":"Claude reply","usage":{"input_tokens":2,"output_tokens":3},"total_cost_usd":0.1}',
    ),
  ).toMatchObject({
    result: "Claude reply",
    usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.1 },
  });
  expect(claude.buildResume("session", "continue", options).argv).toEqual([
    "claude",
    "-p",
    "--resume",
    "session",
    "continue",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Read,Write",
    "--json-schema",
    '{"type":"object"}',
  ]);
});

test("builds Codex commands and parses result usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "smart-router-harness-"));
  const options: HarnessOptions = {
    cwd,
    model: "gpt-5.6-terra",
    effort: "xhigh",
    worktree: true,
    codexSandbox: "workspace-write",
    schema: { path: "/tmp/schema.json", content: "unused" },
  };
  expect(codex.buildSpawn("write code", options).argv).toEqual([
    "codex",
    "exec",
    "--json",
    "-C",
    cwd,
    "-m",
    "gpt-5.6-terra",
    "-c",
    'model_reasoning_effort="xhigh"',
    "-s",
    "workspace-write",
    "--worktree",
    "--skip-git-repo-check",
    "--output-schema",
    "/tmp/schema.json",
    "write code",
  ]);
  const output = [
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Final"}}',
    '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5}}',
  ].join("\n");
  expect(codex.parseSpawnOutput(output)).toEqual({
    sessionId: "thread-123",
    result: "Final",
    usage: { inputTokens: 4, outputTokens: 5, costUsd: null },
  });
  expect(codex.buildResume("thread-123", "continue", options).argv).toEqual([
    "codex",
    "exec",
    "resume",
    "thread-123",
    "--json",
    "-s",
    "workspace-write",
    "--output-schema",
    "/tmp/schema.json",
    "continue",
  ]);
  expect(() =>
    codex.parseSpawnOutput(
      '{"type":"thread.started","thread_id":"thread-123"}\n{"type":"error","message":"Codex failed"}',
    ),
  ).toThrow("Codex failed");
});

test("omits Codex's git-repository override inside a Git repository", () => {
  expect(
    codex.buildSpawn("write code", { cwd: process.cwd(), model: "terra" }).argv,
  ).not.toContain("--skip-git-repo-check");
});

test("builds Pi commands and parses assistant messages", () => {
  const command = pi.buildSpawn("write code", {
    cwd: "/project",
    model: "openrouter/deepseek-v4",
    effort: "medium",
  });
  expect(command.argv.slice(0, -1)).toEqual([
    "pi",
    "-p",
    "write code",
    "--mode",
    "json",
    "--model",
    "openrouter/deepseek-v4",
    "--thinking",
    "medium",
    "--session",
  ]);
  expect(
    pi.parseSpawnOutput(
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Pi reply"}]}}',
    ).result,
  ).toBe("Pi reply");
});
