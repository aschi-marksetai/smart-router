import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseJsonLines,
  record,
  usageFrom,
  turnUsage,
  type Usage,
} from "./harness/types.ts";
import { codexHomeDir } from "./paths.ts";
import { listCostUsd, loadPricing } from "./pricing.ts";
import { addUsage, type Session } from "./sessions.ts";

const CLAUDE_DRIVER = "claudeAgent";
const AMBIGUOUS_TRANSCRIPT = "ambiguous";

export function transcriptUsage(
  output: string,
  harness: Session["harness"],
): Usage | null {
  const messages = new Map<string, { model: string; usage: Usage }>();
  let model = "";
  let cumulative: Usage | null = null;
  const byModel = new Map<string, Usage>();
  for (const value of parseJsonLines(output)) {
    const event = record(value);
    const payload = record(event?.payload);
    if (harness === "codex") {
      if (event?.type === "turn_context")
        model = typeof payload?.model === "string" ? payload.model : "";
      if (event?.type !== "event_msg" || payload?.type !== "token_count")
        continue;
      const usage = usageFrom(record(payload.info)?.total_token_usage);
      if (!usage) continue;
      const delta = turnUsage(usage, { harness, usage: cumulative });
      const modelUsage = addUsage(byModel.get(model), delta);
      if (modelUsage) byModel.set(model, modelUsage);
      cumulative = usage;
      continue;
    }
    const message = record(event?.message);
    if (event?.type !== "assistant" || typeof message?.id !== "string")
      continue;
    const usage = usageFrom(message.usage);
    // Stream snapshots grow; an older copy in a subagent file must not replace the final snapshot.
    const previous = messages.get(message.id);
    if (
      usage &&
      (!previous || usage.outputTokens >= previous.usage.outputTokens)
    )
      messages.set(message.id, {
        model: typeof message.model === "string" ? message.model : "",
        usage,
      });
  }
  if (harness !== "codex") {
    for (const { model, usage } of messages.values()) {
      cumulative = addUsage(cumulative, usage) ?? null;
      const modelUsage = addUsage(byModel.get(model), usage);
      if (modelUsage) byModel.set(model, modelUsage);
    }
  }
  return cumulative
    ? { ...cumulative, byModel: Object.fromEntries(byModel) }
    : null;
}

async function readTranscriptUsage(
  session: Session,
  nativeId: string,
): Promise<Usage | null | typeof AMBIGUOUS_TRANSCRIPT> {
  const root =
    session.harness === "claude"
      ? join(
          process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
          "projects",
        )
      : codexHomeDir();
  const patterns =
    session.harness === "claude"
      ? [`*/${nativeId}.jsonl`]
      : ["sessions/**", "archived_sessions"].flatMap((directory) =>
          ["jsonl", "jsonl.zst"].map(
            (extension) => `${directory}/rollout-*-${nativeId}.${extension}`,
          ),
        );
  const paths = (
    await Promise.all(
      patterns.map((pattern) =>
        Array.fromAsync(
          new Bun.Glob(pattern).scan({ cwd: root, absolute: true }),
        ),
      ),
    )
  ).flat();
  if (paths.length > 1) return AMBIGUOUS_TRANSCRIPT;
  if (paths.length === 0) return null;
  const parent = paths[0]!;
  if (session.harness === "claude") {
    const subagents = await Array.fromAsync(
      new Bun.Glob(`${nativeId}/subagents/**/*.jsonl`).scan({
        cwd: dirname(parent),
        absolute: true,
      }),
    );
    paths.push(...subagents);
  }
  const outputs = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      return (
        path.endsWith(".zst") ? Bun.zstdDecompressSync(bytes) : bytes
      ).toString("utf8");
    }),
  );
  return transcriptUsage(outputs.join("\n"), session.harness);
}

export async function ingestT3Usage(
  session: Session,
  loadPrices = loadPricing,
): Promise<void> {
  if (
    !session.t3ThreadId ||
    session.status === "running" ||
    session.status === "launched" ||
    session.harness === "pi"
  )
    return;
  const key = session.t3UpdatedAt
    ? `${session.t3UpdatedAt}:${session.t3LatestRunId ?? ""}`
    : undefined;
  if (key && session.t3UsageKey === key) return;
  const previous = session.usage;
  session.usage = undefined;
  session.t3UsageKey = undefined;
  try {
    // The CLI has no native-session mapping. Keep this optional projection lookup read-only.
    const database = new Database(
      join(
        process.env.T3CODE_HOME ?? join(homedir(), ".t3"),
        "userdata",
        "statev2.sqlite",
      ),
      { readonly: true },
    );
    let rows;
    try {
      rows = database
        .query<{ payload_json: string }, [string]>(
          "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ? ORDER BY last_run_ordinal DESC",
        )
        .all(session.t3ThreadId);
    } finally {
      database.close();
    }
    // A handoff can leave several provider threads; do not guess which transcript owns the totals.
    if (rows.length > 1) {
      session.t3UsageKey = key;
      return;
    }
    if (rows.length === 0) return;
    const reference = record(
      record(JSON.parse(rows[0]!.payload_json))?.nativeThreadRef,
    );
    const nativeId = reference?.nativeId;
    const driver = session.harness === "claude" ? CLAUDE_DRIVER : "codex";
    if (
      reference?.driver !== driver ||
      typeof nativeId !== "string" ||
      !/^[a-zA-Z0-9-]+$/.test(nativeId)
    )
      return;
    const usage = await readTranscriptUsage(session, nativeId);
    if (usage === AMBIGUOUS_TRANSCRIPT) {
      session.t3UsageKey = key;
      return;
    }
    if (!usage) return;
    const pricing = await loadPrices();
    usage.costUsd = listCostUsd({ ...session, usage }, pricing);
    if (!pricing && previous) {
      const { costUsd, costSource, ...previousTokens } = previous;
      const { costUsd: currentCost, ...tokens } = usage;
      if (JSON.stringify(previousTokens) === JSON.stringify(tokens))
        usage.costUsd = costUsd;
    }
    usage.costSource = "listPrice";
    session.usage = usage;
    if (pricing && usage.costUsd !== null) session.t3UsageKey = key;
  } catch {
    // Missing mappings, incomplete transcripts and unavailable local state leave usage unknown.
  }
}
