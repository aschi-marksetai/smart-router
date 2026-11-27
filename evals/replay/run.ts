#!/usr/bin/env bun
// Dry-run replay of recorded routing decisions. Usage:
//   smart-router stats --days 30 --export sessions.jsonl
//   bun evals/replay/run.ts sessions.jsonl [--reask] [--json] [--seed <n>]
import { readFile } from "node:fs/promises";
import { loadConfig } from "../../src/config.ts";
import { loadDotEnv } from "../../src/env.ts";
import { configDir } from "../../src/paths.ts";
import { loadPricing } from "../../src/pricing.ts";
import {
  defaultRouteDeps,
  readPreferencesSnapshot,
  route,
} from "../../src/route.ts";
import { readSessionPrompt } from "../../src/sessions.ts";
import {
  DEFAULT_SEED,
  formatReplay,
  parseReplayLines,
  replay,
  type ReplayLine,
} from "./replay.ts";

const [exportPath, ...flags] = process.argv.slice(2);
if (!exportPath || exportPath.startsWith("--")) {
  console.error(
    "usage: bun evals/replay/run.ts <export.jsonl> [--reask] [--json] [--seed <n>]",
  );
  process.exit(1);
}
const seedFlag = flags.indexOf("--seed");
const seed = seedFlag >= 0 ? Number(flags[seedFlag + 1]) : DEFAULT_SEED;

// Routes the saved prompt again with the saved hint, quota snapshot, experiment arms and the
// preferences snapshot the decision was made with. Model availability is today's.
async function reask(line: ReplayLine): Promise<string | null> {
  const recorded = line.route;
  if (!recorded || recorded.kind === "pinned") return null;
  const prompt = await readSessionPrompt(line.handle).catch(() => null);
  if (prompt === null) return null;
  const config = await loadConfig();
  const arms = Object.entries(recorded.experiments ?? {});
  config.rules.experiments = Object.fromEntries(
    arms.map(([name, arm]) => [name, arm === "on" ? 1 : 0]),
  );
  const savedQuota = recorded.inputs.quota;
  const preferencesSha256 = recorded.inputs.preferencesSha256;
  const savedPreferences = preferencesSha256
    ? await readPreferencesSnapshot(preferencesSha256)
    : null;
  if (savedPreferences === null)
    console.error(
      `warning: ${line.handle} has no saved preferences snapshot (${preferencesSha256}); re-asked with today's preferences.md`,
    );
  const defaults = defaultRouteDeps(config);
  const result = await route(
    prompt,
    { cwd: line.cwd, hint: recorded.inputs.hint ?? undefined },
    {
      ...defaults,
      preferences: savedPreferences ?? defaults.preferences,
      // A replay must not add today's preferences to the recorded snapshots.
      savePreferences: async () => {},
      getQuota: async () => ({
        quota: savedQuota ?? { error: "quota disabled" },
        ageMs: 0,
      }),
    },
  );
  return "pick" in result && result.kind === "routed" ? result.pick : null;
}

await loadDotEnv(configDir());
const report = await replay(
  parseReplayLines(await readFile(exportPath, "utf8")),
  await loadPricing(),
  { ask: flags.includes("--reask") ? reask : undefined, seed },
);
process.stdout.write(
  flags.includes("--json")
    ? `${JSON.stringify(report)}\n`
    : formatReplay(report),
);
