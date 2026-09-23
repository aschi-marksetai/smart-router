import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLAUDE_PERMISSION_MODE } from "../config.ts";
import { stateDir } from "../paths.ts";
import {
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
const MODEL_FLAG = "--model";
const SESSION_ID_FLAG = "--session-id";
const PERMISSION_MODE_FLAG = "--permission-mode";
const WORKTREE_FLAG = "--worktree";
const RESUME_FLAG = "--resume";
const EFFORT_FLAG = "--effort";
const ALLOWED_TOOLS_FLAG = "--allowedTools";
const JSON_SCHEMA_FLAG = "--json-schema";
const CHROME_FLAG = "--chrome";
const MCP_CONFIG_FLAG = "--mcp-config";
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

export function buildSpawn(
  prompt: string,
  options: HarnessOptions,
): SpawnCommand {
  const sessionId = randomUUID();
  const argv = [
    options.binary ?? CLAUDE_BINARY,
    PRINT_FLAG,
    prompt,
    JSON_OUTPUT_FLAG,
    JSON_OUTPUT_FORMAT,
    MODEL_FLAG,
    options.model,
    SESSION_ID_FLAG,
    sessionId,
    PERMISSION_MODE_FLAG,
    options.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
    APPEND_SYSTEM_PROMPT_FLAG,
    delegatePreamble(options.browser),
  ];
  if (options.browser)
    argv.push(
      CHROME_FLAG,
      MCP_CONFIG_FLAG,
      isolatedChromeDevtoolsMcpConfigPath(),
    );
  if (options.worktree) argv.push(WORKTREE_FLAG);
  if (options.effort) argv.push(EFFORT_FLAG, options.effort);
  if (options.allowedTools) argv.push(ALLOWED_TOOLS_FLAG, options.allowedTools);
  if (options.schema) argv.push(JSON_SCHEMA_FLAG, options.schema.content);
  return { argv, sessionId };
}

export function parseSpawnOutput(stdout: string): ParsedOutput {
  const output = record(JSON.parse(stdout));
  const result = output?.result;
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
    message,
    JSON_OUTPUT_FLAG,
    JSON_OUTPUT_FORMAT,
    PERMISSION_MODE_FLAG,
    options.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE,
  ];
  if (options.browser)
    argv.push(
      CHROME_FLAG,
      MCP_CONFIG_FLAG,
      isolatedChromeDevtoolsMcpConfigPath(),
    );
  if (options.allowedTools) argv.push(ALLOWED_TOOLS_FLAG, options.allowedTools);
  if (options.schema) argv.push(JSON_SCHEMA_FLAG, options.schema.content);
  return { argv, sessionId };
}

export function parseResumeOutput(stdout: string): ParsedOutput {
  return parseSpawnOutput(stdout);
}
