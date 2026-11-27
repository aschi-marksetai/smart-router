import { appendAuditLine } from "./audit-log.ts";
import { enabledHarnesses, poolImbalance } from "./balance.ts";
import {
  DEFAULT_NATIVE_SUBAGENT_ALLOW_TYPES,
  NATIVE_SUBAGENT_GUARD_BLOCK,
  type Config,
  type HarnessName,
} from "./config.ts";
import { record } from "./files.ts";
import type { QuotaReading } from "./quota.ts";

export const NATIVE_SUBAGENT_LOG = "native-subagents.jsonl";
// Under the 6 s hook timeout, so a slow codexbar ends as an allow instead of a killed hook.
export const GUARD_TIMEOUT_MS = 5_000;
const HOOK_EVENT_NAME = "PreToolUse";

export type GuardDecision = {
  decision: "allow" | "deny" | "warn";
  message: string;
};
export type GuardInput = {
  harness: string;
  subagentType?: string;
  model?: string;
  sessionId?: string;
  cwd?: string;
};
type GuardDeps = {
  loadConfig: () => Promise<Config>;
  readQuota: (config: Config) => Promise<QuotaReading>;
  now: () => number;
  timeoutMs?: number;
};
type Verdict = GuardDecision & {
  reason: string;
  guardedGap?: number;
  otherGap?: number;
};

async function verdict(input: GuardInput, deps: GuardDeps): Promise<Verdict> {
  const allow = (reason: string): Verdict => ({
    decision: "allow",
    message: "",
    reason,
  });
  const config = await deps.loadConfig();
  const mode = config.rules.nativeSubagentGuard ?? NATIVE_SUBAGENT_GUARD_BLOCK;
  if (mode === "off") return allow("guard off");
  const allowedTypes =
    config.rules.nativeSubagentAllowTypes ??
    DEFAULT_NATIVE_SUBAGENT_ALLOW_TYPES;
  if (input.subagentType && allowedTypes.includes(input.subagentType))
    return allow("subagent type is always allowed");
  const { quota } = await deps.readQuota(config);
  if ("error" in quota) return allow(`no quota: ${quota.error}`);
  const imbalance = poolImbalance(
    input.harness as HarnessName,
    quota,
    enabledHarnesses(config),
  );
  if (!imbalance) return allow("pools in balance");
  const overPace = Math.round(-imbalance.guardedGap);
  const reserve = Math.round(imbalance.otherGap);
  return {
    decision: mode === NATIVE_SUBAGENT_GUARD_BLOCK ? "deny" : "warn",
    message: `${input.harness} is ${overPace} pts over its weekly pace while ${imbalance.otherHarness} has ${reserve} in reserve, and a native subagent would spend more of ${input.harness}. Delegate through smart-router instead: \`smart-router spawn "<task>" --cwd <repo>\`, or inside T3 \`smart-router route "<task>" --launch --cwd <repo>\` followed by delegate_task.`,
    reason: "guarded pool over pace while another has reserve",
    guardedGap: imbalance.guardedGap,
    otherGap: imbalance.otherGap,
  };
}

// Decides whether a native subagent call may run. Any failure or a slow quota read ends as allow:
// the guard nudges spend toward the pool with reserve and must never be the reason work stops.
export async function guardSubagent(
  input: GuardInput,
  deps: GuardDeps,
): Promise<GuardDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Verdict>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ decision: "allow", message: "", reason: "guard timed out" }),
      deps.timeoutMs ?? GUARD_TIMEOUT_MS,
    );
  });
  const decided = await Promise.race([
    verdict(input, deps).catch((error: unknown): Verdict => ({
      decision: "allow",
      message: "",
      reason: `guard error: ${error instanceof Error ? error.message : String(error)}`,
    })),
    timedOut,
  ]);
  clearTimeout(timer);
  await appendAuditLine(NATIVE_SUBAGENT_LOG, {
    ts: new Date(deps.now()).toISOString(),
    harness: input.harness,
    subagentType: input.subagentType ?? null,
    model: input.model ?? null,
    decision: decided.decision,
    reason: decided.reason,
    guardedGap: decided.guardedGap ?? null,
    otherGap: decided.otherGap ?? null,
    cwd: input.cwd ?? null,
    sessionId: input.sessionId ?? null,
  }).catch(() => {});
  return { decision: decided.decision, message: decided.message };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// Reads a PreToolUse hook payload. Claude Code names the type subagent_type, Codex agent_type.
export function guardInputFromHook(harness: string, stdin: string): GuardInput {
  const event = record(JSON.parse(stdin));
  const tool = record(event?.tool_input);
  return {
    harness,
    subagentType: stringField(tool?.subagent_type ?? tool?.agent_type),
    model: stringField(tool?.model),
    sessionId: stringField(event?.session_id),
    cwd: stringField(event?.cwd),
  };
}

// The PreToolUse output both Claude Code and Codex accept. A warning carries context only:
// an explicit "allow" would skip Claude Code's permission prompt, and Codex 0.169 treats it as a failed hook.
export function hookOutput({ decision, message }: GuardDecision): string {
  if (decision === "deny")
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: HOOK_EVENT_NAME,
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    })}\n`;
  if (decision === "warn")
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: HOOK_EVENT_NAME,
        additionalContext: message,
      },
    })}\n`;
  return "";
}
