import { expect, test } from "bun:test";
import { guardrailsFor } from "../src/guardrails.ts";

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
