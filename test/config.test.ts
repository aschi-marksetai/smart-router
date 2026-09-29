import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.ts";

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
