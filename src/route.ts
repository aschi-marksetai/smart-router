import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import {
  DEFAULT_CONFIDENTIAL_EXCLUDED_PROVIDERS,
  DEFAULT_HARNESS_CAPABILITIES,
  type Config,
  type HarnessName,
} from "./config.ts";
import { doctor, type DoctorResult } from "./doctor.ts";
import { isMissingFile } from "./files.ts";
import { configDir } from "./paths.ts";
import { getQuota, type QuotaResult, type QuotaSnapshot } from "./quota.ts";

const MAX_TASK_LENGTH = 8_000;
const PREFERENCES_FILE_NAME = "preferences.md";
const PICK_INSTRUCTIONS =
  "Pick the model that should run this task according to the user's preferences";
const EFFORT_INSTRUCTIONS = "Pick the reasoning effort this task needs";
const BROWSER_INSTRUCTIONS = "Does this task need a browser or screenshots?";
const NETWORK_INSTRUCTIONS =
  "Does this task need network access, such as installing packages, calling APIs, fetching documentation, or pushing to a remote?";
const FULL_ACCESS_INSTRUCTIONS =
  "Does this task need to write outside the working directory or run privileged operations such as docker, system services, or global installs?";
const STOPPING_POINT_INSTRUCTIONS =
  "Does this task state what finished looks like or where to stop?";
const STOPPING_POINT_THRESHOLD = 0.5;
export const SANDBOX_THRESHOLD = 0.5;
export const CODEX_WORKSPACE_WRITE_SANDBOX = "workspace-write";
export const CODEX_DANGER_FULL_ACCESS_SANDBOX = "danger-full-access";
export const CODEX_NETWORK_ACCESS_OVERRIDE =
  "sandbox_workspace_write.network_access=true";
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export type RouteOptions = {
  cwd?: string;
  hint?: string;
  confidential?: boolean;
  dryRun?: boolean;
};
export type RouteCandidate = {
  id: string;
  harness: HarnessName;
  model: string;
  efforts: string[];
  auth: "subscription" | "api-key" | null;
  capabilities: string;
};
export type RouteState = {
  preferences: string;
  task: string;
  hint: string | null;
  cwd: string;
  quota: QuotaSnapshot | null;
  candidates: RouteCandidate[];
};
type JevResponse = {
  answers: {
    model: {
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
    effort: { choice: string; probabilities: Record<string, number> };
    needsBrowser: { noul: number };
    statesStoppingPoint: { noul: number };
    needsNetwork: { noul: number };
    needsFullAccess: { noul: number };
  };
};
export type JevClient = {
  systemOne(request: {
    state: RouteState;
    model: string;
    questions: ReturnType<typeof routeQuestions>;
  }): Promise<JevResponse>;
};
export type RouteDeps = {
  config: Config;
  client: JevClient;
  doctor: (config: Config) => Promise<DoctorResult>;
  getQuota: () => Promise<QuotaResult>;
  preferences: string | (() => Promise<string>);
};
export type CodexSandboxChoice = {
  sandbox: string;
  usesNetworkAccess: boolean;
};

export function shouldUseClaudeBrowser(
  harness: HarnessName,
  requested: boolean | undefined,
  needsBrowser: number | null,
): boolean {
  return (
    harness === "claude" &&
    (requested === true || (needsBrowser ?? 0) > SANDBOX_THRESHOLD)
  );
}

export function chooseCodexSandbox(options: {
  configuredSandbox: string;
  callerSandbox?: string;
  autoSandbox: boolean;
  allowFullAccess: boolean;
  routingRan: boolean;
  needsNetwork: number | null;
  needsBrowser: number | null;
  needsFullAccess: number | null;
}): CodexSandboxChoice {
  if (options.callerSandbox)
    return { sandbox: options.callerSandbox, usesNetworkAccess: false };
  const canUseRouteScores = options.autoSandbox && options.routingRan;
  const needsFullAccess =
    canUseRouteScores &&
    options.allowFullAccess &&
    ((options.needsFullAccess ?? 0) > SANDBOX_THRESHOLD ||
      (options.needsBrowser ?? 0) > SANDBOX_THRESHOLD);
  if (needsFullAccess)
    return {
      sandbox: CODEX_DANGER_FULL_ACCESS_SANDBOX,
      usesNetworkAccess: false,
    };
  const needsNetwork =
    canUseRouteScores && (options.needsNetwork ?? 0) > SANDBOX_THRESHOLD;
  if (needsNetwork)
    return { sandbox: options.configuredSandbox, usesNetworkAccess: true };
  return { sandbox: options.configuredSandbox, usesNetworkAccess: false };
}

function expandCandidates(
  config: Config,
  candidateIds: Set<string>,
): RouteCandidate[] {
  return config.models
    .filter(({ id, efforts }) =>
      efforts.some((effort) => candidateIds.has(`${id}@${effort}`)),
    )
    .map(({ id, harness, model, efforts }) => ({
      id,
      harness,
      model,
      efforts,
      auth: config.harnesses[harness]?.auth ?? null,
      capabilities:
        config.harnesses[harness]?.capabilities ??
        DEFAULT_HARNESS_CAPABILITIES[harness],
    }));
}

function capabilitiesNote(capabilities: string): string {
  return capabilities ? `; capabilities: ${capabilities}` : "";
}

function routeQuestions(candidates: RouteCandidate[]) {
  const modelCriteria = Object.fromEntries(
    candidates.map((candidate) => [
      candidate.id,
      `${candidate.harness} ${candidate.model}, ${candidate.auth ?? "default auth"}, supports ${candidate.efforts.join(", ")}${capabilitiesNote(candidate.capabilities)}`,
    ]),
  );
  const efforts = [
    ...new Set(candidates.flatMap((candidate) => candidate.efforts)),
  ];
  const effortCriteria = Object.fromEntries(
    efforts.map((effort) => [effort, `Reasoning effort: ${effort}`]),
  );
  return {
    model: choice(PICK_INSTRUCTIONS, modelCriteria),
    effort: choice(EFFORT_INSTRUCTIONS, effortCriteria),
    needsBrowser: noul(BROWSER_INSTRUCTIONS),
    statesStoppingPoint: noul(STOPPING_POINT_INSTRUCTIONS),
    needsNetwork: noul(NETWORK_INSTRUCTIONS),
    needsFullAccess: noul(FULL_ACCESS_INSTRUCTIONS),
  };
}

function clampEffort(efforts: string[], selectedEffort: string): string {
  if (efforts.includes(selectedEffort)) return selectedEffort;
  const selectedIndex = EFFORT_LEVELS.indexOf(selectedEffort);
  if (selectedIndex >= 0) {
    const supported = efforts.filter((effort) => {
      const index = EFFORT_LEVELS.indexOf(effort);
      return index >= 0 && index <= selectedIndex;
    });
    if (supported.length)
      return supported.reduce((best, effort) =>
        EFFORT_LEVELS.indexOf(effort) > EFFORT_LEVELS.indexOf(best)
          ? effort
          : best,
      );
  }
  return efforts[Math.floor(efforts.length / 2)] ?? efforts[0];
}

export function defaultRouteDeps(config: Config): RouteDeps {
  const lazyClient: JevClient = {
    systemOne: (request) =>
      new TypeSafeClient({
        apiKey: process.env[config.jev.apiKeyEnv],
      }).systemOne(request),
  };
  return {
    config,
    client: lazyClient,
    doctor,
    getQuota: () => getQuota(config),
    preferences: async () => {
      try {
        return await readFile(join(configDir(), PREFERENCES_FILE_NAME), "utf8");
      } catch (error) {
        if (isMissingFile(error)) return "";
        throw error;
      }
    },
  };
}

export function needsStoppingPoint(
  config: Config,
  result: {
    pick: string;
    fellBack: boolean;
    statesStoppingPoint: number | null;
  },
): boolean {
  const modelId = result.pick.split("@", 1)[0];
  return (
    !result.fellBack &&
    result.statesStoppingPoint !== null &&
    result.statesStoppingPoint < STOPPING_POINT_THRESHOLD &&
    (config.rules.stoppingPointRequiredFor?.includes(modelId) ?? false)
  );
}

export async function route(
  prompt: string,
  options: RouteOptions,
  deps: RouteDeps,
) {
  const config = deps.config;
  const cwd = options.cwd ?? process.cwd();
  const [detection, quotaResult, preferenceSource] = await Promise.all([
    deps.doctor(config),
    config.quota.enabled
      ? deps.getQuota()
      : Promise.resolve({ error: "quota disabled" as const }),
    Promise.resolve(deps.preferences),
  ]);
  const preferences =
    typeof preferenceSource === "function"
      ? await preferenceSource()
      : preferenceSource;
  const quotaUnavailable = "error" in quotaResult;
  const quota = quotaUnavailable ? null : quotaResult;
  const confidential =
    Boolean(options.confidential) ||
    (config.rules.confidentialPathGlobs?.some((glob) =>
      new Bun.Glob(glob).match(cwd),
    ) ??
      false);
  const candidates = expandCandidates(
    config,
    new Set(detection.candidates),
  ).filter((candidate) => {
    if (
      confidential &&
      (
        config.rules.confidentialExcludedProviders ??
        DEFAULT_CONFIDENTIAL_EXCLUDED_PROVIDERS
      ).some((provider) => candidate.model.startsWith(`${provider}/`))
    )
      return false;
    const cutoff = config.rules.quotaCutoffPercent?.[candidate.harness];
    const usage = quota?.[candidate.harness] ?? null;
    return (
      cutoff === undefined || usage === null || usage.weeklyUsedPercent < cutoff
    );
  });
  const state: RouteState = {
    preferences,
    task: prompt.slice(0, MAX_TASK_LENGTH),
    hint: options.hint ?? null,
    cwd,
    quota,
    candidates,
  };
  if (options.dryRun) return state;
  if (candidates.length === 0) throw new Error("No route candidates available");
  const eligibleDefault = candidates.some(
    ({ id }) => id === config.defaultModelId,
  );
  const fallbackCandidate = eligibleDefault
    ? candidates.find(({ id }) => id === config.defaultModelId)!
    : candidates[0];
  const fallbackEffort = fallbackCandidate.efforts.includes(
    config.defaultEffort,
  )
    ? config.defaultEffort
    : fallbackCandidate.efforts[0];
  const fallbackReason = eligibleDefault
    ? ""
    : `default model unavailable; using ${fallbackCandidate.id}`;
  let response: JevResponse;
  try {
    response = await deps.client.systemOne({
      state,
      model: config.jev.model,
      questions: routeQuestions(candidates),
    });
  } catch (error) {
    return {
      pick: `${fallbackCandidate.id}@${fallbackEffort}`,
      confidence: null,
      probabilities: {},
      effortProbabilities: {},
      reason: [
        config.quota.enabled ? "" : "quota disabled",
        fallbackReason,
        error instanceof Error ? error.message : String(error),
      ]
        .filter(Boolean)
        .join("; "),
      fellBack: true,
      candidates: candidates.map(({ id }) => id),
      availableModels: detection.availableModels,
      needsBrowser: null,
      statesStoppingPoint: null,
      needsNetwork: null,
      needsFullAccess: null,
    };
  }
  const selectedModel = response.answers.model;
  const fallback =
    config.rules.confidenceFloor !== undefined &&
    selectedModel.confidence < config.rules.confidenceFloor;
  const fallbackRequired = !eligibleDefault || fallback;
  const reasons = [];
  if (!config.quota.enabled) reasons.push("quota disabled");
  if (quotaUnavailable && config.rules.quotaCutoffPercent !== undefined)
    reasons.push("codexbar not installed; quota cutoff skipped");
  if (fallbackReason) reasons.push(fallbackReason);
  const reason = reasons.length ? reasons.join("; ") : "selected by Jev";
  return {
    pick: fallbackRequired
      ? `${fallbackCandidate.id}@${fallbackEffort}`
      : `${selectedModel.choice}@${clampEffort(
          candidates.find(({ id }) => id === selectedModel.choice)?.efforts ??
            [],
          response.answers.effort.choice,
        )}`,
    confidence: selectedModel.confidence,
    probabilities: selectedModel.probabilities,
    effortProbabilities: response.answers.effort.probabilities,
    reason,
    fellBack: fallbackRequired,
    candidates: candidates.map(({ id }) => id),
    availableModels: detection.availableModels,
    needsBrowser: response.answers.needsBrowser.noul,
    statesStoppingPoint: response.answers.statesStoppingPoint.noul,
    needsNetwork: response.answers.needsNetwork.noul,
    needsFullAccess: response.answers.needsFullAccess.noul,
  };
}
