export { translateEvents } from "../events.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLAUDE_PERMISSION_MODE } from "../config.ts";
import { stateDir } from "../paths.ts";
import { confinedAllowedTools } from "./mcp.ts";
import {
  parseJsonLines,
  record,
  usageFrom,
  type HarnessOptions,
  type ParsedOutput,
  type SpawnCommand,
} from "./types.ts";

const CLAUDE_BINARY = "claude";
const PRINT_FLAG = "-p";
const JSON_OUTPUT_FLAG = "--output-format";
const JSON_OUTPUT_FORMAT = "json";
const INPUT_FORMAT_FLAG = "--input-format";
const STREAM_JSON_FORMAT = "stream-json";
const VERBOSE_FLAG = "--verbose";
const REPLAY_USER_MESSAGES_FLAG = "--replay-user-messages";
const RESULT_EVENT_TYPE = "result";
const USER_EVENT_TYPE = "user";
const USER_ROLE = "user";
const CONTROL_REQUEST_TYPE = "control_request";
const INTERRUPT_SUBTYPE = "interrupt";
const MODEL_FLAG = "--model";
const SESSION_ID_FLAG = "--session-id";
const PERMISSION_MODE_FLAG = "--permission-mode";
const WORKTREE_FLAG = "--worktree";
const RESUME_FLAG = "--resume";
const EFFORT_FLAG = "--effort";
const ALLOWED_TOOLS_FLAG = "--allowedTools";
const DISALLOWED_TOOLS_FLAG = "--disallowedTools";
const TOOLS_FLAG = "--tools";
const APPEND_SYSTEM_PROMPT_FILE_FLAG = "--append-system-prompt-file";
const JSON_SCHEMA_FLAG = "--json-schema";
const CHROME_FLAG = "--chrome";
const CONFINED_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  enabledPlugins: {},
  autoMemoryEnabled: false,
  claudeMdExcludes: [
    "**/CLAUDE.md",
    "**/CLAUDE.local.md",
    "**/.claude/rules/**",
  ],
});
const BROWSER_ENVIRONMENT =
  /^(?:CLAUDE.*(?:CFC|CHROME|BROWSER|COMPUTER|REMOTE_TOOLS)|ALLOW_ANT_COMPUTER_USE_MCP$)/;

export function confinedClaudeEnvOverrides(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.keys(environment)
        .filter((name) => BROWSER_ENVIRONMENT.test(name))
        .map((name) => [name, undefined]),
    ),
    CLAUDE_CODE_REMOTE_TOOLS_FORWARD: "0",
    CLAUDE_CODE_REMOTE_TOOLS_SERVE: "0",
    CLAUDE_CODE_REMOTE_TOOLS_ADOPT_MCP: "0",
  };
}
const MCP_CONFIG_FLAG = "--mcp-config";
const STRICT_MCP_CONFIG_FLAG = "--strict-mcp-config";
const APPEND_SYSTEM_PROMPT_FLAG = "--append-system-prompt";
const CHROME_DEVTOOLS_MCP_CONFIG_FILE = "chrome-devtools-isolated.mcp.json";
const CHROME_DEVTOOLS_ISOLATED_SERVER_NAME = "chrome-devtools-isolated";
const CHROME_DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp@1.9.0";
const CHROME_DEVTOOLS_ISOLATED_FLAG = "--isolated";
const DELEGATE_PREAMBLE =
  "You are a delegate spawned by smart-router. Do the assigned task yourself with your own tools, including browser tools when the task needs them. Do not delegate through smart-router. Report the result when the stopping point is reached.";
const BROWSER_DELEGATE_PREAMBLE =
  "For browser work use the chrome-devtools-isolated MCP server, which has its own Chrome profile; the plugin's chrome-devtools server may be locked by another session.";

function isolatedChromeDevtoolsMcpConfigPath(): string {
  const directory = stateDir();
  const configPath = join(directory, CHROME_DEVTOOLS_MCP_CONFIG_FILE);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [CHROME_DEVTOOLS_ISOLATED_SERVER_NAME]: {
          type: "stdio",
          command: "npx",
          args: [CHROME_DEVTOOLS_MCP_PACKAGE, CHROME_DEVTOOLS_ISOLATED_FLAG],
        },
      },
    }),
  );
  return configPath;
}

function delegatePreamble(browser: boolean | undefined): string {
  return browser
    ? `${DELEGATE_PREAMBLE} ${BROWSER_DELEGATE_PREAMBLE}`
    : DELEGATE_PREAMBLE;
}

function mcpArguments(options: HarnessOptions): string[] {
  const argv = (options.mcpConfig ?? []).flatMap((path) => [
    MCP_CONFIG_FLAG,
    path,
  ]);
  if (options.strictMcpConfig || options.confined)
    argv.push(STRICT_MCP_CONFIG_FLAG);
  return argv;
}

function toolArguments(options: HarnessOptions): string[] {
  const argv: string[] = [];
  let allowedTools = options.allowedTools;
  if (options.confined) {
    if (options.tools)
      throw new Error("native tools are disabled in confined mode");
    argv.push(
      TOOLS_FLAG,
      "",
      "--no-chrome",
      "--setting-sources",
      "",
      "--settings",
      CONFINED_SETTINGS,
      "--disable-slash-commands",
    );
    allowedTools = confinedAllowedTools(allowedTools);
  } else if (options.tools !== undefined) argv.push(TOOLS_FLAG, options.tools);
  if (allowedTools !== undefined) argv.push(ALLOWED_TOOLS_FLAG, allowedTools);
  if (options.disallowedTools?.length)
    argv.push(DISALLOWED_TOOLS_FLAG, options.disallowedTools.join(","));
  if (options.appendSystemPromptFile)
    argv.push(APPEND_SYSTEM_PROMPT_FILE_FLAG, options.appendSystemPromptFile);
  return argv;
}

export function buildSpawn(
  prompt: string,
  options: HarnessOptions,
): SpawnCommand {
  const sessionId = randomUUID();
  const outputArguments = options.streamInput
    ? [
        INPUT_FORMAT_FLAG,
        STREAM_JSON_FORMAT,
        JSON_OUTPUT_FLAG,
        STREAM_JSON_FORMAT,
        VERBOSE_FLAG,
        REPLAY_USER_MESSAGES_FLAG,
      ]
    : [
        JSON_OUTPUT_FLAG,
        options.events ? STREAM_JSON_FORMAT : JSON_OUTPUT_FORMAT,
      ];
  if (options.events && !options.streamInput)
    outputArguments.push(VERBOSE_FLAG);
  const argv = [
    options.binary ?? CLAUDE_BINARY,
    PRINT_FLAG,
    ...outputArguments,
    MODEL_FLAG,
    options.model,
    SESSION_ID_FLAG,
    sessionId,
    PERMISSION_MODE_FLAG,
    options.confined
      ? "default"
      : (options.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE),
    APPEND_SYSTEM_PROMPT_FLAG,
    delegatePreamble(options.browser && !options.confined),
  ];
  if (options.browser && !options.confined)
    argv.push(
      CHROME_FLAG,
      MCP_CONFIG_FLAG,
      isolatedChromeDevtoolsMcpConfigPath(),
    );
  argv.push(...mcpArguments(options));
  if (options.worktree) argv.push(WORKTREE_FLAG);
  if (options.effort) argv.push(EFFORT_FLAG, options.effort);
  argv.push(...toolArguments(options));
  if (options.schema) argv.push(JSON_SCHEMA_FLAG, options.schema.content);
  if (!options.streamInput) argv.push("--", prompt);
  return {
    argv,
    sessionId,
    env: options.confined ? confinedClaudeEnvOverrides() : undefined,
  };
}

export function isResultEvent(event: unknown): boolean {
  return record(event)?.type === RESULT_EVENT_TYPE;
}

export function isReplayedUserMessage(event: unknown): boolean {
  const eventRecord = record(event);
  return eventRecord?.type === USER_EVENT_TYPE && eventRecord.isReplay === true;
}

export function streamUserMessage(text: string): string {
  return `${JSON.stringify({
    type: USER_EVENT_TYPE,
    message: { role: USER_ROLE, content: text },
    parent_tool_use_id: null,
  })}\n`;
}

export function streamInterruptRequest(): string {
  return `${JSON.stringify({
    type: CONTROL_REQUEST_TYPE,
    request_id: randomUUID(),
    request: { subtype: INTERRUPT_SUBTYPE },
  })}\n`;
}

export function parseSpawnOutput(stdout: string): ParsedOutput {
  const output = record(
    parseJsonLines(stdout).findLast(isResultEvent) ?? JSON.parse(stdout),
  );
  const result = output?.result;
  if (
    output?.type === RESULT_EVENT_TYPE &&
    (output.is_error === true ||
      (output.subtype !== undefined && output.subtype !== "success"))
  )
    throw Object.assign(
      new Error(typeof result === "string" ? result : "Claude turn failed"),
      { lastMessage: typeof result === "string" ? result : undefined },
    );
  const sessionId = output?.session_id;
  const costUsd = output?.total_cost_usd;
  return {
    sessionId: typeof sessionId === "string" ? sessionId : "",
    result: typeof result === "string" ? result : "",
    usage: usageFrom(
      output?.usage,
      typeof costUsd === "number" ? costUsd : null,
    ),
  };
}

export function buildResume(
  sessionId: string,
  message: string,
  options: HarnessOptions,
): SpawnCommand {
  const argv = [
    options.binary ?? CLAUDE_BINARY,
    PRINT_FLAG,
    RESUME_FLAG,
    sessionId,
    JSON_OUTPUT_FLAG,
    options.events ? STREAM_JSON_FORMAT : JSON_OUTPUT_FORMAT,
    PERMISSION_MODE_FLAG,
    options.confined
      ? "default"
      : (options.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE),
  ];
  if (options.events) argv.push(VERBOSE_FLAG);
  if (options.browser && !options.confined)
    argv.push(
      CHROME_FLAG,
      MCP_CONFIG_FLAG,
      isolatedChromeDevtoolsMcpConfigPath(),
    );
  argv.push(...mcpArguments(options));
  argv.push(...toolArguments(options));
  if (options.schema) argv.push(JSON_SCHEMA_FLAG, options.schema.content);
  argv.push("--", message);
  return {
    argv,
    sessionId,
    env: options.confined ? confinedClaudeEnvOverrides() : undefined,
  };
}

export function parseResumeOutput(stdout: string): ParsedOutput {
  return parseSpawnOutput(stdout);
}
