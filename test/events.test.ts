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
  const cacheFigures = { claude: { inputTokens: 3, cachedInputTokens: 6, cacheWriteTokens: 2, cacheHitRatio: 6 / 11 }, codex: { inputTokens: 3, cachedInputTokens: 4, cacheWriteTokens: 2, cacheHitRatio: 4 / 9 }, pi: { cachedInputTokens: null, cacheWriteTokens: null }, "codex-failed": {} };
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

test("session.started carries the route summary, and omits it for an older record", () => {
  const route = {
    version: 2,
    kind: "routed",
    pick: "codex:gpt-6.1-sol@high",
    reason: "Jev: codex:gpt-6.1-sol 0.80",
    warnings: ["a warning"],
    tiltChanged: true,
    lowConfidence: false,
    probabilities: { "codex:gpt-6.1-sol": 0.8 },
    inputs: { hint: "not for the event stream" },
  } as unknown as EventState["route"];
  const started = (stateRoute: EventState["route"]) =>
    getAdapter("codex").translateEvents(
      { type: "thread.started", thread_id: "thread" },
      // prettier-ignore
      { handle: "abcdef", harness: "codex", model: "gpt-6.1-sol", effort: "high", ts: "now", route: stateRoute },
    )[0];
  expect(started(route)).toMatchObject({
    type: "session.started",
    route: {
      kind: "routed",
      pick: "codex:gpt-6.1-sol@high",
      reason: "Jev: codex:gpt-6.1-sol 0.80",
      warnings: ["a warning"],
      tiltChanged: true,
      lowConfidence: false,
    },
  });
  // Only the summary: the full record stays on the session.
  expect(Object.keys((started(route) as { route: object }).route)).toHaveLength(
    6,
  );
  for (const older of [null, undefined, { pick: "x" } as EventState["route"]])
    expect(started(older)).not.toHaveProperty("route");
});
