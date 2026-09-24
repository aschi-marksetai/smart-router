import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  type Config,
} from "../src/config.ts";
import { runInit, type InitDeps } from "../src/init.ts";
import { guardrailsTemplate, preferencesTemplate } from "../src/assets.ts";

const CONFIG_DIR_ENV = "SMART_ROUTER_CONFIG_DIR";
const TYPESAFE_KEY_ENV = "TYPESAFE_API_KEY";
const EDITOR_ENV = "EDITOR";
const CONFIG_DIR_PREFIX = "smart-router-init-";
const CANCEL = Symbol("cancel");
type PromptKind = "select" | "multiselect" | "text" | "confirm" | "password";
type Answer = {
  message: string;
  value: unknown;
  check?: (options: Record<string, unknown>) => void;
};
type Script = Partial<Record<PromptKind, Answer[]>>;
let directory = "";
const priorEnvironment = {
  config: process.env[CONFIG_DIR_ENV],
  key: process.env[TYPESAFE_KEY_ENV],
  editor: process.env[EDITOR_ENV],
};

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  restoreEnvironment(CONFIG_DIR_ENV, priorEnvironment.config);
  restoreEnvironment(TYPESAFE_KEY_ENV, priorEnvironment.key);
  restoreEnvironment(EDITOR_ENV, priorEnvironment.editor);
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

async function setup(config?: Config): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), CONFIG_DIR_PREFIX));
  process.env[CONFIG_DIR_ENV] = directory;
  delete process.env[TYPESAFE_KEY_ENV];
  if (config) await saveConfig(config);
}

function scripted(script: Script, overrides: Partial<InitDeps> = {}) {
  const notes: [string, string | undefined][] = [];
  const launches: string[][] = [];
  const seen: string[] = [];
  const prompt = (kind: PromptKind) => (options: Record<string, unknown>) => {
    const answer = script[kind]?.shift();
    expect(answer, `unexpected ${kind}: ${options.message}`).toBeDefined();
    expect(options.message).toBe(answer?.message);
    answer?.check?.(options);
    seen.push(`${kind}: ${options.message}`);
    return Promise.resolve(answer?.value);
  };
  const prompts = {
    select: prompt("select"),
    multiselect: prompt("multiselect"),
    text: prompt("text"),
    confirm: prompt("confirm"),
    password: prompt("password"),
    note: (message: string, title?: string) => notes.push([message, title]),
    intro: () => {},
    outro: () => {},
    cancel: (message: string) => notes.push([message, undefined]),
    isCancel: (value: unknown) => value === CANCEL,
  } as unknown as InitDeps["prompts"];
  const deps: InitDeps = {
    prompts,
    enumerate: async () => [],
    // prettier-ignore
    doctor: async () => ({ harnesses: {
      claude: { installed: true, version: null, authed: true }, codex: { installed: true, version: null, authed: true }, pi: { installed: false, version: null, authed: false },
    }, providers: {}, codexbar: { installed: false }, candidates: [], availableModels: [] }),
    launch: (argv) => {
      launches.push(argv);
      return { exited: Promise.resolve(0) };
    },
    env: { [TYPESAFE_KEY_ENV]: "present" },
    which: () => null,
    ...overrides,
  };
  const assertConsumed = () => {
    for (const answers of Object.values(script))
      expect(answers).toHaveLength(0);
  };
  return { deps, notes, launches, seen, assertConsumed };
}

function validate(options: Record<string, unknown>, value: string): unknown {
  if (typeof options.validate !== "function")
    throw new Error("missing validator");
  return options.validate(value);
}

function modelConfig(): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.harnesses.claude = { enabled: true, auth: "subscription" };
  config.harnesses.codex = { enabled: true, auth: "subscription" };
  // prettier-ignore
  config.models = [
    { id: "claude:sonnet", harness: "claude", model: "sonnet", efforts: ["medium"] },
    { id: "codex:sol", harness: "codex", model: "sol", efforts: ["low", "high"] },
  ];
  config.defaultModelId = "codex:sol";
  config.defaultEffort = "high";
  return config;
}

const answer = (
  message: string,
  value: unknown,
  check?: Answer["check"],
): Answer => ({ message, value, check });

async function readPreferences(): Promise<string> {
  return readFile(join(directory, "preferences.md"), "utf8");
}

test("TypeSafe key is requested only when missing, saved, and blank is noted", async () => {
  await setup();
  const message =
    "Paste your TypeSafe API key (for Jev routing) — get one at https://console.typesafe.ai/keys";
  const first = scripted({ password: [answer(message, "  secret  ")] });
  delete first.deps.env[TYPESAFE_KEY_ENV];
  first.deps.env.CLAUDE_CONFIG_DIR = join(directory, "missing-claude");
  await runInit({ section: "models" }, first.deps);
  expect(await readFile(join(directory, ".env"), "utf8")).toBe(
    `${TYPESAFE_KEY_ENV}=secret`,
  );
  expect(first.deps.env[TYPESAFE_KEY_ENV]).toBe("secret");
  expect(first.notes).toContainEqual([
    "Install the Claude Code skill with: smart-router install-skill",
    "Next step",
  ]);
  first.assertConsumed();
  const second = scripted({ select: [answer("Models", "keep")] });
  await runInit({ section: "models" }, second.deps);
  expect(second.seen).toEqual(["select: Models"]);
  const blank = scripted({
    password: [answer(message, "  ")],
    select: [answer("Models", "keep")],
  });
  delete blank.deps.env[TYPESAFE_KEY_ENV];
  await runInit({ section: "models" }, blank.deps);
  // prettier-ignore
  expect(blank.notes).toContainEqual(["Routing will fall back to the default model until the key exists.", undefined]);
  blank.assertConsumed();
});

test("auth sets harnesses, capabilities, provider env vars, and codexbar quota", async () => {
  await setup();
  // prettier-ignore
  const script: Script = {
    confirm: [answer("Enable claude?", true), answer("Enable codex?", false), answer("Enable pi?", true), answer("Use codexbar for quota?", true)],
    select: [answer("claude authentication", "subscription"), answer("pi authentication", "api-key")],
    text: [answer("Capabilities note for routing (claude)", "strong reasoning"), answer("Capabilities note for routing (pi)", "cheap tasks")],
  };
  const { deps, assertConsumed } = scripted(script, {
    which: () => "/bin/codexbar",
  });
  const providerPrompts = script.text ?? [];
  // prettier-ignore
  const providers = ["openai", "anthropic", "openrouter", "google", ...(await import("@earendil-works/pi-ai/providers/all")).getBuiltinProviders()];
  for (const provider of new Set(providers)) {
    const variable = `${provider.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`;
    // prettier-ignore
    providerPrompts.push(answer(`${provider} key environment variable (not set)`, provider === "openai" ? "CUSTOM_OPENAI_KEY" : ""));
  }
  // prettier-ignore
  providerPrompts.push(answer("claude codexbar provider (blank = none)", "claude-custom"));
  providerPrompts.push(answer("pi codexbar provider (blank = none)", ""));
  await runInit({ section: "auth" }, deps);
  const config = await loadConfig();
  // prettier-ignore
  expect(config.harnesses.claude).toMatchObject({ enabled: true, auth: "subscription", capabilities: "strong reasoning" });
  expect(config.harnesses.codex?.enabled).toBe(false);
  // prettier-ignore
  expect(config.harnesses.pi).toMatchObject({ enabled: true, auth: "api-key", capabilities: "cheap tasks" });
  expect(config.providers.openai.apiKeyEnv).toBe("CUSTOM_OPENAI_KEY");
  expect(config.quota.providers.claude).toBe("claude-custom");
  expect(config.quota.providers.pi).toBeUndefined();
  assertConsumed();
});

test("models enable all, record ignored models, and continue after enumeration error", async () => {
  await setup(modelConfig());
  const config = await loadConfig();
  config.harnesses.pi = { enabled: true, auth: "api-key" };
  config.ignoredModels = ["claude:a", "codex:y", "stale"];
  await saveConfig(config);
  // prettier-ignore
  const { deps, notes, assertConsumed } = scripted({
    select: [answer("Models", "edit")],
    multiselect: [
      answer("Enable claude models", ["enable-all"], (options) => expect((options.options as { value: string }[]).map(({ value }) => value)).toEqual(["enable-all", "claude:a", "claude:b"])),
      answer("Enable codex models", ["codex:x"]),
    ],
  }, { enumerate: async (harness) => {
    if (harness === "pi") throw new Error("offline");
    if (harness === "claude") return [{ id: "claude:b", model: "b", name: "Model 10", efforts: ["high"] }, { id: "claude:a", model: "a", name: "Model 2", efforts: ["low"] }];
    return [{ id: "codex:x", model: "x", name: "X", efforts: ["high"] }, { id: "codex:y", model: "y", name: "Y", efforts: ["medium"] }];
  } });
  await runInit({ section: "models" }, deps);
  const saved = await loadConfig();
  expect(saved.models.map(({ id }) => id)).toEqual([
    "claude:b",
    "claude:a",
    "codex:x",
  ]);
  expect(saved.ignoredModels).toEqual(["stale", "codex:y"]);
  expect(notes).toContainEqual(["Error: offline", "pi models unavailable"]);
  assertConsumed();
});

test("notes when an enabled harness returns no models", async () => {
  await setup(modelConfig());
  const { deps, notes } = scripted({ select: [answer("Models", "edit")] });
  await runInit({ section: "models" }, deps);
  expect(notes).toContainEqual(["No models found", "claude"]);
  expect(notes).toContainEqual(["No models found", "codex"]);
});

test("rules handle blank and numeric cutoffs, validation, globs, floor, stopping points, and defaults", async () => {
  await setup(modelConfig());
  const config = await loadConfig();
  config.rules.quotaCutoffPercent = { claude: 40 };
  config.rules.stoppingPointRequiredFor = ["claude:sonnet", "pi:off"];
  config.rules.directModel = "deny";
  // prettier-ignore
  config.models.push({ id: "pi:off", harness: "pi", model: "off", efforts: ["medium"] });
  await saveConfig(config);
  // prettier-ignore
  const { deps, assertConsumed } = scripted({
    select: [answer("Rules", "edit"), answer("Allow callers to pick a model directly with --model?", "allow", (options) => { expect(options.initialValue).toBe("deny"); }), answer("Default model", "codex:sol"), answer("Default effort", "low")],
    text: [
      answer("claude cutoff percent used (blank = none)", "", (options) => { expect(options.initialValue).toBe("40"); expect(validate(options, "bad")).toBe("Enter a finite number"); }),
      answer("codex cutoff percent used (blank = none)", "60", (options) => expect(validate(options, "Infinity")).toBe("Enter a finite number")),
      answer("Confidential path globs, comma-separated (blank = none)", " **/secret/**, *.key "),
      answer("Confidential excluded providers, comma-separated", "openrouter, google"),
      answer("Confidence floor, 0 to 1 (below it the default model runs; 0.35 recommended)", "", (options) => expect(validate(options, "NaN")).toBe("Enter a finite number")),
    ],
    confirm: [answer("Check for updates once a day?", false), answer("Choose the Codex sandbox automatically from the task?", false), answer("Allow automatic Codex full-access sandbox?", false)],
    multiselect: [answer("Models that must be given a stopping point", ["claude:sonnet"], (options) => { expect((options.options as { value: string }[]).map(({ value }) => value)).toEqual(["claude:sonnet", "codex:sol"]); expect(options.initialValues).toEqual(["claude:sonnet"]); })],
  });
  await runInit({ section: "rules" }, deps);
  const saved = await loadConfig();
  expect(saved.rules).toMatchObject({
    quotaCutoffPercent: { codex: 60 },
    confidentialPathGlobs: ["**/secret/**", "*.key"],
    confidentialExcludedProviders: ["openrouter", "google"],
    confidenceFloor: 0.35,
    directModel: "allow",
    stoppingPointRequiredFor: ["claude:sonnet"],
  });
  expect(saved.defaultModelId).toBe("codex:sol");
  expect(saved.defaultEffort).toBe("low");
  expect(saved.updates?.check).toBe(false);
  expect(saved.spawn).toMatchObject({
    autoSandbox: false,
    allowFullAccess: false,
  });
  assertConsumed();
});

test.each(["editor", "claude", "codex", "skip"] as const)(
  "preferences seeds templates and handles %s",
  async (method) => {
    await setup(modelConfig());
    process.env[EDITOR_ENV] = "nano";
    const { deps, launches, assertConsumed } = scripted({
      select: [
        answer("Preferences", "edit"),
        answer("How do you want to edit preferences.md?", method, (options) =>
          expect(
            (options.options as { value: string }[]).map(({ value }) => value),
          ).toEqual(["editor", "claude", "codex", "skip"]),
        ),
      ],
    });
    deps.env = { ...deps.env, [EDITOR_ENV]: "nano" };
    await runInit({ section: "preferences" }, deps);
    expect(await readPreferences()).toBe(preferencesTemplate);
    expect(await readFile(join(directory, "guardrails.md"), "utf8")).toBe(
      guardrailsTemplate,
    );
    const preferencesPath = join(directory, "preferences.md");
    if (method === "editor")
      expect(launches).toEqual([["nano", preferencesPath]]);
    if (method === "skip") expect(launches).toEqual([]);
    if (method === "claude" || method === "codex") {
      expect(launches).toHaveLength(1);
      const argv = launches[0];
      const interview = method === "claude" ? argv[1] : argv[argv.length - 1];
      expect(interview).toContain(preferencesPath);
      expect(interview).toContain("claude:sonnet (efforts: medium)");
      expect(interview).toContain("codex:sol (efforts: low, high)");
      expect(interview).toContain("just seeded from the default template");
      expect(interview).not.toContain("{{");
      if (method === "claude")
        expect(argv).toEqual(["claude", interview, "--add-dir", directory]);
      else {
        // prettier-ignore
        expect(argv).toEqual(["codex", "-C", directory, "-s", "workspace-write", interview]);
      }
    }
    assertConsumed();
  },
);

test("existing preferences use refinement prompt and Keep as is leaves config unchanged", async () => {
  await setup(modelConfig());
  await writeFile(join(directory, "preferences.md"), "custom");
  const before = await readFile(join(directory, "config.json"), "utf8");
  const kept = scripted({ select: [answer("Authentication", "keep")] });
  await runInit({ section: "auth" }, kept.deps);
  expect(await readFile(join(directory, "config.json"), "utf8")).toBe(before);
  kept.assertConsumed();
  const edited = scripted({
    select: [
      answer("Preferences", "edit"),
      answer("How do you want to edit preferences.md?", "claude"),
    ],
  });
  await runInit({ section: "preferences" }, edited.deps);
  expect(await readPreferences()).toBe("custom");
  expect(edited.launches[0][1]).toContain(
    "already written; you are refining it",
  );
  edited.assertConsumed();
});

test("reset starts from defaults and cancel mid-section leaves saved config unchanged", async () => {
  await setup(modelConfig());
  const before = await readFile(join(directory, "config.json"), "utf8");
  const cancelled = scripted({
    select: [answer("Rules", "edit")],
    text: [
      answer("claude cutoff percent used (blank = none)", "12"),
      answer("codex cutoff percent used (blank = none)", CANCEL),
    ],
  });
  await runInit({ section: "rules" }, cancelled.deps);
  expect(await readFile(join(directory, "config.json"), "utf8")).toBe(before);
  expect(cancelled.notes).toContainEqual(["Setup cancelled", undefined]);
  cancelled.assertConsumed();
  const reset = scripted({});
  await runInit({ section: "models", reset: true }, reset.deps);
  expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  reset.assertConsumed();
});
