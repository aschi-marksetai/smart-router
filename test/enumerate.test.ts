import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  enumerate,
  parseClaudeCatalog,
  parseCodexModels,
  parseOpenRouterModels,
  parsePiRegistry,
} from "../src/enumerate.ts";

const API_KEY_ENV = "SMART_ROUTER_ENUMERATE_TEST_KEY";
const directories: string[] = [];
afterEach(async () => {
  delete process.env[API_KEY_ENV];
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-enumerate-"));
  directories.push(directory);
  return directory;
}

test("parses the Claude catalog cache fixture", () => {
  const fixture = {
    catalog: {
      config: {
        models: [
          {
            id: "claude-x",
            name: "Opus 5.5",
            short_name: "x",
            thinking: { effort_options: [{ id: "low" }, { id: "high" }] },
          },
        ],
      },
    },
  };
  expect(parseClaudeCatalog(fixture)).toEqual([
    {
      id: "claude:claude-x",
      model: "claude-x",
      name: "Opus 5.5",
      efforts: ["low", "high"],
    },
  ]);
});

test("parses public Codex debug models fixtures", () => {
  const fixture = [
    {
      slug: "gpt-x",
      display_name: "GPT X",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "medium" }],
    },
    { slug: "hidden", visibility: "hide" },
  ];
  expect(parseCodexModels(fixture)).toEqual([
    { id: "codex:gpt-x", model: "gpt-x", name: "GPT X", efforts: ["medium"] },
  ]);
});

test("parses the OpenRouter models fixture", () => {
  expect(
    parseOpenRouterModels({ data: [{ id: "deepseek/x", name: "DeepSeek X" }] }),
  ).toEqual([
    {
      id: "pi:openrouter/deepseek/x",
      model: "openrouter/deepseek/x",
      name: "DeepSeek X",
      efforts: ["medium"],
    },
  ]);
});

test("parses the pi-ai registry fixture", () => {
  expect(
    parsePiRegistry("google", [
      { id: "gemini", name: "Gemini", reasoning: true },
    ]),
  ).toEqual([
    {
      id: "pi:google/gemini",
      model: "google/gemini",
      name: "Gemini",
      efforts: ["low", "medium", "high"],
    },
  ]);
});

test("reads the newest Claude catalog", async () => {
  const directory = await temporaryDirectory();
  const catalogDirectory = join(directory, "cache", "model-catalog");
  await mkdir(catalogDirectory, { recursive: true });
  for (const [name, timestamp] of [
    ["old", 1],
    ["new", 2],
  ] as const) {
    const path = join(catalogDirectory, `${name}.json`);
    await writeFile(
      path,
      JSON.stringify({ catalog: { config: { models: [{ id: name }] } } }),
    );
    await utimes(path, timestamp, timestamp);
  }
  expect(
    (
      await enumerate("claude", DEFAULT_CONFIG, { claudeConfigDir: directory })
    )[0]?.model,
  ).toBe("new");
});

test("fetches Claude API models with the configured key", async () => {
  process.env[API_KEY_ENV] = "secret";
  const config = {
    ...DEFAULT_CONFIG,
    harnesses: { claude: { enabled: true, auth: "api-key" as const } },
    providers: { anthropic: { apiKeyEnv: API_KEY_ENV } },
  };
  const fetchModels = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    expect(String(input)).toBe("https://api.anthropic.com/v1/models");
    expect(init?.headers).toMatchObject({ "x-api-key": "secret" });
    return new Response(
      JSON.stringify({
        data: [{ id: "claude-x", capabilities: { effort: ["high", null] } }],
      }),
    );
  };
  expect(
    (await enumerate("claude", config, { fetch: fetchModels }))[0]?.id,
  ).toBe("claude:claude-x");
});

test("runs Codex debug models and falls back to its cache", async () => {
  const directory = await temporaryDirectory();
  const config = {
    ...DEFAULT_CONFIG,
    harnesses: { codex: { enabled: true, binary: "custom-codex" } },
  };
  const payload = JSON.stringify({ models: [{ slug: "gpt-x" }] });
  expect(
    (
      await enumerate("codex", config, {
        runCodexModels: async () => payload,
      })
    )[0]?.model,
  ).toBe("gpt-x");
  await writeFile(join(directory, "models_cache.json"), payload);
  expect(
    (
      await enumerate("codex", config, {
        codexHome: directory,
        runCodexModels: async () => {
          throw new Error("offline");
        },
      })
    )[0]?.model,
  ).toBe("gpt-x");
});

test("enumerates configured Pi providers including Anthropic remapping", async () => {
  process.env[API_KEY_ENV] = "secret";
  const config = {
    ...DEFAULT_CONFIG,
    providers: Object.fromEntries(
      ["openrouter", "openai", "anthropic", "google", "unknown"].map(
        (provider) => [provider, { apiKeyEnv: API_KEY_ENV }],
      ),
    ),
  };
  const fetchModels = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("openrouter"))
      return new Response(JSON.stringify({ data: [{ id: "vendor/model" }] }));
    if (url.includes("openai"))
      return new Response(
        JSON.stringify({ data: [{ id: "gpt-x" }, { id: null }] }),
      );
    return new Response(JSON.stringify({ data: [{ id: "claude-x" }] }));
  };
  const result = await enumerate("pi", config, { fetch: fetchModels });
  expect(result.map(({ id }) => id)).toContain("pi:openrouter/vendor/model");
  expect(result.map(({ id }) => id)).toContain("pi:openai/gpt-x");
  expect(result.map(({ id }) => id)).toContain("pi:anthropic/claude-x");
  expect(result.some(({ id }) => id.startsWith("pi:google/"))).toBe(true);
  expect(result.some(({ id }) => id.startsWith("pi:unknown/"))).toBe(false);
});
