import "./environment.ts";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listCostUsd,
  loadPricing,
  PRICING_CACHE_PATH,
} from "../src/pricing.ts";

const usage = {
  inputTokens: 1_000_000,
  outputTokens: 2_000_000,
  cachedInputTokens: 10_000_000,
  cacheWriteTokens: 4_000_000,
  costUsd: null,
};
const catalog = {
  anthropic: {
    models: {
      "claude-fable-5-2": {
        cost: { input: 8, output: 40, cache_read: 0.2, cache_write: 10 },
      },
    },
  },
  openai: { models: { "gpt-6-luna": { cost: { input: 0.1, output: 0.5 } } } },
  openrouter: {
    models: {
      "vendor/model": { cost: { input: 1, output: 2, cache_read: 0.5 } },
    },
  },
  broken: { models: { model: { cost: { input: "free", output: 1 } } } },
};

test("prices usage at list rates including cache reads and writes", () => {
  expect(
    listCostUsd(
      { harness: "claude", model: "claude-fable-5-2", usage },
      catalog,
    ),
  ).toBe(8 + 80 + 2 + 40);
});

test("prices cache tokens at the input rate when the model lists no cache rates", () => {
  expect(
    listCostUsd({ harness: "codex", model: "gpt-6-luna", usage }, catalog),
  ).toBeCloseTo(0.1 + 1 + 1 + 0.4);
  expect(
    listCostUsd(
      {
        harness: "codex",
        model: "gpt-6-luna",
        usage: { ...usage, cachedInputTokens: null, cacheWriteTokens: null },
      },
      catalog,
    ),
  ).toBeCloseTo(0.1 + 1);
});

test("pi models are priced under the provider named in the model", () => {
  expect(
    listCostUsd(
      { harness: "pi", model: "openrouter/vendor/model", usage },
      catalog,
    ),
  ).toBe(1 + 4 + 5 + 4);
});

test("a session without a price or without usage has no list cost", () => {
  const session = { harness: "claude" as const, model: "claude-fable-5-2" };
  expect(listCostUsd({ ...session, usage: null }, catalog)).toBeNull();
  expect(listCostUsd({ ...session, usage }, null)).toBeNull();
  expect(
    listCostUsd({ harness: "claude", model: "unknown", usage }, catalog),
  ).toBeNull();
  expect(
    listCostUsd({ harness: "pi", model: "bare", usage }, catalog),
  ).toBeNull();
  expect(
    listCostUsd({ harness: "pi", model: "broken/model", usage }, catalog),
  ).toBeNull();
});

test("loads the CodexBar pricing cache and treats a missing or malformed one as no prices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-pricing-"));
  try {
    const path = join(directory, "models-dev-v1.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, catalog: { providers: catalog } }),
    );
    expect(await loadPricing(path)).toEqual(catalog);
    await writeFile(path, JSON.stringify({ version: 1 }));
    expect(await loadPricing(path)).toBeNull();
    await writeFile(path, "not json");
    expect(await loadPricing(path)).toBeNull();
    expect(await loadPricing(join(directory, "missing.json"))).toBeNull();
    expect(PRICING_CACHE_PATH).toContain("codexbar/model-pricing");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the long-context tier prices every token at the over-200k rates where a model has them", () => {
  const tiered = {
    openai: {
      models: {
        "gpt-6.1-sol": {
          cost: {
            input: 2,
            output: 10,
            cache_read: 0.1,
            cache_write: 2.5,
            context_over_200k: {
              input: 4,
              output: 15,
              cache_read: 0.2,
              cache_write: 5,
            },
          },
        },
      },
    },
  };
  const session = { harness: "codex" as const, model: "gpt-6.1-sol", usage };
  expect(listCostUsd(session, tiered)).toBe(2 + 20 + 1 + 10);
  expect(listCostUsd(session, tiered, "longContext")).toBe(4 + 30 + 2 + 20);
  // A model without a long-context tier costs the same on both bounds.
  const flat = { harness: "claude" as const, model: "claude-fable-5-2", usage };
  expect(listCostUsd(flat, catalog, "longContext")).toBe(
    listCostUsd(flat, catalog),
  );
});

test("Claude cache durations and per-model totals retain correct base and upper prices", () => {
  const split = {
    ...usage,
    cacheWrite5mTokens: 1_000_000,
    cacheWrite1hTokens: 3_000_000,
  };
  const session = {
    harness: "claude" as const,
    model: "claude-fable-5-2",
    usage: split,
  };
  expect(listCostUsd(session, catalog)).toBe(8 + 80 + 2 + 10 + 48);
  const models = {
    ...catalog,
    anthropic: {
      models: {
        ...catalog.anthropic.models,
        actual: {
          cost: {
            input: 2,
            output: 10,
            context_over_200k: { input: 4, output: 20 },
          },
        },
      },
    },
  };
  const total = {
    ...split,
    byModel: {
      "claude-fable-5-2": split,
      actual: {
        ...usage,
        inputTokens: 0,
        outputTokens: 1_000_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };
  expect(
    listCostUsd({ ...session, model: "planned", usage: total }, models),
  ).toBe(148 + 10);
  expect(listCostUsd({ ...session, usage: total }, models, "longContext")).toBe(
    148 + 20,
  );
  expect(listCostUsd({ ...session, usage: total }, catalog)).toBeNull();
  expect(
    listCostUsd(
      {
        ...session,
        usage: {
          ...usage,
          byModel: {
            unknown: {
              ...usage,
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        },
      },
      catalog,
    ),
  ).toBe(0);
});

test("upper pricing uses the largest context tier when the legacy long-context field is absent", () => {
  const session = { harness: "claude" as const, model: "haiku", usage };
  const tier = {
    tier: { type: "context", size: 100_000 },
    input: 0.5,
    output: 2.5,
    cache_read: 0.05,
    cache_write: 0.625,
  };
  const models = {
    anthropic: {
      models: {
        haiku: {
          cost: {
            input: 0.1,
            output: 0.5,
            cache_read: 0.01,
            cache_write: 0.125,
            tiers: [
              null,
              { tier: { type: "other", size: 1_000_000 } },
              { ...tier, tier: { type: "context", size: "invalid" } },
              { ...tier, input: "invalid" },
              tier,
              { ...tier, tier: { type: "context", size: 10_000 } },
            ],
          },
        },
      },
    },
  };
  expect(listCostUsd(session, models)).toBe(1.7);
  expect(listCostUsd(session, models, "longContext")).toBe(8.5);
  const legacy = {
    ...models,
    anthropic: {
      models: {
        haiku: {
          cost: {
            ...models.anthropic.models.haiku.cost,
            context_over_200k: { ...tier, input: 1, output: 5 },
          },
        },
      },
    },
  };
  expect(listCostUsd(session, legacy, "longContext")).toBe(14);
});
