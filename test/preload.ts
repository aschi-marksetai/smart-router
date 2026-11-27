import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "smart-router-tests-"));
process.env.SMART_ROUTER_TEST_PRELOAD = String(process.pid);
process.env.SMART_ROUTER_STATE_DIR = join(directory, "state");
process.env.SMART_ROUTER_CONFIG_DIR = join(directory, "config");
process.env.T3CODE_HOME = join(directory, "t3");
afterAll(() => rmSync(directory, { recursive: true, force: true }));
