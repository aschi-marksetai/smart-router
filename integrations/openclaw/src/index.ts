import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";

import manifest from "../openclaw.plugin.json";

const BACKEND_ID = "smart-router";
const EVENT_VERSION = 1;
// OpenClaw keeps tool events in the transcript, so the routing decision is reported as one.
const ROUTE_TOOL_NAME = "smart_router_route";

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
> &
  Partial<Pick<OpenClawPluginApi, "logger">>;
export type RouteSummary = {
  kind: string;
  pick: string;
  reason: string;
  warnings: string[];
  tiltChanged: boolean;
  lowConfidence: boolean;
};

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

// The route summary on session.started; undefined from smart-router versions that predate it.
export function parseRouteSummary(value: unknown): RouteSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, pick, reason, warnings, tiltChanged, lowConfidence } = value;
  if (
    typeof kind !== "string" ||
    typeof pick !== "string" ||
    typeof reason !== "string" ||
    !Array.isArray(warnings)
  )
    return undefined;
  return {
    kind,
    pick,
    reason,
    warnings: warnings.filter((warning) => typeof warning === "string"),
    tiltChanged: tiltChanged === true,
    lowConfidence: lowConfidence === true,
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
    case "session.started": {
      if (typeof event.handle !== "string") return null;
      const session = { kind: "sessionId", sessionId: event.handle } as const;
      const route = parseRouteSummary(event.route);
      if (!route) return session;
      const toolCallId = `route:${event.handle}`;
      return [
        session,
        {
          kind: "toolStart",
          toolCallId,
          name: ROUTE_TOOL_NAME,
          args: route,
        },
        {
          kind: "toolResult",
          toolCallId,
          name: ROUTE_TOOL_NAME,
          isError: false,
          result: `${route.pick} (${route.kind}): ${route.reason}`,
        },
      ];
    }
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
  const spawnArgs = ["spawn", "{prompt}", "--events", "--confined"];
  const resumeArgs = [
    "send",
    "{sessionId}",
    "{prompt}",
    "--events",
    "--confined",
  ];
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
      systemPromptWhen: "always",
      systemPromptFileArg: "--append-system-prompt-file",
    },
    resolveExecutionArgs(context) {
      const args = [...context.baseArgs];
      if (!context.useResume && typeof config.cwd !== "string")
        args.push("--cwd", context.workspaceDir);
      if (!context.useResume && context.modelId !== "auto")
        args.push("--model", context.modelId);
      return args;
    },
    parseJsonlEvent(line, context) {
      const parsed = parseSmartRouterEvent(line, context);
      const routeEvent = Array.isArray(parsed)
        ? parsed.find((event) => event.kind === "toolStart")
        : undefined;
      const route = parseRouteSummary(routeEvent?.args);
      if (route) {
        api.logger?.info(
          `smart-router routed to ${route.pick} (${route.kind}): ${route.reason}`,
        );
        for (const warning of route.warnings)
          api.logger?.warn(`smart-router route warning: ${warning}`);
      }
      return parsed;
    },
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "none",
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
