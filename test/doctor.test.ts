import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { buildCandidates, doctor, type Detection } from "../src/doctor.ts";

const TEST_ANTHROPIC_KEY = "SMART_ROUTER_TEST_ANTHROPIC_KEY";
const TEST_CODEX_KEY = "CODEX_API_KEY";

afterEach(() => {
  delete process.env[TEST_ANTHROPIC_KEY];
  delete process.env[TEST_CODEX_KEY];
});

test("detects configured API-key authentication", async () => {
  process.env[TEST_ANTHROPIC_KEY] = "test";
  process.env[TEST_CODEX_KEY] = "test";
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "api-key", binary: "/usr/bin/true" },
      codex: { enabled: true, auth: "api-key", binary: "/usr/bin/true" },
    },
    providers: { anthropic: { apiKeyEnv: TEST_ANTHROPIC_KEY } },
    ignoredModels: ["claude:retired"],
  };
  const result = await doctor(config, {
    enumerate: async (harness) =>
      harness === "claude"
        ? [
            {
              id: "claude:new",
              model: "new",
              name: "New",
              efforts: ["high"],
            },
            {
              id: "claude:retired",
              model: "retired",
              name: "Retired",
              efforts: ["high"],
            },
          ]
        : [],
  });
  expect(result.harnesses.claude.authed).toBe(true);
  expect(result.harnesses.codex.authed).toBe(true);
  expect(result.availableModels).toEqual(["claude:new"]);
});

test("detects subscription credentials without model caches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-doctor-"));
  const claudeDirectory = join(directory, "claude");
  const codexDirectory = join(directory, "codex");
  const previousClaudeDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = claudeDirectory;
  process.env.CODEX_HOME = codexDirectory;
  await mkdir(claudeDirectory);
  await mkdir(codexDirectory);
  await writeFile(join(claudeDirectory, ".credentials.json"), "{}");
  await writeFile(join(codexDirectory, "auth.json"), "{}");
  const { doctor: detect } = await import(
    `../src/doctor.ts?test=${crypto.randomUUID()}`
  );
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "subscription", binary: "/usr/bin/true" },
      codex: { enabled: true, auth: "subscription", binary: "/usr/bin/true" },
    },
  };
  const result = await detect(config, { enumerate: async () => [] });
  expect(result.harnesses.claude.authed).toBe(true);
  expect(result.harnesses.codex.authed).toBe(true);
  if (previousClaudeDirectory === undefined)
    delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeDirectory;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(directory, { recursive: true });
});

test("rejects subscription authentication without model caches or credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-doctor-"));
  const previousClaudeDirectory = process.env.CLAUDE_CONFIG_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
  process.env.CODEX_HOME = join(directory, "codex");
  const { doctor: detect } = await import(
    `../src/doctor.ts?test=${crypto.randomUUID()}`
  );
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "subscription", binary: "/usr/bin/true" },
      codex: { enabled: true, auth: "subscription", binary: "/usr/bin/true" },
    },
  };
  const result = await detect(config, { enumerate: async () => [] });
  expect(result.harnesses.claude.authed).toBe(false);
  expect(result.harnesses.codex.authed).toBe(false);
  if (previousClaudeDirectory === undefined)
    delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeDirectory;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(directory, { recursive: true });
});

test("ignores failed model enumeration and keeps configured candidates", async () => {
  process.env[TEST_ANTHROPIC_KEY] = "test";
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "api-key", binary: "/usr/bin/true" },
    },
    providers: { anthropic: { apiKeyEnv: TEST_ANTHROPIC_KEY } },
    models: [
      {
        id: "claude:opus",
        harness: "claude",
        model: "opus",
        efforts: ["high"],
      },
    ],
  };
  const result = await doctor(config, {
    enumerate: async () => {
      throw new Error("offline");
    },
  });
  expect(result.availableModels).toEqual([]);
  expect(result.candidates).toEqual(["claude:opus@high"]);
});

test("builds candidates only for installed and authed harnesses", () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: { claude: { enabled: true } },
    models: [
      {
        id: "claude:opus",
        harness: "claude",
        model: "opus",
        efforts: ["high"],
      },
      {
        id: "codex:terra",
        harness: "codex",
        model: "terra",
        efforts: ["medium", "high"],
      },
    ],
  };
  const detection: Detection = {
    harnesses: {
      claude: { installed: true, version: "1", authed: true },
      codex: { installed: true, version: "1", authed: false },
      pi: { installed: false, version: null, authed: false },
    },
    providers: {},
    codexbar: { installed: false },
  };
  expect(buildCandidates(config, detection)).toEqual(["claude:opus@high"]);
});

test("skips disabled harnesses", () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: { claude: { enabled: false, auth: "api-key" } },
    models: [
      {
        id: "claude:opus",
        harness: "claude",
        model: "opus",
        efforts: ["high"],
      },
    ],
  };
  const detection: Detection = {
    harnesses: {
      claude: { installed: true, version: "1", authed: true },
      codex: { installed: false, version: null, authed: false },
      pi: { installed: false, version: null, authed: false },
    },
    providers: {},
    codexbar: { installed: false },
  };
  expect(buildCandidates(config, detection)).toEqual([]);
});
