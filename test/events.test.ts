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
  const usage = events.find((event) => event.type === "usage");
  const result = events.find((event) => event.type === "result");
  // prettier-ignore
  const cacheFigures = { claude: { cachedInputTokens: 6, cacheWriteTokens: 2, cacheHitRatio: 6 / 11 }, codex: { cachedInputTokens: 4, cacheWriteTokens: 2, cacheHitRatio: 4 / 7 }, pi: { cachedInputTokens: null, cacheWriteTokens: null }, "codex-failed": {} };
  if (usage) expect(usage).toMatchObject(cacheFigures[name]);
  if (result?.type === "result") {
    expect(result.usage).toEqual(
      getAdapter(harness).parseSpawnOutput(log).usage,
    );
    expect(result.usage).not.toHaveProperty("cacheHitRatio");
  }
  if (name === "pi") expect(usage).not.toHaveProperty("cacheHitRatio");
  expect(events.map((event) => event.type).join(" ")).toBe(expectedTypes[name]);
});

// prettier-ignore
test.each([0, null, "unknown"])("omits undefined ratio: %s", (cachedInputTokens) => {
  const state: EventState = { handle: "abcdef", harness: "codex", model: "model", effort: "low", ts: "now" };
  const [usage] = getAdapter("codex").translateEvents({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 1, cached_input_tokens: cachedInputTokens } }, state);
  expect(usage).not.toHaveProperty("cacheHitRatio");
});
