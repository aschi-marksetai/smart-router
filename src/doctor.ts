import { existsSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { harnessBinary, type Config, type HarnessName } from "./config.ts";
import { enumerate } from "./enumerate.ts";

const CODEX_API_KEY_ENV = "CODEX_API_KEY";
const CODEX_MODELS_CACHE = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "models_cache.json",
);
const CLAUDE_CATALOG_GLOB = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "cache",
  "model-catalog",
  "*.json",
);
const CODEXBAR_BINARY = "codexbar";
const HARNESS_NAMES: HarnessName[] = ["claude", "codex", "pi"];
const CLAUDE_PROVIDER = "anthropic";
const CODEX_PROVIDER = "openai";
const PROVIDERS_BY_HARNESS: Partial<Record<HarnessName, string>> = {
  claude: CLAUDE_PROVIDER,
  codex: CODEX_PROVIDER,
};

export type HarnessDetection = {
  installed: boolean;
  version: string | null;
  authed: boolean;
};
export type Detection = {
  harnesses: Record<HarnessName, HarnessDetection>;
  providers: Record<string, { apiKeySet: boolean }>;
  codexbar: { installed: boolean };
};
export type DoctorResult = Detection & {
  candidates: string[];
  availableModels: string[];
};
export type DetectionDeps = { enumerate: typeof enumerate };
const DEFAULT_DETECTION_DEPS: DetectionDeps = { enumerate };

async function commandOutput(
  command: string,
  ...arguments_: string[]
): Promise<string | null> {
  try {
    const output = await $`${command} ${arguments_}`.quiet();
    return output.text().trim();
  } catch {
    return null;
  }
}

async function isInstalled(binary: string): Promise<boolean> {
  return (await commandOutput("command", "-v", binary)) !== null;
}

async function detectHarness(
  name: HarnessName,
  config: Config,
): Promise<HarnessDetection> {
  const binary = harnessBinary(config, name);
  const installed = await isInstalled(binary);
  const version = installed ? await commandOutput(binary, "--version") : null;
  const provider = PROVIDERS_BY_HARNESS[name];
  const providerKeyEnv = provider && config.providers[provider]?.apiKeyEnv;
  const providerKeySet = Boolean(providerKeyEnv && process.env[providerKeyEnv]);
  const piProviderKeySet = Object.values(config.providers).some(
    ({ apiKeyEnv }) => Boolean(process.env[apiKeyEnv]),
  );
  if (name === "claude")
    return {
      installed,
      version,
      authed:
        config.harnesses.claude?.auth === "api-key"
          ? providerKeySet
          : globSync(CLAUDE_CATALOG_GLOB).length > 0,
    };
  if (name === "codex")
    return {
      installed,
      version,
      authed:
        config.harnesses.codex?.auth === "api-key"
          ? providerKeySet || Boolean(process.env[CODEX_API_KEY_ENV])
          : existsSync(CODEX_MODELS_CACHE),
    };
  const authed = piProviderKeySet;
  return { installed, version, authed };
}

export function buildCandidates(
  config: Config,
  detection: Detection,
): string[] {
  return config.models.flatMap(({ id, harness, efforts }) => {
    const detectedHarness = detection.harnesses[harness];
    return config.harnesses[harness]?.enabled === true &&
      detectedHarness.installed &&
      detectedHarness.authed
      ? efforts.map((effort) => `${id}@${effort}`)
      : [];
  });
}

export async function doctor(
  config: Config,
  deps: DetectionDeps = DEFAULT_DETECTION_DEPS,
): Promise<DoctorResult> {
  const [claude, codex, pi] = await Promise.all([
    detectHarness("claude", config),
    detectHarness("codex", config),
    detectHarness("pi", config),
  ]);
  const harnesses = { claude, codex, pi };
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([name, { apiKeyEnv }]) => [
      name,
      { apiKeySet: Boolean(process.env[apiKeyEnv]) },
    ]),
  );
  const codexbar = { installed: await isInstalled(CODEXBAR_BINARY) };
  const detection = { harnesses, providers, codexbar };
  const configuredModelIds = new Set(config.models.map(({ id }) => id));
  const ignoredModelIds = new Set(config.ignoredModels);
  const availableModels = (
    await Promise.all(
      HARNESS_NAMES.flatMap((harness) =>
        config.harnesses[harness]?.enabled && harnesses[harness].authed
          ? deps.enumerate(harness, config).catch(() => [])
          : [],
      ),
    )
  )
    .flat()
    .map(({ id }) => id)
    .filter((id) => !configuredModelIds.has(id) && !ignoredModelIds.has(id));
  return {
    ...detection,
    candidates: buildCandidates(config, detection),
    availableModels: [...new Set(availableModels)],
  };
}
