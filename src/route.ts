import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import {
  DEFAULT_HARNESS_CAPABILITIES,
  type Config,
  type HarnessName,
} from "./config.ts";
import { doctor, type DoctorResult } from "./doctor.ts";
import { isMissingFile } from "./files.ts";
import { configDir, stateDir } from "./paths.ts";
import { getQuota, type QuotaResult, type QuotaSnapshot } from "./quota.ts";

const MAX_TASK_LENGTH = 8_000;
export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_ZDR_URL = `${OPENROUTER_API_BASE_URL}/v1/endpoints/zdr`;
export const OPENROUTER_SYSTEM_ONE_URL = `${OPENROUTER_API_BASE_URL}/v1/systemone`;
const OPENROUTER_ZDR_CACHE_FILE = "openrouter-zdr.json";
const OPENROUTER_ZDR_CACHE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OPENROUTER_PROVIDER_PREFIX = "openrouter/";
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
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
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

export function routeQuestions(candidates: RouteCandidate[]) {
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

export function defaultRouteDeps(
  config: Config,
  fetch: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
): RouteDeps {
  const lazyClient: JevClient = {
    systemOne: async (request) => {
      if (config.jev.provider === "openrouter" && config.jev.zdr) {
        const response = await fetch(OPENROUTER_SYSTEM_ONE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env[config.jev.apiKeyEnv] ?? ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: request.model,
            state: request.state,
            questions: request.questions,
            provider: { zdr: true },
          }),
        });
        if (!response.ok)
          throw new Error(`Jev request failed: ${response.status}`);
        const payload = await response.json();
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("answers" in payload)
        )
          throw new Error("Invalid Jev response");
        return payload as JevResponse;
      }
      const client = new TypeSafeClient({
        apiKey: process.env[config.jev.apiKeyEnv],
        ...(config.jev.provider === "openrouter"
          ? { baseURL: OPENROUTER_API_BASE_URL }
          : {}),
      });
      return client.systemOne(request);
    },
  };
  return {
    config,
    client: lazyClient,
    fetch,
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

async function openRouterZdrModels(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<Set<string> | null> {
  const cachePath = join(stateDir(), OPENROUTER_ZDR_CACHE_FILE);
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as string[];
    if (
      Date.now() - (await stat(cachePath)).mtimeMs <
      OPENROUTER_ZDR_CACHE_INTERVAL_MS
    )
      return new Set(cached);
  } catch {}
  try {
    const response = await fetch(OPENROUTER_ZDR_URL);
    if (!response.ok)
      throw new Error(`OpenRouter ZDR check failed: ${response.status}`);
    const payload = (await response.json()) as {
      data?: { model_id?: string }[];
    };
    const models = (payload.data ?? []).flatMap(({ model_id }) =>
      model_id ? [model_id] : [],
    );
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(models));
    return new Set(models);
  } catch {
    return null;
  }
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
  const configuredCandidates = expandCandidates(
    config,
    new Set(detection.candidates),
  );
  const hasOpenRouterCandidates = configuredCandidates.some(
    ({ harness, model }) =>
      harness === "pi" && model.startsWith(OPENROUTER_PROVIDER_PREFIX),
  );
  const zdrModels =
    confidential &&
    config.rules.confidentialRequireZdr &&
    hasOpenRouterCandidates
      ? await openRouterZdrModels(
          deps.fetch ?? ((input) => globalThis.fetch(input)),
        )
      : new Set<string>();
  let zdrUnavailable = false;
  const candidates = configuredCandidates.filter((candidate) => {
    if (
      confidential &&
      (config.rules.confidentialExcludedModels ?? []).some((pattern) =>
        new Bun.Glob(pattern).match(candidate.id),
      )
    )
      return false;
    if (
      confidential &&
      config.rules.confidentialRequireZdr &&
      candidate.harness === "pi" &&
      candidate.model.startsWith(OPENROUTER_PROVIDER_PREFIX)
    ) {
      if (!zdrModels) {
        zdrUnavailable = true;
        return false;
      }
      if (
        !zdrModels.has(candidate.model.slice(OPENROUTER_PROVIDER_PREFIX.length))
      )
        return false;
    }
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
  const selectedModelIsCandidate = candidates.some(
    ({ id }) => id === selectedModel.choice,
  );
  const confidenceFallback =
    config.rules.confidenceFloor !== undefined &&
    selectedModel.confidence < config.rules.confidenceFloor;
  const fallbackRequired =
    !eligibleDefault || !selectedModelIsCandidate || confidenceFallback;
  const reasons = [];
  if (zdrUnavailable)
    reasons.push(
      "OpenRouter ZDR list unavailable; OpenRouter candidates dropped",
    );
  if (!config.quota.enabled) reasons.push("quota disabled");
  if (quotaUnavailable && config.rules.quotaCutoffPercent !== undefined)
    reasons.push("codexbar not installed; quota cutoff skipped");
  if (fallbackReason) reasons.push(fallbackReason);
  if (!selectedModelIsCandidate)
    reasons.push(
      `Jev picked ${selectedModel.choice}, which is not a candidate`,
    );
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
