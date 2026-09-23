import { $ } from "bun";
import type { Config, HarnessName } from "./config.ts";

const CODEXBAR_BINARY = "codexbar";
export type QuotaProvider = {
  weeklyUsedPercent: number;
  weeklyResetsAt: string;
  fiveHourUsedPercent: number | null;
  pace: string;
};
export type QuotaSnapshot = Partial<Record<HarnessName, QuotaProvider | null>>;
export type QuotaError = { error: "codexbar not installed" | "quota disabled" };
export type QuotaResult = QuotaSnapshot | QuotaError;

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

export function normalizeCodexbar(payload: unknown): QuotaProvider | null {
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
  return {
    weeklyUsedPercent,
    weeklyResetsAt,
    fiveHourUsedPercent,
    pace: summary,
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
