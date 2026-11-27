import { restoreEnvironmentVariable } from "./environment.ts";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  codexbarCostUsd,
  getQuota,
  GUARD_QUOTA_MAX_AGE_MS,
  readCachedQuota,
  ROUTE_QUOTA_MAX_AGE_MS,
  MODEL_WINDOW_MODELS,
  normalizeCodexbar,
  runCodexbar,
} from "../src/quota.ts";
import claudeUsage from "./fixtures/codexbar/claude.json";
import codexUsage from "./fixtures/codexbar/codex.json";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

test("normalizes codexbar usage", () => {
  expect(
    normalizeCodexbar({
      usage: {
        primary: { used_percent: 12 },
        secondary: { used_percent: 34, resets_at: "2026-09-22T00:00:00Z" },
      },
      pace: { secondary: { summary: "on pace" } },
    }),
  ).toMatchObject({
    weeklyUsedPercent: 34,
    weeklyResetsAt: "2026-09-22T00:00:00Z",
    fiveHourUsedPercent: 12,
    pace: "on pace",
    modelWindows: [],
  });
});

test("normalizes Codex usage when the primary window is absent", () => {
  expect(
    normalizeCodexbar({
      usage: {
        primary: null,
        secondary: { usedPercent: 34, resetsAt: "2026-09-22T00:00:00Z" },
      },
      pace: { secondary: { summary: "on pace" } },
    }),
  ).toMatchObject({
    weeklyUsedPercent: 34,
    weeklyResetsAt: "2026-09-22T00:00:00Z",
    fiveHourUsedPercent: null,
    pace: "on pace",
  });
});

test("rejects incomplete codexbar usage", () => {
  expect(
    normalizeCodexbar({ usage: { secondary: {} }, pace: { secondary: {} } }),
  ).toBeNull();
});

test("runs the default codexbar command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-codexbar-"));
  const previousPath = process.env.PATH;
  const binary = join(directory, "codexbar");
  try {
    await writeFile(
      binary,
      '#!/bin/sh\necho \'{"usage":{"secondary":{"usedPercent":4,"resetsAt":"soon"}},"pace":{"secondary":{"summary":"ok"}}}\'\n',
    );
    await chmod(binary, 0o755);
    process.env.PATH = `${directory}:${previousPath}`;
    expect((await runCodexbar("codex"))?.weeklyUsedPercent).toBe(4);
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs codexbar and treats command or JSON failures as unavailable", async () => {
  const output = JSON.stringify({
    usage: { secondary: { usedPercent: 30, resetsAt: "tomorrow" } },
    pace: { secondary: { summary: "ok" } },
  });
  expect(
    (
      await runCodexbar("codex", async (provider) => {
        expect(provider).toBe("codex");
        return output;
      })
    )?.weeklyUsedPercent,
  ).toBe(30);
  expect(await runCodexbar("codex", async () => "invalid")).toBeNull();
});

test("returns disabled, missing, and configured quota results", async () => {
  const disabled = {
    ...DEFAULT_CONFIG,
    quota: { ...DEFAULT_CONFIG.quota, enabled: false },
  };
  expect(await getQuota(disabled)).toEqual({ error: "quota disabled" });
  expect(await getQuota(DEFAULT_CONFIG, { which: () => null })).toEqual({
    error: "codexbar not installed",
  });
  const result = await getQuota(DEFAULT_CONFIG, {
    which: () => "/bin/codexbar",
    runCodexbar: async () => null,
  });
  expect(result).toEqual({ claude: null, codex: null });
});

test("reads pace gaps and the Fable window from real CodexBar output", () => {
  const now = Date.parse("2026-11-27T08:26:46Z");
  const claude = normalizeCodexbar(claudeUsage, now);
  // CodexBar's own expected 71% minus used 55%.
  expect(claude).toMatchObject({ weeklyUsedPercent: 55, paceGap: 16 });
  expect(claude?.modelWindows).toEqual([
    {
      label: "Fable only",
      usedPercent: 32,
      resetsAt: "2026-11-29T09:59:59Z",
      // 5 days 22.4 hours into the 7-day window is 70.5% expected, minus 32% used.
      paceGap: 38.5,
      models: MODEL_WINDOW_MODELS["Fable only"],
    },
  ]);
  expect(
    new Bun.Glob(MODEL_WINDOW_MODELS["Fable only"][0]).match(
      "claude:claude-fable-5-2",
    ),
  ).toBe(true);
  expect(normalizeCodexbar(codexUsage, now)).toMatchObject({
    weeklyUsedPercent: 2,
    paceGap: 2,
    modelWindows: [],
  });
});

test("computes the pace gap from elapsed time when CodexBar reports no expected percent", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const usage = (secondary: object, extraRateWindows?: unknown) => ({
    usage: { secondary, extraRateWindows },
    pace: { secondary: { summary: "old codexbar" } },
  });
  const halfwayReset = new Date(now + WEEK_MS / 2).toISOString();
  // Half the 7-day window has passed, so 50% is expected.
  expect(
    normalizeCodexbar(usage({ usedPercent: 80, resetsAt: halfwayReset }), now)
      ?.paceGap,
  ).toBe(-30);
  // A window that reports its own length uses it: one day into a two-day window.
  expect(
    normalizeCodexbar(
      usage({
        usedPercent: 10,
        resetsAt: new Date(now + WEEK_MS / 7).toISOString(),
        windowMinutes: 2 * 24 * 60,
      }),
      now,
    )?.paceGap,
  ).toBe(40);
  // Clamped: a reset further away than one window means nothing is expected yet.
  expect(
    normalizeCodexbar(
      usage({
        usedPercent: 5,
        resetsAt: new Date(now + 2 * WEEK_MS).toISOString(),
      }),
      now,
    )?.paceGap,
  ).toBe(-5);
  // An unreadable reset time counts as on pace.
  expect(
    normalizeCodexbar(usage({ usedPercent: 80, resetsAt: "soon" }), now)
      ?.paceGap,
  ).toBe(0);
  const windows = normalizeCodexbar(
    usage({ usedPercent: 1, resetsAt: halfwayReset }, [
      {
        title: "Unknown tier",
        window: { used_percent: 20, resets_at: halfwayReset },
      },
      { title: "Fable only", window: {} },
      { title: 7, window: { usedPercent: 1, resetsAt: halfwayReset } },
      "junk",
    ]),
    now,
  )?.modelWindows;
  expect(windows).toEqual([
    {
      label: "Unknown tier",
      usedPercent: 20,
      resetsAt: halfwayReset,
      paceGap: 30,
      models: [],
    },
  ]);
});

test("reads CodexBar's total list cost and treats failures as unavailable", async () => {
  expect(
    await codexbarCostUsd("claude", 7, async (provider, days) => {
      expect([provider, days]).toEqual(["claude", 7]);
      return JSON.stringify([{ totals: { totalCost: 12.5 } }]);
    }),
  ).toBe(12.5);
  expect(
    await codexbarCostUsd("codex", 7, async () =>
      JSON.stringify({ totals: { totalCost: 3 } }),
    ),
  ).toBe(3);
  for (const output of [
    "invalid",
    "[]",
    '[{"totals":{}}]',
    '[{"totals":null}]',
  ])
    expect(await codexbarCostUsd("codex", 7, async () => output)).toBeNull();
});

test("runs the default codexbar cost command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-codexbar-"));
  const previousPath = process.env.PATH;
  const binary = join(directory, "codexbar");
  try {
    await writeFile(
      binary,
      '#!/bin/sh\n[ "$1" = cost ] && echo \'[{"totals":{"totalCost":9}}]\'\n',
    );
    await chmod(binary, 0o755);
    process.env.PATH = `${directory}:${previousPath}`;
    expect(await codexbarCostUsd("codex", 3)).toBe(9);
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shared quota cache serves a recent reading and refetches an old one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-quota-cache-"));
  const previousState = process.env.SMART_ROUTER_STATE_DIR;
  process.env.SMART_ROUTER_STATE_DIR = join(directory, "state");
  let fetches = 0;
  let now = 1_000_000;
  const pool = normalizeCodexbar(codexUsage, now);
  const read = (maxAgeMs: number, quota: object = { codex: pool }) =>
    readCachedQuota(DEFAULT_CONFIG, maxAgeMs, {
      now: () => now,
      getQuota: async () => {
        fetches += 1;
        return quota;
      },
    });
  try {
    expect(await read(ROUTE_QUOTA_MAX_AGE_MS)).toEqual({
      quota: { codex: pool },
      ageMs: 0,
    });
    now += 45_000;
    // Within a minute: served from the cache with its age.
    expect(await read(ROUTE_QUOTA_MAX_AGE_MS)).toEqual({
      quota: { codex: pool },
      ageMs: 45_000,
    });
    expect(fetches).toBe(1);
    now += 30_000;
    // 75 s old: too old for a route, still fine for the guard.
    expect((await read(GUARD_QUOTA_MAX_AGE_MS)).ageMs).toBe(75_000);
    expect((await read(ROUTE_QUOTA_MAX_AGE_MS)).ageMs).toBe(0);
    expect(fetches).toBe(2);
    // A clock that went backwards does not serve a reading "from the future".
    now -= 10_000;
    expect((await read(ROUTE_QUOTA_MAX_AGE_MS)).ageMs).toBe(0);
    expect(fetches).toBe(3);
  } finally {
    restoreEnvironmentVariable("SMART_ROUTER_STATE_DIR", previousState);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the quota cache never stores an error or a partial reading, and ignores a damaged file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-quota-cache-"));
  const previousState = process.env.SMART_ROUTER_STATE_DIR;
  process.env.SMART_ROUTER_STATE_DIR = directory;
  const cachePath = join(directory, "quota-cache.json");
  const pool = normalizeCodexbar(codexUsage, 0);
  let fetches = 0;
  const read = (quota: object) =>
    readCachedQuota(DEFAULT_CONFIG, ROUTE_QUOTA_MAX_AGE_MS, {
      now: () => 5_000,
      getQuota: async () => {
        fetches += 1;
        return quota;
      },
    });
  try {
    for (const unusable of [
      { error: "codexbar not installed" },
      { claude: null, codex: pool },
    ]) {
      expect(await read(unusable)).toEqual({ quota: unusable, ageMs: 0 });
      expect(await Bun.file(cachePath).exists()).toBe(false);
    }
    for (const damaged of [
      "not json",
      "[]",
      '{"fetchedAt":"now","quota":{}}',
      '{"fetchedAt":4000}',
    ]) {
      await writeFile(cachePath, damaged);
      expect((await read({ codex: pool })).ageMs).toBe(0);
    }
    expect(fetches).toBe(6);
    // The default dependencies read the real clock and codexbar; disabled quota needs neither.
    expect(
      await readCachedQuota(
        {
          ...DEFAULT_CONFIG,
          quota: { ...DEFAULT_CONFIG.quota, enabled: false },
        },
        0,
      ),
    ).toEqual({ quota: { error: "quota disabled" }, ageMs: 0 });
  } finally {
    restoreEnvironmentVariable("SMART_ROUTER_STATE_DIR", previousState);
    await rm(directory, { recursive: true, force: true });
  }
});

test("turning quota off takes effect at once, even with a fresh reading in the cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smart-router-quota-cache-"));
  const previousState = process.env.SMART_ROUTER_STATE_DIR;
  process.env.SMART_ROUTER_STATE_DIR = directory;
  const pool = normalizeCodexbar(codexUsage, 0);
  const deps = { now: () => 1_000, getQuota: async () => ({ codex: pool }) };
  try {
    expect(
      (await readCachedQuota(DEFAULT_CONFIG, GUARD_QUOTA_MAX_AGE_MS, deps))
        .quota,
    ).toEqual({ codex: pool });
    const disabled = {
      ...DEFAULT_CONFIG,
      quota: { ...DEFAULT_CONFIG.quota, enabled: false },
    };
    // The cached reading is seconds old, but a disabled quota must not be served from it.
    expect(
      await readCachedQuota(disabled, GUARD_QUOTA_MAX_AGE_MS, {
        ...deps,
        getQuota: async () => {
          throw new Error("codexbar must not run when quota is disabled");
        },
      }),
    ).toEqual({ quota: { error: "quota disabled" }, ageMs: 0 });
  } finally {
    restoreEnvironmentVariable("SMART_ROUTER_STATE_DIR", previousState);
    await rm(directory, { recursive: true, force: true });
  }
});
