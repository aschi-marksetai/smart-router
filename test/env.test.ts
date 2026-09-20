import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../src/env.ts";

const ENVIRONMENT_KEY = "SMART_ROUTER_DOTENV_TEST";
const QUOTED_ENVIRONMENT_KEY = "SMART_ROUTER_DOTENV_QUOTED_TEST";
const EXPORTED_ENVIRONMENT_KEY = "SMART_ROUTER_DOTENV_EXPORTED_TEST";
const EQUALS_ENVIRONMENT_KEY = "SMART_ROUTER_DOTENV_EQUALS_TEST";
const CONFIG_ENVIRONMENT_KEY = "SMART_ROUTER_DOTENV_CONFIG_TEST";
let directory = "";

afterEach(async () => {
  delete process.env[ENVIRONMENT_KEY];
  delete process.env[QUOTED_ENVIRONMENT_KEY];
  delete process.env[EXPORTED_ENVIRONMENT_KEY];
  delete process.env[EQUALS_ENVIRONMENT_KEY];
  delete process.env[CONFIG_ENVIRONMENT_KEY];
  if (directory) await rm(directory, { recursive: true });
});

test("strips export prefixes and matching quotes while preserving equals", async () => {
  directory = await mkdtemp(join(tmpdir(), "smart-router-env-"));
  await writeFile(
    join(directory, ".env"),
    `export ${EXPORTED_ENVIRONMENT_KEY}='single quoted'\n${QUOTED_ENVIRONMENT_KEY}="double quoted"\n${EQUALS_ENVIRONMENT_KEY}=left=right\n`,
  );
  await loadDotEnv(directory);
  expect(process.env[EXPORTED_ENVIRONMENT_KEY]).toBe("single quoted");
  expect(process.env[QUOTED_ENVIRONMENT_KEY]).toBe("double quoted");
  expect(process.env[EQUALS_ENVIRONMENT_KEY]).toBe("left=right");
});

test("loads dotenv assignments without overriding the environment", async () => {
  directory = await mkdtemp(join(tmpdir(), "smart-router-env-"));
  await writeFile(
    join(directory, ".env"),
    `# comment\n${ENVIRONMENT_KEY}=from-file\nEMPTY=\n`,
  );
  await loadDotEnv(directory);
  expect(process.env[ENVIRONMENT_KEY]).toBe("from-file");
  process.env[ENVIRONMENT_KEY] = "existing";
  await loadDotEnv(directory);
  expect(process.env[ENVIRONMENT_KEY]).toBe("existing");
});

test("loads the config dotenv before the current working directory dotenv", async () => {
  const configDirectory = await mkdtemp(
    join(tmpdir(), "smart-router-env-config-"),
  );
  directory = await mkdtemp(join(tmpdir(), "smart-router-env-cwd-"));
  await writeFile(
    join(configDirectory, ".env"),
    `${CONFIG_ENVIRONMENT_KEY}=from-config\n${ENVIRONMENT_KEY}=from-config\n`,
  );
  await writeFile(join(directory, ".env"), `${ENVIRONMENT_KEY}=from-cwd\n`);

  await loadDotEnv(configDirectory);
  await loadDotEnv(directory);

  expect(process.env[CONFIG_ENVIRONMENT_KEY]).toBe("from-config");
  expect(process.env[ENVIRONMENT_KEY]).toBe("from-config");
  await rm(configDirectory, { recursive: true });
});
