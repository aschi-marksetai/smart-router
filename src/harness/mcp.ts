import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { record } from "./types.ts";

export const OPENCLAW_TOOL_PREFIX = "mcp__openclaw__";

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BEARER_ENV_REFERENCE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i;
const BEARER_LITERAL = /^Bearer (.+)$/i;
const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]+$/;
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;
type StringMap = Record<string, string>;
type StdioServer = { command: string; args: string[]; env: StringMap };
type HttpServer = { url: string; headers: StringMap };
type McpServer =
  ({ type: "stdio" } & StdioServer) | ({ type: "http" | "sse" } & HttpServer);

function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const fields = record(value);
  if (!fields) throw new Error("MCP env and headers must be string maps");
  return Object.fromEntries(
    Object.entries(fields).map(([key, entry]) => {
      if (typeof entry !== "string")
        throw new Error("MCP env and headers must contain strings");
      return [key, entry];
    }),
  );
}

function parseServer(value: unknown): McpServer {
  const server = record(value);
  const { type, command, url } = server ?? {};
  const args: unknown = server?.args ?? [];
  if (
    !Array.isArray(args) ||
    !args.every((entry): entry is string => typeof entry === "string")
  )
    throw new Error("MCP args must be an array of strings");
  if (type === "stdio" && typeof command === "string") {
    const env = stringMap(server?.env);
    return { type, command, args, env };
  }
  if ((type === "http" || type === "sse") && typeof url === "string") {
    const headers = stringMap(server?.headers);
    return { type, url, headers };
  }
  throw new Error("MCP server requires a stdio command or an http/sse URL");
}

function interpolate(value: string): string {
  return value.replace(ENV_REFERENCE, (_match, variable: string) => {
    const replacement = process.env[variable];
    if (replacement === undefined)
      throw new Error(`Missing MCP environment variable: ${variable}`);
    return replacement;
  });
}

function inlineTable(fields: Record<string, string>): string {
  const entries = Object.entries(fields).map(([key, value]) => {
    return `${JSON.stringify(key)}=${JSON.stringify(interpolate(value))}`;
  });
  return `{${entries.join(",")}}`;
}

function matchingEnvironmentVariable(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const matches = Object.keys(process.env).filter(
    (variable) => process.env[variable] === value,
  );
  return (
    matches.find((variable) => variable.startsWith("OPENCLAW_")) ?? matches[0]
  );
}

export function codexMcpOverrides(paths: string[]): string[] {
  const servers = new Map<string, McpServer>();
  for (const path of paths) {
    const config: unknown = JSON.parse(readFileSync(path, "utf8"));
    const entries = record(record(config)?.mcpServers);
    if (!entries) throw new Error(`MCP config requires mcpServers: ${path}`);
    for (const [name, server] of Object.entries(entries))
      servers.set(name, parseServer(server));
  }
  const overrides: string[] = [];
  for (const [name, server] of servers) {
    const key = TOML_BARE_KEY.test(name) ? name : JSON.stringify(name);
    const prefix = `mcp_servers.${key}`;
    if (server.type === "stdio") {
      overrides.push(
        `${prefix}.command=${JSON.stringify(server.command)}`,
        `${prefix}.args=${JSON.stringify(server.args)}`,
        `${prefix}.env=${inlineTable(server.env)}`,
      );
      continue;
    }
    if (server.type === "sse")
      throw new Error(
        "Codex does not support SSE MCP servers; use streamable HTTP",
      );
    const headers = { ...server.headers };
    const authorization = Object.keys(headers).find(
      (header) => header.toLowerCase() === "authorization",
    );
    const bearerVariable =
      authorization &&
      (headers[authorization].match(BEARER_ENV_REFERENCE)?.[1] ??
        matchingEnvironmentVariable(
          headers[authorization].match(BEARER_LITERAL)?.[1],
        ));
    if (bearerVariable) {
      overrides.push(
        `${prefix}.bearer_token_env_var=${JSON.stringify(bearerVariable)}`,
      );
      delete headers[authorization];
    }
    const environmentHeaders: StringMap = {};
    for (const [header, value] of Object.entries(headers)) {
      if (value.match(ENV_REFERENCE)) continue;
      const variable = matchingEnvironmentVariable(value);
      if (!variable) {
        console.error(
          `Warning: MCP server ${name} header ${header} value will be visible in the process list`,
        );
        continue;
      }
      environmentHeaders[header] = variable;
      delete headers[header];
    }
    if (Object.keys(environmentHeaders).length)
      overrides.push(
        `${prefix}.env_http_headers=${inlineTable(environmentHeaders)}`,
      );
    overrides.push(
      `${prefix}.url=${JSON.stringify(server.url)}`,
      `${prefix}.http_headers=${inlineTable(headers)}`,
    );
  }
  return overrides;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const HTTP_TRANSPORT_TYPES = new Set([
  "http",
  "streamable-http",
  "streamable_http",
]);

function readConfinedBridge(
  paths: string[],
): ({ type: "http" } & HttpServer) | undefined {
  let bridge: ({ type: "http" } & HttpServer) | undefined;
  for (const path of paths) {
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("Cannot read confined MCP config");
    }
    const servers = record(record(config)?.mcpServers);
    if (!servers) throw new Error("MCP config requires mcpServers");
    if (!Object.hasOwn(servers, "openclaw")) continue;
    if (bridge) throw new Error("more than one MCP config defines openclaw");
    const server = record(servers.openclaw);
    const { type, url } = server ?? {};
    if (
      typeof type !== "string" ||
      !HTTP_TRANSPORT_TYPES.has(type) ||
      typeof url !== "string"
    )
      throw new Error("openclaw must be an HTTP loopback bridge");
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      throw new Error("openclaw must be an HTTP loopback bridge");
    }
    if (
      !LOOPBACK_HOSTS.has(address.hostname) ||
      !["http:", "https:"].includes(address.protocol) ||
      address.username ||
      address.password
    )
      throw new Error("openclaw must be an HTTP loopback bridge");
    bridge = { type: "http", url, headers: stringMap(server?.headers) };
  }
  return bridge;
}

export async function writeConfinedMcpConfig(
  paths: string[],
  destination: string,
  dropOpenclaw = false,
): Promise<boolean> {
  const bridge = readConfinedBridge(paths);
  const openclaw = dropOpenclaw ? undefined : bridge;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination,
    JSON.stringify({ mcpServers: openclaw ? { openclaw } : {} }),
    { mode: 0o600, flag: "wx" },
  );
  return openclaw !== undefined;
}

export function confinedCodexMcp(
  paths: string[],
  denied: string[] = [],
  allowedTools?: string,
): { overrides: string[]; env: Record<string, string> } {
  const server = readConfinedBridge(paths);
  const { enabled, disabled, dropServer } = confinedCodexToolPolicy(
    denied,
    allowedTools,
  );
  const env: Record<string, string> = {};
  if (!server || dropServer) return { overrides: [], env };
  const prefix = "mcp_servers.openclaw";
  const overrides: string[] = [
    `${prefix}={}`,
    `${prefix}.required=true`,
    `${prefix}.enabled=true`,
  ];
  overrides.push(`${prefix}.url=${JSON.stringify(server.url)}`);
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(server.headers)) {
    const value = interpolate(raw);
    const bearer =
      name.toLowerCase() === "authorization" && BEARER_LITERAL.exec(value);
    const variable = `SMART_ROUTER_OPENCLAW_HEADER_${Object.keys(env).length}`;
    env[variable] = bearer ? bearer[1] : value;
    if (bearer)
      overrides.push(
        `${prefix}.bearer_token_env_var=${JSON.stringify(variable)}`,
      );
    else headers[name] = variable;
  }
  overrides.push(
    `${prefix}.env_http_headers={${Object.entries(headers)
      .map(
        ([name, variable]) =>
          `${JSON.stringify(name)}=${JSON.stringify(variable)}`,
      )
      .join(",")}}`,
  );
  if (enabled !== undefined)
    overrides.push(`${prefix}.enabled_tools=${JSON.stringify(enabled)}`);
  overrides.push(`${prefix}.disabled_tools=${JSON.stringify(disabled)}`);
  return { overrides, env };
}

export function parseToolList(value: string): string[] {
  const tools: string[] = [];
  let depth = 0;
  let token = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) throw new Error("Unbalanced tool pattern parentheses");
    if (depth === 0 && (character === "," || /\s/.test(character))) {
      if (token) tools.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (depth !== 0) throw new Error("Unbalanced tool pattern parentheses");
  if (token) tools.push(token);
  return [...new Set(tools)];
}

export function intersectAllowedTools(
  previous: string | undefined,
  requested: string | undefined,
): string | undefined {
  if (previous === undefined) return requested;
  if (requested === undefined) return previous;
  const normalize = (list: string) =>
    parseToolList(list).map((tool) =>
      tool === "mcp__openclaw" ? `${OPENCLAW_TOOL_PREFIX}*` : tool,
    );
  const stored = normalize(previous),
    incoming = normalize(requested);
  const covered = (tool: string, limit: string) => {
    if (tool === limit) return true;
    if (!limit.startsWith(OPENCLAW_TOOL_PREFIX) || !limit.endsWith("*"))
      return false;
    const namePrefix = limit.slice(OPENCLAW_TOOL_PREFIX.length, -1);
    if (namePrefix && !MCP_TOOL_NAME.test(namePrefix)) return false;
    return tool.startsWith(limit.slice(0, -1));
  };
  return [
    ...new Set([
      ...incoming.filter((tool) =>
        stored.some((limit) => covered(tool, limit)),
      ),
      ...stored.filter((tool) =>
        incoming.some((limit) => covered(tool, limit)),
      ),
    ]),
  ].join(",");
}

export function confinedAllowedTools(value: string | undefined): string {
  return parseToolList(value ?? `${OPENCLAW_TOOL_PREFIX}*`)
    .map((tool) =>
      tool === "mcp__openclaw" ? `${OPENCLAW_TOOL_PREFIX}*` : tool,
    )
    .filter((tool) => tool.startsWith(OPENCLAW_TOOL_PREFIX))
    .join(",");
}

const CLAUDE_NATIVE_TOOLS = new Set([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "NotebookEdit",
  "TodoWrite",
  "TodoRead",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
  "Skill",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ToolSearch",
  "LSP",
  "Computer",
  "ComputerUse",
  "Browser",
]);
export function confinedCodexToolPolicy(
  denied: string[],
  allowedTools?: string,
): { enabled: string[] | undefined; disabled: string[]; dropServer: boolean } {
  const names = (tokens: string[]) =>
    tokens.flatMap(parseToolList).flatMap((tool) => {
      if (tool === "mcp__openclaw" || tool === `${OPENCLAW_TOOL_PREFIX}*`)
        return ["*"];
      if (tool.startsWith(OPENCLAW_TOOL_PREFIX)) {
        const name = tool.slice(OPENCLAW_TOOL_PREFIX.length);
        if (!MCP_TOOL_NAME.test(name))
          throw new Error(
            "Codex confinement supports only exact OpenClaw tool names",
          );
        return [name];
      }
      // Native Claude tools are off, and other MCP servers are dropped; these denials are already enforced.
      if (
        CLAUDE_NATIVE_TOOLS.has(tool.split("(", 1)[0]) ||
        /^mcp__[A-Za-z0-9_.-]+(?:__[A-Za-z0-9_.*-]+)?$/.test(tool)
      )
        return [];
      throw new Error("Unsupported confined Codex tool entry");
    });
  const disabled = names(denied);
  const allowed =
    allowedTools === undefined ? undefined : names([allowedTools]);
  const dropServer = disabled.includes("*");
  if (dropServer) return { enabled: [], disabled: [], dropServer };
  return {
    enabled: allowed?.includes("*") ? undefined : allowed,
    disabled,
    dropServer,
  };
}
