import { expect, test } from "bun:test";
import { getAdapter } from "../src/harness/index.ts";
import type { EventState } from "../src/events.ts";

const expected =
  "session.started tool.started tool.finished message usage result";
const fixtures = ["claude", "codex", "pi", "codex-failed"] as const;
test.each([...fixtures])("translates %s", async (name) => {
  const harness = name === "codex-failed" ? "codex" : name;
  const state: EventState = {
    handle: "abcdef",
    harness,
    model: "model",
    effort: "low",
    ts: "2026-10-11T00:00:00.000Z",
    text: "done",
  };
  const translate = getAdapter(harness).translateEvents;
  const log = await Bun.file(
    `${import.meta.dir}/fixtures/events/${name}.jsonl`,
  ).text();
  const events = log
    .trim()
    .split("\n")
    .flatMap((line) => translate(line, state));
  const expectedTypes = {
    claude: expected,
    codex: expected,
    pi: "session.started message usage",
    "codex-failed": "session.started error",
  };
  expect(events.map((event) => event.type).join(" ")).toBe(expectedTypes[name]);
});
