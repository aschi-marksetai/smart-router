import { $ } from "bun";

const CODEXBAR_BINARY = "codexbar";
const PROVIDERS = ["claude", "codex"] as const;

type QuotaProviderName = (typeof PROVIDERS)[number];
export type QuotaProvider = {
  weeklyUsedPercent: number;
  weeklyResetsAt: string;
  fiveHourUsedPercent: number | null;
  pace: string;
};
export type QuotaSnapshot = Record<QuotaProviderName, QuotaProvider | null>;
export type QuotaError = { error: "codexbar not installed" };
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
  provider: QuotaProviderName,
): Promise<QuotaProvider | null> {
  try {
    const output =
      await $`codexbar usage --format json --provider ${provider}`.quiet();
    return normalizeCodexbar(JSON.parse(output.text()));
  } catch {
    return null;
  }
}

export async function getQuota(): Promise<QuotaResult> {
  if (!Bun.which(CODEXBAR_BINARY)) return { error: "codexbar not installed" };
  const [claude, codex] = await Promise.all(PROVIDERS.map(runCodexbar));
  return { claude, codex };
}
