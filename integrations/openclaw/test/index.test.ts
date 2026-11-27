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
    nativeToolMode: "none",
    config: {
      command: "smart-router",
      args: ["spawn", "{prompt}", "--events", "--confined"],
      resumeArgs: ["send", "{sessionId}", "{prompt}", "--events", "--confined"],
      output: "jsonl",
      resumeOutput: "jsonl",
      sessionMode: "existing",
      sessionIdFields: ["handle"],
      systemPromptWhen: "always",
      systemPromptFileArg: "--append-system-prompt-file",
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
test("static catalog publishes smart-router/auto without credentials", async () => {
  expect(provider.id).toBe("smart-router");
  expect(provider.staticCatalog).toBe(provider.catalog);
  expect(provider.resolveSyntheticAuth?.({ provider: provider.id })).toEqual({
    apiKey: "smart-router-harness-auth",
    source: "smart-router harness-managed auth",
    mode: "api-key",
  });
  const catalog = await provider.staticCatalog!.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      mode: "none",
      source: "none",
    }),
  });
  expect(catalog).toMatchObject({
    provider: {
      ...manifest.modelCatalog.providers["smart-router"],
      agentRuntime: { id: "smart-router" },
      models: manifest.modelCatalog.providers["smart-router"].models.map(
        (model) => ({ ...model, agentRuntime: { id: "smart-router" } }),
      ),
    },
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
    "spawn {prompt} --events --confined --cwd /tmp/project --hint browser --confidential --result-limit 1000",
  );
  expect(configured.config.resumeArgs?.join(" ")).toBe(
    "send {sessionId} {prompt} --events --confined --result-limit 1000",
  );
});

test("OpenClaw model pins reach spawn while auto routes and resumes retain the stored model", () => {
  const context = {
    workspaceDir: "/tmp/workspace",
    provider: "smart-router",
    useResume: false,
    baseArgs: ["spawn", "{prompt}", "--events", "--confined"],
  };
  for (const modelId of [
    "codex:gpt-6.1-terra",
    "claude:opus",
    "codex:auto",
    "claude:auto",
  ]) {
    expect(backend.resolveExecutionArgs?.({ ...context, modelId })).toEqual([
      ...context.baseArgs,
      "--cwd",
      context.workspaceDir,
      "--model",
      modelId,
    ]);
    const configured = captureRegistration({ cwd: "/tmp/override" }).backend;
    expect(configured.resolveExecutionArgs?.({ ...context, modelId })).toEqual([
      ...context.baseArgs,
      "--model",
      modelId,
    ]);
    const baseArgs = ["send", "handle", "{prompt}", "--events", "--confined"];
    expect(
      backend.resolveExecutionArgs?.({
        ...context,
        modelId,
        baseArgs,
        useResume: true,
      }),
    ).toEqual(baseArgs);
  }
});

test("a started event's route summary is kept as a tool event and logged", () => {
  const route = {
    kind: "routed",
    pick: "claude:claude-sonnet-5-5@medium",
    reason: "Jev: claude:claude-sonnet-5-5 0.87 · Codex 40 pts over pace",
    warnings: ["T3 thread runs another model"],
    tiltChanged: true,
    lowConfidence: false,
  };
  const started = JSON.stringify({
    v: 1,
    type: "session.started",
    handle: "abc123",
    model: "claude-sonnet-5-5",
    effort: "medium",
    route,
  });
  expect(parse(started)).toEqual([
    { kind: "sessionId", sessionId: "abc123" },
    {
      kind: "toolStart",
      toolCallId: "route:abc123",
      name: "smart_router_route",
      args: route,
    },
    {
      kind: "toolResult",
      toolCallId: "route:abc123",
      name: "smart_router_route",
      isError: false,
      result: `${route.pick} (routed): ${route.reason}`,
    },
  ]);
  const logged: string[] = [];
  const backends: Backend[] = [];
  registerSmartRouter({
    pluginConfig: {},
    registerCliBackend: (registered) => backends.push(registered),
    registerProvider: () => {},
    logger: {
      info: (message) => logged.push(`info ${message}`),
      warn: (message) => logged.push(`warn ${message}`),
      error: () => {},
    },
  });
  const context = { backendId: backend.id, backend: backend.config };
  expect(backends[0]!.parseJsonlEvent?.(started, context)).toHaveLength(3);
  expect(logged).toEqual([
    `info smart-router routed to ${route.pick} (routed): ${route.reason}`,
    "warn smart-router route warning: T3 thread runs another model",
  ]);
  // Without a logger, or with an event from an older smart-router, nothing is logged or added.
  expect(backend.parseJsonlEvent?.(started, context)).toHaveLength(3);
  const older = JSON.stringify({
    v: 1,
    type: "session.started",
    handle: "abc123",
  });
  expect(backends[0]!.parseJsonlEvent?.(older, context)).toEqual({
    kind: "sessionId",
    sessionId: "abc123",
  });
  for (const broken of [
    { ...route, pick: 1 },
    { ...route, warnings: "x" },
    "x",
  ])
    expect(
      parse(
        JSON.stringify({
          v: 1,
          type: "session.started",
          handle: "h",
          route: broken,
        }),
      ),
    ).toEqual({ kind: "sessionId", sessionId: "h" });
  expect(logged).toHaveLength(2);
});
