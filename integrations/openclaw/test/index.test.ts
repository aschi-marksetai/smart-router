import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "../openclaw.plugin.json";
import plugin, {
  parseSmartRouterEvent,
  registerSmartRouter,
} from "../src/index";

type Backend = Parameters<OpenClawPluginApi["registerCliBackend"]>[0];
type Provider = Parameters<OpenClawPluginApi["registerProvider"]>[0];

function captureRegistration(
  pluginConfig: OpenClawPluginApi["pluginConfig"] = {},
) {
  const backends: Backend[] = [];
  const providers: Provider[] = [];
  registerSmartRouter({
    pluginConfig,
    registerCliBackend: (backend) => backends.push(backend),
    registerProvider: (provider) => providers.push(provider),
  });
  return {
    backend: backends[0]!,
    provider: providers[0]!,
  };
}
const { backend, provider } = captureRegistration();
const parse = (line: string) =>
  parseSmartRouterEvent(line, {
    backendId: backend.id,
    backend: backend.config,
  });
function fixture(name: string) {
  const path = new URL(`./fixtures/${name}.jsonl`, import.meta.url);
  return readFileSync(path, "utf8").trim().split("\n").map(parse);
}

test("real reply retains router handle, final text and cached usage", () => {
  const events = fixture("reply");
  expect(events[0]).toEqual({ kind: "sessionId", sessionId: "d562f0" });
  expect(events[1]).toEqual({ kind: "text", text: "done" });
  const usage = { input: 22733, output: 5, cacheRead: 12032, cacheWrite: 0 };
  expect(events[2]).toEqual({ kind: "result", usage });
  expect(events[3]).toEqual({ kind: "result", text: "done", usage });
});
test("real tool call maps starts, results and final text", () => {
  const events = fixture("tool");
  expect(events[2]).toMatchObject({
    kind: "toolStart",
    toolCallId: "item_1",
    args: { input: "/bin/zsh -lc 'printf done'" },
  });
  expect(events[3]).toMatchObject({
    kind: "toolResult",
    toolCallId: "item_1",
    name: "command_execution",
    isError: false,
    result: "done",
  });
  expect(events.at(-1)).toMatchObject({
    kind: "result",
    text: "done",
    usage: { cacheRead: 34304, cacheWrite: 0 },
  });
});
test("deltas and errors map; malformed and unknown records are dropped", () => {
  expect(parse('{"v":1,"type":"text.delta","text":"hello"}')).toEqual({
    kind: "text",
    text: "hello",
  });
  expect(parse('{"v":1,"type":"error","message":"failed"}')).toEqual({
    kind: "result",
    errorText: "failed",
  });
  for (const line of [
    "{",
    "null",
    "[]",
    '{"v":2}',
    '{"v":1,"type":"unknown"}',
    '{"v":1,"type":"tool.started"}',
  ])
    expect(parse(line)).toBeNull();
});

test("entry registers backend, MCP bridge, workspace args and bound model", async () => {
  expect(plugin.register).toBe(registerSmartRouter);
  expect(backend).toMatchObject({
    id: "smart-router",
    modelProvider: "smart-router",
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "always-on",
    config: {
      command: "smart-router",
      args: ["spawn", "{prompt}", "--events"],
      resumeArgs: ["send", "{sessionId}", "{prompt}", "--events"],
      output: "jsonl",
      resumeOutput: "jsonl",
      sessionMode: "existing",
      sessionIdFields: ["handle"],
    },
  });
  const context = {
    workspaceDir: "/tmp/workspace",
    provider: "smart-router",
    modelId: "auto",
    useResume: false,
    baseArgs: [
      "spawn",
      "{prompt}",
      "--events",
      "--mcp-config",
      "/tmp/mcp.json",
    ],
  };
  expect(backend.resolveExecutionArgs?.(context)).toEqual([
    ...context.baseArgs,
    "--cwd",
    context.workspaceDir,
  ]);
  expect(
    backend.resolveExecutionArgs?.({ ...context, useResume: true }),
  ).toEqual(context.baseArgs);
  const catalog = await Reflect.apply(provider.catalog!.run, undefined, []);
  expect(catalog.provider.models).toMatchObject(
    manifest.modelCatalog.providers["smart-router"].models,
  );
  expect(catalog.provider).toMatchObject({
    agentRuntime: { id: "smart-router" },
    models: [{ id: "auto", agentRuntime: { id: "smart-router" } }],
  });
});
test("configured binary and flags pass through", () => {
  const { backend: configured } = captureRegistration({
    smartRouterBinary: "/opt/smart-router",
    cwd: "/tmp/project",
    hint: "browser",
    confidential: true,
    resultLimit: 1000,
  });
  expect(configured.config.command).toBe("/opt/smart-router");
  expect(configured.config.args?.join(" ")).toBe(
    "spawn {prompt} --events --cwd /tmp/project --hint browser --confidential --result-limit 1000",
  );
  expect(configured.config.resumeArgs?.join(" ")).toBe(
    "send {sessionId} {prompt} --events --result-limit 1000",
  );
});
