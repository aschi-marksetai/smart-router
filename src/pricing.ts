import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessName } from "./config.ts";
import { record } from "./files.ts";
import type { Usage } from "./harness/types.ts";

// CodexBar's cache of models.dev list prices; smart-router reads it and never ships prices of its own.
export const PRICING_CACHE_PATH = join(
  homedir(),
  "Library",
  "Caches",
  "codexbar",
  "model-pricing",
  "models-dev-v1.json",
);
const SUBSCRIPTION_PRICING_PROVIDERS: Partial<Record<HarnessName, string>> = {
  claude: "anthropic",
  codex: "openai",
};
const TOKENS_PER_PRICE_UNIT = 1_000_000;
const LONG_CONTEXT_RATES_KEY = "context_over_200k";

export type PricingCatalog = Record<string, unknown>;
type PricedSession = {
  harness: HarnessName;
  model: string;
  usage?: Usage | null;
};

// Missing or unreadable means "no prices"; every session is then reported as unpriced.
export async function loadPricing(
  path: string = PRICING_CACHE_PATH,
): Promise<PricingCatalog | null> {
  try {
    const cache = record(JSON.parse(await readFile(path, "utf8")));
    return record(record(cache?.catalog)?.providers) ?? null;
  } catch {
    return null;
  }
}

function modelRates(
  session: PricedSession,
  catalog: PricingCatalog,
): Record<string, unknown> | undefined {
  // pi model names are "<provider>/<model>"; the subscription harnesses each map to one provider.
  const subscriptionProvider = SUBSCRIPTION_PRICING_PROVIDERS[session.harness];
  const separator = session.model.indexOf("/");
  const provider =
    subscriptionProvider ?? session.model.slice(0, Math.max(0, separator));
  const model = subscriptionProvider
    ? session.model
    : session.model.slice(separator + 1);
  return record(
    record(record(record(catalog[provider])?.models)?.[model])?.cost,
  );
}

// List price of a session's tokens in USD; null when the model has no price or no usage was reported.
// A session stores token totals, not each request's context size, so which requests crossed a
// long-context tier is unknown. "base" prices every token at the normal rate (a lower bound) and
// "longContext" at the over-200k rate where the model has one (an upper bound).
export function listCostUsd(
  session: PricedSession,
  catalog: PricingCatalog | null,
  tier: "base" | "longContext" = "base",
): number | null {
  const usage = session.usage;
  const baseRates = catalog ? modelRates(session, catalog) : undefined;
  const longContextRates = record(baseRates?.[LONG_CONTEXT_RATES_KEY]);
  const rates =
    tier === "longContext" && longContextRates ? longContextRates : baseRates;
  if (
    !usage ||
    typeof rates?.input !== "number" ||
    typeof rates.output !== "number"
  )
    return null;
  // A model without cache rates is priced at its input rate for those tokens.
  const cacheReadRate =
    typeof rates.cache_read === "number" ? rates.cache_read : rates.input;
  const cacheWriteRate =
    typeof rates.cache_write === "number" ? rates.cache_write : rates.input;
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      (usage.cachedInputTokens ?? 0) * cacheReadRate +
      (usage.cacheWriteTokens ?? 0) * cacheWriteRate) /
    TOKENS_PER_PRICE_UNIT
  );
}
