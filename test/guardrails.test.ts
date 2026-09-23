import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardrailsFor, loadGuardrails } from "../src/guardrails.ts";

const fixture = `# Guardrails

## codex

Harness rules.

## codex:terra

Model rules.

## claude:opus

Claude model rules.
`;

test("returns matching harness and model guardrails", () => {
  expect(guardrailsFor(fixture, "codex:other")).toBe("Harness rules.");
  expect(guardrailsFor(fixture, "claude:opus")).toBe("Claude model rules.");
  expect(guardrailsFor(fixture, "pi:model")).toBe("");
  expect(guardrailsFor(fixture, "codex:terra")).toBe(
    "Harness rules.\n\nModel rules.",
  );
});

let directory = "";
afterEach(async () => {
  delete process.env.SMART_ROUTER_CONFIG_DIR;
  if (directory) await rm(directory, { recursive: true });
});

test("loads guardrails and returns empty text for a missing file", async () => {
  directory = await mkdtemp(join(tmpdir(), "smart-router-guardrails-"));
  process.env.SMART_ROUTER_CONFIG_DIR = directory;
  expect(await loadGuardrails()).toBe("");
  await writeFile(join(directory, "guardrails.md"), fixture);
  expect(await loadGuardrails()).toBe(fixture);
});
