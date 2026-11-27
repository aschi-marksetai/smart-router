import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  jevApiKeyEnv,
  loadConfig,
  saveConfig,
} from "../src/config.ts";

const temporaryDirectories: string[] = [];
const CONFIG_DIRECTORY_ENV = "SMART_ROUTER_CONFIG_DIR";

afterEach(async () => {
  delete process.env[CONFIG_DIRECTORY_ENV];
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

test("loads the empty default and round-trips config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-config-"));
  temporaryDirectories.push(directory);
  process.env[CONFIG_DIRECTORY_ENV] = directory;
  expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  const config = { ...DEFAULT_CONFIG, defaultModelId: "codex:gpt-5.6-terra" };
  await saveConfig(config);
  expect(await loadConfig()).toEqual(config);
});

test("Jev key follows the provider unless overridden", () => {
  expect(jevApiKeyEnv(DEFAULT_CONFIG)).toBe("TYPESAFE_API_KEY");
  const openrouter = {
    ...DEFAULT_CONFIG,
    jev: { ...DEFAULT_CONFIG.jev, provider: "openrouter" as const },
  };
  expect(jevApiKeyEnv(openrouter)).toBe("OPENROUTER_API_KEY");
  expect(
    jevApiKeyEnv({
      ...openrouter,
      jev: { ...openrouter.jev, apiKeyEnv: "CUSTOM_JEV_KEY" },
    }),
  ).toBe("CUSTOM_JEV_KEY");
});

test("migrates Jev default keys and keeps a custom override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-config-"));
  temporaryDirectories.push(directory);
  process.env[CONFIG_DIRECTORY_ENV] = directory;
  for (const defaultKey of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]) {
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({ jev: { apiKeyEnv: defaultKey } }),
    );
    expect((await loadConfig()).jev.apiKeyEnv).toBeUndefined();
  }
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ jev: { apiKeyEnv: "CUSTOM_JEV_KEY" } }),
  );
  expect((await loadConfig()).jev.apiKeyEnv).toBe("CUSTOM_JEV_KEY");
});

test("does not restore removed default quota providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-config-"));
  temporaryDirectories.push(directory);
  process.env[CONFIG_DIRECTORY_ENV] = directory;
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      quota: { enabled: true, providers: { codex: "codex" } },
      rules: { confidentialExcludedProviders: ["openrouter"] },
    }),
  );
  const migrated = await loadConfig();
  expect(migrated.quota.providers).toEqual({ codex: "codex" });
  expect(migrated.rules.confidentialExcludedModels).toEqual([
    "pi:openrouter/*",
  ]);
  await saveConfig(migrated);
  const saved = await Bun.file(join(directory, "config.json")).text();
  expect(saved).not.toContain("confidentialExcludedProviders");
});

test("fills tier and taste defaults for known models and keeps explicit values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-config-"));
  temporaryDirectories.push(directory);
  process.env[CONFIG_DIRECTORY_ENV] = directory;
  const model = (name: string, extra: object = {}) => ({
    id: `claude:${name}`,
    harness: "claude",
    model: name,
    efforts: ["high"],
    ...extra,
  });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      models: [
        model("gpt-6-luna"),
        model("claude-haiku-5-5"),
        model("gpt-6.1-terra"),
        model("claude-sonnet-5-5"),
        model("gpt-6.2-sol"),
        model("gpt-6.2-astra"),
        model("claude-opus-5-5"),
        model("claude-fable-5-2"),
        model("mystery"),
        model("claude-opus-custom", { tier: 2, taste: false }),
      ],
    }),
  );
  const { models } = await loadConfig();
  expect(models.map(({ tier }) => tier)).toEqual([
    1,
    1,
    2,
    2,
    3,
    4,
    4,
    4,
    undefined,
    2,
  ]);
  expect(models.map(({ taste }) => taste)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    true,
    undefined,
    false,
  ]);
});

test("limits and the pace tilt are on by default and the user's values win", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-config-"));
  temporaryDirectories.push(directory);
  process.env[CONFIG_DIRECTORY_ENV] = directory;
  expect((await loadConfig()).rules).toMatchObject({
    quotaCutoffPercent: { claude: 95, codex: 95 },
    modelWindowCutoffPercent: 95,
    paceTilt: 1,
  });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      rules: {
        quotaCutoffPercent: { codex: 80 },
        modelWindowCutoffPercent: 90,
        paceTilt: 0,
      },
    }),
  );
  expect((await loadConfig()).rules).toMatchObject({
    // One pool's override keeps the other pool's default; it must not leave Claude without a cutoff.
    quotaCutoffPercent: { claude: 95, codex: 80 },
    modelWindowCutoffPercent: 90,
    paceTilt: 0,
  });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      rules: {
        quotaCutoffPercent: { claude: 90 },
        experiments: { repoContext: 1 },
      },
    }),
  );
  expect((await loadConfig()).rules).toMatchObject({
    quotaCutoffPercent: { claude: 90, codex: 95 },
    experiments: { repoContext: 1, outcomeFeedback: 0.5 },
  });
  // null is how a pool's cutoff is turned off; it survives a load.
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ rules: { quotaCutoffPercent: { codex: null } } }),
  );
  expect((await loadConfig()).rules.quotaCutoffPercent).toEqual({
    claude: 95,
    codex: null,
  });
});

test("the default Jev model is a pinned version named for the provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-config-"));
  temporaryDirectories.push(directory);
  process.env[CONFIG_DIRECTORY_ENV] = directory;
  expect((await loadConfig()).jev.model).toBe("jev-1.14.0");
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ jev: { provider: "openrouter" } }),
  );
  expect((await loadConfig()).jev.model).toBe("typesafe/jev-1.14-20261014");
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ jev: { provider: "openrouter", model: "jev-latest" } }),
  );
  expect((await loadConfig()).jev.model).toBe("jev-latest");
});
