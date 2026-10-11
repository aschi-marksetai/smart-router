import type { Session } from "./sessions.ts";
import {
  record,
  parseJsonLines,
  usageFrom,
  type Usage,
} from "./harness/types.ts";
export const EVENT_TYPE = {
  started: "session.started",
  delta: "text.delta",
  message: "message",
  toolStarted: "tool.started",
  toolFinished: "tool.finished",
  usage: "usage",
  result: "result",
  error: "error",
} as const;
export const EVENT_TEXT_LIMIT = 2000;
export const LOG_FOLLOW_INTERVAL_MS = 100;
type Payloads = {
  "session.started": { model: string; effort: string; sessionId?: string };
  "text.delta": { text: string };
  message: { role: "assistant"; text: string };
  "tool.started": { toolId: string; name: string; input: string };
  "tool.finished": {
    toolId: string;
    name: string;
    exitCode?: number;
    isError: boolean;
    output: string;
  };
  usage: Usage & { cacheHitRatio?: number };
  result: { text: string; usage: Usage | null };
  error: { message: string; lastAction?: string };
};
type EventPayload = {
  [Type in keyof Payloads]: { type: Type } & Payloads[Type];
}[keyof Payloads];
export type EventState = Pick<
  Session,
  "handle" | "harness" | "model" | "effort"
> & {
  ts: string;
  text?: string;
  tools?: ReadonlyMap<string, string>;
};
export type NormalizedEvent = Pick<EventState, "handle" | "harness" | "ts"> & {
  v: 1;
} & EventPayload;
export function normalized(
  { handle, harness, ts }: EventState,
  payload: EventPayload,
): NormalizedEvent {
  return { v: 1, handle, harness, ts, ...payload };
}
function truncated(value: unknown): string {
  return (
    typeof value === "string" ? value : (JSON.stringify(value) ?? "")
  ).slice(0, EVENT_TEXT_LIMIT);
}
const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "file_change",
]);
const NATIVE_EVENT_TYPES = new Set(
  "thread.started item.started item.completed turn.completed turn.failed error system assistant user result stream_event message message_end session usage".split(
    " ",
  ),
);
export function translateEvents(
  raw: unknown,
  state: EventState,
): NormalizedEvent[] {
  const event = record(typeof raw === "string" ? parseJsonLines(raw)[0] : raw);
  if (!event || !NATIVE_EVENT_TYPES.has(String(event.type))) return [];
  const events: NormalizedEvent[] = [];
  const emit = (payload: EventPayload) =>
    events.push(normalized(state, payload));
  const sessionId = event.thread_id ?? event.session_id;
  const initialization =
    event.type === "thread.started" ||
    (event.type === "system" && event.subtype === "init") ||
    (state.harness === "pi" && typeof sessionId === "string");
  if (initialization)
    emit({
      type: EVENT_TYPE.started,
      model: state.model,
      effort: state.effort,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
    });
  const message = record(event.message);
  const item = record(event.item);
  const completedItem = event.type === "item.completed";
  if (
    completedItem &&
    item?.type === "agent_message" &&
    typeof item.text === "string"
  )
    emit({ type: EVENT_TYPE.message, role: "assistant", text: item.text });
  for (const item of [record(event.item)]) {
    if (
      !item ||
      typeof item.type !== "string" ||
      !TOOL_ITEM_TYPES.has(item.type) ||
      typeof item.id !== "string"
    )
      continue;
    const name = typeof item.tool === "string" ? item.tool : item.type;
    if (event.type === "item.started")
      emit({
        type: EVENT_TYPE.toolStarted,
        toolId: item.id,
        name,
        input: truncated(item.command ?? item.arguments ?? item.changes),
      });
    if (completedItem)
      emit({
        type: EVENT_TYPE.toolFinished,
        toolId: item.id,
        name,
        ...(typeof item.exit_code === "number"
          ? { exitCode: item.exit_code }
          : {}),
        isError:
          item.status === "failed" ||
          item.error != null ||
          (typeof item.exit_code === "number" && item.exit_code !== 0),
        output: truncated(
          item.aggregated_output ?? item.result ?? item.error ?? item.changes,
        ),
      });
  }
  const content = Array.isArray(message?.content)
    ? message.content.map(record)
    : [];
  const text = content
    .filter((block) => block?.type === "text")
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("");
  if (text && (event.type === "assistant" || message?.role === "assistant"))
    emit({ type: EVENT_TYPE.message, role: "assistant", text });
  for (const block of content) {
    if (
      block?.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    )
      emit({
        type: EVENT_TYPE.toolStarted,
        toolId: block.id,
        name: block.name,
        input: truncated(block.input),
      });
    if (block?.type === "tool_result" && typeof block.tool_use_id === "string")
      emit({
        type: EVENT_TYPE.toolFinished,
        toolId: block.tool_use_id,
        name: state.tools?.get(block.tool_use_id) ?? "tool",
        isError: block.is_error === true,
        output: truncated(block.content),
      });
  }
  const delta = record(record(event.event)?.delta);
  const deltaText = delta?.type === "text_delta" ? delta.text : undefined;
  if (event.type === "stream_event" && typeof deltaText === "string")
    emit({ type: EVENT_TYPE.delta, text: deltaText });
  const failed =
    event.type === "error" ||
    event.type === "turn.failed" ||
    (event.type === "result" &&
      (event.is_error === true ||
        (event.subtype !== undefined && event.subtype !== "success")));
  if (failed) {
    const message =
      record(event.error)?.message ?? event.message ?? event.result;
    emit({
      type: EVENT_TYPE.error,
      message: truncated(message ?? "Harness turn failed"),
    });
    return events;
  }
  const terminal = event.type === "result" || event.type === "turn.completed";
  const usage = usageFrom(
    event.usage ?? message?.usage,
    typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
  );
  if (usage && (terminal || state.harness === "pi")) {
    // Codex input_tokens already includes cached tokens; Claude and pi report
    // uncached input, cache reads and cache writes as separate counts.
    const totalInputTokens =
      state.harness === "codex"
        ? usage.inputTokens
        : usage.inputTokens +
          (usage.cachedInputTokens ?? 0) +
          (usage.cacheWriteTokens ?? 0);
    const hasCacheHitRatio =
      typeof usage.cachedInputTokens === "number" && totalInputTokens > 0;
    const cacheHitRatio = hasCacheHitRatio
      ? { cacheHitRatio: (usage.cachedInputTokens ?? 0) / totalInputTokens }
      : {};
    emit({ type: EVENT_TYPE.usage, ...usage, ...cacheHitRatio });
  }
  if (terminal)
    emit({
      type: EVENT_TYPE.result,
      text:
        typeof event.result === "string" ? event.result : (state.text ?? ""),
      usage,
    });
  return events;
}
