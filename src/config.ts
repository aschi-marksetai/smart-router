import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./paths.ts";
import { isMissingFile } from "./files.ts";

export const CONFIG_VERSION = 1;
export const DEFAULT_EFFORT = "medium";
export const DEFAULT_CLAUDE_PERMISSION_MODE = "bypassPermissions";
export const DEFAULT_CODEX_SANDBOX = "workspace-write";
// Pinned so routing does not change when the jev-latest alias moves; bump deliberately.
// The two providers name the same release differently, and OpenRouter rejects TypeSafe's id.
export const DEFAULT_JEV_MODELS = {
  typesafe: "jev-1.14.0",
  openrouter: "typesafe/jev-1.14-20261014",
} as const;
export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const DEFAULT_CONFIDENTIAL_EXCLUDED_MODELS: string[] = [];
export const DEFAULT_MAX_RUNNING = 6;
export const DEFAULT_MAX_PER_CALLER = 3;
export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_QUOTA_CUTOFF_PERCENT = 95;
export const DEFAULT_PACE_TILT = 1;
export const ROUTE_POLICY_JEV = "jev";
export const ROUTE_POLICY_JUDGMENTS = "judgments";
// Probability of each experiment's "on" arm; 0 or 1 pins it.
export const DEFAULT_EXPERIMENTS = { repoContext: 0.5, outcomeFeedback: 0.5 };
export const NATIVE_SUBAGENT_GUARD_BLOCK = "block";
export const DEFAULT_NATIVE_SUBAGENT_ALLOW_TYPES = [
  "claude-code-guide",
  "statusline-setup",
];
export const DIRECT_MODEL_ALLOW = "allow";
export const DIRECT_MODEL_DENY = "deny";
export const DEFAULT_HARNESS_CAPABILITIES: Record<HarnessName, string> = {
  claude: "",
  codex: "",
  pi: "",
};
const CONFIG_FILE_NAME = "config.json";
// Tier 1 is cheapest, 4 strongest. Matched against the model name; the first match wins.
export const MODEL_TRAIT_DEFAULTS: {
  match: string;
  tier: number;
  taste?: boolean;
}[] = [
  { match: "luna", tier: 1 },
  { match: "haiku", tier: 1 },
  { match: "terra", tier: 2 },
  { match: "sonnet", tier: 2 },
  { match: "sol", tier: 3 },
  { match: "astra", tier: 4 },
  { match: "opus", tier: 4, taste: true },
  { match: "fable", tier: 4, taste: true },
];

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
  tier?: number;
  taste?: boolean;
};
export type DirectModelRule =
  typeof DIRECT_MODEL_ALLOW | typeof DIRECT_MODEL_DENY;
export type RoutePolicy =
  typeof ROUTE_POLICY_JEV | typeof ROUTE_POLICY_JUDGMENTS;
export type ExperimentName = keyof typeof DEFAULT_EXPERIMENTS;
export type ConcurrencyRules = {
  maxRunning: number;
  maxPerCaller: number;
  maxDepth: number;
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
    directModel?: DirectModelRule;
    // A pool left out keeps its default; null turns that pool's cutoff off.
    quotaCutoffPercent?: Partial<Record<HarnessName, number | null>>;
    modelWindowCutoffPercent?: number;
    paceTilt?: number;
    policy?: RoutePolicy;
    experiments?: Partial<Record<ExperimentName, number>>;
    nativeSubagentGuard?: typeof NATIVE_SUBAGENT_GUARD_BLOCK | "warn" | "off";
    nativeSubagentAllowTypes?: string[];
    confidentialExcludedModels?: string[];
    confidentialPathGlobs?: string[];
    confidentialRequireZdr?: boolean;
    stoppingPointRequiredFor?: string[];
    confidenceFloor?: number;
    concurrency?: ConcurrencyRules;
  };
  defaultModelId: string;
  defaultEffort: string;
  spawn: {
    claudePermissionMode: string;
    codexSandbox: string;
    codexExtraWritableRoots?: string[];
    codexLocalhostNeedsNetwork?: boolean;
    autoSandbox: boolean;
    allowFullAccess: boolean;
  };
  jev: {
    model: string;
    apiKeyEnv?: string;
    provider: "typesafe" | "openrouter";
    zdr: boolean;
  };
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
    confidentialExcludedModels: DEFAULT_CONFIDENTIAL_EXCLUDED_MODELS,
    confidentialRequireZdr: false,
    directModel: DIRECT_MODEL_ALLOW,
    quotaCutoffPercent: {
      claude: DEFAULT_QUOTA_CUTOFF_PERCENT,
      codex: DEFAULT_QUOTA_CUTOFF_PERCENT,
    },
    modelWindowCutoffPercent: DEFAULT_QUOTA_CUTOFF_PERCENT,
    paceTilt: DEFAULT_PACE_TILT,
    policy: ROUTE_POLICY_JEV,
    experiments: DEFAULT_EXPERIMENTS,
    nativeSubagentGuard: NATIVE_SUBAGENT_GUARD_BLOCK,
    nativeSubagentAllowTypes: DEFAULT_NATIVE_SUBAGENT_ALLOW_TYPES,
    concurrency: {
      maxRunning: DEFAULT_MAX_RUNNING,
      maxPerCaller: DEFAULT_MAX_PER_CALLER,
      maxDepth: DEFAULT_MAX_DEPTH,
    },
  },
  defaultModelId: "",
  defaultEffort: DEFAULT_EFFORT,
  spawn: {
    claudePermissionMode: DEFAULT_CLAUDE_PERMISSION_MODE,
    codexSandbox: DEFAULT_CODEX_SANDBOX,
    codexExtraWritableRoots: [],
    codexLocalhostNeedsNetwork: false,
    autoSandbox: true,
    allowFullAccess: true,
  },
  jev: {
    model: DEFAULT_JEV_MODELS.typesafe,
    provider: "typesafe",
    zdr: false,
  },
  quota: { enabled: true, providers: { claude: "claude", codex: "codex" } },
  updates: { check: true },
};

export function configPath(): string {
  return join(configDir(), CONFIG_FILE_NAME);
}

export function jevApiKeyEnv(config: Config): string {
  if (config.jev.apiKeyEnv) return config.jev.apiKeyEnv;
  if (config.jev.provider === "openrouter") return OPENROUTER_API_KEY_ENV;
  return TYPESAFE_API_KEY_ENV;
}

function withModelTraitDefaults(model: ModelConfig): ModelConfig {
  const defaults = MODEL_TRAIT_DEFAULTS.find(({ match }) =>
    model.model.includes(match),
  );
  if (!defaults) return model;
  return {
    ...model,
    tier: model.tier ?? defaults.tier,
    ...(model.taste === undefined && defaults.taste ? { taste: true } : {}),
  };
}

export async function loadConfig(): Promise<Config> {
  try {
    const saved = JSON.parse(await readFile(configPath(), "utf8"));
    const confidentialExcludedModels =
      saved.rules?.confidentialExcludedModels ??
      saved.rules?.confidentialExcludedProviders?.map(
        (provider: string) => `pi:${provider}/*`,
      ) ??
      DEFAULT_CONFIDENTIAL_EXCLUDED_MODELS;
    const rules = {
      ...DEFAULT_CONFIG.rules,
      ...saved.rules,
      confidentialExcludedModels,
    };
    delete rules.confidentialExcludedProviders;
    const jev: Config["jev"] = { ...DEFAULT_CONFIG.jev, ...saved.jev };
    if (saved.jev?.model === undefined)
      jev.model = DEFAULT_JEV_MODELS[jev.provider];
    if (
      jev.apiKeyEnv === TYPESAFE_API_KEY_ENV ||
      jev.apiKeyEnv === OPENROUTER_API_KEY_ENV
    )
      delete jev.apiKeyEnv;
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      models: (saved.models ?? DEFAULT_CONFIG.models).map(
        withModelTraitDefaults,
      ),
      rules: {
        ...DEFAULT_CONFIG.rules,
        ...rules,
        quotaCutoffPercent: {
          ...DEFAULT_CONFIG.rules.quotaCutoffPercent,
          ...saved.rules?.quotaCutoffPercent,
        },
        experiments: {
          ...DEFAULT_CONFIG.rules.experiments,
          ...saved.rules?.experiments,
        },
        concurrency: {
          ...DEFAULT_CONFIG.rules.concurrency,
          ...saved.rules?.concurrency,
        },
      },
      updates: { ...DEFAULT_CONFIG.updates, ...saved.updates },
      jev,
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
