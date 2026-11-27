import { restoreEnvironmentVariable } from "./environment.ts";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestT3Usage, transcriptUsage } from "../src/t3-usage.ts";
import { addUsage, type Session } from "../src/sessions.ts";
import { usageFrom } from "../src/harness/types.ts";

const claudeFixture = [
  {
    type: "assistant",
    message: {
      model: "actual",
      id: "one",
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 3,
      },
    },
  },
  {
    type: "assistant",
    message: {
      model: "actual",
      id: "one",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 3,
      },
    },
  },
  {
    type: "assistant",
    message: {
      model: "actual",
      id: "two",
      usage: {
        input_tokens: 2,
        output_tokens: 4,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0,
      },
    },
  },
];
const codexFixture = [
  { type: "turn_context", payload: { model: "actual" } },
  {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 20,
          output_tokens: 5,
          cached_input_tokens: 10,
        },
      },
    },
  },
  {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 100,
          output_tokens: 20,
          cached_input_tokens: 40,
        },
      },
    },
  },
];
const jsonl = (values: unknown[]) =>
  values.map((value) => JSON.stringify(value)).join("\n") + '\n{"incomplete"';

test("Claude dedupes streamed message ids; Codex reads the last cumulative token count", () => {
  expect(transcriptUsage(jsonl(claudeFixture), "claude")).toMatchObject({
    inputTokens: 12,
    outputTokens: 9,
    cachedInputTokens: 21,
    cacheWriteTokens: 3,
    costUsd: null,
  });
  expect(transcriptUsage(jsonl(codexFixture), "codex")).toMatchObject({
    inputTokens: 60,
    outputTokens: 20,
    cachedInputTokens: 40,
    cacheWriteTokens: null,
    costUsd: null,
  });
  expect(
    transcriptUsage(
      jsonl([{}, { type: "assistant", message: { id: "empty" } }]),
      "claude",
    ),
  ).toBeNull();
  expect(
    transcriptUsage(
      jsonl([{}, { type: "event_msg", payload: { type: "token_count" } }]),
      "codex",
    ),
  ).toBeNull();
  const unknownCache = {
    type: "assistant",
    message: { id: "three", usage: { input_tokens: 1, output_tokens: 1 } },
  };
  expect(
    transcriptUsage(jsonl([...claudeFixture, unknownCache]), "claude")
      ?.cachedInputTokens,
  ).toBeNull();
});

const previous = { ...process.env };
let directory = "";
afterEach(async () => {
  for (const name of ["T3CODE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    restoreEnvironmentVariable(name, previous[name]);
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("same-revision ingestion recovers from SQLite and pricing failures, replaces totals and rejects ambiguity", async () => {
  directory = await mkdtemp(join(tmpdir(), "router-usage-"));
  process.env.T3CODE_HOME = directory;
  process.env.CODEX_HOME = directory;
  process.env.CLAUDE_CONFIG_DIR = directory;
  const session: Session = {
    handle: "abcdef",
    owner: "test",
    harness: "claude",
    model: "unknown",
    effort: "high",
    cwd: directory,
    sessionId: "",
    createdAt: new Date().toISOString(),
    promptPreview: "test",
    runner: "t3",
    t3ThreadId: "test",
    t3UpdatedAt: "retry-revision",
    status: "done",
  };
  await ingestT3Usage(session);
  expect(session.usage).toBeUndefined();
  expect(session.t3UsageKey).toBeUndefined();
  await mkdir(join(directory, "userdata"));
  const database = new Database(join(directory, "userdata", "statev2.sqlite"));
  database.run(
    "CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT, last_run_ordinal INTEGER)",
  );
  const setMapping = (nativeId: string, driver = "claudeAgent") => {
    database.run("DELETE FROM orchestration_v2_projection_provider_threads");
    database.run(
      "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, 1)",
      ["test", JSON.stringify({ nativeThreadRef: { driver, nativeId } })],
    );
  };
  try {
    await ingestT3Usage(session);
    setMapping("../unsafe");
    await ingestT3Usage(session);
    expect(session.usage).toBeUndefined();
    setMapping("native");
    await ingestT3Usage(session);
    await mkdir(join(directory, "projects", "project"), { recursive: true });
    const transcript = join(directory, "projects", "project", "native.jsonl");
    await writeFile(transcript, "{}");
    await ingestT3Usage(session);
    expect(session.usage).toBeUndefined();
    await writeFile(transcript, jsonl(claudeFixture));
    await ingestT3Usage(session);
    expect(session.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 9,
      costSource: "listPrice",
    });
    const subagentDirectory = join(
      directory,
      "projects",
      "project",
      "native",
      "subagents",
      "nested",
    );
    await mkdir(subagentDirectory, { recursive: true });
    const subagent = join(subagentDirectory, "agent.jsonl");
    await writeFile(
      subagent,
      jsonl([
        claudeFixture[0],
        {
          type: "assistant",
          message: {
            id: "child",
            model: "child-model",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      ]),
    );
    const prices = {
      anthropic: {
        models: {
          actual: { cost: { input: 2, output: 10 } },
          "child-model": { cost: { input: 1, output: 5 } },
        },
      },
    };
    await ingestT3Usage(session, async () => null);
    expect(session.usage?.costUsd).toBeNull();
    expect(session.t3UsageKey).toBeUndefined();
    await ingestT3Usage(session, async () => prices);
    expect(session.t3UsageKey).toBe("retry-revision:");
    session.t3UpdatedAt = undefined;

    expect(session.usage).toMatchObject({
      inputTokens: 22,
      outputTokens: 11,
      costSource: "listPrice",
    });
    expect(session.usage?.byModel?.["child-model"]?.inputTokens).toBe(10);
    const priced = session.usage?.costUsd;
    expect(priced).toBeGreaterThan(0);
    await ingestT3Usage(session, async () => null);
    expect(session.usage?.costUsd).toBe(priced);
    await ingestT3Usage(session, async () => ({
      anthropic: { models: { actual: prices.anthropic.models.actual } },
    }));
    expect(session.usage?.costUsd).toBeNull();
    await rm(subagent);
    await ingestT3Usage(session);
    const first = structuredClone(session.usage);
    await ingestT3Usage(session);
    expect(session.usage).toEqual(first);
    await writeFile(
      transcript,
      jsonl([
        ...claudeFixture,
        {
          type: "assistant",
          message: {
            id: "later",
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ]),
    );
    await ingestT3Usage(session);
    expect(session.usage?.outputTokens).toBe(11);
    session.status = "running";
    await ingestT3Usage(session);
    session.status = "done";
    session.harness = "pi";
    await ingestT3Usage(session);
    session.harness = "codex";
    setMapping("native", "codex");
    await mkdir(join(directory, "sessions", "2026", "11", "27"), {
      recursive: true,
    });
    await writeFile(
      join(
        directory,
        "sessions",
        "2026",
        "11",
        "27",
        "rollout-test-native.jsonl",
      ),
      jsonl(codexFixture),
    );
    await ingestT3Usage(session);
    expect(session.usage).toMatchObject({ inputTokens: 60 });
    await mkdir(join(directory, "archived_sessions"));
    const rollout = join(
      directory,
      "sessions",
      "2026",
      "11",
      "27",
      "rollout-test-native.jsonl",
    );
    const archived = join(
      directory,
      "archived_sessions",
      "rollout-test-native.jsonl",
    );
    await writeFile(archived, jsonl(codexFixture));
    session.usage = undefined;
    await ingestT3Usage(session);
    expect(session.usage).toBeUndefined();
    await rm(rollout);
    await ingestT3Usage(session);
    expect(session.usage).toMatchObject({ inputTokens: 60 });
    await writeFile(
      archived + ".zst",
      Bun.zstdCompressSync(jsonl(codexFixture)),
    );
    await rm(archived);
    session.t3UpdatedAt = "revision-1";
    await ingestT3Usage(session, async () => ({
      openai: { models: { actual: { cost: { input: 2, output: 10 } } } },
    }));
    expect(session.usage).toMatchObject({ inputTokens: 60 });
    await writeFile(archived, jsonl(codexFixture));
    await ingestT3Usage(session, async () => ({
      openai: { models: { actual: { cost: { input: 2, output: 10 } } } },
    }));
    expect(session.usage).toMatchObject({ inputTokens: 60 });
    session.t3UpdatedAt = "revision-2";
    await ingestT3Usage(session, async () => ({
      openai: { models: { actual: { cost: { input: 2, output: 10 } } } },
    }));
    expect(session.usage).toBeUndefined();
    expect(session.t3UsageKey).toBe("revision-2:");
    await rm(archived);
    session.t3UpdatedAt = "revision-3";
    await ingestT3Usage(session, async () => ({
      openai: { models: { actual: { cost: { input: 2, output: 10 } } } },
    }));
    expect(session.usage).toMatchObject({ inputTokens: 60 });
    database.run(
      "INSERT INTO orchestration_v2_projection_provider_threads VALUES ('test', '{}', 2)",
    );
    session.t3UpdatedAt = "revision-4";
    await ingestT3Usage(session, async () => ({
      openai: { models: { actual: { cost: { input: 2, output: 10 } } } },
    }));
    expect(session.usage).toBeUndefined();
    expect(session.t3UsageKey).toBe("revision-4:");
  } finally {
    database.close();
  }
});

test("native Claude parsing preserves and accumulates cache duration splits", () => {
  const first = usageFrom({
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 30,
    cache_creation: {
      ephemeral_5m_input_tokens: 10,
      ephemeral_1h_input_tokens: 20,
    },
  })!;
  expect(first).toMatchObject({
    cacheWrite5mTokens: 10,
    cacheWrite1hTokens: 20,
  });
  expect(addUsage(first, first)).toMatchObject({
    cacheWriteTokens: 60,
    cacheWrite5mTokens: 20,
    cacheWrite1hTokens: 40,
  });
  expect(
    addUsage(first, usageFrom({ input_tokens: 1, output_tokens: 1 })),
  ).not.toHaveProperty("cacheWrite1hTokens");
});

test("transcript models are authoritative and Codex model switches split cumulative deltas", () => {
  const output = jsonl([
    { type: "turn_context", payload: { model: "first" } },
    codexFixture[1],
    { type: "turn_context", payload: { model: "second" } },
    codexFixture[2],
  ]);
  expect(transcriptUsage(output, "codex")?.byModel).toMatchObject({
    first: { inputTokens: 10, outputTokens: 5 },
    second: { inputTokens: 50, outputTokens: 15 },
  });
  expect(
    transcriptUsage(jsonl([...claudeFixture, claudeFixture[0]]), "claude")
      ?.outputTokens,
  ).toBe(9);
});
