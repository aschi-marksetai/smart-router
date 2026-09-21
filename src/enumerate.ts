import { globSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { harnessBinary, type Config, type HarnessName } from "./config.ts";
import { record } from "./files.ts";

const CLAUDE_CATALOG_GLOB = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "cache",
  "model-catalog",
  "*.json",
);
const CODEX_MODELS_CACHE = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "models_cache.json",
);
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_EFFORTS = ["low", "medium", "high"];
const STANDARD_EFFORT = ["medium"];
const CODEX_LISTED_VISIBILITY = "list";
const ANTHROPIC_VERSION = "2023-06-01";

export type EnumeratedModel = {
  id: string;
  model: string;
  name: string;
  efforts: string[];
};

function models(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => record(item) !== undefined,
      )
    : [];
}

function entry(
  harness: HarnessName,
  model: string,
  name: string,
  efforts: string[],
): EnumeratedModel {
  return { id: `${harness}:${model}`, model, name, efforts };
}

export function parseClaudeCatalog(payload: unknown): EnumeratedModel[] {
  const catalog = record(payload)?.catalog;
  const config = record(catalog)?.config;
  return models(record(config)?.models).flatMap((model) => {
    const id = model.id;
    if (typeof id !== "string") return [];
    const shortName = model.short_name;
    const name = typeof shortName === "string" ? shortName : id;
    const thinking = record(model.thinking);
    const efforts = models(thinking?.effort_options)
      .map((option) => option.id)
      .filter((effort): effort is string => typeof effort === "string");
    return [
      entry("claude", id, name, efforts.length ? efforts : DEFAULT_EFFORTS),
    ];
  });
}

export function parseAnthropicModels(payload: unknown): EnumeratedModel[] {
  return models(record(payload)?.data).flatMap((model) => {
    const id = model.id;
    if (typeof id !== "string") return [];
    const name =
      typeof model.display_name === "string" ? model.display_name : id;
    const effort = record(model.capabilities)?.effort;
    const efforts = Array.isArray(effort)
      ? effort.filter((item): item is string => typeof item === "string")
      : [];
    return [
      entry("claude", id, name, efforts.length ? efforts : DEFAULT_EFFORTS),
    ];
  });
}

export function parseCodexModels(payload: unknown): EnumeratedModel[] {
  const sourceModels = Array.isArray(payload)
    ? payload
    : record(payload)?.models;
  return models(sourceModels).flatMap((model) => {
    if (
      model.visibility !== undefined &&
      model.visibility !== CODEX_LISTED_VISIBILITY
    )
      return [];
    const slug = model.slug;
    if (typeof slug !== "string") return [];
    const efforts = models(model.supported_reasoning_levels)
      .map((level) => level.effort)
      .filter((effort): effort is string => typeof effort === "string");
    return [
      entry("codex", slug, slug, efforts.length ? efforts : STANDARD_EFFORT),
    ];
  });
}

export function parseOpenRouterModels(payload: unknown): EnumeratedModel[] {
  return models(record(payload)?.data).flatMap((model) => {
    const id = model.id;
    if (typeof id !== "string") return [];
    const name = typeof model.name === "string" ? model.name : id;
    return [entry("pi", `openrouter/${id}`, name, STANDARD_EFFORT)];
  });
}

export function parsePiRegistry(
  provider: string,
  registry: readonly { id: string; name: string; reasoning: boolean }[],
): EnumeratedModel[] {
  return registry.map(({ id, name, reasoning }) =>
    entry(
      "pi",
      `${provider}/${id}`,
      name,
      reasoning ? DEFAULT_EFFORTS : STANDARD_EFFORT,
    ),
  );
}

function newestCatalog(): string {
  const catalogs = globSync(CLAUDE_CATALOG_GLOB);
  const newest = catalogs.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
  )[0];
  if (!newest) throw new Error("Claude model catalog not found");
  return newest;
}

async function responseJson(
  url: string,
  headers: HeadersInit,
): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Model request failed: ${response.status}`);
  return response.json();
}

async function fetchAnthropicModels(key: string): Promise<unknown> {
  return responseJson(ANTHROPIC_MODELS_URL, {
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
  });
}

async function enumerateClaude(config: Config): Promise<EnumeratedModel[]> {
  if (config.harnesses.claude?.auth === "api-key") {
    const key = process.env[config.providers.anthropic?.apiKeyEnv ?? ""];
    if (!key) throw new Error("Anthropic API key not set");
    return parseAnthropicModels(await fetchAnthropicModels(key));
  }
  return parseClaudeCatalog(
    JSON.parse(await readFile(newestCatalog(), "utf8")),
  );
}

async function enumerateCodex(config: Config): Promise<EnumeratedModel[]> {
  const binary = harnessBinary(config, "codex");
  try {
    return parseCodexModels(
      JSON.parse((await $`${binary} debug models`.quiet()).text()),
    );
  } catch {
    return parseCodexModels(
      JSON.parse(await readFile(CODEX_MODELS_CACHE, "utf8")),
    );
  }
}

async function enumeratePi(config: Config): Promise<EnumeratedModel[]> {
  const providers = Object.entries(config.providers).filter(([, provider]) =>
    Boolean(process.env[provider.apiKeyEnv]),
  );
  return (
    await Promise.all(
      providers.map(async ([provider, { apiKeyEnv }]) => {
        const key = process.env[apiKeyEnv];
        if (!key) return [];
        if (provider === "openrouter")
          return parseOpenRouterModels(
            await responseJson(OPENROUTER_MODELS_URL, {
              Authorization: `Bearer ${key}`,
            }),
          );
        if (provider === "openai") {
          const payload = await responseJson(OPENAI_MODELS_URL, {
            Authorization: `Bearer ${key}`,
          });
          const registry = models(record(payload)?.data).flatMap((model) => {
            const id = model.id;
            return typeof id === "string"
              ? [{ id, name: id, reasoning: false }]
              : [];
          });
          return parsePiRegistry("openai", registry);
        }
        if (provider === "anthropic")
          return parseAnthropicModels(await fetchAnthropicModels(key)).map(
            (model) => ({
              ...model,
              id: `pi:anthropic/${model.model}`,
              model: `anthropic/${model.model}`,
            }),
          );
        const builtinProvider = getBuiltinProviders().find(
          (id) => id === provider,
        );
        return builtinProvider
          ? parsePiRegistry(provider, getBuiltinModels(builtinProvider))
          : [];
      }),
    )
  ).flat();
}

export async function enumerate(
  harness: HarnessName,
  config: Config,
): Promise<EnumeratedModel[]> {
  if (harness === "claude") return enumerateClaude(config);
  if (harness === "codex") return enumerateCodex(config);
  return enumeratePi(config);
}
