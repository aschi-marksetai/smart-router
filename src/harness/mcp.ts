import { readFileSync } from "node:fs";
import { record } from "./types.ts";

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BEARER_ENV_REFERENCE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i;
const BEARER_LITERAL = /^Bearer (.+)$/i;
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
