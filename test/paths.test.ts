import { afterEach, expect, test } from "bun:test";
import { configDir, sessionsDir, stateDir } from "../src/paths.ts";

const CONFIG_DIRECTORY_ENV = "SMART_ROUTER_CONFIG_DIR";
const STATE_DIRECTORY_ENV = "SMART_ROUTER_STATE_DIR";
const CONFIG_DIRECTORY = "/tmp/smart-router-config";
const STATE_DIRECTORY = "/tmp/smart-router-state";

afterEach(() => {
  delete process.env[CONFIG_DIRECTORY_ENV];
  delete process.env[STATE_DIRECTORY_ENV];
});

test("uses configured state and config directories", () => {
  process.env[CONFIG_DIRECTORY_ENV] = CONFIG_DIRECTORY;
  process.env[STATE_DIRECTORY_ENV] = STATE_DIRECTORY;
  expect(configDir()).toBe(CONFIG_DIRECTORY);
  expect(stateDir()).toBe(STATE_DIRECTORY);
  expect(sessionsDir()).toBe(`${STATE_DIRECTORY}/sessions`);
});
