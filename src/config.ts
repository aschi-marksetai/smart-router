import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths.ts";
import { isMissingFile } from "./files.ts";

export const CONFIG_VERSION = 1;
export const DEFAULT_EFFORT = "medium";
export const DEFAULT_CLAUDE_PERMISSION_MODE = "bypassPermissions";
export const DEFAULT_CODEX_SANDBOX = "workspace-write";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const DEFAULT_CONFIDENTIAL_EXCLUDED_PROVIDERS = ["openrouter"];
export const DEFAULT_HARNESS_CAPABILITIES: Record<HarnessName, string> = {
  claude: "",
  codex: "",
  pi: "",
};
const CONFIG_FILE_NAME = "config.json";

export type HarnessName = "claude" | "codex" | "pi";
export type HarnessConfig = {
  enabled: boolean;
  auth?: "subscription" | "api-key";
  binary?: string;
  capabilities?: string;
};
export type PiHarnessConfig = Omit<HarnessConfig, "auth"> & {
  auth?: "api-key";
};
export type ProviderConfig = { apiKeyEnv: string };
export type ModelConfig = {
  id: string;
  harness: HarnessName;
  model: string;
  efforts: string[];
};
export type Config = {
  version: number;
  harnesses: {
    claude?: HarnessConfig;
    codex?: HarnessConfig;
    pi?: PiHarnessConfig;
  };
  providers: Record<string, ProviderConfig>;
  models: ModelConfig[];
  ignoredModels: string[];
  rules: {
    quotaCutoffPercent?: Partial<Record<HarnessName, number>>;
    confidentialExcludedProviders?: string[];
    confidentialPathGlobs?: string[];
    stoppingPointRequiredFor?: string[];
    confidenceFloor?: number;
  };
  defaultModelId: string;
  defaultEffort: string;
  spawn: {
    claudePermissionMode: string;
    codexSandbox: string;
    autoSandbox: boolean;
    allowFullAccess: boolean;
  };
  jev: { model: string; apiKeyEnv: string };
  quota: { enabled: boolean; providers: Partial<Record<HarnessName, string>> };
  updates?: { check: boolean };
};

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  harnesses: {},
  providers: {},
  models: [],
  ignoredModels: [],
  rules: {
    confidentialExcludedProviders: DEFAULT_CONFIDENTIAL_EXCLUDED_PROVIDERS,
  },
  defaultModelId: "",
  defaultEffort: DEFAULT_EFFORT,
  spawn: {
    claudePermissionMode: DEFAULT_CLAUDE_PERMISSION_MODE,
    codexSandbox: DEFAULT_CODEX_SANDBOX,
    autoSandbox: true,
    allowFullAccess: true,
  },
  jev: { model: DEFAULT_JEV_MODEL, apiKeyEnv: DEFAULT_JEV_API_KEY_ENV },
  quota: { enabled: true, providers: { claude: "claude", codex: "codex" } },
  updates: { check: true },
};

export function configPath(): string {
  return join(configDir(), CONFIG_FILE_NAME);
}

export async function loadConfig(): Promise<Config> {
  try {
    const saved = JSON.parse(await readFile(configPath(), "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      rules: { ...DEFAULT_CONFIG.rules, ...saved.rules },
      updates: { ...DEFAULT_CONFIG.updates, ...saved.updates },
      spawn: { ...DEFAULT_CONFIG.spawn, ...saved.spawn },
      quota: {
        ...DEFAULT_CONFIG.quota,
        ...saved.quota,
        ...(saved.quota && "providers" in saved.quota
          ? { providers: saved.quota.providers }
          : {}),
      },
    };
  } catch (error) {
    if (isMissingFile(error)) return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
}

export function harnessBinary(config: Config, harness: HarnessName): string {
  return config.harnesses[harness]?.binary ?? harness;
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
