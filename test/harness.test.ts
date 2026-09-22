import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
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
    "--append-system-prompt",
    expect.any(String),
    "--worktree",
    "--effort",
    "high",
    "--allowedTools",
    "Read,Write",
    "--json-schema",
    '{"type":"object"}',
  ]);
  expect(spawned.argv).toContain(
    "You are a delegate spawned by smart-router. Do the assigned task yourself with your own tools, including browser tools when the task needs them. Do not delegate through smart-router. Report the result when the stopping point is reached.",
  );
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
    "--append-system-prompt",
    expect.any(String),
    "--allowedTools",
    "Read,Write",
    "--json-schema",
    '{"type":"object"}',
  ]);
});

test("uses an isolated Chrome DevTools MCP config for browser commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-state-"));
  const environmentVariable = "SMART_ROUTER_STATE_DIR";
  const originalDirectory = process.env[environmentVariable];
  process.env[environmentVariable] = directory;
  const configPath = join(directory, "chrome-devtools-isolated.mcp.json");
  const options: HarnessOptions = {
    cwd: "/project",
    model: "opus",
    browser: true,
  };

  try {
    const spawned = claude.buildSpawn("write code", options);
    const resumed = claude.buildResume("session", "continue", options);
    expect(spawned.argv).toContain(configPath);
    expect(resumed.argv).toContain(configPath);
    expect(spawned.argv).toContain(
      "You are a delegate spawned by smart-router. Do the assigned task yourself with your own tools, including browser tools when the task needs them. Do not delegate through smart-router. Report the result when the stopping point is reached. For browser work use the chrome-devtools-isolated MCP server, which has its own Chrome profile; the plugin's chrome-devtools server may be locked by another session.",
    );
    expect(
      claude.buildSpawn("write code", { cwd: "/project", model: "opus" }).argv,
    ).not.toContain("--mcp-config");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      mcpServers: {
        "chrome-devtools-isolated": {
          type: "stdio",
          command: "npx",
          args: ["chrome-devtools-mcp@1.9.0", "--isolated"],
        },
      },
    });
  } finally {
    if (originalDirectory === undefined)
      delete process.env[environmentVariable];
    else process.env[environmentVariable] = originalDirectory;
  }
});

test("builds Codex commands and parses result usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "smart-router-harness-"));
  const options: HarnessOptions = {
    cwd,
    model: "gpt-5.6-terra",
    effort: "xhigh",
    worktree: true,
    codexSandbox: "workspace-write",
    codexConfigOverrides: ["sandbox_workspace_write.network_access=true"],
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
    "-c",
    "sandbox_workspace_write.network_access=true",
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
    "-c",
    "sandbox_workspace_write.network_access=true",
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
