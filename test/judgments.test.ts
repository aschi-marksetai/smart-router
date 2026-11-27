import "./environment.ts";
import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import {
  isDifficulty,
  judgmentPick,
  type Judgments,
} from "../src/judgments.ts";
import type { QuotaProvider } from "../src/quota.ts";

// prettier-ignore
const config: Config = {
  ...DEFAULT_CONFIG,
  models: [
    { id: "claude:opus", harness: "claude", model: "opus", efforts: ["high"], tier: 4, taste: true },
    { id: "codex:astra", harness: "codex", model: "astra", efforts: ["high"], tier: 4 },
    { id: "claude:haiku", harness: "claude", model: "haiku", efforts: ["high"], tier: 1 },
    { id: "codex:luna", harness: "codex", model: "luna", efforts: ["high"], tier: 1 },
    { id: "codex:sol", harness: "codex", model: "sol", efforts: ["high"], tier: 3 },
    { id: "codex:custom", harness: "codex", model: "custom", efforts: ["high"] },
  ],
};
const candidates = config.models.map(({ id, harness }) => ({ id, harness }));

function pool(paceGap: number, weeklyUsedPercent = 50): QuotaProvider {
  return {
    weeklyUsedPercent,
    weeklyResetsAt: "soon",
    fiveHourUsedPercent: null,
    pace: "",
    paceGap,
    modelWindows: [],
  };
}

function judged(
  difficulty: Judgments["difficulty"],
  needsTaste = 0,
): Judgments {
  return { difficulty, difficultyProbabilities: {}, needsTaste };
}

test("difficulty sets the tier, and the pick stays at the lowest tier that qualifies", () => {
  const pick = (judgments: Judgments, pools = candidates) =>
    judgmentPick(pools, judgments, config, null).pick;
  // Equal pace weights: config order decides between the two tier-1 models.
  expect(pick(judged("trivial"))).toBe("claude:haiku");
  // Nothing at tier 2, so a bounded task climbs to tier 3.
  expect(pick(judged("bounded"))).toBe("codex:sol");
  expect(pick(judged("hard"))).toBe("codex:sol");
  expect(pick(judged("frontier"))).toBe("claude:opus");
  expect(
    pick(
      judged("frontier"),
      candidates.filter(({ id }) => id === "codex:custom"),
    ),
  ).toBeNull();
});

test("taste above the threshold limits the pick to taste models", () => {
  expect(
    judgmentPick(candidates, judged("trivial", 0.51), config, null).pick,
  ).toBe("claude:opus");
  expect(
    judgmentPick(candidates, judged("trivial", 0.5), config, null).pick,
  ).toBe("claude:haiku");
  const withoutTaste = candidates.filter(({ harness }) => harness === "codex");
  expect(
    judgmentPick(withoutTaste, judged("bounded", 0.9), config, null),
  ).toEqual({ pick: null, limitsRelaxed: false });
});

test("among matching models the pool with more reserve wins, unless the tilt is off", () => {
  const quota = { claude: pool(-30), codex: pool(40) };
  expect(judgmentPick(candidates, judged("trivial"), config, quota).pick).toBe(
    "codex:luna",
  );
  expect(judgmentPick(candidates, judged("frontier"), config, quota).pick).toBe(
    "codex:astra",
  );
  const untilted = { ...config, rules: { ...config.rules, paceTilt: 0 } };
  expect(
    judgmentPick(candidates, judged("trivial"), untilted, quota).pick,
  ).toBe("claude:haiku");
});

test("recognises the four difficulty labels", () => {
  expect(["trivial", "bounded", "hard", "frontier"].every(isDifficulty)).toBe(
    true,
  );
  expect(isDifficulty("impossible")).toBe(false);
});

test("a full pool never erases the tier or taste requirement", () => {
  // Claude holds the only taste models and is over its cutoff; Codex has room.
  const quota = { claude: pool(-30, 99), codex: pool(40, 10) };
  // Frontier work that needs taste: quota is relaxed inside the qualifying set, not replaced by a tier-1 model.
  expect(
    judgmentPick(candidates, judged("frontier", 0.9), config, quota),
  ).toEqual({ pick: "claude:opus", limitsRelaxed: true });
  // Where a qualifying model is under its cutoff, it is used and nothing is relaxed.
  expect(judgmentPick(candidates, judged("frontier"), config, quota)).toEqual({
    pick: "codex:astra",
    limitsRelaxed: false,
  });
  // Both pools over: the least-used pool among the qualifying models wins, as in a normal route.
  const bothOver = { claude: pool(0, 99), codex: pool(0, 97) };
  expect(
    judgmentPick(candidates, judged("frontier"), config, bothOver),
  ).toEqual({ pick: "codex:astra", limitsRelaxed: true });
});
