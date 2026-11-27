import {
  DEFAULT_EXPERIMENTS,
  ROUTE_POLICY_JUDGMENTS,
  type ExperimentName,
  type HarnessName,
} from "./config.ts";
import {
  retriesByOriginal,
  sessionOutcome,
  type SessionOutcome,
} from "./outcomes.ts";
import { listCostUsd, type PricingCatalog } from "./pricing.ts";
import type { QuotaSnapshot } from "./quota.ts";
import { isRouteRecord, type RouteRecord, type RouteShadow } from "./route.ts";
import type { Session } from "./sessions.ts";

export const DEFAULT_STATS_DAYS = 7;
// One model taking this share of routed picks means the router has stopped choosing.
export const COLLAPSE_SHARE = 0.9;
// Below this many routed picks a 90% share is noise, not collapse.
export const COLLAPSE_MINIMUM_ROUTED = 10;
const DAY_MS = 24 * 60 * 60 * 1_000;
const QUOTA_WINDOW_MS = 7 * DAY_MS;
const FULL_PERCENT = 100;
const PERCENT_DECIMALS = 10;
const UNLABELED = "(none)";
const COST_SOURCE_LABELS: Record<GroupStats["costSource"], string> = {
  harness: "harness-reported",
  listPrice: "list price",
  mixed: "harness-reported and list price",
  none: "no cost",
};

export type StatsWindow = {
  label: string;
  from: string;
  to: string;
  // Days to ask CodexBar's rolling cost report for; null when the window does not end now.
  rollingDays: number | null;
};
export type StatsWindowOptions = {
  days?: number;
  window?: "current" | "previous";
};
export type StatsEntry = {
  session: Session;
  modelId: string;
  route: RouteRecord | null;
  outcome: SessionOutcome;
  // What the harness reported when it reports a cost (Claude does), else the computed list cost.
  costUsd: number | null;
  costSource: CostSource | null;
  // The same, with a computed cost taken at the long-context rate: the most the tokens could have cost.
  costUpperBoundUsd: number | null;
  // Always the computed list cost, so replay can compare models on one basis.
  listCostUsd: number | null;
  // A retry without its own label or phase counts under the original's.
  label: string | null;
  phase: string | null;
  retriedBy: string[];
};
type OutcomeRates = {
  sessions: number;
  failedPercent: number | null;
  retriedPercent: number | null;
  ratedBadPercent: number | null;
  rerunPercent: number | null;
};
type CostSource = "harness" | "listPrice";
// costSource says where a row's cost came from: "mixed" when it sums both kinds, "none" without any.
type GroupStats = {
  runs: number;
  costUsd: number;
  costSource: CostSource | "mixed" | "none";
};
type Feature = {
  name: string;
  // The sessions the feature could have fired on; the rest are left out of both sides.
  applies: (entry: StatsEntry) => boolean;
  fired: (entry: StatsEntry) => boolean;
};
export type StatsReport = {
  window: StatsWindow;
  sessions: number;
  // Harness-reported cost where there is one, else list cost at base rates, which undercounts long-context requests.
  costUsd: number;
  costSource: GroupStats["costSource"];
  // With computed costs at the over-200k rate instead: the most the same tokens could have cost.
  costUpperBoundUsd: number;
  unpricedSessions: number;
  pools: Record<
    string,
    GroupStats & {
      sessionSharePercent: number | null;
      costSharePercent: number | null;
      weeklyUsedPercent: number | null;
      paceGap: number | null;
    }
  >;
  pickSources: {
    routed: number;
    pinned: number;
    fallback: number;
    unrecorded: number;
    tiltChanged: number;
    lowConfidence: number;
    limitsRelaxed: number;
    policyRelaxed: number;
    pinWarningsIssued: number;
    pinWarningsRanAnyway: number;
  };
  models: Record<
    string,
    GroupStats & {
      failedPercent: number | null;
      retriedPercent: number | null;
      escalatedFromPercent: number | null;
      followUpSends: number;
      ratedGood: number;
      ratedBad: number;
      unpriced: number;
    }
  >;
  callers: Record<string, GroupStats>;
  labels: Record<string, GroupStats>;
  phases: Record<string, GroupStats>;
  features: {
    name: string;
    fired: OutcomeRates;
    notFired: OutcomeRates;
  }[];
  // Decisions of the native-subagent guard in the window, per harness.
  nativeSubagentGuard: Record<
    string,
    { allow: number; warn: number; deny: number }
  >;
  collapse: { model: string; sharePercent: number; routed: number } | null;
  // smart-router's part of everything CodexBar measured for the pool; the rest ran outside it.
  spendShare: Record<
    string,
    {
      smartRouterCostUsd: number;
      totalListCostUsd: number;
      sharePercent: number | null;
    }
  >;
};

const SHADOW_POLICIES: (keyof RouteShadow)[] = [
  "rawJev",
  "weighted",
  "fixedDefault",
  "judgments",
];

const FEATURES: Feature[] = [
  {
    name: "paceTilt",
    applies: ({ route }) =>
      route?.kind === "routed" && route.policy !== ROUTE_POLICY_JUDGMENTS,
    fired: ({ route }) => route?.tiltChanged === true,
  },
  {
    name: "hardLimits",
    applies: ({ route }) => route !== null && route.kind !== "pinned",
    fired: ({ route }) =>
      route !== null &&
      (route.limitsRelaxed ||
        route.excluded.some(({ kind }) => kind === "quota")),
  },
  {
    name: "pinWarnings",
    applies: ({ route }) => route?.kind === "pinned",
    fired: ({ route }) => (route?.warnings.length ?? 0) > 0,
  },
  {
    name: "retryUp",
    applies: () => true,
    fired: ({ session }) => session.escalated === true,
  },
  // A shadow policy "fires" when it would have picked the model that actually ran.
  ...SHADOW_POLICIES.map((policy): Feature => ({
    name: `shadowAgrees:${policy}`,
    applies: ({ route }) => Boolean(route?.shadow?.[policy]),
    fired: ({ route, modelId }) =>
      pickModel(route?.shadow?.[policy]) === modelId,
  })),
  // An experiment "fires" on its on arm; sessions routed before it existed are left out.
  ...Object.keys(DEFAULT_EXPERIMENTS).map((experiment): Feature => ({
    name: `experiment:${experiment}`,
    applies: ({ route }) =>
      route?.experiments?.[experiment as ExperimentName] !== undefined,
    fired: ({ route }) =>
      route?.experiments?.[experiment as ExperimentName] === "on",
  })),
];

function pickModel(pick: string | null | undefined): string | undefined {
  return pick?.split("@", 1)[0];
}

export function statsWindow(
  options: StatsWindowOptions,
  quota: QuotaSnapshot | null,
  now: number,
): StatsWindow {
  if (!options.window) {
    const days = options.days ?? DEFAULT_STATS_DAYS;
    return {
      label: `last ${days} days`,
      from: new Date(now - days * DAY_MS).toISOString(),
      to: new Date(now).toISOString(),
      rollingDays: days,
    };
  }
  // Pools reset at different times; the window starts at the earliest current start so it covers all of them.
  const windowStarts = Object.values(quota ?? {}).flatMap((pool) => {
    const resetTime = Date.parse(pool?.weeklyResetsAt ?? "");
    return Number.isFinite(resetTime) ? [resetTime - QUOTA_WINDOW_MS] : [];
  });
  if (windowStarts.length === 0)
    throw new Error(
      "--window needs the quota reset times from codexbar; use --days instead",
    );
  const currentStart = Math.min(...windowStarts);
  if (options.window === "current")
    return {
      label: "current quota window",
      from: new Date(currentStart).toISOString(),
      to: new Date(now).toISOString(),
      rollingDays: Math.ceil((now - currentStart) / DAY_MS),
    };
  return {
    label: "previous quota window",
    from: new Date(currentStart - QUOTA_WINDOW_MS).toISOString(),
    to: new Date(currentStart).toISOString(),
    rollingDays: null,
  };
}

// The end is inclusive so something recorded this instant counts in a window that ends now;
// the start is exclusive so the previous and current windows never share an entry.
function isInWindow(window: StatsWindow, timestamp: string): boolean {
  const time = Date.parse(timestamp);
  return time > Date.parse(window.from) && time <= Date.parse(window.to);
}

function percent(count: number, total: number): number | null {
  if (total === 0) return null;
  return (
    Math.round((count / total) * FULL_PERCENT * PERCENT_DECIMALS) /
    PERCENT_DECIMALS
  );
}

function count(entries: StatsEntry[], matches: (entry: StatsEntry) => boolean) {
  return entries.filter(matches).length;
}

function totalCost(entries: StatsEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
}

function costSource(entries: StatsEntry[]): GroupStats["costSource"] {
  const sources = new Set(
    entries.flatMap((entry) => (entry.costSource ? [entry.costSource] : [])),
  );
  if (sources.size > 1) return "mixed";
  return [...sources][0] ?? "none";
}

function groupCost(entries: StatsEntry[]): GroupStats {
  return {
    runs: entries.length,
    costUsd: totalCost(entries),
    costSource: costSource(entries),
  };
}

function outcomeRates(entries: StatsEntry[]): OutcomeRates {
  const sessions = entries.length;
  return {
    sessions,
    failedPercent: percent(
      count(entries, ({ outcome }) => outcome.failed),
      sessions,
    ),
    retriedPercent: percent(
      count(entries, ({ outcome }) => outcome.retried),
      sessions,
    ),
    ratedBadPercent: percent(
      count(entries, ({ outcome }) => outcome.rating === "bad"),
      sessions,
    ),
    rerunPercent: percent(
      count(entries, ({ outcome }) => outcome.rerun),
      sessions,
    ),
  };
}

function grouped(
  entries: StatsEntry[],
  key: (entry: StatsEntry) => string,
): Map<string, StatsEntry[]> {
  const groups = new Map<string, StatsEntry[]>();
  for (const entry of entries)
    groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  return groups;
}

function groupStats(
  entries: StatsEntry[],
  key: (entry: StatsEntry) => string,
): Record<string, GroupStats> {
  return Object.fromEntries(
    [...grouped(entries, key)].map(([name, group]) => [name, groupCost(group)]),
  );
}

function collapse(entries: StatsEntry[]): StatsReport["collapse"] {
  const routed = entries.filter(({ route }) => route?.kind === "routed");
  if (routed.length < COLLAPSE_MINIMUM_ROUTED) return null;
  for (const [model, picks] of grouped(routed, ({ modelId }) => modelId))
    if (picks.length / routed.length >= COLLAPSE_SHARE)
      return {
        model,
        sharePercent: percent(picks.length, routed.length) ?? 0,
        routed: routed.length,
      };
  return null;
}

function sessionCost(
  session: Session,
  pricing: PricingCatalog | null,
): Pick<
  StatsEntry,
  "costUsd" | "costSource" | "costUpperBoundUsd" | "listCostUsd"
> {
  const listCost = listCostUsd(session, pricing);
  const harnessCost = session.usage?.costUsd;
  if (typeof harnessCost === "number")
    return {
      costUsd: harnessCost,
      costSource: "harness",
      costUpperBoundUsd: harnessCost,
      listCostUsd: listCost,
    };
  return {
    costUsd: listCost,
    costSource: listCost === null ? null : "listPrice",
    costUpperBoundUsd: listCostUsd(session, pricing, "longContext"),
    listCostUsd: listCost,
  };
}

export function statsEntries(
  sessions: Session[],
  window: StatsWindow,
  pricing: PricingCatalog | null,
): StatsEntry[] {
  const byHandle = new Map(
    sessions.map((session) => [session.handle, session]),
  );
  const retries = retriesByOriginal(sessions);
  // Follows retryOf to the first attempt; a retry is always newer, so the chain ends.
  const firstAttempt = (session: Session): Session => {
    const original = session.retryOf && byHandle.get(session.retryOf);
    return original ? firstAttempt(original) : session;
  };
  return sessions
    .filter(({ createdAt }) => isInWindow(window, createdAt))
    .map((session) => ({
      session,
      modelId: `${session.harness}:${session.model}`,
      route: isRouteRecord(session.route) ? session.route : null,
      // Outcomes look at every session, so a retry or rerun just past the window still counts.
      outcome: sessionOutcome(session, sessions),
      ...sessionCost(session, pricing),
      retriedBy: retries.get(session.handle) ?? [],
      label: session.label ?? firstAttempt(session).label ?? null,
      phase: session.phase ?? firstAttempt(session).phase ?? null,
    }));
}

export function statsReport(input: {
  entries: StatsEntry[];
  window: StatsWindow;
  quota: QuotaSnapshot | null;
  pinWarnings: Record<string, unknown>[];
  guardDecisions: Record<string, unknown>[];
  externalCostUsd: Partial<Record<HarnessName, number | null>>;
}): StatsReport {
  const { entries, window, quota } = input;
  const cost = totalCost(entries);
  const byPool = grouped(entries, ({ session }) => session.harness);
  const poolNames = new Set([...byPool.keys(), ...Object.keys(quota ?? {})]);
  const escalatedFrom = new Set(
    entries.flatMap(({ session }) =>
      session.escalated && session.retryOf ? [session.retryOf] : [],
    ),
  );
  const inWindow = ({ ts }: Record<string, unknown>) =>
    isInWindow(window, String(ts));
  const warningsInWindow = input.pinWarnings.filter(inWindow);
  const nativeSubagentGuard: StatsReport["nativeSubagentGuard"] = {};
  for (const { harness, decision } of input.guardDecisions.filter(inWindow)) {
    const counts = (nativeSubagentGuard[String(harness)] ??= {
      allow: 0,
      warn: 0,
      deny: 0,
    });
    if (decision === "allow" || decision === "warn" || decision === "deny")
      counts[decision] += 1;
  }
  return {
    window,
    sessions: entries.length,
    costUsd: cost,
    costSource: costSource(entries),
    costUpperBoundUsd: entries.reduce(
      (sum, entry) => sum + (entry.costUpperBoundUsd ?? 0),
      0,
    ),
    unpricedSessions: count(entries, (entry) => entry.costUsd === null),
    pools: Object.fromEntries(
      [...poolNames].map((pool) => {
        const group = byPool.get(pool) ?? [];
        const usage = quota?.[pool as HarnessName];
        return [
          pool,
          {
            ...groupCost(group),
            sessionSharePercent: percent(group.length, entries.length),
            costSharePercent: percent(totalCost(group), cost),
            weeklyUsedPercent: usage?.weeklyUsedPercent ?? null,
            paceGap: usage?.paceGap ?? null,
          },
        ];
      }),
    ),
    pickSources: {
      routed: count(entries, ({ route }) => route?.kind === "routed"),
      pinned: count(entries, ({ route }) => route?.kind === "pinned"),
      fallback: count(entries, ({ route }) => route?.kind === "fallback"),
      unrecorded: count(entries, ({ route }) => route === null),
      tiltChanged: count(entries, ({ route }) => route?.tiltChanged === true),
      lowConfidence: count(
        entries,
        ({ route }) => route?.lowConfidence === true,
      ),
      limitsRelaxed: count(
        entries,
        ({ route }) => route?.limitsRelaxed === true,
      ),
      policyRelaxed: count(
        entries,
        ({ route }) => route?.policyRelaxed === true,
      ),
      pinWarningsIssued: warningsInWindow.length,
      pinWarningsRanAnyway: warningsInWindow.filter(({ ran }) => ran === true)
        .length,
    },
    models: Object.fromEntries(
      [...grouped(entries, ({ modelId }) => modelId)].map(([model, group]) => {
        const rates = outcomeRates(group);
        return [
          model,
          {
            ...groupCost(group),
            failedPercent: rates.failedPercent,
            retriedPercent: rates.retriedPercent,
            escalatedFromPercent: percent(
              count(group, ({ session }) => escalatedFrom.has(session.handle)),
              group.length,
            ),
            followUpSends: group.reduce(
              (sum, { outcome }) => sum + outcome.followUpSends,
              0,
            ),
            ratedGood: count(group, ({ outcome }) => outcome.rating === "good"),
            ratedBad: count(group, ({ outcome }) => outcome.rating === "bad"),
            unpriced: count(group, (entry) => entry.costUsd === null),
          },
        ];
      }),
    ),
    callers: groupStats(entries, ({ session }) => session.owner),
    labels: groupStats(entries, ({ label }) => label ?? UNLABELED),
    phases: groupStats(entries, ({ phase }) => phase ?? UNLABELED),
    features: FEATURES.map(({ name, applies, fired }) => {
      const applicable = entries.filter(applies);
      return {
        name,
        fired: outcomeRates(applicable.filter(fired)),
        notFired: outcomeRates(applicable.filter((entry) => !fired(entry))),
      };
    }),
    nativeSubagentGuard,
    collapse: collapse(entries),
    spendShare: Object.fromEntries(
      Object.entries(input.externalCostUsd).flatMap(([pool, total]) => {
        if (typeof total !== "number") return [];
        const smartRouterCostUsd = totalCost(byPool.get(pool) ?? []);
        return [
          [
            pool,
            {
              smartRouterCostUsd,
              totalListCostUsd: total,
              sharePercent: percent(smartRouterCostUsd, total),
            },
          ],
        ];
      }),
    ),
  };
}

// One JSON line per session: everything needed to analyse routing offline.
export function exportLines(entries: StatsEntry[]): string {
  return entries
    .map(
      ({
        session,
        route,
        outcome,
        label,
        phase,
        retriedBy: retries,
        ...cost
      }) =>
        JSON.stringify({
          handle: session.handle,
          createdAt: session.createdAt,
          owner: session.owner,
          harness: session.harness,
          model: session.model,
          effort: session.effort,
          cwd: session.cwd,
          label,
          phase,
          promptSha256: session.promptSha256 ?? null,
          retryOf: session.retryOf ?? null,
          retriedBy: retries,
          escalated: session.escalated ?? false,
          usage: session.usage ?? null,
          costUsd: cost.costUsd,
          costSource: cost.costSource,
          listCostUsd: cost.listCostUsd,
          route,
          outcome,
        }),
    )
    .map((line) => `${line}\n`)
    .join("");
}

function shown(value: number | null, unit = "%"): string {
  return value === null ? "n/a" : `${value}${unit}`;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function ratesLine({ sessions, ...rates }: OutcomeRates): string {
  return `${sessions} sessions, failed ${shown(rates.failedPercent)}, retried ${shown(rates.retriedPercent)}, rated bad ${shown(rates.ratedBadPercent)}, rerun ${shown(rates.rerunPercent)}`;
}

function costText({ costUsd, costSource: source }: GroupStats): string {
  return `${dollars(costUsd)} (${COST_SOURCE_LABELS[source]})`;
}

function groupLines(title: string, groups: Record<string, GroupStats>) {
  return [
    title,
    ...Object.entries(groups).map(
      ([name, group]) => `  ${name}: ${group.runs} runs, ${costText(group)}`,
    ),
  ];
}

export function formatStats(report: StatsReport): string {
  const sources = report.pickSources;
  return [
    `smart-router stats: ${report.window.label} (${report.window.from} to ${report.window.to})`,
    `${report.sessions} sessions, ${dollars(report.costUsd)} cost (${COST_SOURCE_LABELS[report.costSource]}; at most ${dollars(report.costUpperBoundUsd)} if every list-priced request was billed at the over-200k-context rate), ${report.unpricedSessions} without a cost`,
    ...(report.collapse
      ? [
          `WARNING: ${report.collapse.model} took ${report.collapse.sharePercent}% of ${report.collapse.routed} routed picks; the router is not choosing`,
        ]
      : []),
    "Pools",
    ...Object.entries(report.pools).map(
      ([pool, stats]) =>
        `  ${pool}: ${shown(stats.sessionSharePercent)} of sessions, ${shown(stats.costSharePercent)} of cost (${costText(stats)}); weekly used ${shown(stats.weeklyUsedPercent)}, pace gap ${shown(stats.paceGap, " pts")}`,
    ),
    "Pick sources",
    `  routed ${sources.routed}, pinned ${sources.pinned}, fallback ${sources.fallback}, unrecorded ${sources.unrecorded}`,
    `  tilt changed ${sources.tiltChanged}, low confidence ${sources.lowConfidence}, limits relaxed ${sources.limitsRelaxed}, judgment policy relaxed ${sources.policyRelaxed}`,
    `  pin warnings issued ${sources.pinWarningsIssued}, ran anyway ${sources.pinWarningsRanAnyway}`,
    "Models",
    ...Object.entries(report.models).map(
      ([model, stats]) =>
        `  ${model}: ${stats.runs} runs, failed ${shown(stats.failedPercent)}, retried ${shown(stats.retriedPercent)}, escalated from ${shown(stats.escalatedFromPercent)}, ${stats.followUpSends} follow-up sends, rated ${stats.ratedGood} good / ${stats.ratedBad} bad, ${costText(stats)}, ${stats.unpriced} without a cost`,
    ),
    ...groupLines("Callers", report.callers),
    ...groupLines("Labels", report.labels),
    ...groupLines("Phases", report.phases),
    "Feature audit (fired vs not fired)",
    ...report.features.flatMap(({ name, fired, notFired }) => [
      `  ${name} fired: ${ratesLine(fired)}`,
      `  ${name} not fired: ${ratesLine(notFired)}`,
    ]),
    "Native-subagent guard",
    ...Object.entries(report.nativeSubagentGuard).map(
      ([harness, { allow, warn, deny }]) =>
        `  ${harness}: allowed ${allow}, warned ${warn}, denied ${deny}`,
    ),
    "Share of all measured list spend",
    ...Object.entries(report.spendShare).map(
      ([pool, share]) =>
        `  ${pool}: ${dollars(share.smartRouterCostUsd)} of ${dollars(share.totalListCostUsd)} (${shown(share.sharePercent)}) went through smart-router`,
    ),
    "",
  ].join("\n");
}
