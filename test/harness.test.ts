import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as claude from "../src/harness/claude.ts";
import * as codex from "../src/harness/codex.ts";
import { codexMcpOverrides } from "../src/harness/mcp.ts";
import * as pi from "../src/harness/pi.ts";
import type { HarnessOptions } from "../src/harness/types.ts";
import { parseJsonLines } from "../src/harness/types.ts";

const ACCEPTED_CODEX_EXEC_RESUME_FLAGS = new Set(
  "-c --last --all --enable --disable -i --strict-config -m --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --worktree --thread-source --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --output-schema --json -o".split(
    " ",
  ),
);
const ACCEPTED_CLAUDE_RESUME_FLAGS = new Set(
  "-p --resume --output-format --model --effort --permission-mode --append-system-prompt --allowedTools --json-schema --chrome --mcp-config --strict-mcp-config --add-dir --worktree".split(
    " ",
  ),
);

function flagsIn(argv: string[]): string[] {
  return argv.filter((argument) => argument.startsWith("-"));
}

// prettier-ignore
test("uses preferred OpenClaw environment variables without secrets in Codex argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-mcp-"));
  const configPath = join(directory, "mcp.json");
  const environment = { OTHER_MCP_TOKEN: "tok-123", OTHER_CAPTURE_KEY: "cap-9", OPENCLAW_MCP_TOKEN: "tok-123", OPENCLAW_MCP_CLI_CAPTURE_KEY: "cap-9" };
  const originals = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
  Object.assign(process.env, environment);
  try {
    await writeFile(configPath, '{"mcpServers":{"openclaw":{"type":"http","url":"http://127.0.0.1:43123/mcp","alwaysLoad":true,"headers":{"Authorization":"Bearer tok-123","x-openclaw-cli-capture-key":"cap-9"},"timeout":3610000}}}');
    const options = { cwd: directory, model: "terra", mcpConfig: [configPath] };
    for (const { argv } of [codex.buildSpawn("task", options), codex.buildResume("session", "again", options)]) {
      expect(argv).toContain('mcp_servers.openclaw.bearer_token_env_var="OPENCLAW_MCP_TOKEN"');
      expect(argv).toContain('mcp_servers.openclaw.env_http_headers={"x-openclaw-cli-capture-key"="OPENCLAW_MCP_CLI_CAPTURE_KEY"}');
      expect(argv.join(" ")).not.toMatch(/tok-123|cap-9|alwaysLoad|timeout/);
    }
    delete process.env.OPENCLAW_MCP_TOKEN;
    delete process.env.OPENCLAW_MCP_CLI_CAPTURE_KEY;
    expect(codexMcpOverrides([configPath])).toContain('mcp_servers.openclaw.bearer_token_env_var="OTHER_MCP_TOKEN"');
    expect(codexMcpOverrides([configPath])).toContain('mcp_servers.openclaw.env_http_headers={"x-openclaw-cli-capture-key"="OTHER_CAPTURE_KEY"}');
  } finally {
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
// prettier-ignore
test("warns for unmatched literal headers and rejects unsupported MCP servers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-mcp-"));
  const configPath = join(directory, "mcp.json");
  const warning = spyOn(console, "error").mockImplementation(() => {});
  try {
    await writeFile(configPath, '{"mcpServers":{"remote":{"type":"http","url":"http://localhost/mcp","headers":{"Authorization":"Bearer unmatched-mcp-secret"}}}}');
    expect(codexMcpOverrides([configPath])).toContain('mcp_servers.remote.http_headers={"Authorization"="Bearer unmatched-mcp-secret"}');
    expect(warning).toHaveBeenCalledWith("Warning: MCP server remote header Authorization value will be visible in the process list");
    for (const server of [{ type: "sse", url: "http://localhost/mcp" }, {}, { type: "stdio", command: "node", env: { TOKEN: "${SMART_ROUTER_MISSING_MCP_TEST_VARIABLE}" } }]) {
      await writeFile(configPath, JSON.stringify({ mcpServers: { remote: server } }));
      expect(() => codexMcpOverrides([configPath])).toThrow();
    }
  } finally {
    warning.mockRestore();
  }
});

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
      '{"result":"Claude reply","usage":{"input_tokens":2,"output_tokens":3,"cache_read_input_tokens":6,"cache_creation_input_tokens":2},"total_cost_usd":0.1}',
    ),
  ).toMatchObject({
    result: "Claude reply",
    // prettier-ignore
    usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.1, cachedInputTokens: 6, cacheWriteTokens: 2 },
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
    mcpConfig: ["/tmp/user.mcp.json", "/tmp/other.mcp.json"],
    strictMcpConfig: true,
  };

  try {
    const spawned = claude.buildSpawn("write code", options);
    const resumed = claude.buildResume("session", "continue", options);
    // prettier-ignore
    const singleFile = { ...options, browser: false, mcpConfig: ["/tmp/user.mcp.json"] };
    for (const { argv } of [
      claude.buildSpawn("task", singleFile),
      claude.buildResume("session", "again", singleFile),
    ]) {
      expect(argv.slice(argv.indexOf("--mcp-config"))).toEqual([
        "--mcp-config",
        singleFile.mcpConfig[0],
        "--strict-mcp-config",
      ]);
    }
    expect(spawned.argv).toContain(configPath);
    expect(resumed.argv).toContain(configPath);
    for (const { argv } of [spawned, resumed]) {
      expect(
        argv.filter((argument) => argument === "--mcp-config"),
      ).toHaveLength(3);
      expect(argv).toContain("--strict-mcp-config");
      for (const path of options.mcpConfig ?? []) expect(argv).toContain(path);
    }
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
    '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5,"cached_input_tokens":3,"cache_write_input_tokens":1}}',
  ].join("\n");
  expect(codex.parseSpawnOutput(output)).toEqual({
    sessionId: "thread-123",
    result: "Final",
    // prettier-ignore
    usage: { inputTokens: 4, outputTokens: 5, costUsd: null, cachedInputTokens: 3, cacheWriteTokens: 1 },
  });
  expect(codex.buildResume("thread-123", "continue", options).argv).toEqual([
    "codex",
    "exec",
    "resume",
    "thread-123",
    "--json",
    "-m",
    "gpt-5.6-terra",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    'sandbox_mode="workspace-write"',
    "--skip-git-repo-check",
    "--output-schema",
    "/tmp/schema.json",
    "continue",
  ]);
  expect(() =>
    codex.parseSpawnOutput(
      '{"type":"thread.started","thread_id":"thread-123"}\n{"type":"error","message":"Codex failed"}',
    ),
  ).toThrow("Codex failed");
  expect(() =>
    codex.parseSpawnOutput(
      output.replace('"type":"turn.completed"', '"type":"turn.failed"'),
    ),
  ).toThrow("did not complete");
  expect(() =>
    codex.parseSpawnOutput(output.split("\n").slice(0, 2).join("\n")),
  ).toThrow("did not complete");
  // prettier-ignore
  expect(() => codex.parseSpawnOutput(`${output}\n{"type":"turn.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}`)).toThrow("did not complete");
  // prettier-ignore
  expect(codex.parseSpawnOutput(`${output}\n{"type":"turn.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Last"}}\n{"type":"turn.completed"}`).result).toBe("Last");
  expect(
    codex.parseResumeOutput(
      '1\n{"type":"item.completed","item":{"type":"agent_message","text":"continued"}}\n{"type":"turn.completed"}',
    ),
  ).toEqual({
    sessionId: "",
    result: "continued",
    usage: null,
  });
});

test("uses only accepted resume flags", () => {
  const options: HarnessOptions = {
    cwd: "/project",
    model: "model",
    codexSandbox: "workspace-write",
    strictMcpConfig: true,
  };
  expect(
    flagsIn(codex.buildResume("session", "continue", options).argv),
  ).toSatisfy((flags) =>
    flags.every((flag) => ACCEPTED_CODEX_EXEC_RESUME_FLAGS.has(flag)),
  );
  expect(
    flagsIn(claude.buildResume("session", "continue", options).argv),
  ).toSatisfy((flags) =>
    flags.every((flag) => ACCEPTED_CLAUDE_RESUME_FLAGS.has(flag)),
  );
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
  // prettier-ignore
  const nativePiUsage = pi.parseSpawnOutput('{"type":"message_end","message":{"role":"assistant","content":[],"usage":{"input":2,"output":3,"cacheRead":4,"cacheWrite":1}}}').usage;
  // prettier-ignore
  expect(nativePiUsage).toEqual({ inputTokens: 2, outputTokens: 3, cachedInputTokens: 4, cacheWriteTokens: 1, costUsd: null });
  expect(
    pi.buildResume("session.json", "continue", {
      cwd: "/project",
      model: "model",
    }).sessionId,
  ).toBe("session.json");
  expect(
    pi.parseResumeOutput(
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Pi reply"}]}}',
    ).result,
  ).toBe("Pi reply");
});

test("builds stream-json Claude spawns and parses the stream-json log", () => {
  const spawned = claude.buildSpawn("write code", {
    cwd: "/project",
    model: "haiku",
    streamInput: true,
  });
  expect(spawned.argv.slice(0, 8)).toEqual([
    "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
  ]);
  expect(spawned.argv).not.toContain("write code");
  const streamLog = [
    '{"type":"system","subtype":"init","session_id":"stream-session"}',
    '{"type":"user","message":{"role":"user","content":"count"},"isReplay":true}',
    '{"type":"result","subtype":"error_during_execution","session_id":"stream-session"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"steered"}]}}',
    '{"type":"result","subtype":"success","result":"steered","session_id":"stream-session","usage":{"input_tokens":4,"output_tokens":1},"total_cost_usd":0.002}',
  ].join("\n");
  expect(claude.parseSpawnOutput(streamLog)).toEqual({
    sessionId: "stream-session",
    result: "steered",
    // prettier-ignore
    usage: { inputTokens: 4, outputTokens: 1, costUsd: 0.002, cachedInputTokens: null, cacheWriteTokens: null },
  });
});

test("treats Claude error result events as failures", () => {
  expect(() =>
    claude.parseSpawnOutput(
      '{"type":"result","subtype":"error","is_error":true,"result":"failed"}',
    ),
  ).toThrow("failed");
});
