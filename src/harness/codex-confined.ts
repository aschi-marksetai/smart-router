import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { record, type HarnessOptions } from "./types.ts";
import { codexHomeDir, stateDir } from "../paths.ts";

// Expected residual tools on verified Codex 0.162.1/0.167.0: `apply_patch`,
// `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`.
// read-only + approval_policy="never" blocks patch writes; resources can only come from the loopback bridge.
// The CLI has no cheap pre-execution schema capture; live request traces verify this exact native set.
const VERIFIED_VERSIONS = new Set(["0.162.1", "0.167.0"]);
const REQUIRED_FEATURES = ["shell_tool", "view_image", "plugins", "apps"];
const BASE_OVERRIDES = [
  'web_search="disabled"',
  'sandbox_mode="read-only"',
  'approval_policy="never"',
  "agents.enabled=false",
  "tools.experimental_request_user_input.enabled=false",
  "tools.update_plan.enabled=false",
];
// Removed compatibility flags add no tools. unified_exec cannot register shell tools with shell_tool=false.
const HARMLESS_FEATURES = new Set([
  "item_ids",
  "realtime_conversation",
  "resize_all_images",
  "terminal_resize_reflow",
  "tool_search_always_defer_mcp_tools",
  "tui_app_server",
  "worktrees",
]);
const FEATURE_LINE =
  /^([a-z0-9_.]+)\s+(stable|experimental|under development|removed|deprecated)\s+(true|false)$/;
const PROBE_TIMEOUT_MS = 15_000;
const CACHE_POLICY_VERSION = 4;

type Feature = { name: string; stage: string; enabled: boolean };
function parseFeatures(output: string): Feature[] {
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const match = FEATURE_LINE.exec(line.trim());
      if (!match)
        throw new Error("codex features list returned invalid output");
      return { name: match[1], stage: match[2], enabled: match[3] === "true" };
    });
}
function overridesFor(features: Feature[]): string[] {
  return [
    ...BASE_OVERRIDES,
    ...features.map(({ name }) => `features.${name}=false`),
  ];
}
function validateFeatures(features: Feature[]): void {
  for (const required of REQUIRED_FEATURES) {
    if (!features.some(({ name, enabled }) => name === required && !enabled))
      throw new Error(`features.${required}=false was not resolved`);
  }
  const unexpected = features.find(
    ({ name, stage, enabled }) =>
      enabled &&
      name !== "unified_exec" &&
      !(stage === "removed" && HARMLESS_FEATURES.has(name)),
  );
  if (unexpected)
    throw new Error(`features.${unexpected.name}=false was not resolved`);
}

export function verifyConfinedCodex(
  binary: string,
  cwd = process.cwd(),
): string[] {
  try {
    const path = Bun.which(binary);
    if (!path) throw new Error("Binary unavailable");
    const run = (args: string[]) => {
      try {
        return execFileSync(path, args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: PROBE_TIMEOUT_MS,
        });
      } catch {
        throw new Error(`codex ${args[0]} probe failed`);
      }
    };
    const version = run(["--version"])
      .trim()
      .match(/^codex-cli (\S+)$/)?.[1];
    if (!version || !VERIFIED_VERSIONS.has(version))
      throw new Error(
        "codex --version is unsupported (supported: 0.162.1, 0.167.0)",
      );
    const { mtimeMs, size } = statSync(path);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([path, version, mtimeMs, size, CACHE_POLICY_VERSION]),
      )
      .digest("hex");
    const cache = join(stateDir(), `codex-confined-${fingerprint}.txt`);
    let features: Feature[];
    if (existsSync(cache))
      features = parseFeatures(readFileSync(cache, "utf8"));
    else {
      const baseline = parseFeatures(run(["features", "list"]));
      const resolved = run([
        "features",
        "list",
        ...overridesFor(baseline).flatMap((value) => ["-c", value]),
      ]);
      features = parseFeatures(resolved);
      if (
        features.length !== baseline.length ||
        features.some((feature, index) => feature.name !== baseline[index].name)
      )
        throw new Error("codex features list changed during verification");
      validateFeatures(features);
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cache, resolved, { mode: 0o600 });
    }
    validateFeatures(features);
    const overrides = overridesFor(features);
    // --ignore-user-config leaves project MCP settings in scope; disable every inherited registration.
    const servers = parseMcpInventory(
      run([
        "mcp",
        "list",
        "--json",
        ...overrides.flatMap((value) => ["-c", value]),
      ]),
    );
    overrides.push(
      `mcp_servers={${servers.map(({ name, transport }) => `${JSON.stringify(name)}={enabled=false,${transport === "stdio" ? 'command="false"' : 'url="http://127.0.0.1:1"'}}`).join(",")}}`,
    );
    const resolvedServers = parseMcpInventory(
      run([
        "mcp",
        "list",
        "--json",
        ...overrides.flatMap((value) => ["-c", value]),
      ]),
    );
    const enabled = resolvedServers.find((server) => server.enabled);
    if (enabled)
      throw new Error("mcp_servers.*.enabled=false was not resolved");
    return overrides;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "codex probe failed";
    throw new Error(
      `cannot verify Codex confinement: ${reason}; upgrade codex`,
    );
  }
}

function parseMcpInventory(output: string) {
  try {
    const rows: unknown = JSON.parse(output);
    if (!Array.isArray(rows)) throw new Error();
    return rows.map((value: unknown) => {
      const row = record(value);
      const transport = record(row?.transport)?.type;
      if (
        typeof row?.name !== "string" ||
        typeof row.enabled !== "boolean" ||
        (transport !== "stdio" && transport !== "streamable_http")
      )
        throw new Error();
      return { name: row.name, enabled: row.enabled, transport };
    });
  } catch {
    throw new Error(
      "mcp_servers.*.enabled=false inventory could not be verified",
    );
  }
}

const DEFAULT_TRUNCATION_BYTES = 10_000;
export function confinedCodexModelCatalog(
  options: Pick<HarnessOptions, "model" | "effort">,
): string {
  let cached: Record<string, unknown> | undefined;
  try {
    const catalog = record(
      JSON.parse(
        readFileSync(join(codexHomeDir(), "models_cache.json"), "utf8"),
      ),
    );
    if (Array.isArray(catalog?.models))
      cached = catalog.models
        .map(record)
        .find((model) => model?.slug === options.model);
  } catch {}
  const model = {
    slug: options.model,
    display_name: options.model,
    base_instructions: "Follow the user task and the tool permissions.",
    supported_reasoning_levels: [
      {
        effort: options.effort ?? "medium",
        description: "Configured reasoning effort",
      },
    ],
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: DEFAULT_TRUNCATION_BYTES },
    apply_patch_tool_type: "freeform",
    ...cached,
    // Model metadata takes precedence over feature flags, so constrain it independently.
    tool_mode: "direct",
    multi_agent_version: "disabled",
    shell_type: "disabled",
    supports_search_tool: false,
    experimental_supported_tools: [],
  };
  const content = JSON.stringify({ models: [model] });
  const fingerprint = createHash("sha256").update(content).digest("hex");
  const path = join(stateDir(), `codex-confined-model-${fingerprint}.json`);
  mkdirSync(stateDir(), { recursive: true });
  const temporary = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}
