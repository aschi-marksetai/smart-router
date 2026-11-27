import {
  assertTestIsolation,
  restoreEnvironmentVariable,
} from "./environment.ts";
const previousTestState = process.env.SMART_ROUTER_STATE_DIR;
const previousTestConfig = process.env.SMART_ROUTER_CONFIG_DIR;
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { configDir, sessionsDir, stateDir } from "../src/paths.ts";

const CONFIG_DIRECTORY_ENV = "SMART_ROUTER_CONFIG_DIR";
const STATE_DIRECTORY_ENV = "SMART_ROUTER_STATE_DIR";
const CONFIG_DIRECTORY = "/tmp/smart-router-config";
const STATE_DIRECTORY = "/tmp/smart-router-state";

afterEach(() => {
  restoreEnvironmentVariable(CONFIG_DIRECTORY_ENV, previousTestConfig);
  restoreEnvironmentVariable(STATE_DIRECTORY_ENV, previousTestState);
});

test("uses configured state and config directories", () => {
  process.env[CONFIG_DIRECTORY_ENV] = CONFIG_DIRECTORY;
  process.env[STATE_DIRECTORY_ENV] = STATE_DIRECTORY;
  expect(configDir()).toBe(CONFIG_DIRECTORY);
  expect(stateDir()).toBe(STATE_DIRECTORY);
  expect(sessionsDir()).toBe(`${STATE_DIRECTORY}/sessions`);
});

test("default directory resolution is pure and leaves test isolation intact", () => {
  try {
    delete process.env[CONFIG_DIRECTORY_ENV];
    delete process.env[STATE_DIRECTORY_ENV];
    expect(configDir()).toBe(join(homedir(), ".config", "smart-router"));
    expect(stateDir()).toBe(join(homedir(), ".local", "state", "smart-router"));
  } finally {
    restoreEnvironmentVariable(CONFIG_DIRECTORY_ENV, previousTestConfig);
    restoreEnvironmentVariable(STATE_DIRECTORY_ENV, previousTestState);
  }
});

test("missing preload fails before tests access state, and restoring unset variables deletes them", () => {
  const previous = process.env.SMART_ROUTER_TEST_PRELOAD;
  try {
    restoreEnvironmentVariable("SMART_ROUTER_TEST_PRELOAD", undefined);
    expect(assertTestIsolation).toThrow(
      "run bun test from the repository root",
    );
    expect(process.env.SMART_ROUTER_TEST_PRELOAD).toBeUndefined();
  } finally {
    restoreEnvironmentVariable("SMART_ROUTER_TEST_PRELOAD", previous);
  }
  expect(assertTestIsolation).not.toThrow();
});
