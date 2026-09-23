import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { getQuota, normalizeCodexbar, runCodexbar } from "../src/quota.ts";

test("normalizes codexbar usage", () => {
  expect(
    normalizeCodexbar({
      usage: {
        primary: { used_percent: 12 },
        secondary: { used_percent: 34, resets_at: "2026-09-22T00:00:00Z" },
      },
      pace: { secondary: { summary: "on pace" } },
    }),
  ).toEqual({
    weeklyUsedPercent: 34,
    weeklyResetsAt: "2026-09-22T00:00:00Z",
    fiveHourUsedPercent: 12,
    pace: "on pace",
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
  ).toEqual({
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
