import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, Timer } from "claude-code";
import type {
  ConversationItem,
  PaneState,
  Scope,
  SpawnCall,
  SpawnCalls,
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
const TITLE_LIMIT = 80;
// A background spawn's session must appear within this window after its Bash call starts.
const SPAWN_MATCH_WINDOW = 10 * 60 * 1000;
const CLOCK_SKEW = 2000;
const SPAWN_COMMAND = /\bsmart-router\s+spawn\b/g;
const DRY_RUN_FLAG = /\s--dry-run\b/;
const LABEL_ARGUMENT =
  /\s--label(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"';&|]+))/;
// `spawn` and `spawn --detach` print one JSON line that starts with the handle.
const SPAWN_OUTPUT_HANDLE = /^\{"handle":"([a-f0-9]{6})"/gm;
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
const spawns = atom(
  { plugin: "smart-router-threads", key: "spawns" } as const,
  {} as SpawnCalls,
  { shape: "spawns-1" },
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
    label: optionalString(record.label),
    phase: optionalString(record.phase),
    startedAt: optionalString(record.startedAt),
    endedAt: optionalString(record.endedAt),
    cwd: optionalString(record.cwd),
    routePick: optionalString(route.pick),
    inputTokens: optionalNumber(usage.inputTokens),
    outputTokens: optionalNumber(usage.outputTokens),
    costUsd: optionalNumber(usage.costUsd),
    lastAction: optionalString(record.lastAction),
    error: optionalString(record.error),
    result: optionalString(
      record.result ?? record.lastResult ?? record.resultPreview,
    ),
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
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
export function statusText(status: ThreadStatus): string {
  return {
    running: "Working",
    done: "Completed",
    failed: "Failed",
    stopped: "Stopped",
    unknown: "Unknown",
  }[status];
}
export function statusColor(status: ThreadStatus): string {
  return {
    running: "suggestion",
    done: "success",
    failed: "error",
    stopped: "warning",
    unknown: "inactive",
  }[status];
}
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
function threadEnd(thread: Thread, now: number): number | undefined {
  if (thread.endedAt) return Date.parse(thread.endedAt);
  if (thread.status === "running") return now;
  return undefined;
}
export function threadElapsed(thread: Thread, now: number): string {
  const end = threadEnd(thread, now);
  if (end === undefined) return "";
  return formatDuration(end - Date.parse(thread.startedAt ?? thread.createdAt));
}
function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
export type ThreadRow = {
  title: string;
  glyph: string;
  status: string;
  color: string;
  route: string;
  preview: string;
};
export function threadRow(thread: Thread, now: number): ThreadRow {
  const harness =
    thread.harness.charAt(0).toUpperCase() + thread.harness.slice(1);
  return {
    title: truncate(thread.label ?? oneLine(thread.promptPreview), TITLE_LIMIT),
    glyph: statusGlyph(thread.status),
    status: statusText(thread.status),
    color: statusColor(thread.status),
    route: [harness, thread.model, thread.effort, threadElapsed(thread, now)]
      .filter(Boolean)
      .join(" · "),
    preview: oneLine(thread.result ?? thread.error ?? ""),
  };
}
export type PhaseGroup = {
  phase: string;
  done: number;
  total: number;
  threads: Thread[];
};
function progress(threads: Thread[]) {
  return {
    done: threads.filter((thread) => thread.status !== "running").length,
    total: threads.length,
  };
}
export function groupThreads(threads: Thread[]): {
  phases: PhaseGroup[];
  ungrouped: Thread[];
} {
  const phases = new Map<string, Thread[]>();
  const ungrouped: Thread[] = [];
  for (const thread of threads) {
    if (!thread.phase) {
      ungrouped.push(thread);
      continue;
    }
    phases.set(thread.phase, [...(phases.get(thread.phase) ?? []), thread]);
  }
  return {
    phases: [...phases].map(([phase, members]) => ({
      phase,
      threads: members,
      ...progress(members),
    })),
    ungrouped,
  };
}
export function phaseHeader(group: PhaseGroup): string {
  return `${group.phase} · ${group.done}/${group.total}`;
}
export function runFooter(threads: Thread[], now: number): string {
  if (threads.length === 0) return "";
  const { done, total } = progress(threads);
  const start = Math.min(
    ...threads.map((thread) => Date.parse(thread.createdAt)),
  );
  if (done < total)
    return `Working ${formatDuration(now - start)} · ${done}/${total}`;
  const end = Math.max(
    ...threads.map((thread) => Date.parse(thread.endedAt ?? thread.createdAt)),
  );
  return `Finished in ${formatDuration(end - start)} · ${done}/${total}`;
}
// One spawn per command; a dry run creates no session.
export function spawnCallFromCommand(
  command: string,
  startedAt: number,
): SpawnCall | undefined {
  const spawnCount = command.match(SPAWN_COMMAND)?.length ?? 0;
  if (spawnCount !== 1 || DRY_RUN_FLAG.test(command)) return undefined;
  const match = LABEL_ARGUMENT.exec(command);
  const label = (
    match?.[1]?.replace(/\\(.)/g, "$1") ??
    match?.[2] ??
    match?.[3]
  )?.trim();
  return label ? { startedAt, label } : { startedAt };
}
export function spawnOutputHandle(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null || !("stdout" in output))
    return undefined;
  if (typeof output.stdout !== "string") return undefined;
  const handles = new Set(
    [...output.stdout.matchAll(SPAWN_OUTPUT_HANDLE)].map((match) => match[1]),
  );
  return handles.size === 1 ? [...handles][0] : undefined;
}
function isOpenSpawn(call: SpawnCall, now: number): boolean {
  return (
    !call.handle && !!call.label && now - call.startedAt < SPAWN_MATCH_WINDOW
  );
}
function couldBeSpawn(call: SpawnCall, thread: Thread, owner: string): boolean {
  return (
    thread.owner === owner &&
    thread.label === call.label &&
    Date.parse(thread.createdAt) >= call.startedAt - CLOCK_SKEW
  );
}
// Pin a call to a session only when each is the other's sole candidate.
export function resolveSpawnCalls(
  calls: SpawnCalls,
  threads: Thread[],
  owner: string,
  now: number,
): SpawnCalls {
  const pinned = new Set(Object.values(calls).map((call) => call.handle));
  const unpinned = threads.filter((thread) => !pinned.has(thread.handle));
  const open = Object.entries(calls).filter(([, call]) =>
    isOpenSpawn(call, now),
  );
  const resolved = { ...calls };
  for (const [id, call] of open) {
    const candidates = unpinned.filter((thread) =>
      couldBeSpawn(call, thread, owner),
    );
    const thread = candidates[0];
    if (candidates.length !== 1 || !thread) continue;
    const rivals = open.filter(([, other]) =>
      couldBeSpawn(other, thread, owner),
    );
    if (rivals.length === 1) resolved[id] = { ...call, handle: thread.handle };
  }
  return resolved;
}
export function hasPendingSpawns(
  calls: SpawnCalls,
  threads: Thread[],
  now: number,
): boolean {
  return Object.values(calls).some(
    (call) =>
      isOpenSpawn(call, now) ||
      threads.some(
        (thread) =>
          thread.handle === call.handle && thread.status === "running",
      ),
  );
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

function stopTimer() {
  timer?.cancel();
  timer = undefined;
}
async function refresh($: EngineInterface, force = false) {
  if (busy) return;
  busy = true;
  const started = generation;
  try {
    const placed = await isPlaced($);
    const current = await read($, pane);
    const now = await $.clock.now();
    const watching = hasPendingSpawns(
      await read($, spawns),
      current.threads,
      now,
    );
    if (!placed && !watching) {
      stopTimer();
      return;
    }
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
      const owner = await $.session.id();
      await update($, spawns, (calls) =>
        resolveSpawnCalls(calls, threads, owner, now),
      );
    }
    if (!placed || current.view.kind !== "thread") return;
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
async function openPane(
  $: EngineInterface,
  scope: Scope,
  handle?: string,
): Promise<string | undefined> {
  const opened = await $.ui.open({
    id: PANE,
    title: "Smart Router",
    focus: true,
  });
  if (!opened.isPlaced) return opened.reason;
  startTimer($);
  await navigate($, scope, handle);
  return undefined;
}
function bashCommand(tool: string, input: unknown): string | undefined {
  if (tool !== "Bash" || typeof input !== "object" || input === null)
    return undefined;
  if (!("command" in input) || typeof input.command !== "string")
    return undefined;
  return input.command;
}
type Elements = ReturnType<EngineInterface["ui"]["resolve"]>;
function rowView(
  { Box, Text, Button }: Elements,
  row: ThreadRow,
  key: string,
  indent: string,
  onPress: () => unknown,
) {
  return (
    <Box flexDirection="column">
      <Button key={key} plain onPress={onPress}>
        {indent}
        <Text color={row.color}>{row.glyph}</Text> {row.title} ·{" "}
        <Text color={row.color}>{row.status}</Text>
      </Button>
      <Text dimColor wrap="truncate-end">
        {indent}
        {"  "}
        {row.route}
      </Text>
      {row.preview && (
        <Text dimColor wrap="truncate-end">
          {indent}
          {"  "}
          {row.preview}
        </Text>
      )}
    </Box>
  );
}
export const register: Register = (on, _options) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "sr",
      description: "Browse smart-router threads",
      argumentHint: "[all|handle]",
    });
    // The timer stops itself when no pane is placed and no spawn card is live.
    startTimer($);
    if (await isPlaced($)) await refresh($, true);
    return next(e);
  });
  on("command.run", { command: "sr" }, async ($, e) => {
    const argument = e.args.trim();
    if (argument && argument !== "all" && !/^[a-f0-9]{6}$/.test(argument))
      return { text: "Usage: /sr [all|handle]" };
    const reason = await openPane(
      $,
      argument === "all" ? "all" : "session",
      argument && argument !== "all" ? argument : undefined,
    );
    if (reason) return { text: `Smart Router: ${reason}` };
    return { text: "Smart Router pane opened." };
  });
  on("ui.close", { id: PANE }, async ($, e, next) => {
    const result = await next(e);
    if (!(await isPlaced($))) generation++;
    return result;
  });
  on("session.end", async (_$, e, next) => {
    generation++;
    stopTimer();
    return next(e);
  });
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const call = spawnCallFromCommand(e.command, await $.clock.now());
    if (!call) return next(e);
    await update($, spawns, (calls) => ({ ...calls, [e.tool_use_id]: call }));
    startTimer($);
    const result = await next(e);
    // A spawn that failed in the foreground created no session to match.
    if (result.deny !== undefined || result.isError)
      await update(
        $,
        spawns,
        ({ [e.tool_use_id]: _failed, ...calls }) => calls,
      );
    return result;
  });
  on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
    const row = await next(e);
    const command = bashCommand(e.props.tool, e.props.input);
    if (command === undefined || !spawnCallFromCommand(command, 0)) return row;
    const call = (await read($, spawns))[e.props.tool_use_id];
    const handle = spawnOutputHandle(e.props.output) ?? call?.handle;
    const state = await read($, pane);
    const thread = state.threads.find((item) => item.handle === handle);
    if (!thread) return row;
    const elements = $.ui.resolve(e);
    const { Box } = elements;
    return (
      <Box flexDirection="column" borderStyle="round">
        {row}
        {rowView(
          elements,
          threadRow(thread, state.now),
          `card-${thread.handle}`,
          "",
          async () => {
            const reason = await openPane($, "session", thread.handle);
            if (reason) $.ui.toast(`Smart Router: ${reason}`);
          },
        )}
      </Box>
    );
  });
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e);
    const { Box, Text, Button } = elements;
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
      const isSessionScope = state.scope === "session";
      const groups = groupThreads(threads);
      const footer = runFooter(threads, state.now);
      const rows = (items: Thread[]) =>
        items.map((thread) =>
          rowView(
            elements,
            threadRow(thread, state.now),
            thread.handle,
            "  ".repeat(Math.min(thread.depth - 1, Math.floor(width / 4))),
            () => navigate($, state.scope, thread.handle),
          ),
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
          {isSessionScope &&
            groups.phases.map((group) => (
              <Box flexDirection="column">
                <Text bold>{phaseHeader(group)}</Text>
                {rows(group.threads)}
              </Box>
            ))}
          {rows(isSessionScope ? groups.ungrouped : threads)}
          {isSessionScope && footer && <Text dimColor>{footer}</Text>}
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
