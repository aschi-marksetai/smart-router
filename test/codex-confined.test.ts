import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyConfinedCodex } from "../src/harness/codex-confined.ts";
import {
  confinedCodexMcp,
  parseToolList,
  intersectAllowedTools,
  writeConfinedMcpConfig,
} from "../src/harness/mcp.ts";
import * as codex from "../src/harness/codex.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
  delete process.env.SMART_ROUTER_STATE_DIR;
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sr-codex-confined-"));
  directories.push(directory);
  process.env.SMART_ROUTER_STATE_DIR = directory;
  const binary = join(directory, "codex");
  const settings = join(directory, "settings.json");
  const count = join(directory, "calls");
  writeFileSync(settings, JSON.stringify({ version: "0.167.0" }));
  writeFileSync(
    binary,
    `#!/usr/bin/env bun
import {readFileSync,appendFileSync} from "node:fs";
const settings=JSON.parse(readFileSync(${JSON.stringify(settings)},"utf8"));
appendFileSync(${JSON.stringify(count)},process.argv.slice(2).join(" ")+"\\n");
if(process.argv.includes("--version")){console.log("codex-cli "+settings.version);process.exit(0);}
if(settings.fail)process.exit(1);
if(process.argv.includes("mcp")){console.log(JSON.stringify(settings.mcpMalformed ? {} : settings.mcpInvalidRow ? [{}] : [{name:"other.server",transport:{type:"stdio"},enabled:settings.mcpEnabled||!process.argv.some(arg=>arg.startsWith("mcp_servers="))}]));process.exit(0);}
if(settings.malformed){console.log("unexpected output");process.exit(0);}
const names=["shell_tool","view_image","plugins","apps","multi_agent","image_generation","memories","js_repl","unified_exec"];
for(const name of names.filter(name=>name!==settings.missing))console.log(name+" stable "+(name==="unified_exec"||!process.argv.includes("features."+name+"=false")));
if(settings.extra || (settings.changed && process.argv.includes("features.shell_tool=false")))console.log("unknown_feature stable true");
`,
  );
  chmodSync(binary, 0o755);
  return { binary, settings, count };
}

test("Codex confinement verifies resolved features and caches per binary and version", () => {
  const { binary, count, settings } = fixture();
  const overrides = verifyConfinedCodex(binary);
  expect(overrides).toContain("features.shell_tool=false");
  expect(overrides).toContain('web_search="disabled"');
  expect(overrides).toContain('sandbox_mode="read-only"');
  expect(overrides).toContain('approval_policy="never"');
  expect(verifyConfinedCodex(binary)).toEqual(overrides);
  expect(
    readFileSync(count, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("features list")),
  ).toHaveLength(2);
  writeFileSync(settings, JSON.stringify({ version: "0.162.1" }));
  expect(verifyConfinedCodex(binary)).toEqual(overrides);
  expect(
    readFileSync(count, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("features list")),
  ).toHaveLength(4);
});

test("Codex confinement fails closed on unknown versions, failed probes, missing flags and enabled unknown features", () => {
  for (const options of [
    { version: "0.999.0" },
    { version: "0.167.0", fail: true },
    { version: "0.167.0", malformed: true },
    { version: "0.167.0", missing: "shell_tool" },
    { version: "0.167.0", extra: true },
    { version: "0.167.0", mcpEnabled: true },
    { version: "0.167.0", mcpMalformed: true },
    { version: "0.167.0", mcpInvalidRow: true },
    { version: "0.167.0", changed: true },
  ]) {
    const { binary, settings } = fixture();
    writeFileSync(settings, JSON.stringify(options));
    expect(() => verifyConfinedCodex(binary)).toThrow(
      "cannot verify Codex confinement",
    );
  }
  expect(() => verifyConfinedCodex("/nonexistent/sr-codex")).toThrow(
    "cannot verify Codex confinement",
  );
});

test("confined Codex spawn and resume keep credentials out of argv and remove native authority", () => {
  const { binary } = fixture();
  const config = join(process.env.SMART_ROUTER_STATE_DIR!, "mcp.json");
  const token = "test-credential-not-for-argv";
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        openclaw: {
          type: "http",
          url: "http://127.0.0.1:9999/mcp",
          headers: { Authorization: `Bearer ${token}`, "X-Test": token },
        },
        other: { type: "stdio", command: "forbidden" },
      },
    }),
  );
  const options = {
    cwd: "/tmp",
    model: "test",
    confined: true,
    codexConfinedOverrides: verifyConfinedCodex(binary),
    mcpConfig: [config],
    disallowedTools: ["mcp__openclaw__pay", "WebSearch"],
    codexSandbox: "danger-full-access",
    codexExtraWritableRoots: ["/"],
  };
  for (const command of [
    codex.buildSpawn("task", options),
    codex.buildResume("thread", "again", options),
  ]) {
    expect(command.argv).toContain("--ignore-user-config");
    expect(command.argv).toContain('sandbox_mode="read-only"');
    expect(command.argv).toContain(
      'mcp_servers.openclaw.disabled_tools=["pay"]',
    );
    expect(command.argv.join(" ")).not.toContain(token);
    expect(command.argv.join(" ")).not.toContain("forbidden");
    expect(command.argv.join(" ")).not.toContain("writable_roots");
    expect(command.argv.join(" ")).not.toContain("danger-full-access");
    expect(Object.values(command.env ?? {})).toContain(token);
  }
});

test("confined MCP input errors fail without exposing contents and HTTP credentials stay out of argv", async () => {
  const { binary } = fixture();
  const directory = process.env.SMART_ROUTER_STATE_DIR!;
  const input = join(directory, "input.json");
  const target = join(directory, "filtered.json");
  writeFileSync(input, "not JSON with a private credential");
  await expect(writeConfinedMcpConfig([input], target)).rejects.toThrow(
    "Cannot read confined MCP config",
  );
  writeFileSync(
    input,
    JSON.stringify({
      mcpServers: {
        openclaw: {
          type: "http",
          url: "http://127.0.0.1:9999/mcp",
          headers: { Authorization: "Bearer test-secret" },
        },
      },
    }),
  );
  const mcp = confinedCodexMcp([input], ["Read", "mcp__openclaw__pay"]);
  expect(Object.values(mcp.env)).toEqual(["test-secret"]);
  expect(mcp.overrides.join(" ")).not.toContain("test-secret");
  expect(mcp.overrides).toContain(
    'mcp_servers.openclaw.bearer_token_env_var="SMART_ROUTER_OPENCLAW_HEADER_0"',
  );
  expect(
    codex.buildResume("thread", "again", {
      cwd: "/tmp",
      model: "test",
      confined: true,
      codexConfinedOverrides: verifyConfinedCodex(binary),
      mcpConfig: [input],
    }).env,
  ).toEqual(mcp.env);
  writeFileSync(
    input,
    JSON.stringify({
      mcpServers: { openclaw: { type: "sse", url: "http://localhost" } },
    }),
  );
  expect(() => confinedCodexMcp([input])).toThrow("HTTP loopback bridge");
  for (const value of [{}, { mcpServers: { openclaw: null } }]) {
    writeFileSync(input, JSON.stringify(value));
    await expect(writeConfinedMcpConfig([input], target)).rejects.toThrow();
  }
});

test("Codex refuses an unverified confined argv", () => {
  const options = { cwd: "/tmp", model: "test", confined: true };
  expect(() => codex.buildSpawn("task", options)).toThrow("not verified");
  expect(() => codex.buildResume("thread", "again", options)).toThrow(
    "not verified",
  );
});

test("Codex confines allowed MCP names and refuses unsupported deny patterns", () => {
  fixture();
  const path = join(process.env.SMART_ROUTER_STATE_DIR!, "mcp.json");
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        openclaw: { type: "http", url: "http://localhost:9999/mcp" },
      },
    }),
  );
  expect(() => confinedCodexMcp([path], ["mcp__openclaw__pay*"])).toThrow(
    "exact OpenClaw tool names",
  );
  expect(
    confinedCodexMcp([path], [], "Read,mcp__openclaw__read").overrides,
  ).toContain('mcp_servers.openclaw.enabled_tools=["read"]');
  expect(confinedCodexMcp([path], [], "Read").overrides).toContain(
    "mcp_servers.openclaw.enabled_tools=[]",
  );
});

test("confined Codex catalogs cannot restore model-native code mode, search or agents", () => {
  const { binary } = fixture();
  const command = codex.buildSpawn("task", {
    cwd: "/tmp",
    model: "test",
    effort: "high",
    confined: true,
    codexConfinedOverrides: verifyConfinedCodex(binary),
  });
  const entry = command.argv.find((value) =>
    value.startsWith("model_catalog_json="),
  );
  expect(entry).toBeDefined();
  const path = JSON.parse(entry!.slice("model_catalog_json=".length));
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  expect(catalog.models).toMatchObject([
    {
      slug: "test",
      tool_mode: "direct",
      multi_agent_version: "disabled",
      shell_type: "disabled",
      supports_search_tool: false,
      experimental_supported_tools: [],
    },
  ]);
});

test("confined bridge validation rejects stdio, remote hosts and duplicate openclaw definitions for both harnesses", async () => {
  fixture();
  const directory = process.env.SMART_ROUTER_STATE_DIR!;
  const input = join(directory, "untrusted.json"),
    second = join(directory, "duplicate.json");
  for (const server of [
    { type: "stdio", command: "node" },
    { type: "http", url: "https://example.com/mcp" },
    { type: "sse", url: "http://localhost/mcp" },
    { type: "http", url: "file://localhost/etc/passwd" },
  ]) {
    writeFileSync(input, JSON.stringify({ mcpServers: { openclaw: server } }));
    await expect(
      writeConfinedMcpConfig([input], join(directory, "filtered")),
    ).rejects.toThrow("HTTP loopback bridge");
    expect(() => confinedCodexMcp([input])).toThrow("HTTP loopback bridge");
  }
  for (const path of [input, second])
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          openclaw: { type: "http", url: "http://127.0.0.1:9999/mcp" },
        },
      }),
    );
  await expect(
    writeConfinedMcpConfig([input, second], join(directory, "filtered")),
  ).rejects.toThrow("more than one");
  expect(() => confinedCodexMcp([input, second])).toThrow("more than one");
});

test("Codex residual native tools and their read-only guards are documented", () => {
  const source = readFileSync(
    new URL("../src/harness/codex-confined.ts", import.meta.url),
    "utf8",
  );
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const name of [
    "apply_patch",
    "list_mcp_resources",
    "list_mcp_resource_templates",
    "read_mcp_resource",
  ]) {
    expect(source).toContain(`\`${name}\``);
    expect(readme).toContain(`\`${name}\``);
  }
  expect(readme).toContain('approval_policy="never"');
  expect(source.includes("tools.update_plan.enabled=false")).toBe(true);
});

test("Codex parses spaced tool policies, drops whole-server denials and rejects unknown entries", () => {
  fixture();
  const path = join(process.env.SMART_ROUTER_STATE_DIR!, "loopback.json");
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        openclaw: { type: "http", url: "http://127.0.0.1:9999/mcp" },
      },
    }),
  );
  expect(
    confinedCodexMcp([path], ["WebSearch mcp__openclaw__pay"]).overrides,
  ).toContain('mcp_servers.openclaw.disabled_tools=["pay"]');
  for (const entry of ["mcp__openclaw", "mcp__openclaw__*"])
    expect(confinedCodexMcp([path], [entry])).toEqual({
      overrides: [],
      env: {},
    });
  expect(() => confinedCodexMcp([path], ["unknown_tool"])).toThrow(
    "Unsupported",
  );
  expect(() => confinedCodexMcp([path], [], "unknown_tool")).toThrow(
    "Unsupported",
  );
});

test("tool tokenization preserves parenthesized spaces and commas and rejects malformed patterns", () => {
  expect(
    parseToolList(
      " WebSearch mcp__openclaw__pay, Bash(git commit:*) Bash(echo a,b) WebSearch ",
    ),
  ).toEqual([
    "WebSearch",
    "mcp__openclaw__pay",
    "Bash(git commit:*)",
    "Bash(echo a,b)",
  ]);
  expect(() => parseToolList("Bash(git commit:*")).toThrow("parentheses");
  expect(() => parseToolList("Read)")).toThrow("parentheses");
  expect(intersectAllowedTools(undefined, "Read")).toBe("Read");
  expect(intersectAllowedTools("Read", undefined)).toBe("Read");
  expect(
    intersectAllowedTools("mcp__openclaw__*", "mcp__openclaw__safe_ping"),
  ).toBe("mcp__openclaw__safe_ping");
  expect(
    intersectAllowedTools("mcp__openclaw__safe_ping", "mcp__openclaw__*"),
  ).toBe("mcp__openclaw__safe_ping");
});

test("confined bridge accepts HTTP transport aliases on the exact loopback hosts", async () => {
  fixture();
  const directory = process.env.SMART_ROUTER_STATE_DIR!;
  for (const [index, host] of ["127.0.0.1", "localhost", "[::1]"].entries()) {
    const path = join(directory, "bridge.json"),
      url = `http://${host}:9999/mcp`;
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          openclaw: {
            type:
              index === 0
                ? "http"
                : index === 1
                  ? "streamable-http"
                  : "streamable_http",
            url,
          },
        },
      }),
    );
    const filtered = join(directory, "filtered-" + index);
    expect(await writeConfinedMcpConfig([path], filtered)).toBe(true);
    expect(
      JSON.parse(readFileSync(filtered, "utf8")).mcpServers.openclaw,
    ).toMatchObject({ type: "http", url });
    expect(confinedCodexMcp([path]).overrides).toContain(
      `mcp_servers.openclaw.url=${JSON.stringify(url)}`,
    );
  }
});

test("allowlist intersection never treats escaped MCP patterns as literal wildcard prefixes", () => {
  expect(
    intersectAllowedTools("mcp__openclaw__pay\\*", "mcp__openclaw__pay\\evil"),
  ).toBe("");
});

test("allowlist intersection handles exact names, bridge aliases and literal MCP wildcard prefixes", () => {
  expect(intersectAllowedTools("Read", "Write")).toBe("");
  expect(
    intersectAllowedTools("mcp__openclaw__safe_ping", "mcp__openclaw"),
  ).toBe("mcp__openclaw__safe_ping");
  expect(
    intersectAllowedTools("mcp__openclaw__safe*", "mcp__openclaw__safe_ping"),
  ).toBe("mcp__openclaw__safe_ping");
});
