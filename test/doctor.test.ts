import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { buildCandidates, doctor, type Detection } from "../src/doctor.ts";

const TEST_ANTHROPIC_KEY = "SMART_ROUTER_TEST_ANTHROPIC_KEY";
const TEST_CODEX_KEY = "CODEX_API_KEY";
const previousClaudeDirectory = process.env.CLAUDE_CONFIG_DIR;
const previousCodexHome = process.env.CODEX_HOME;
let directory: string;
let binary: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "smart-router-doctor-"));
  binary = join(directory, "test-harness");
  await writeFile(binary, "#!/bin/sh\nprintf 'test-version\\n'\n", {
    mode: 0o755,
  });
  process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
  process.env.CODEX_HOME = join(directory, "codex");
});

afterEach(async () => {
  delete process.env[TEST_ANTHROPIC_KEY];
  delete process.env[TEST_CODEX_KEY];
  if (previousClaudeDirectory === undefined)
    delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeDirectory;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(directory, { recursive: true });
});

test("detects configured API-key authentication", async () => {
  process.env[TEST_ANTHROPIC_KEY] = "test";
  process.env[TEST_CODEX_KEY] = "test";
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "api-key", binary },
      codex: { enabled: true, auth: "api-key", binary },
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
  expect(result.harnesses.claude.version).toBe("test-version");
  expect(result.harnesses.codex.version).toBe("test-version");
  expect(result.availableModels).toEqual(["claude:new"]);
});

test("detects subscription credentials without model caches", async () => {
  const claudeDirectory = join(directory, "claude");
  const codexDirectory = join(directory, "codex");
  await mkdir(claudeDirectory);
  await mkdir(codexDirectory);
  await writeFile(join(claudeDirectory, ".credentials.json"), "{}");
  await writeFile(join(codexDirectory, "auth.json"), "{}");
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "subscription", binary },
      codex: { enabled: true, auth: "subscription", binary },
    },
  };
  const result = await doctor(config, { enumerate: async () => [] });
  expect(result.harnesses.claude.authed).toBe(true);
  expect(result.harnesses.codex.authed).toBe(true);
});

test("detects cached catalogs and handles a failed version command", async () => {
  const catalogDirectory = join(directory, "claude", "cache", "model-catalog");
  const codexDirectory = join(directory, "codex");
  await mkdir(catalogDirectory, { recursive: true });
  await mkdir(codexDirectory);
  await writeFile(join(catalogDirectory, "models.json"), "{}");
  await writeFile(join(codexDirectory, "models_cache.json"), "{}");
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "subscription", binary },
      codex: { enabled: true, auth: "subscription", binary },
    },
  };
  const result = await doctor(config, { enumerate: async () => [] });
  expect(result.harnesses.claude.authed).toBe(true);
  expect(result.harnesses.codex.authed).toBe(true);
  await writeFile(binary, "#!/bin/sh\nexit 1\n");
  const failedVersion = await doctor(config, { enumerate: async () => [] });
  expect(failedVersion.harnesses.claude.installed).toBe(true);
  expect(failedVersion.harnesses.claude.version).toBeNull();
});

test("rejects subscription authentication without model caches or credentials", async () => {
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "subscription", binary },
      codex: { enabled: true, auth: "subscription", binary },
    },
  };
  const result = await doctor(config, { enumerate: async () => [] });
  expect(result.harnesses.claude.authed).toBe(false);
  expect(result.harnesses.codex.authed).toBe(false);
});

test("ignores failed model enumeration and keeps configured candidates", async () => {
  process.env[TEST_ANTHROPIC_KEY] = "test";
  const config: Config = {
    ...DEFAULT_CONFIG,
    harnesses: {
      claude: { enabled: true, auth: "api-key", binary },
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
