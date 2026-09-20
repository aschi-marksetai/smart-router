import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as claude from "../src/harness/claude.ts";
import * as codex from "../src/harness/codex.ts";
import * as pi from "../src/harness/pi.ts";
import type { HarnessOptions, ProcessRunner } from "../src/harness/types.ts";

type Call = { argv: string[]; cwd: string };

function fixtureRunner(output: string, calls: Call[]): ProcessRunner {
  return async (argv, { cwd }) => {
    calls.push({ argv, cwd });
    return output;
  };
}

test("runs Claude spawn and resume commands and reads their results", async () => {
  const calls: Call[] = [];
  const options: HarnessOptions = {
    cwd: "/project",
    model: "opus",
    effort: "high",
    worktree: true,
    claudePermissionMode: "bypassPermissions",
    runner: fixtureRunner('{"result":"Claude reply"}', calls),
  };
  const spawned = await claude.spawn("write code", options);
  expect(calls[0].argv).toEqual([
    "claude",
    "-p",
    "write code",
    "--output-format",
    "json",
    "--model",
    "opus",
    "--session-id",
    spawned.sessionId,
    "--permission-mode",
    "bypassPermissions",
    "--worktree",
    "--append-system-prompt",
    "Reasoning effort: high",
  ]);
  expect(spawned.result).toBe("Claude reply");
  await claude.resume(spawned.sessionId, "continue", options);
  expect(calls[1].argv).toEqual([
    "claude",
    "-p",
    "--resume",
    spawned.sessionId,
    "continue",
    "--output-format",
    "json",
  ]);
});

test("runs Codex spawn and resume commands and reads JSONL results", async () => {
  const calls: Call[] = [];
  const cwd = await mkdtemp(join(tmpdir(), "smart-router-harness-"));
  const output = [
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"First"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Final"}}',
  ].join("\n");
  const options: HarnessOptions = {
    cwd,
    model: "gpt-5.6-terra",
    effort: "xhigh",
    worktree: true,
    codexSandbox: "workspace-write",
    runner: fixtureRunner(output, calls),
  };
  const spawned = await codex.spawn("write code", options);
  expect(calls[0].argv).toEqual([
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
    "write code",
  ]);
  expect(spawned).toMatchObject({ sessionId: "thread-123", result: "Final" });
  await codex.resume(spawned.sessionId, "continue", options);
  expect(calls[1].argv).toEqual([
    "codex",
    "exec",
    "resume",
    "thread-123",
    "--json",
    "continue",
  ]);
});

test("omits Codex's git-repository override inside a Git repository", async () => {
  const calls: Call[] = [];
  await codex.spawn("write code", {
    cwd: process.cwd(),
    model: "gpt-5.6-terra",
    runner: fixtureRunner(
      '{"type":"thread.started","thread_id":"thread-123"}',
      calls,
    ),
  });
  expect(calls[0].argv).not.toContain("--skip-git-repo-check");
});

test("runs Pi spawn and resume commands and reads assistant message events", async () => {
  const calls: Call[] = [];
  const options: HarnessOptions = {
    cwd: "/project",
    model: "openrouter/deepseek-v4",
    effort: "medium",
    runner: fixtureRunner(
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Pi reply"}]}}',
      calls,
    ),
  };
  const spawned = await pi.spawn("write code", options);
  expect(calls[0].argv).toEqual([
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
    spawned.sessionId,
  ]);
  expect(spawned.result).toBe("Pi reply");
  await pi.resume(spawned.sessionId, "continue", options);
  expect(calls[1].argv).toEqual([
    "pi",
    "-p",
    "continue",
    "--mode",
    "json",
    "--model",
    "openrouter/deepseek-v4",
    "--thinking",
    "medium",
    "--session",
    spawned.sessionId,
  ]);
});
