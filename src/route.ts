import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Config, HarnessName } from "./config.ts";
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
const STOPPING_POINT_INSTRUCTIONS =
  "Does this task state what finished looks like or where to stop?";
const STOPPING_POINT_THRESHOLD = 0.5;
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
    }));
}

function routeQuestions(candidates: RouteCandidate[]) {
  const modelCriteria = Object.fromEntries(
    candidates.map((candidate) => [
      candidate.id,
      `${candidate.harness} ${candidate.model}, ${candidate.auth ?? "default auth"}, supports ${candidate.efforts.join(", ")}`,
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
  };
}

function clampEffort(efforts: string[], selectedEffort: string): string {
  const selectedIndex = EFFORT_LEVELS.indexOf(selectedEffort);
  const supportedEfforts = efforts.filter(
    (effort) => EFFORT_LEVELS.indexOf(effort) <= selectedIndex,
  );
  return (
    supportedEfforts
      .toSorted(
        (left, right) =>
          EFFORT_LEVELS.indexOf(left) - EFFORT_LEVELS.indexOf(right),
      )
      .at(-1) ?? efforts[0]
  );
}

export function defaultRouteDeps(config: Config): RouteDeps {
  const client = new TypeSafeClient({
    apiKey: process.env[config.jev.apiKeyEnv],
  });
  return {
    config,
    client,
    doctor,
    getQuota,
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
    deps.getQuota(),
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
    if (confidential && candidate.model.startsWith("openrouter/")) return false;
    if (candidate.harness === "pi") return true;
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
  let response: JevResponse;
  try {
    response = await deps.client.systemOne({
      state,
      model: config.jev.model,
      questions: routeQuestions(candidates),
    });
  } catch (error) {
    return {
      pick: `${config.defaultModelId}@${config.defaultEffort}`,
      confidence: null,
      probabilities: {},
      effortProbabilities: {},
      reason: error instanceof Error ? error.message : String(error),
      fellBack: true,
      candidates: candidates.map(({ id }) => id),
      needsBrowser: null,
      statesStoppingPoint: null,
    };
  }
  const selectedModel = response.answers.model;
  const fallback =
    config.rules.confidenceFloor !== undefined &&
    selectedModel.confidence < config.rules.confidenceFloor;
  const reason =
    quotaUnavailable && config.rules.quotaCutoffPercent !== undefined
      ? "codexbar not installed; quota cutoff skipped"
      : "selected by Jev";
  return {
    pick: fallback
      ? `${config.defaultModelId}@${config.defaultEffort}`
      : `${selectedModel.choice}@${clampEffort(
          candidates.find(({ id }) => id === selectedModel.choice)?.efforts ??
            [],
          response.answers.effort.choice,
        )}`,
    confidence: selectedModel.confidence,
    probabilities: selectedModel.probabilities,
    effortProbabilities: response.answers.effort.probabilities,
    reason,
    fellBack: fallback,
    candidates: candidates.map(({ id }) => id),
    needsBrowser: response.answers.needsBrowser.noul,
    statesStoppingPoint: response.answers.statesStoppingPoint.noul,
  };
}
