import { $ } from "bun";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, HarnessName } from "./config.ts";
import { stateDir } from "./paths.ts";

const CODEXBAR_BINARY = "codexbar";
const QUOTA_CACHE_FILE = "quota-cache.json";
// Routes and pins accept a reading this old; a spawn burst then shares one codexbar call.
export const ROUTE_QUOTA_MAX_AGE_MS = 60_000;
// The native-subagent guard runs on every subagent call, so it accepts an older reading.
export const GUARD_QUOTA_MAX_AGE_MS = 5 * 60_000;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const MILLISECONDS_PER_MINUTE = 60_000;
const FULL_PERCENT = 100;
const PACE_GAP_DECIMALS = 10;
// Labels of the model-specific windows CodexBar reports, mapped to the model ids each one meters.
export const MODEL_WINDOW_MODELS: Record<string, string[]> = {
  "Fable only": ["claude:*fable*"],
};

export type ModelWindow = {
  label: string;
  usedPercent: number;
  resetsAt: string;
  // Expected minus used percent: positive is reserve, negative is over pace.
  paceGap: number;
  models: string[];
};
export type QuotaProvider = {
  weeklyUsedPercent: number;
  weeklyResetsAt: string;
  fiveHourUsedPercent: number | null;
  pace: string;
  paceGap: number;
  modelWindows: ModelWindow[];
};
export type QuotaSnapshot = Partial<Record<HarnessName, QuotaProvider | null>>;
export type QuotaError = { error: "codexbar not installed" | "quota disabled" };
export type QuotaResult = QuotaSnapshot | QuotaError;
export type QuotaReading = { quota: QuotaResult; ageMs: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function valueAt(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function roundedGap(gap: number): number {
  return Math.round(gap * PACE_GAP_DECIMALS) / PACE_GAP_DECIMALS;
}

// Pace gap from the share of the window that has elapsed; 0 (on pace) when the reset time is unreadable.
function elapsedPaceGap(
  usedPercent: number,
  resetsAt: string,
  windowMinutes: unknown,
  now: number,
): number {
  const resetTime = Date.parse(resetsAt);
  if (!Number.isFinite(resetTime)) return 0;
  const windowMilliseconds =
    (typeof windowMinutes === "number" && windowMinutes > 0
      ? windowMinutes
      : WEEKLY_WINDOW_MINUTES) * MILLISECONDS_PER_MINUTE;
  const elapsedFraction = 1 - (resetTime - now) / windowMilliseconds;
  const expectedPercent = Math.min(
    FULL_PERCENT,
    Math.max(0, elapsedFraction * FULL_PERCENT),
  );
  return roundedGap(expectedPercent - usedPercent);
}

function modelWindow(entry: unknown, now: number): ModelWindow | null {
  if (!isRecord(entry) || !isRecord(entry.window)) return null;
  const label = entry.title;
  const usedPercent = valueAt(entry.window, "usedPercent", "used_percent");
  const resetsAt = valueAt(entry.window, "resetsAt", "resets_at");
  if (
    typeof label !== "string" ||
    typeof usedPercent !== "number" ||
    typeof resetsAt !== "string"
  )
    return null;
  return {
    label,
    usedPercent,
    resetsAt,
    paceGap: elapsedPaceGap(
      usedPercent,
      resetsAt,
      entry.window.windowMinutes,
      now,
    ),
    models: MODEL_WINDOW_MODELS[label] ?? [],
  };
}

export function normalizeCodexbar(
  payload: unknown,
  now: number = Date.now(),
): QuotaProvider | null {
  const providerPayload = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(providerPayload)) return null;
  const usage = providerPayload.usage;
  const pace = providerPayload.pace;
  if (!isRecord(usage) || !isRecord(pace)) return null;
  const primary = usage.primary;
  const secondary = usage.secondary;
  const secondaryPace = pace.secondary;
  if (!isRecord(secondary) || !isRecord(secondaryPace)) return null;
  const weeklyUsedPercent = valueAt(secondary, "usedPercent", "used_percent");
  const weeklyResetsAt = valueAt(secondary, "resetsAt", "resets_at");
  const fiveHourUsedPercent = isRecord(primary)
    ? valueAt(primary, "usedPercent", "used_percent")
    : null;
  const summary = valueAt(secondaryPace, "summary");
  if (
    typeof weeklyUsedPercent !== "number" ||
    typeof weeklyResetsAt !== "string" ||
    (fiveHourUsedPercent !== null && typeof fiveHourUsedPercent !== "number") ||
    typeof summary !== "string"
  )
    return null;
  const expectedUsedPercent = secondaryPace.expectedUsedPercent;
  const extraRateWindows = Array.isArray(usage.extraRateWindows)
    ? usage.extraRateWindows
    : [];
  return {
    weeklyUsedPercent,
    weeklyResetsAt,
    fiveHourUsedPercent,
    pace: summary,
    paceGap:
      typeof expectedUsedPercent === "number"
        ? roundedGap(expectedUsedPercent - weeklyUsedPercent)
        : elapsedPaceGap(
            weeklyUsedPercent,
            weeklyResetsAt,
            secondary.windowMinutes,
            now,
          ),
    modelWindows: extraRateWindows.flatMap((entry) => {
      const window = modelWindow(entry, now);
      return window ? [window] : [];
    }),
  };
}

export async function runCodexbar(
  provider: string,
  runCommand: (provider: string) => Promise<string> = async (name) =>
    (await $`codexbar usage --format json --provider ${name}`.quiet()).text(),
): Promise<QuotaProvider | null> {
  try {
    return normalizeCodexbar(JSON.parse(await runCommand(provider)));
  } catch {
    return null;
  }
}

export async function getQuota(
  config?: Config,
  deps: {
    which?: (binary: string) => string | null;
    runCodexbar?: typeof runCodexbar;
  } = {},
): Promise<QuotaResult> {
  if (config && !config.quota.enabled) return { error: "quota disabled" };
  if (!(deps.which ?? Bun.which)(CODEXBAR_BINARY))
    return { error: "codexbar not installed" };
  const entries = await Promise.all(
    Object.entries(
      config?.quota.providers ?? { claude: "claude", codex: "codex" },
    ).map(
      async ([harness, provider]) =>
        [harness, await (deps.runCodexbar ?? runCodexbar)(provider)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

// Total list-price spend CodexBar measured for a provider, including work that never went through smart-router.
export async function codexbarCostUsd(
  provider: string,
  days: number,
  runCommand: (provider: string, days: number) => Promise<string> = async (
    name,
    dayCount,
  ) =>
    (
      await $`codexbar cost --provider ${name} --format json --days ${dayCount}`.quiet()
    ).text(),
): Promise<number | null> {
  try {
    const payload: unknown = JSON.parse(await runCommand(provider, days));
    const report = Array.isArray(payload) ? payload[0] : payload;
    const totals = isRecord(report) ? report.totals : undefined;
    const totalCost = isRecord(totals) ? totals.totalCost : undefined;
    return typeof totalCost === "number" ? totalCost : null;
  } catch {
    return null;
  }
}

function quotaCachePath(): string {
  return join(stateDir(), QUOTA_CACHE_FILE);
}

// One cache for routes, pins and the guard. Only a complete reading is stored, so a codexbar
// failure is retried on the next call instead of being served for the whole window.
export async function readCachedQuota(
  config: Config,
  maxAgeMs: number,
  deps: { getQuota?: typeof getQuota; now?: () => number } = {},
): Promise<QuotaReading> {
  // Checked before the cache, so turning quota off takes effect at once, not when the cache expires.
  if (!config.quota.enabled)
    return { quota: { error: "quota disabled" }, ageMs: 0 };
  const now = (deps.now ?? Date.now)();
  try {
    const cached: unknown = JSON.parse(
      await readFile(quotaCachePath(), "utf8"),
    );
    if (
      isRecord(cached) &&
      typeof cached.fetchedAt === "number" &&
      isRecord(cached.quota)
    ) {
      const ageMs = now - cached.fetchedAt;
      if (ageMs >= 0 && ageMs <= maxAgeMs)
        return { quota: cached.quota as QuotaSnapshot, ageMs };
    }
  } catch {}
  const quota = await (deps.getQuota ?? getQuota)(config);
  const complete =
    !("error" in quota) && Object.values(quota).every((pool) => pool !== null);
  if (complete) {
    await mkdir(stateDir(), { recursive: true });
    const temporaryPath = `${quotaCachePath()}.${randomUUID()}`;
    await writeFile(temporaryPath, JSON.stringify({ fetchedAt: now, quota }));
    await rename(temporaryPath, quotaCachePath());
  }
  return { quota, ageMs: 0 };
}
