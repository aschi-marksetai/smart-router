import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

import manifest from "../openclaw.plugin.json";

const BACKEND_ID = "smart-router";
const EVENT_VERSION = 1;

type Backend = Parameters<OpenClawPluginApi["registerCliBackend"]>[0];
type Provider = Parameters<OpenClawPluginApi["registerProvider"]>[0];
type EventParser = NonNullable<Backend["parseJsonlEvent"]>;
type ParsedEvent = Exclude<
  ReturnType<EventParser>,
  readonly unknown[] | null | undefined
>;
type ParsedUsage = Extract<ParsedEvent, { kind: "result" }>["usage"];
type RegistrationApi = Pick<
  OpenClawPluginApi,
  "pluginConfig" | "registerCliBackend" | "registerProvider"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsage(value: unknown): ParsedUsage {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.inputTokens !== "number" ||
    typeof value.outputTokens !== "number"
  )
    return undefined;
  return {
    input: value.inputTokens,
    output: value.outputTokens,
    cacheRead:
      typeof value.cachedInputTokens === "number"
        ? value.cachedInputTokens
        : undefined,
    cacheWrite:
      typeof value.cacheWriteTokens === "number"
        ? value.cacheWriteTokens
        : undefined,
  };
}

export const parseSmartRouterEvent: EventParser = (line) => {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(event) || event.v !== EVENT_VERSION) return null;
  switch (event.type) {
    case "session.started":
      if (typeof event.handle !== "string") return null;
      return { kind: "sessionId", sessionId: event.handle };
    case "text.delta":
    case "message":
      if (typeof event.text !== "string") return null;
      if (event.type === "message" && event.role !== "assistant") return null;
      return { kind: "text", text: event.text };
    case "tool.started":
      if (
        typeof event.toolId !== "string" ||
        typeof event.name !== "string" ||
        typeof event.input !== "string"
      )
        return null;
      return {
        kind: "toolStart",
        toolCallId: event.toolId,
        name: event.name,
        args: { input: event.input },
      };
    case "tool.finished":
      if (
        typeof event.toolId !== "string" ||
        typeof event.name !== "string" ||
        typeof event.isError !== "boolean" ||
        typeof event.output !== "string"
      )
        return null;
      return {
        kind: "toolResult",
        toolCallId: event.toolId,
        name: event.name,
        isError: event.isError,
        result: event.output,
      };
    case "usage": {
      const usage = parseUsage(event);
      if (!usage) return null;
      return { kind: "result", usage };
    }
    case "result":
      if (typeof event.text !== "string") return null;
      return {
        kind: "result",
        text: event.text,
        usage: parseUsage(event.usage),
      };
    case "error":
      if (typeof event.message !== "string") return null;
      return { kind: "result", errorText: event.message };
    default:
      return null;
  }
};

export function registerSmartRouter(api: RegistrationApi): void {
  const config = api.pluginConfig ?? {};
  const spawnArgs = ["spawn", "{prompt}", "--events"];
  const resumeArgs = ["send", "{sessionId}", "{prompt}", "--events"];
  if (typeof config.cwd === "string") spawnArgs.push("--cwd", config.cwd);
  if (typeof config.hint === "string") spawnArgs.push("--hint", config.hint);
  if (config.confidential === true) spawnArgs.push("--confidential");
  if (typeof config.resultLimit === "number") {
    const limitArgs = ["--result-limit", String(config.resultLimit)];
    spawnArgs.push(...limitArgs);
    resumeArgs.push(...limitArgs);
  }
  api.registerCliBackend({
    id: BACKEND_ID,
    modelProvider: BACKEND_ID,
    config: {
      command:
        typeof config.smartRouterBinary === "string"
          ? config.smartRouterBinary
          : BACKEND_ID,
      args: spawnArgs,
      resumeArgs,
      output: "jsonl",
      resumeOutput: "jsonl",
      input: "arg",
      sessionMode: "existing",
      sessionIdFields: ["handle"],
      systemPromptWhen: "never",
    },
    resolveExecutionArgs(context) {
      if (context.useResume || typeof config.cwd === "string")
        return context.baseArgs;
      return [...context.baseArgs, "--cwd", context.workspaceDir];
    },
    parseJsonlEvent: parseSmartRouterEvent,
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "always-on",
    ownsNativeCompaction: true,
  });
  api.registerProvider({
    id: BACKEND_ID,
    label: "smart-router",
    auth: [],
    catalog: smartRouterCatalog,
    staticCatalog: smartRouterCatalog,
    resolveSyntheticAuth: () => ({
      apiKey: "smart-router-harness-auth",
      source: "smart-router harness-managed auth",
      mode: "api-key",
    }),
  });
}

const smartRouterCatalog: NonNullable<Provider["staticCatalog"]> = {
  order: "simple",
  async run() {
    const provider = manifest.modelCatalog.providers[BACKEND_ID];
    return {
      provider: {
        ...provider,
        agentRuntime: { id: BACKEND_ID },
        models: provider.models.map((model) => ({
          ...model,
          input: ["text"],
          agentRuntime: { id: BACKEND_ID },
        })),
      },
    };
  },
};

export default definePluginEntry({
  id: BACKEND_ID,
  name: "smart-router",
  description: "Delegate OpenClaw turns through the smart-router CLI",
  register: registerSmartRouter,
});
