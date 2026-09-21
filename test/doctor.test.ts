import { afterEach, expect, test } from "bun:test";
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
  };
  const result = await doctor(config);
  expect(result.harnesses.claude.authed).toBe(true);
  expect(result.harnesses.codex.authed).toBe(true);
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
