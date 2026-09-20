import { expect, test } from "bun:test";
import { normalizeCodexbar } from "../src/quota.ts";

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
