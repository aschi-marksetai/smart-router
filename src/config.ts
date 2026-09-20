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
const CONFIG_FILE_NAME = "config.json";

export type HarnessName = "claude" | "codex" | "pi";
export type HarnessConfig = {
  enabled: boolean;
  auth?: "subscription" | "api-key";
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
  harnesses: Partial<Record<HarnessName, HarnessConfig>>;
  providers: Record<string, ProviderConfig>;
  models: ModelConfig[];
  rules: {
    quotaCutoffPercent?: Partial<Record<"claude" | "codex", number>>;
    confidentialPathGlobs?: string[];
    stoppingPointRequiredFor?: string[];
    confidenceFloor?: number;
  };
  defaultModelId: string;
  defaultEffort: string;
  spawn: { claudePermissionMode: string; codexSandbox: string };
  jev: { model: string; apiKeyEnv: string };
};

export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  harnesses: {},
  providers: {},
  models: [],
  rules: {},
  defaultModelId: "",
  defaultEffort: DEFAULT_EFFORT,
  spawn: {
    claudePermissionMode: DEFAULT_CLAUDE_PERMISSION_MODE,
    codexSandbox: DEFAULT_CODEX_SANDBOX,
  },
  jev: { model: DEFAULT_JEV_MODEL, apiKeyEnv: DEFAULT_JEV_API_KEY_ENV },
};

export function configPath(): string {
  return join(configDir(), CONFIG_FILE_NAME);
}

export async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
