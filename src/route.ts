import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import {
  applyQuotaLimits,
  fallbackCandidate,
  paceSummary,
  pinWarnings,
  weightedPick,
  type Exclusion,
} from "./balance.ts";
import {
  DEFAULT_HARNESS_CAPABILITIES,
  jevApiKeyEnv,
  ROUTE_POLICY_JEV,
  ROUTE_POLICY_JUDGMENTS,
  type Config,
  type HarnessName,
  type ModelConfig,
  type RoutePolicy,
} from "./config.ts";
import {
  cryptoRandom,
  drawExperiments,
  repoContext,
  type ExperimentArms,
  type RepoContext,
} from "./experiments.ts";
import {
  DIFFICULTY_CRITERIA,
  isDifficulty,
  judgmentPick,
  type Judgments,
} from "./judgments.ts";
import { recentModelOutcomes, type ModelOutcomes } from "./outcomes.ts";
import { listSessions } from "./sessions.ts";
import { doctor, type DoctorResult } from "./doctor.ts";
import { isMissingFile, record } from "./files.ts";
import { configDir, stateDir } from "./paths.ts";
import {
  readCachedQuota,
  ROUTE_QUOTA_MAX_AGE_MS,
  type QuotaReading,
  type QuotaSnapshot,
} from "./quota.ts";

const MAX_TASK_LENGTH = 8_000;
export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_ZDR_URL = `${OPENROUTER_API_BASE_URL}/v1/endpoints/zdr`;
export const OPENROUTER_SYSTEM_ONE_URL = `${OPENROUTER_API_BASE_URL}/v1/systemone`;
const OPENROUTER_ZDR_CACHE_FILE = "openrouter-zdr.json";
const OPENROUTER_ZDR_CACHE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OPENROUTER_PROVIDER_PREFIX = "openrouter/";
const PREFERENCES_FILE_NAME = "preferences.md";
const PREFERENCES_SNAPSHOT_DIRECTORY = "preferences";
const PICK_INSTRUCTIONS =
  "Pick the model that should run this task according to the user's preferences";
const EFFORT_INSTRUCTIONS = "Pick the reasoning effort this task needs";
const DIFFICULTY_INSTRUCTIONS =
  "How hard is this task for a coding agent working unsupervised?";
const TASTE_INSTRUCTIONS =
  "Does the quality of this task depend on taste: UI or UX, copy, API design, or code-quality judgment?";
const BROWSER_INSTRUCTIONS = "Does this task need a browser or screenshots?";
const NETWORK_INSTRUCTIONS =
  "Does this task need network access, such as installing packages, calling APIs, fetching documentation, or pushing to a remote?";
const FULL_ACCESS_INSTRUCTIONS =
  "Does this task need to write outside the working directory or run privileged operations such as docker, system services, or global installs? Treat iOS Simulator, simctl, XCUITest, UI-test execution and WebKit/WKWebView tests as requiring full access: workspace-write blocks CoreSimulator service access even with extra writable roots, and WebKit content rule-list compilation even with SwiftPM --disable-sandbox.";
const STOPPING_POINT_INSTRUCTIONS =
  "Does this task state what finished looks like or where to stop?";
const STOPPING_POINT_THRESHOLD = 0.5;
export const SANDBOX_THRESHOLD = 0.5;
export const CODEX_WORKSPACE_WRITE_SANDBOX = "workspace-write";
export const CODEX_DANGER_FULL_ACCESS_SANDBOX = "danger-full-access";
export const CODEX_NETWORK_ACCESS_OVERRIDE =
  "sandbox_workspace_write.network_access=true";
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
// Only for comparing efforts on retry --up; picking an effort still uses EFFORT_LEVELS.
const ESCALATION_EFFORT_ORDER = [...EFFORT_LEVELS, "ultra"];

export function isStrongerEffort(effort: string, than: string): boolean {
  return (
    ESCALATION_EFFORT_ORDER.indexOf(effort) >
    ESCALATION_EFFORT_ORDER.indexOf(than)
  );
}
export const ROUTE_RECORD_VERSION = 2;
const REASON_SEPARATOR = " · ";
const REASON_TOP_PROBABILITIES = 2;
const PINNED_REASON = "pinned by caller";
const ZDR_UNAVAILABLE_REASON = "OpenRouter ZDR list unavailable";
const ZDR_UNAVAILABLE_NOTICE =
  "OpenRouter ZDR list unavailable; OpenRouter candidates dropped";
const PREVIOUS_RESULT_TAIL_LENGTH = 2_000;

export type RouteOptions = {
  cwd?: string;
  hint?: string;
  confidential?: boolean;
  dryRun?: boolean;
  confined?: boolean;
  claudeOnly?: boolean;
  harnessOnly?: HarnessName;
  confinedCodexAvailable?: boolean;
  confinedCodexFailure?: string;
  appendSystemPromptFile?: string;
  previousAttempt?: PreviousAttempt;
  strongerThan?: { modelId: string; effort: string };
};
export type PreviousAttempt = {
  model: string;
  effort: string;
  status: string;
  error: string | null;
  resultTail: string;
  note: string | null;
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
  previousAttempt?: PreviousAttempt;
  // Present only when the matching experiment arm is on.
  repo?: RepoContext | null;
  recentOutcomes?: Record<string, ModelOutcomes>;
};
export type RouteDryRun = RouteState & {
  excluded: Exclusion[];
  limitsRelaxed: boolean;
  experiments: ExperimentArms;
};
type JevAnswers = {
  model: {
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  effort: { choice: string; probabilities: Record<string, number> };
  needsBrowser: number;
  statesStoppingPoint: number;
  needsNetwork: number;
  needsFullAccess: number;
  servedModel: string | null;
  // null when the reply lacks usable judgment answers; the model pick does not depend on them.
  judgments: Judgments | null;
};
export type JevClient = {
  // The reply is validated by parseJevReply, so a client may return anything.
  systemOne(request: {
    state: RouteState;
    model: string;
    questions: ReturnType<typeof routeQuestions>;
  }): Promise<unknown>;
};
export type RouteKind = "routed" | "pinned" | "fallback" | "refusal_fallback";
export type RouteInputs = {
  hint: string | null;
  quota: QuotaSnapshot | null;
  preferencesSha256: string | null;
  jevModel: string | null;
  jevServedModel: string | null;
  routingLatencyMs: number | null;
  quotaLatencyMs: number | null;
  // How old the quota reading was; 0 when it was fetched for this decision.
  quotaAgeMs: number | null;
};
export type RouteRecord = {
  version: typeof ROUTE_RECORD_VERSION;
  kind: RouteKind;
  pick: string;
  confidence: number | null;
  probabilities: Record<string, number>;
  effortProbabilities: Record<string, number>;
  reason: string;
  fellBack: boolean;
  candidates: string[];
  availableModels: string[];
  needsBrowser: number | null;
  statesStoppingPoint: number | null;
  needsNetwork: number | null;
  needsFullAccess: number | null;
  rawPick: string | null;
  weights: Record<string, number>;
  weightedScores: Record<string, number>;
  tiltChanged: boolean;
  lowConfidence: boolean;
  excluded: Exclusion[];
  limitsRelaxed: boolean;
  warnings: string[];
  inputs: RouteInputs;
  // Which policy made the pick, and what the others would have picked. Never run, only compared in stats.
  policy: RoutePolicy;
  // The judgment policy was configured but could not pick, so the weighted Jev pick ran instead.
  policyRelaxed: boolean;
  judgments: Judgments | null;
  shadow: RouteShadow | null;
  experiments: ExperimentArms;
};
export type RouteShadow = {
  rawJev: string | null;
  weighted: string | null;
  fixedDefault: string | null;
  judgments: string | null;
};
export type RouteDeps = {
  config: Config;
  client: JevClient;
  doctor: (config: Config) => Promise<DoctorResult>;
  getQuota: () => Promise<QuotaReading>;
  preferences: string | (() => Promise<string>);
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  random: () => number;
  repoContext: (cwd: string) => Promise<RepoContext | null>;
  savePreferences: (sha256: string, text: string) => Promise<void>;
  recentOutcomes: (
    modelIds: string[],
  ) => Promise<Record<string, ModelOutcomes>>;
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
  codexLocalhostNeedsNetwork?: boolean;
  routingRan: boolean;
  needsNetwork: number | null;
  needsBrowser: number | null;
  needsFullAccess: number | null;
}): CodexSandboxChoice {
  if (options.callerSandbox)
    return {
      sandbox: options.callerSandbox,
      usesNetworkAccess:
        options.callerSandbox === CODEX_WORKSPACE_WRITE_SANDBOX &&
        options.codexLocalhostNeedsNetwork === true,
    };
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
  if (
    options.configuredSandbox === CODEX_WORKSPACE_WRITE_SANDBOX &&
    options.codexLocalhostNeedsNetwork
  )
    return { sandbox: options.configuredSandbox, usesNetworkAccess: true };
  return { sandbox: options.configuredSandbox, usesNetworkAccess: false };
}

function toRouteCandidate(
  config: Config,
  { id, harness, model, efforts }: ModelConfig,
): RouteCandidate {
  return {
    id,
    harness,
    model,
    efforts,
    auth: config.harnesses[harness]?.auth ?? null,
    capabilities:
      config.harnesses[harness]?.capabilities ??
      DEFAULT_HARNESS_CAPABILITIES[harness],
  };
}

function expandCandidates(
  config: Config,
  candidateIds: Set<string>,
): RouteCandidate[] {
  return config.models
    .filter(({ id, efforts }) =>
      efforts.some((effort) => candidateIds.has(`${id}@${effort}`)),
    )
    .map((model) => toRouteCandidate(config, model));
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
    difficulty: choice(DIFFICULTY_INSTRUCTIONS, DIFFICULTY_CRITERIA),
    needsTaste: noul(TASTE_INSTRUCTIONS),
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
      const keyEnv = jevApiKeyEnv(config);
      const apiKey = process.env[keyEnv];
      if (!apiKey)
        throw new Error(
          `${keyEnv} is not set (needed by jev.provider=${config.jev.provider}; checked the environment and the smart-router .env files)`,
        );
      if (config.jev.provider === "openrouter" && config.jev.zdr) {
        const response = await fetch(OPENROUTER_SYSTEM_ONE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
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
        return payload;
      }
      const client = new TypeSafeClient({
        apiKey,
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
    getQuota: () => readCachedQuota(config, ROUTE_QUOTA_MAX_AGE_MS),
    random: cryptoRandom,
    repoContext,
    savePreferences: savePreferencesSnapshot,
    recentOutcomes: async (modelIds) =>
      recentModelOutcomes(await listSessions(), modelIds, Date.now()),
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

function preferencesSnapshotPath(sha256: string): string {
  return join(stateDir(), PREFERENCES_SNAPSHOT_DIRECTORY, `${sha256}.md`);
}

// Keeps the preferences text a route was decided with, once per distinct text, so a
// recorded decision can be replayed against the rules that were in force.
export async function savePreferencesSnapshot(
  sha256: string,
  text: string,
): Promise<void> {
  const path = preferencesSnapshotPath(sha256);
  const existing = await readPreferencesSnapshot(sha256);
  // A snapshot that does not hash to its name is damaged and is written again.
  if (existing !== null && sha256Of(existing) === sha256) return;
  await mkdir(dirname(path), { recursive: true });
  // Written under a temporary name and renamed, so a crash never leaves a truncated snapshot behind.
  const temporaryPath = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporaryPath, text);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function readPreferencesSnapshot(
  sha256: string,
): Promise<string | null> {
  try {
    return await readFile(preferencesSnapshotPath(sha256), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
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

function invalidJevReply(field: string): Error {
  return new Error(`Invalid Jev reply: ${field}`);
}

function jevProbability(value: unknown, field: string): number {
  // The comparison form also rejects NaN.
  if (typeof value !== "number" || !(value >= 0 && value <= 1))
    throw invalidJevReply(field);
  return value;
}

function jevChoice(
  value: unknown,
  field: string,
): { choice: string; probabilities: Record<string, number> } {
  const answer = record(value);
  if (typeof answer?.choice !== "string") throw invalidJevReply(field);
  const reported = record(answer.probabilities);
  if (!reported) throw invalidJevReply(`${field}.probabilities`);
  const probabilities: Record<string, number> = {};
  for (const [label, probability] of Object.entries(reported))
    probabilities[label] = jevProbability(
      probability,
      `${field}.probabilities.${label}`,
    );
  return { choice: answer.choice, probabilities };
}

export function parseJevReply(payload: unknown): JevAnswers {
  const reply = record(payload);
  const answers = record(reply?.answers);
  if (!answers) throw invalidJevReply("answers");
  const noul = (field: string) =>
    jevProbability(record(answers[field])?.noul, field);
  return {
    model: {
      ...jevChoice(answers.model, "model"),
      confidence: jevProbability(
        record(answers.model)?.confidence,
        "model.confidence",
      ),
    },
    effort: jevChoice(answers.effort, "effort"),
    needsBrowser: noul("needsBrowser"),
    statesStoppingPoint: noul("statesStoppingPoint"),
    needsNetwork: noul("needsNetwork"),
    needsFullAccess: noul("needsFullAccess"),
    servedModel: typeof reply?.model === "string" ? reply.model : null,
    judgments: jevJudgments(answers),
  };
}

function jevJudgments(answers: Record<string, unknown>): Judgments | null {
  try {
    const difficulty = jevChoice(answers.difficulty, "difficulty");
    if (!isDifficulty(difficulty.choice)) return null;
    return {
      difficulty: difficulty.choice,
      difficultyProbabilities: difficulty.probabilities,
      needsTaste: jevProbability(
        record(answers.needsTaste)?.noul,
        "needsTaste",
      ),
    };
  } catch {
    return null;
  }
}

type QuotaRead = {
  quota: QuotaSnapshot | null;
  quotaError: string | null;
  quotaLatencyMs: number | null;
  quotaAgeMs: number | null;
};

async function readQuota(config: Config, deps: RouteDeps): Promise<QuotaRead> {
  if (!config.quota.enabled)
    return {
      quota: null,
      quotaError: "quota disabled",
      quotaLatencyMs: null,
      quotaAgeMs: null,
    };
  const startedAt = performance.now();
  const { quota, ageMs } = await deps.getQuota();
  const quotaLatencyMs = Math.round(performance.now() - startedAt);
  if ("error" in quota)
    return {
      quota: null,
      quotaError: String(quota.error),
      quotaLatencyMs,
      quotaAgeMs: null,
    };
  return { quota, quotaError: null, quotaLatencyMs, quotaAgeMs: ageMs };
}

function isOpenRouterCandidate({ harness, model }: RouteCandidate): boolean {
  return harness === "pi" && model.startsWith(OPENROUTER_PROVIDER_PREFIX);
}

type ConfidentialContext = {
  confidential: boolean;
  zdrModels: Set<string> | null;
};

async function confidentialContext(
  config: Config,
  cwd: string,
  options: RouteOptions,
  candidates: RouteCandidate[],
  fetch: RouteDeps["fetch"],
): Promise<ConfidentialContext> {
  const confidential =
    Boolean(options.confidential) ||
    (config.rules.confidentialPathGlobs?.some((glob) =>
      new Bun.Glob(glob).match(cwd),
    ) ??
      false);
  const needsZdrList =
    confidential &&
    config.rules.confidentialRequireZdr &&
    candidates.some(isOpenRouterCandidate);
  return {
    confidential,
    zdrModels: needsZdrList
      ? await openRouterZdrModels(fetch ?? ((input) => globalThis.fetch(input)))
      : new Set<string>(),
  };
}

// Never relaxed, and applied to pins as well as routed picks.
function confidentialExclusionReason(
  candidate: RouteCandidate,
  context: ConfidentialContext,
  config: Config,
): string | null {
  if (!context.confidential) return null;
  const excludedByPattern = (
    config.rules.confidentialExcludedModels ?? []
  ).some((pattern) => new Bun.Glob(pattern).match(candidate.id));
  if (excludedByPattern) return "excluded for confidential work";
  if (!config.rules.confidentialRequireZdr || !isOpenRouterCandidate(candidate))
    return null;
  if (!context.zdrModels) return ZDR_UNAVAILABLE_REASON;
  const hasZdrEndpoint = context.zdrModels.has(
    candidate.model.slice(OPENROUTER_PROVIDER_PREFIX.length),
  );
  return hasZdrEndpoint ? null : "no zero-data-retention endpoint";
}

function scopeExclusionReason(
  candidate: RouteCandidate,
  options: RouteOptions,
): string | null {
  if (options.claudeOnly && candidate.harness !== "claude")
    return "the tool flags need a Claude model";
  if (options.harnessOnly && candidate.harness !== options.harnessOnly)
    return `outside harness scope ${options.harnessOnly}`;
  const confinedCapable =
    candidate.harness === "claude" ||
    (candidate.harness === "codex" && options.confinedCodexAvailable);
  if (options.confined && !confinedCapable)
    return "not available in confined mode";
  if (options.appendSystemPromptFile && candidate.harness === "pi")
    return "pi does not take an appended system prompt";
  return null;
}

// retry --up: a higher tier, or the same model limited to its higher efforts.
function strongerCandidates(
  candidates: RouteCandidate[],
  previous: NonNullable<RouteOptions["strongerThan"]>,
  config: Config,
): RouteCandidate[] {
  const tierOf = (modelId: string) =>
    config.models.find(({ id }) => id === modelId)?.tier;
  const previousTier = tierOf(previous.modelId);
  return candidates.flatMap((candidate) => {
    if (candidate.id === previous.modelId) {
      const effortRank = (effort: string) =>
        ESCALATION_EFFORT_ORDER.indexOf(effort);
      // Lowest first, so the smallest step up is the default when Jev asks for less.
      const higherEfforts = candidate.efforts
        .filter((effort) => isStrongerEffort(effort, previous.effort))
        .sort((left, right) => effortRank(left) - effortRank(right));
      return higherEfforts.length
        ? [{ ...candidate, efforts: higherEfforts }]
        : [];
    }
    const tier = tierOf(candidate.id);
    const isHigherTier =
      tier !== undefined && previousTier !== undefined && tier > previousTier;
    return isHigherTier ? [candidate] : [];
  });
}

export function previousAttemptFrom(
  attempt: {
    harness: HarnessName;
    model: string;
    effort: string;
    status: string;
    error?: string;
    lastResult?: string;
    result?: string;
  },
  note?: string,
): PreviousAttempt {
  return {
    model: `${attempt.harness}:${attempt.model}`,
    effort: attempt.effort,
    status: attempt.status,
    error: attempt.error ?? null,
    resultTail: (attempt.lastResult ?? attempt.result ?? "").slice(
      -PREVIOUS_RESULT_TAIL_LENGTH,
    ),
    note: note ?? null,
  };
}

function topProbabilities(probabilities: Record<string, number>): string {
  return Object.entries(probabilities)
    .sort(([, left], [, right]) => right - left)
    .slice(0, REASON_TOP_PROBABILITIES)
    .map(([id, probability]) => `${id} ${probability.toFixed(2)}`)
    .join(", ");
}

function joinReason(parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(REASON_SEPARATOR);
}

export type RouteSummary = Pick<
  RouteRecord,
  "kind" | "pick" | "reason" | "warnings" | "tiltChanged" | "lowConfidence"
>;

// The part of a route record that events and session lists carry; undefined for older records.
export function routeSummary(value: unknown): RouteSummary | undefined {
  if (!isRouteRecord(value)) return undefined;
  const { kind, pick, reason, warnings, tiltChanged, lowConfidence } = value;
  return { kind, pick, reason, warnings, tiltChanged, lowConfidence };
}

export function isRouteRecord(value: unknown): value is RouteRecord {
  return record(value)?.version === ROUTE_RECORD_VERSION;
}

export async function route(
  prompt: string,
  options: RouteOptions,
  deps: RouteDeps,
): Promise<RouteDryRun | RouteRecord> {
  const config = deps.config;
  const cwd = options.cwd ?? process.cwd();
  const [detection, quotaRead, preferenceSource] = await Promise.all([
    deps.doctor(config),
    readQuota(config, deps),
    Promise.resolve(deps.preferences),
  ]);
  const preferences =
    typeof preferenceSource === "function"
      ? await preferenceSource()
      : preferenceSource;
  const { quota } = quotaRead;
  const configuredCandidates = expandCandidates(
    config,
    new Set(detection.candidates),
  ).filter(
    ({ harness, id }) =>
      config.harnesses[harness]?.enabled && !config.ignoredModels.includes(id),
  );
  const confidentiality = await confidentialContext(
    config,
    cwd,
    options,
    configuredCandidates,
    deps.fetch,
  );
  const excluded: Exclusion[] = [];
  const scoped = configuredCandidates.filter((candidate) => {
    const scopeReason = scopeExclusionReason(candidate, options);
    const confidentialReason = confidentialExclusionReason(
      candidate,
      confidentiality,
      config,
    );
    if (scopeReason)
      excluded.push({ id: candidate.id, reason: scopeReason, kind: "scope" });
    else if (confidentialReason)
      excluded.push({
        id: candidate.id,
        reason: confidentialReason,
        kind: "confidential",
      });
    return !scopeReason && !confidentialReason;
  });
  const previous = options.strongerThan;
  const escalated = previous
    ? strongerCandidates(scoped, previous, config)
    : scoped;
  if (previous && escalated.length === 0)
    throw new Error(
      `no available candidate is stronger than ${previous.modelId}@${previous.effort}; give models a higher tier in config or drop --up`,
    );
  if (previous)
    excluded.push(
      ...scoped
        .filter(({ id }) => !escalated.some((kept) => kept.id === id))
        .map(({ id }) => ({
          id,
          reason: `not stronger than ${previous.modelId}@${previous.effort}`,
          kind: "escalation" as const,
        })),
    );
  const limits = applyQuotaLimits(escalated, quota, config.rules);
  excluded.push(...limits.excluded);
  const candidates = limits.eligible;
  const experiments = drawExperiments(
    config.rules.experiments ?? {},
    deps.random,
  );
  const state: RouteState = {
    preferences,
    task: prompt.slice(0, MAX_TASK_LENGTH),
    hint: options.hint ?? null,
    cwd,
    quota,
    candidates,
    ...(options.previousAttempt
      ? { previousAttempt: options.previousAttempt }
      : {}),
    ...(experiments.repoContext === "on"
      ? { repo: await deps.repoContext(cwd) }
      : {}),
    ...(experiments.outcomeFeedback === "on"
      ? {
          recentOutcomes: await deps.recentOutcomes(
            candidates.map(({ id }) => id),
          ),
        }
      : {}),
  };
  if (candidates.length === 0 && options.harnessOnly)
    throw new Error(
      `No route candidates available for harness ${options.harnessOnly}`,
    );
  if (options.dryRun)
    return {
      ...state,
      excluded,
      limitsRelaxed: limits.limitsRelaxed,
      experiments,
    };
  if (candidates.length === 0)
    throw new Error(
      options.confined
        ? "confined mode needs Claude or verified Codex; none is available"
        : "No route candidates available",
    );
  const providersWithoutQuota = quota
    ? Object.keys(quota).filter(
        (harness) => quota[harness as HarnessName] === null,
      )
    : [];
  const notices = [
    limits.excluded.length > 0 &&
      `quota limits excluded ${limits.excluded.length} of ${escalated.length} candidates: ${[...new Set(limits.excluded.map(({ reason }) => reason))].join("; ")}`,
    limits.limitsRelaxed &&
      `every candidate was over a quota cutoff; limits relaxed to the least-used pool (${candidates[0].harness})`,
    excluded.some(({ reason }) => reason === ZDR_UNAVAILABLE_REASON) &&
      ZDR_UNAVAILABLE_NOTICE,
    quotaRead.quotaError &&
      `${quotaRead.quotaError}; quota limits and pace tilt skipped`,
    providersWithoutQuota.length > 0 &&
      `no quota reading for ${providersWithoutQuota.join(", ")}; its limits and pace tilt skipped`,
    options.confinedCodexFailure,
  ];
  const base = {
    version: ROUTE_RECORD_VERSION,
    candidates: candidates.map(({ id }) => id),
    availableModels: detection.availableModels,
    excluded,
    limitsRelaxed: limits.limitsRelaxed,
    experiments,
  } as const;
  const policy = config.rules.policy ?? ROUTE_POLICY_JEV;
  const preferencesSha256 = sha256Of(preferences);
  await deps.savePreferences(preferencesSha256, preferences);
  const inputs = {
    hint: state.hint,
    quota,
    preferencesSha256,
    jevModel: config.jev.model,
    quotaLatencyMs: quotaRead.quotaLatencyMs,
    quotaAgeMs: quotaRead.quotaAgeMs,
  };
  const jevStartedAt = performance.now();
  const routingLatency = () => Math.round(performance.now() - jevStartedAt);
  try {
    const answers = parseJevReply(
      await deps.client.systemOne({
        state,
        model: config.jev.model,
        questions: routeQuestions(candidates),
      }),
    );
    const routingLatencyMs = routingLatency();
    const weighted = weightedPick(
      candidates,
      answers.model.probabilities,
      quota,
      config.rules.paceTilt,
    );
    const weightedCandidate = candidates.find(({ id }) => id === weighted.pick);
    if (!weightedCandidate)
      throw new Error(
        `Jev picked ${answers.model.choice} and gave no probability to an eligible candidate`,
      );
    // Judged over the candidates before quota limits, so a full pool cannot erase the tier or taste requirement.
    const judgment = answers.judgments
      ? judgmentPick(escalated, answers.judgments, config, quota)
      : { pick: null, limitsRelaxed: false };
    const judgmentsCandidate = escalated.find(({ id }) => id === judgment.pick);
    const usesJudgments =
      policy === ROUTE_POLICY_JUDGMENTS && judgmentsCandidate !== undefined;
    const policyRelaxed = policy === ROUTE_POLICY_JUDGMENTS && !usesJudgments;
    const judgmentLimitsRelaxed = usesJudgments && judgment.limitsRelaxed;
    const picked =
      usesJudgments && judgmentsCandidate
        ? judgmentsCandidate
        : weightedCandidate;
    const pickWithEffort = (candidate: RouteCandidate) => {
      const escalatingSameModel =
        candidate.id === previous?.modelId &&
        !candidate.efforts.includes(answers.effort.choice);
      const effort = escalatingSameModel
        ? candidate.efforts[0]
        : clampEffort(candidate.efforts, answers.effort.choice);
      return `${candidate.id}@${effort}`;
    };
    const shadowPick = (candidate: RouteCandidate | undefined) =>
      candidate ? pickWithEffort(candidate) : null;
    const tiltChanged = weightedCandidate.id !== weighted.untiltedPick;
    const policyWarnings = policyRelaxed
      ? [
          answers.judgments
            ? `no candidate meets the judgment policy's requirement (${answers.judgments.difficulty}, taste ${answers.judgments.needsTaste.toFixed(2)}) even without quota limits; used the weighted Jev pick`
            : "Jev gave no usable difficulty or taste judgment; used the weighted Jev pick",
        ]
      : [];
    const confidenceFloor = config.rules.confidenceFloor;
    const lowConfidence =
      confidenceFloor !== undefined &&
      answers.model.confidence < confidenceFloor;
    return {
      ...base,
      kind: "routed",
      pick: pickWithEffort(picked),
      confidence: answers.model.confidence,
      probabilities: answers.model.probabilities,
      effortProbabilities: answers.effort.probabilities,
      reason: joinReason([
        usesJudgments &&
          `Judgments: ${answers.judgments?.difficulty}, taste ${answers.judgments?.needsTaste.toFixed(2)} picked ${picked.id}`,
        `Jev: ${topProbabilities(answers.model.probabilities)}`,
        paceSummary(quota),
        tiltChanged && `tilt changed pick from ${weighted.untiltedPick}`,
        lowConfidence &&
          `low confidence ${answers.model.confidence.toFixed(2)} (floor ${confidenceFloor.toFixed(2)})`,
        judgmentLimitsRelaxed &&
          "every model meeting the judgment requirement was over a quota cutoff; limits relaxed within those models",
        ...notices,
      ]),
      fellBack: false,
      needsBrowser: answers.needsBrowser,
      statesStoppingPoint: answers.statesStoppingPoint,
      needsNetwork: answers.needsNetwork,
      needsFullAccess: answers.needsFullAccess,
      rawPick: answers.model.choice,
      weights: weighted.weights,
      weightedScores: weighted.weightedScores,
      tiltChanged,
      lowConfidence,
      limitsRelaxed: limits.limitsRelaxed || judgmentLimitsRelaxed,
      policyRelaxed,
      warnings: policyWarnings,
      inputs: {
        ...inputs,
        jevServedModel: answers.servedModel,
        routingLatencyMs,
      },
      policy: usesJudgments ? ROUTE_POLICY_JUDGMENTS : ROUTE_POLICY_JEV,
      judgments: answers.judgments,
      shadow: {
        rawJev: shadowPick(
          candidates.find(({ id }) => id === answers.model.choice),
        ),
        weighted: pickWithEffort(weightedCandidate),
        fixedDefault: config.defaultModelId
          ? `${config.defaultModelId}@${config.defaultEffort}`
          : null,
        judgments: shadowPick(judgmentsCandidate),
      },
    };
  } catch (error) {
    const fallback = fallbackCandidate(
      candidates,
      config.defaultModelId,
      quota,
    );
    const fallbackEffort = fallback.efforts.includes(config.defaultEffort)
      ? config.defaultEffort
      : fallback.efforts[0];
    return {
      ...base,
      kind: "fallback",
      pick: `${fallback.id}@${fallbackEffort}`,
      confidence: null,
      probabilities: {},
      effortProbabilities: {},
      reason: joinReason([
        `fallback to ${fallback.id}: ${error instanceof Error ? error.message : String(error)}`,
        paceSummary(quota),
        ...notices,
      ]),
      fellBack: true,
      needsBrowser: null,
      statesStoppingPoint: null,
      needsNetwork: null,
      needsFullAccess: null,
      rawPick: null,
      weights: {},
      weightedScores: {},
      tiltChanged: false,
      lowConfidence: false,
      warnings: [],
      inputs: {
        ...inputs,
        jevServedModel: null,
        routingLatencyMs: routingLatency(),
      },
      policy: ROUTE_POLICY_JEV,
      policyRelaxed: false,
      judgments: null,
      shadow: null,
    };
  }
}

// A concrete --model pin skips Jev, but still has to pass the confidential filters,
// and reads quota so the caller is told when the pin works against the balance.
export async function pinnedRoute(
  model: ModelConfig,
  effort: string,
  options: RouteOptions,
  deps: RouteDeps,
): Promise<RouteRecord> {
  const config = deps.config;
  const candidate = toRouteCandidate(config, model);
  const confidentiality = await confidentialContext(
    config,
    options.cwd ?? process.cwd(),
    options,
    [candidate],
    deps.fetch,
  );
  const exclusion = confidentialExclusionReason(
    candidate,
    confidentiality,
    config,
  );
  if (exclusion)
    throw new Error(
      `${model.id} cannot be pinned for confidential work: ${exclusion}`,
    );
  const { quota, quotaLatencyMs, quotaAgeMs } = await readQuota(config, deps);
  const warnings = pinWarnings(candidate, quota, config);
  return {
    version: ROUTE_RECORD_VERSION,
    kind: "pinned",
    pick: `${model.id}@${effort}`,
    confidence: null,
    probabilities: {},
    effortProbabilities: {},
    reason: joinReason([PINNED_REASON, ...warnings]),
    fellBack: false,
    candidates: [model.id],
    availableModels: [],
    needsBrowser: null,
    statesStoppingPoint: null,
    needsNetwork: null,
    needsFullAccess: null,
    rawPick: null,
    weights: {},
    weightedScores: {},
    tiltChanged: false,
    lowConfidence: false,
    excluded: [],
    limitsRelaxed: false,
    warnings,
    policy: ROUTE_POLICY_JEV,
    policyRelaxed: false,
    judgments: null,
    shadow: null,
    experiments: {},
    inputs: {
      hint: options.hint ?? null,
      quota,
      preferencesSha256: null,
      jevModel: null,
      jevServedModel: null,
      routingLatencyMs: null,
      quotaLatencyMs,
      quotaAgeMs,
    },
  };
}
