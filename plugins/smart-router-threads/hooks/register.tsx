import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, Timer } from "claude-code";
import type {
  ConversationItem,
  PaneState,
  Scope,
  Thread,
  ThreadStatus,
} from "../types/index";

// Pane ids accept letters, digits, underscores and hyphens; titles accept spaces.
const PANE = "smart-router";
const LIST_INTERVAL = 5000;
const THREAD_INTERVAL = 3000;
const TICK_INTERVAL = 1000;
const ALL_LIMIT = 30;
const ITEM_LIMIT = 40;
const PREVIEW_LIMIT = 160;
const TOOL_OUTPUT_LINES = 3;
const PROCESS_TIMEOUT = 15000;
const pane = atom(
  { plugin: "smart-router-threads", key: "pane" } as const,
  {
    scope: "session",
    view: { kind: "list" },
    threads: [],
    now: 0,
    error: "",
  } satisfies PaneState,
  { shape: "pane-1" },
);

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid smart-router JSON object");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid smart-router string field");
  return value;
}
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value);
}
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Invalid smart-router number field");
  return value;
}
export function parseThread(value: unknown): Thread {
  const record = object(value);
  const status = record.status ?? "unknown";
  if (
    status !== "running" &&
    status !== "done" &&
    status !== "failed" &&
    status !== "stopped" &&
    status !== "unknown"
  )
    throw new Error("Invalid smart-router status");
  const usage = object(record.usage ?? {});
  const route = object(record.route ?? {});
  const depth = optionalNumber(record.depth) ?? 1;
  const createdAt = requiredString(record.createdAt);
  if (
    !Number.isInteger(depth) ||
    depth < 1 ||
    !Number.isFinite(Date.parse(createdAt))
  )
    throw new Error("Invalid smart-router depth or date");
  return {
    handle: requiredString(record.handle),
    owner: optionalString(record.owner),
    status,
    harness: requiredString(record.harness),
    model: requiredString(record.model),
    effort: requiredString(record.effort),
    depth,
    createdAt,
    promptPreview: requiredString(record.promptPreview),
    cwd: optionalString(record.cwd),
    routePick: optionalString(route.pick),
    inputTokens: optionalNumber(usage.inputTokens),
    outputTokens: optionalNumber(usage.outputTokens),
    costUsd: optionalNumber(usage.costUsd),
    lastAction: optionalString(record.lastAction),
    error: optionalString(record.error),
    result: optionalString(record.result ?? record.lastResult),
  };
}
export function selectThreads(
  threads: Thread[],
  scope: Scope,
  owner: string,
): Thread[] {
  const selected = threads
    .filter((thread) => scope === "all" || thread.owner === owner)
    .sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
  return scope === "all" ? selected.slice(0, ALL_LIMIT) : selected;
}
export function statusGlyph(status: ThreadStatus): string {
  return { running: "●", done: "✓", failed: "✗", stopped: "■", unknown: "?" }[
    status
  ];
}
export function relativeAge(createdAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
export function conversationFromEvents(
  jsonl: string,
  thread: Thread,
): ConversationItem[] {
  const promptLabel =
    thread.promptPreview.length >= PREVIEW_LIMIT ? "User (truncated)" : "User";
  const items: ConversationItem[] = [
    {
      kind: "user",
      text: `${promptLabel}: ${thread.promptPreview}`,
      isError: false,
    },
  ];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const event = object(JSON.parse(line));
    if (event.v !== 1 || event.handle !== thread.handle)
      throw new Error("Invalid smart-router event envelope");
    const type = requiredString(event.type);
    let item: ConversationItem;
    switch (type) {
      case "message":
        if (event.role !== "assistant") continue;
        item = {
          kind: "assistant",
          text: requiredString(event.text),
          isError: false,
        };
        break;
      case "tool.started":
        item = {
          kind: "tool",
          text: `▸ ${requiredString(event.name)}: ${requiredString(event.input).split("\n")[0] ?? ""}`,
          isError: false,
        };
        break;
      case "tool.finished":
        if (typeof event.isError !== "boolean")
          throw new Error("Invalid smart-router tool error flag");
        item = {
          kind: "output",
          text: requiredString(event.output)
            .split("\n")
            .slice(0, TOOL_OUTPUT_LINES)
            .join("\n"),
          isError: event.isError,
        };
        break;
      case "result":
        item = {
          kind: "result",
          text: requiredString(event.text),
          isError: false,
        };
        break;
      case "error":
        item = {
          kind: "error",
          text: requiredString(event.message),
          isError: true,
        };
        break;
      default:
        continue;
    }
    items.push(item);
  }
  if (
    thread.result &&
    !items.some((item) => item.kind === "result" && item.text === thread.result)
  ) {
    items.push({ kind: "result", text: thread.result, isError: false });
  }
  return items;
}

async function cli($: EngineInterface, args: string[]): Promise<string> {
  let result;
  try {
    result = await $.process.run(["smart-router", ...args], {
      timeoutMs: PROCESS_TIMEOUT,
    });
  } catch (error) {
    if (!/ENOENT|not found|cannot start|spawn/i.test(String(error)))
      throw error;
    const home = await $.env.get("HOME");
    if (!home) throw error;
    // ponytail: some hosts omit ~/.bun/bin from PATH; retry the installed binary only on a start failure.
    result = await $.process.run([`${home}/.bun/bin/smart-router`, ...args], {
      timeoutMs: PROCESS_TIMEOUT,
    });
  }
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim() || `smart-router exited ${result.exitCode}`,
    );
  if (result.isStdoutTruncated)
    throw new Error("smart-router output exceeded the host limit (4 MiB)");
  return result.stdout;
}
async function isPlaced($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some((item) => item.id === PANE && item.isPlaced);
}

let timer: Timer | undefined;
let busy = false;
let generation = 0;
let listDue = 0;
let threadDue = 0;

async function refresh($: EngineInterface, force = false) {
  if (busy) return;
  const placed = await isPlaced($);
  if (!placed || busy) return;
  busy = true;
  const started = generation;
  try {
    const current = await read($, pane);
    const now = await $.clock.now();
    if (force || now >= listDue) {
      listDue = now + LIST_INTERVAL;
      const value: unknown = JSON.parse(await cli($, ["sessions", "--all"]));
      if (!Array.isArray(value))
        throw new Error("Invalid smart-router sessions array");
      // One malformed legacy record should not blank the whole list.
      const threads = value.flatMap((item) => {
        try {
          return [parseThread(item)];
        } catch {
          return [];
        }
      });
      if (started !== generation) return;
      await update($, pane, (state) => ({ ...state, threads, now, error: "" }));
    }
    if (current.view.kind !== "thread") return;
    const { handle, record } = current.view;
    const shouldFetch =
      force ||
      (now >= threadDue && (record === null || record.status === "running"));
    if (!shouldFetch || started !== generation || !(await isPlaced($))) return;
    threadDue = now + THREAD_INTERVAL;
    const thread = parseThread(JSON.parse(await cli($, ["status", handle])));
    if (started !== generation || !(await isPlaced($))) return;
    const items = conversationFromEvents(
      await cli($, ["logs", handle, "--events"]),
      thread,
    );
    if (started !== generation) return;
    await update($, pane, (state): PaneState => ({
      ...state,
      now,
      error: "",
      view: { kind: "thread", handle, record: thread, items },
    }));
  } catch (error) {
    if (started === generation)
      await update($, pane, (state) => ({
        ...state,
        error: oneLine(error instanceof Error ? error.message : String(error)),
      }));
  } finally {
    busy = false;
  }
}
function startTimer($: EngineInterface) {
  if (!timer)
    timer = $.clock.every(TICK_INTERVAL, () => {
      void refresh($);
    });
}
async function navigate($: EngineInterface, scope: Scope, handle?: string) {
  generation++;
  threadDue = 0;
  await update($, pane, (state): PaneState => ({
    ...state,
    scope,
    error: "",
    view: handle
      ? { kind: "thread", handle, record: null, items: [] }
      : { kind: "list" },
  }));
  await refresh($, true);
}
export const register: Register = (on, _options) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "sr",
      description: "Browse smart-router threads",
      argumentHint: "[all|handle]",
    });
    if (await isPlaced($)) {
      startTimer($);
      await refresh($, true);
    }
    return next(e);
  });
  on("command.run", { command: "sr" }, async ($, e) => {
    const argument = e.args.trim();
    if (argument && argument !== "all" && !/^[a-f0-9]{6}$/.test(argument))
      return { text: "Usage: /sr [all|handle]" };
    const opened = await $.ui.open({
      id: PANE,
      title: "Smart Router",
      focus: true,
    });
    if (!opened.isPlaced) return { text: `Smart Router: ${opened.reason}` };
    startTimer($);
    await navigate(
      $,
      argument === "all" ? "all" : "session",
      argument && argument !== "all" ? argument : undefined,
    );
    return { text: "Smart Router pane opened." };
  });
  on("ui.close", { id: PANE }, async ($, e, next) => {
    const result = await next(e);
    if (!(await isPlaced($))) {
      generation++;
      timer?.cancel();
      timer = undefined;
    }
    return result;
  });
  on("session.end", async (_$, e, next) => {
    generation++;
    timer?.cancel();
    timer = undefined;
    return next(e);
  });
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const state = await read($, pane);
    const width = Math.max(1, e.props.bodyColumns);
    const view = state.view;
    const refreshButton = (
      <Button key="refresh" label="Refresh" onPress={() => refresh($, true)} />
    );
    if (view.kind === "list") {
      const threads = selectThreads(
        state.threads,
        state.scope,
        await $.session.id(),
      );
      return (
        <Box flexDirection="column" width={width}>
          <Box flexDirection="row" flexWrap="wrap">
            <Button
              key="session"
              label={
                state.scope === "session" ? "[This session]" : "This session"
              }
              onPress={() => navigate($, "session")}
            />
            <Button
              key="all"
              label={state.scope === "all" ? "[All]" : "All"}
              onPress={() => navigate($, "all")}
            />
            {refreshButton}
          </Box>
          {state.error && (
            <Text color="error" wrap="truncate-end">
              {state.error}
            </Text>
          )}
          {!state.error && threads.length === 0 && (
            <Text dimColor>
              {state.scope === "session"
                ? "No smart-router threads in this session"
                : "No smart-router threads"}
            </Text>
          )}
          {threads.map((thread) => (
            <Box flexDirection="column">
              <Button
                key={thread.handle}
                plain
                onPress={() => navigate($, state.scope, thread.handle)}
              >
                <Text wrap="truncate-end">
                  {"  ".repeat(
                    Math.min(thread.depth - 1, Math.floor(width / 4)),
                  )}
                  {statusGlyph(thread.status)} {thread.handle} {thread.harness}:
                  {thread.model}@{thread.effort}{" "}
                  {relativeAge(thread.createdAt, state.now)}
                </Text>
              </Button>
              <Text dimColor wrap="truncate-end">
                {oneLine(thread.promptPreview)}
              </Text>
            </Box>
          ))}
        </Box>
      );
    }
    const record = view.record;
    const hidden = Math.max(0, view.items.length - ITEM_LIMIT);
    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row">
          <Button
            key="back"
            label="Back"
            onPress={() => navigate($, state.scope)}
          />
          {refreshButton}
        </Box>
        {state.error && (
          <Text color="error" wrap="truncate-end">
            {state.error}
          </Text>
        )}
        {!record && !state.error && <Text>Loading {view.handle}…</Text>}
        {record && (
          <Box flexDirection="column">
            <Text bold>
              {record.handle} {statusGlyph(record.status)} {record.status}{" "}
              {record.harness}:{record.model}@{record.effort}
            </Text>
            {record.cwd && <Text wrap="wrap">{record.cwd}</Text>}
            {record.routePick && (
              <Text wrap="wrap">Route: {record.routePick}</Text>
            )}
            {(record.inputTokens !== undefined ||
              record.outputTokens !== undefined) && (
              <Text>
                Tokens: {record.inputTokens ?? 0} in /{" "}
                {record.outputTokens ?? 0} out
              </Text>
            )}
            {record.costUsd !== undefined && (
              <Text>Cost: ${record.costUsd.toFixed(4)}</Text>
            )}
            {(record.error || record.lastAction) && (
              <Text color={record.error ? "error" : undefined} wrap="wrap">
                {record.error || record.lastAction}
              </Text>
            )}
          </Box>
        )}
        {hidden > 0 && <Text dimColor>{hidden} earlier items hidden</Text>}
        {view.items.slice(-ITEM_LIMIT).map((item) => (
          <Box flexDirection="column">
            <Text
              bold={item.kind === "user" || item.kind === "result"}
              dimColor={item.kind === "output"}
              color={item.isError ? "error" : undefined}
              wrap={
                item.kind === "tool" || item.kind === "output"
                  ? "truncate-end"
                  : "wrap"
              }
            >
              {item.isError ? "✗ " : ""}
              {item.kind === "assistant" ? "Assistant: " : ""}
              {item.kind === "result" ? "Result: " : ""}
              {item.text}
            </Text>
          </Box>
        ))}
      </Box>
    );
  });
};
