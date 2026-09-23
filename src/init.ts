import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  guardrailsTemplate,
  preferencesInterviewTemplate,
  preferencesTemplate,
} from "./assets.ts";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  configPath,
  DEFAULT_CONFIG,
  DEFAULT_CONFIDENTIAL_EXCLUDED_PROVIDERS,
  DEFAULT_HARNESS_CAPABILITIES,
  harnessBinary,
  loadConfig,
  type Config,
  type HarnessName,
  saveConfig,
} from "./config.ts";
import { enumerate, type EnumeratedModel } from "./enumerate.ts";
import { doctor } from "./doctor.ts";
import { configDir } from "./paths.ts";
import { writeDotEnvValue } from "./env.ts";

const HARNESS_NAMES: HarnessName[] = ["claude", "codex", "pi"];
const ENABLE_ALL = "enable-all";
const KEEP = "keep";
const EDITOR_ENVIRONMENT_VARIABLE = "EDITOR";
const PREFERENCES_FILE_NAME = "preferences.md";
const GUARDRAILS_FILE_NAME = "guardrails.md";
const CLAUDE_ADD_DIR_FLAG = "--add-dir";
const CODEX_DIRECTORY_FLAG = "-C";
const CODEX_SANDBOX_FLAG = "-s";
const CODEX_WORKSPACE_WRITE_SANDBOX = "workspace-write";
const DEFAULT_CONFIDENCE_FLOOR = 0.35;
const INTERVIEW_MODE_SEEDED =
  "just seeded from the default template, so treat it as a starting point to replace with my own preferences";
const INTERVIEW_MODE_EXISTING =
  "already written; you are refining it, so keep what I have unless I say otherwise";
const PROVIDER_NAMES = [
  ...new Set([
    "openai",
    "anthropic",
    "openrouter",
    "google",
    ...getBuiltinProviders(),
  ]),
];
const PROVIDER_ENVIRONMENT_VARIABLES: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
};
const TYPESAFE_KEYS_URL = "https://console.typesafe.ai/keys";

type InitSection = "auth" | "models" | "rules" | "preferences";
type PreferencesEditMethod = "editor" | "claude" | "codex" | "skip";
type Prompts = Pick<
  typeof import("@clack/prompts"),
  | "select"
  | "multiselect"
  | "text"
  | "confirm"
  | "password"
  | "note"
  | "intro"
  | "outro"
  | "cancel"
  | "isCancel"
>;
export type InitDeps = {
  prompts: Prompts;
  enumerate: typeof enumerate;
  doctor: typeof doctor;
  launch: (
    argv: string[],
    options: { cwd?: string; stdio: ["inherit", "inherit", "inherit"] },
  ) => { exited: Promise<number> };
  env: NodeJS.ProcessEnv;
  which: typeof Bun.which;
};
const defaultDeps: InitDeps = {
  prompts: {
    select,
    multiselect,
    text,
    confirm,
    password,
    note,
    intro,
    outro,
    cancel,
    isCancel,
  },
  enumerate,
  doctor,
  launch: (argv, options) => Bun.spawn(argv, options),
  env: process.env,
  which: Bun.which,
};

class SetupCancelled extends Error {}

function providerEnvironmentVariable(provider: string): string {
  return (
    PROVIDER_ENVIRONMENT_VARIABLES[provider] ??
    `${provider.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`
  );
}

function isSection(value: string | undefined): value is InitSection {
  return ["auth", "models", "rules", "preferences"].includes(value ?? "");
}

async function prompt<T>(
  question: Promise<T | symbol>,
  deps: InitDeps,
): Promise<T> {
  const answer = await question;
  if (!deps.prompts.isCancel(answer)) return answer;
  deps.prompts.cancel("Setup cancelled");
  throw new SetupCancelled();
}

async function beginSection(
  title: string,
  hasExistingConfig: boolean,
  deps: InitDeps,
): Promise<"continue" | "skip"> {
  if (!hasExistingConfig) return "continue";
  const answer = await prompt(
    deps.prompts.select({
      message: title,
      options: [
        { value: KEEP, label: "Keep as is" },
        { value: "edit", label: "Edit" },
      ],
      initialValue: KEEP,
    }),
    deps,
  );
  return answer === KEEP ? "skip" : "continue";
}

async function runAuth(
  config: Config,
  hasExistingConfig: boolean,
  deps: InitDeps,
): Promise<Config> {
  const start = await beginSection("Authentication", hasExistingConfig, deps);
  if (start === "skip") return config;
  const next = structuredClone(config);
  for (const harness of HARNESS_NAMES) {
    const enabled = await prompt(
      deps.prompts.confirm({
        message: `Enable ${harness}?`,
        initialValue: next.harnesses[harness]?.enabled ?? false,
      }),
      deps,
    );
    const current = next.harnesses[harness] ?? { enabled };
    if (harness === "pi") next.harnesses.pi = { ...next.harnesses.pi, enabled };
    else next.harnesses[harness] = { ...current, enabled };
    if (!enabled) continue;
    const auth = await prompt(
      deps.prompts.select<"subscription" | "api-key">({
        message: `${harness} authentication`,
        options:
          harness === "pi"
            ? [{ value: "api-key", label: "API key" }]
            : [
                { value: "subscription", label: "Subscription" },
                { value: "api-key", label: "API key" },
              ],
        initialValue:
          current.auth ?? (harness === "pi" ? "api-key" : "subscription"),
      }),
      deps,
    );
    const capabilities = await prompt(
      deps.prompts.text({
        message: `Capabilities note for routing (${harness})`,
        initialValue:
          current.capabilities ?? DEFAULT_HARNESS_CAPABILITIES[harness],
      }),
      deps,
    );
    if (harness === "pi") {
      next.harnesses.pi = {
        ...next.harnesses.pi,
        enabled,
        auth: "api-key",
        capabilities,
      };
    } else {
      next.harnesses[harness] = { ...current, enabled, auth, capabilities };
    }
  }
  for (const provider of PROVIDER_NAMES) {
    const current = next.providers[provider]?.apiKeyEnv;
    const defaultValue = current ?? providerEnvironmentVariable(provider);
    const state = deps.env[defaultValue] ? "set" : "not set";
    const apiKeyEnv =
      (await prompt(
        deps.prompts.text({
          message: `${provider} key environment variable (${state})`,
          initialValue: defaultValue,
        }),
        deps,
      )) ?? "";
    if (apiKeyEnv) next.providers[provider] = { apiKeyEnv };
    if (!apiKeyEnv) delete next.providers[provider];
  }
  if (deps.which("codexbar")) {
    const enabled = await prompt(
      deps.prompts.confirm({
        message: "Use codexbar for quota?",
        initialValue: next.quota.enabled,
      }),
      deps,
    );
    next.quota.enabled = enabled;
    if (enabled) {
      for (const harness of HARNESS_NAMES) {
        if (!next.harnesses[harness]?.enabled) continue;
        const provider =
          (await prompt(
            deps.prompts.text({
              message: `${harness} codexbar provider (blank = none)`,
              initialValue: next.quota.providers[harness] ?? "",
            }),
            deps,
          )) ?? "";
        if (provider) next.quota.providers[harness] = provider;
        if (!provider) delete next.quota.providers[harness];
      }
    }
  }
  return next;
}

function selectedModels(
  models: EnumeratedModel[],
  selectedIds: string[],
): EnumeratedModel[] {
  const ids = selectedIds.includes(ENABLE_ALL)
    ? new Set(models.map(({ id }) => id))
    : new Set(selectedIds);
  return models.filter(({ id }) => ids.has(id));
}

async function runModels(
  config: Config,
  hasExistingConfig: boolean,
  deps: InitDeps,
): Promise<Config> {
  const start = await beginSection("Models", hasExistingConfig, deps);
  if (start === "skip") return config;
  const next = structuredClone(config);
  for (const harness of HARNESS_NAMES) {
    if (!next.harnesses[harness]?.enabled) continue;
    let models: EnumeratedModel[];
    try {
      models = await deps.enumerate(harness, next);
    } catch (error) {
      deps.prompts.note(String(error), `${harness} models unavailable`);
      continue;
    }
    if (!models.length) {
      deps.prompts.note("No models found", harness);
      continue;
    }
    const currentIds = next.models
      .filter((model) => model.harness === harness)
      .map(({ id }) => id);
    const selectedIds = await prompt(
      deps.prompts.multiselect({
        message: `Enable ${harness} models`,
        options: [
          { value: ENABLE_ALL, label: "Enable all" },
          ...[...models]
            .sort((left, right) =>
              left.name.localeCompare(right.name, undefined, { numeric: true }),
            )
            .map(({ id, name }) => ({ value: id, label: `${name}  ${id}` })),
        ],
        initialValues: currentIds,
      }),
      deps,
    );
    const enabledModels = selectedModels(models, selectedIds);
    const enabledModelIds = new Set(enabledModels.map(({ id }) => id));
    const enumeratedModelIds = new Set(models.map(({ id }) => id));
    const retainedIgnoredModels = next.ignoredModels.filter(
      (id) => !enumeratedModelIds.has(id),
    );
    const ignoredModels = models
      .filter(({ id }) => !enabledModelIds.has(id))
      .map(({ id }) => id);
    next.ignoredModels = [
      ...new Set([...retainedIgnoredModels, ...ignoredModels]),
    ];
    next.models = next.models.filter((model) => model.harness !== harness);
    next.models.push(
      ...enabledModels.map(({ id, model, efforts }) => ({
        id,
        harness,
        model,
        efforts,
      })),
    );
  }
  return next;
}

function candidates(config: Config): { id: string; effort: string }[] {
  return config.models.flatMap(({ id, harness, efforts }) =>
    config.harnesses[harness]?.enabled
      ? efforts.map((effort) => ({ id, effort }))
      : [],
  );
}

async function runRules(
  config: Config,
  hasExistingConfig: boolean,
  deps: InitDeps,
): Promise<Config> {
  const start = await beginSection("Rules", hasExistingConfig, deps);
  if (start === "skip") return config;
  const next = structuredClone(config);
  const cutoffPercent = { ...next.rules.quotaCutoffPercent };
  for (const harness of HARNESS_NAMES) {
    if (
      !next.harnesses[harness]?.enabled ||
      next.harnesses[harness]?.auth !== "subscription"
    )
      continue;
    const cutoff =
      (await prompt(
        deps.prompts.text({
          message: `${harness} cutoff percent used (blank = none)`,
          initialValue: cutoffPercent[harness]?.toString() ?? "",
          validate: (value) =>
            !value || Number.isFinite(Number(value))
              ? undefined
              : "Enter a finite number",
        }),
        deps,
      )) ?? "";
    if (cutoff) cutoffPercent[harness] = Number(cutoff);
    if (!cutoff) delete cutoffPercent[harness];
  }
  next.rules.quotaCutoffPercent = Object.keys(cutoffPercent).length
    ? cutoffPercent
    : undefined;
  const confidentialGlobs =
    (await prompt(
      deps.prompts.text({
        message: "Confidential path globs, comma-separated (blank = none)",
        initialValue: next.rules.confidentialPathGlobs?.join(", ") ?? "",
      }),
      deps,
    )) ?? "";
  const globs = confidentialGlobs
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean);
  next.rules.confidentialPathGlobs = globs.length ? globs : undefined;
  const excludedProviders =
    (await prompt(
      deps.prompts.text({
        message: "Confidential excluded providers, comma-separated",
        initialValue: (
          next.rules.confidentialExcludedProviders ??
          DEFAULT_CONFIDENTIAL_EXCLUDED_PROVIDERS
        ).join(", "),
      }),
      deps,
    )) ?? "";
  const providers = excludedProviders
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  next.rules.confidentialExcludedProviders = providers;
  const confidenceFloor =
    (await prompt(
      deps.prompts.text({
        message:
          "Confidence floor, 0 to 1 (below it the default model runs; 0.35 recommended)",
        initialValue: (
          next.rules.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR
        ).toString(),
        validate: (value) =>
          !value || Number.isFinite(Number(value))
            ? undefined
            : "Enter a finite number",
      }),
      deps,
    )) ?? "";
  next.rules.confidenceFloor = confidenceFloor
    ? Number(confidenceFloor)
    : DEFAULT_CONFIDENCE_FLOOR;
  next.updates = {
    check: await prompt(
      deps.prompts.confirm({
        message: "Check for updates once a day?",
        initialValue: next.updates?.check ?? true,
      }),
      deps,
    ),
  };
  next.spawn.autoSandbox = await prompt(
    deps.prompts.confirm({
      message: "Choose the Codex sandbox automatically from the task?",
      initialValue: next.spawn.autoSandbox,
    }),
    deps,
  );
  next.spawn.allowFullAccess = await prompt(
    deps.prompts.confirm({
      message: "Allow automatic Codex full-access sandbox?",
      initialValue: next.spawn.allowFullAccess,
    }),
    deps,
  );
  const enabledCandidates = candidates(next);
  if (!enabledCandidates.length) return next;
  const enabledModelIds = [...new Set(enabledCandidates.map(({ id }) => id))];
  const stoppingPointRequiredFor = await prompt(
    deps.prompts.multiselect({
      message: "Models that must be given a stopping point",
      options: enabledModelIds.map((id) => ({ value: id })),
      initialValues: next.rules.stoppingPointRequiredFor?.filter((id) =>
        enabledModelIds.includes(id),
      ),
    }),
    deps,
  );
  next.rules.stoppingPointRequiredFor = stoppingPointRequiredFor.length
    ? stoppingPointRequiredFor
    : undefined;
  const defaultModelId = await prompt(
    deps.prompts.select({
      message: "Default model",
      options: enabledModelIds.map((id) => ({ value: id })),
      initialValue: enabledCandidates.some(
        ({ id }) => id === next.defaultModelId,
      )
        ? next.defaultModelId
        : enabledCandidates[0].id,
    }),
    deps,
  );
  next.defaultModelId = defaultModelId;
  const efforts = enabledCandidates
    .filter(({ id }) => id === defaultModelId)
    .map(({ effort }) => effort);
  const defaultEffort = await prompt(
    deps.prompts.select({
      message: "Default effort",
      options: efforts.map((effort) => ({ value: effort })),
      initialValue: efforts.includes(next.defaultEffort)
        ? next.defaultEffort
        : efforts[0],
    }),
    deps,
  );
  next.defaultEffort = defaultEffort;
  return next;
}

async function runPreferences(
  config: Config,
  hasExistingConfig: boolean,
  deps: InitDeps,
): Promise<Config> {
  const start = await beginSection("Preferences", hasExistingConfig, deps);
  if (start === "skip") return config;
  const configDirectory = configDir();
  const preferencesPath = join(configDirectory, PREFERENCES_FILE_NAME);
  const guardrailsPath = join(configDirectory, GUARDRAILS_FILE_NAME);
  const wasJustSeeded = !existsSync(preferencesPath);
  if (wasJustSeeded || !existsSync(guardrailsPath)) {
    await mkdir(configDirectory, { recursive: true });
  }
  if (wasJustSeeded) {
    await writeFile(preferencesPath, preferencesTemplate);
  }
  if (!existsSync(guardrailsPath))
    await writeFile(guardrailsPath, guardrailsTemplate);
  const detection = await deps.doctor(config);
  const editOptions: { value: PreferencesEditMethod; label: string }[] = [
    { value: "editor", label: "Open in $EDITOR" },
  ];
  if (detection.harnesses.claude.installed)
    editOptions.push({
      value: "claude",
      label: "Interview me with Claude Code",
    });
  if (detection.harnesses.codex.installed)
    editOptions.push({ value: "codex", label: "Interview me with Codex" });
  editOptions.push({ value: "skip", label: "Skip" });
  const editMethod = await prompt(
    deps.prompts.select<PreferencesEditMethod>({
      message: "How do you want to edit preferences.md?",
      options: editOptions,
    }),
    deps,
  );
  if (editMethod === "editor") {
    const editor = deps.env[EDITOR_ENVIRONMENT_VARIABLE] ?? "vi";
    const editorProcess = deps.launch([editor, preferencesPath], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await editorProcess.exited;
  }
  if (editMethod === "claude" || editMethod === "codex") {
    const candidateLines = config.models
      .filter(({ harness }) => config.harnesses[harness]?.enabled)
      .map(
        ({ harness, model, efforts }) =>
          `${harness}:${model} (efforts: ${efforts.join(", ")})`,
      )
      .join("\n");
    const interviewPrompt = preferencesInterviewTemplate
      .replaceAll("{{PREFERENCES_PATH}}", preferencesPath)
      .replaceAll("{{CANDIDATES}}", candidateLines)
      .replaceAll(
        "{{MODE}}",
        wasJustSeeded ? INTERVIEW_MODE_SEEDED : INTERVIEW_MODE_EXISTING,
      );
    // --add-dir is variadic in claude, so the prompt must come before it
    const argv =
      editMethod === "claude"
        ? [
            harnessBinary(config, "claude"),
            interviewPrompt,
            CLAUDE_ADD_DIR_FLAG,
            configDirectory,
          ]
        : [
            harnessBinary(config, "codex"),
            CODEX_DIRECTORY_FLAG,
            configDirectory,
            CODEX_SANDBOX_FLAG,
            CODEX_WORKSPACE_WRITE_SANDBOX,
            interviewPrompt,
          ];
    const interviewProcess = deps.launch(argv, {
      cwd: configDirectory,
      stdio: ["inherit", "inherit", "inherit"],
    });
    await interviewProcess.exited;
  }
  return config;
}

export async function runInit(
  options: {
    section?: string;
    reset?: boolean;
  },
  deps: InitDeps = defaultDeps,
): Promise<void> {
  let config = options.reset
    ? structuredClone(DEFAULT_CONFIG)
    : await loadConfig();
  const keyEnvironmentVariable = config.jev.apiKeyEnv;
  if (!deps.env[keyEnvironmentVariable]) {
    const apiKey = await prompt(
      deps.prompts.password({
        message: `Paste your TypeSafe API key (for Jev routing) — get one at ${TYPESAFE_KEYS_URL}`,
      }),
      deps,
    );
    if (apiKey.trim()) {
      await writeDotEnvValue(
        join(configDir(), ".env"),
        keyEnvironmentVariable,
        apiKey.trim(),
      );
      deps.env[keyEnvironmentVariable] = apiKey.trim();
    } else {
      deps.prompts.note(
        "Routing will fall back to the default model until the key exists.",
      );
    }
  }
  const section = options.section;
  if (section !== undefined && !isSection(section))
    throw new Error("Section must be auth, models, rules, or preferences");
  const hasExistingConfig = !options.reset && existsSync(configPath());
  const sections: Record<
    InitSection,
    (config: Config, existing: boolean, deps: InitDeps) => Promise<Config>
  > = {
    auth: runAuth,
    models: runModels,
    rules: runRules,
    preferences: runPreferences,
  };
  deps.prompts.intro("smart-router setup");
  const names: InitSection[] = section
    ? [section]
    : ["auth", "models", "rules", "preferences"];
  try {
    for (const name of names) {
      config = await sections[name](config, hasExistingConfig, deps);
      await saveConfig(config);
    }
  } catch (error) {
    if (error instanceof SetupCancelled) return;
    throw error;
  }
  deps.prompts.outro("Configuration saved");
  const skillPath = join(
    deps.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "skills",
    "smart-router",
    "SKILL.md",
  );
  if (!existsSync(skillPath))
    deps.prompts.note(
      "Install the Claude Code skill with: smart-router install-skill",
      "Next step",
    );
}
