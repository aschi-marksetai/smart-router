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
