import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditLine, readAuditLines } from "../src/audit-log.ts";

const STATE_DIRECTORY_ENV = "SMART_ROUTER_STATE_DIR";
let directory: string;
let previousState: string | undefined;

beforeEach(async () => {
  previousState = process.env[STATE_DIRECTORY_ENV];
  directory = await mkdtemp(join(tmpdir(), "smart-router-audit-"));
  process.env[STATE_DIRECTORY_ENV] = join(directory, "state");
});

afterEach(async () => {
  if (previousState === undefined) delete process.env[STATE_DIRECTORY_ENV];
  else process.env[STATE_DIRECTORY_ENV] = previousState;
  await rm(directory, { recursive: true, force: true });
});

test("appends one JSON line per entry and reads them back, skipping damaged lines", async () => {
  expect(await readAuditLines("log.jsonl")).toEqual([]);
  await appendAuditLine("log.jsonl", { decision: "allow" });
  await appendAuditLine("log.jsonl", { decision: "deny" });
  await writeFile(
    join(directory, "state", "log.jsonl"),
    '{"decision":"allow"}\nnot json\n[1]\n{"decision":"deny"}\n',
  );
  expect(await readAuditLines("log.jsonl")).toEqual([
    { decision: "allow" },
    { decision: "deny" },
  ]);
});

test("an unreadable log is an error, not an empty one", async () => {
  await mkdir(join(directory, "state", "log.jsonl"), { recursive: true });
  await expect(readAuditLines("log.jsonl")).rejects.toThrow();
});
