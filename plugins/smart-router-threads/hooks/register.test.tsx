import { expect, mock, test } from "claude-code/testing";
import {
  conversationFromEvents,
  formatDuration,
  groupThreads,
  hasPendingSpawns,
  parseThread,
  phaseHeader,
  resolveSpawnCalls,
  runFooter,
  selectThreads,
  spawnCallFromCommand,
  spawnOutputHandle,
  statusGlyph,
  threadRow,
} from "./register";
import type { CommandRunInput } from "claude-code";
import type { Thread } from "../types/index";

// Synthetic smart-router logs <handle> --events fixtures.
const CODEX =
  '{"v":1,"handle":"abcdef","harness":"codex","ts":"2026-01-01T12:00:00.000Z","type":"session.started","model":"gpt-6.1-sol","effort":"high","sessionId":"00000000-0000-4000-8000-000000000001"}\n{"v":1,"handle":"abcdef","harness":"codex","ts":"2026-01-01T12:00:00.001Z","type":"message","role":"assistant","text":"I will rename the variable in /tmp/project and check the result with the existing tests."}\n{"v":1,"handle":"abcdef","harness":"codex","ts":"2026-01-01T12:00:00.002Z","type":"tool.started","toolId":"tool_test_001","name":"command_execution","input":"/bin/zsh -lc pwd"}\n{"v":1,"handle":"abcdef","harness":"codex","ts":"2026-01-01T12:00:00.003Z","type":"tool.finished","toolId":"tool_test_001","name":"command_execution","exitCode":0,"isError":false,"output":"/tmp/project\\n"}\n{"v":1,"handle":"abcdef","harness":"codex","ts":"2026-01-01T12:00:00.004Z","type":"usage","inputTokens":100,"outputTokens":20,"costUsd":null,"cachedInputTokens":50,"cacheWriteTokens":0,"cacheHitRatio":0.5}\n{"v":1,"handle":"abcdef","harness":"codex","ts":"2026-01-01T12:00:00.005Z","type":"result","text":"Renamed the variable in /tmp/project/src/example.ts and confirmed that all existing tests pass.","usage":{"inputTokens":100,"outputTokens":20,"cachedInputTokens":50,"cacheWriteTokens":0,"costUsd":null}}';

const CLAUDE =
  '{"v":1,"handle":"123abc","harness":"claude","ts":"2026-01-01T12:00:00.000Z","type":"session.started","model":"claude-fable-5-1","effort":"high","sessionId":"00000000-0000-4000-8000-000000000002"}\n{"v":1,"handle":"123abc","harness":"claude","ts":"2026-01-01T12:00:00.001Z","type":"message","role":"assistant","text":"I will rename the variable in /tmp/project and check the result with the existing tests."}\n{"v":1,"handle":"123abc","harness":"claude","ts":"2026-01-01T12:00:00.002Z","type":"tool.started","toolId":"tool_test_001","name":"Bash","input":"{\\"command\\": \\"cd /tmp/project && pwd\\"}"}\n{"v":1,"handle":"123abc","harness":"claude","ts":"2026-01-01T12:00:00.003Z","type":"tool.finished","toolId":"tool_test_001","name":"Bash","isError":false,"output":"/tmp/project\\n"}\n{"v":1,"handle":"123abc","harness":"claude","ts":"2026-01-01T12:00:00.004Z","type":"usage","inputTokens":100,"outputTokens":20,"costUsd":0.25,"cachedInputTokens":50,"cacheWriteTokens":0,"cacheHitRatio":0.5}\n{"v":1,"handle":"123abc","harness":"claude","ts":"2026-01-01T12:00:00.005Z","type":"result","text":"Renamed the variable in /tmp/project/src/example.ts and confirmed that all existing tests pass.","usage":{"inputTokens":100,"outputTokens":20,"costUsd":0.25,"cachedInputTokens":50,"cacheWriteTokens":0}}';

const OWNER = "00000000-0000-4000-8000-000000000003";
const THREAD: Thread = {
  handle: "abcdef",
  owner: OWNER,
  status: "done",
  harness: "codex",
  model: "gpt-6.1-sol",
  effort: "high",
  depth: 1,
  createdAt: "2026-01-01T12:00:00.000Z",
  promptPreview: "Rename a variable",
};
const PANE = {
  plugin: "smart-router-threads",
  component: "Pane",
  requestId: "smart-router",
  props: {
    title: "Smart Router",
    isFocused: true,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;
const command = (args = ""): CommandRunInput => ({
  command: "sr",
  args,
  origin: { kind: "composer" },
  presentation: { isFullscreen: true, columns: 160 },
});
const output = (stdout: string, stderr = "", exitCode = 0) => ({
  value: {
    stdout,
    stderr,
    exitCode,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});

test("owner filtering includes nested delegates, sorts newest first and caps only All", () => {
  const nested = {
    ...THREAD,
    handle: "nested",
    depth: 2,
    createdAt: "2026-01-01T13:00:00Z",
  };
  const other = { ...THREAD, handle: "other", owner: "another-session" };
  expect(
    selectThreads([THREAD, other, nested], "session", OWNER).map(
      (item) => item.handle,
    ),
  ).toEqual(["nested", "abcdef"]);
  const many = Array.from({ length: 35 }, (_, index) => ({
    ...THREAD,
    handle: String(index),
  }));
  expect(selectThreads(many, "all", OWNER)).toHaveLength(30);
  expect(selectThreads(many, "session", OWNER)).toHaveLength(35);
  // Older CLI records omit ownership, status and depth.
  const legacy = parseThread({
    handle: "fedcba",
    harness: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
    createdAt: "2026-01-01T11:00:00.000Z",
    promptPreview: "",
  });
  expect(selectThreads([legacy], "session", OWNER)).toHaveLength(0);
  expect(selectThreads([legacy], "all", OWNER)).toHaveLength(1);
  expect(legacy.status).toBe("unknown");
  expect(legacy.depth).toBe(1);
  expect(statusGlyph(legacy.status)).toBe("?");
  expect(statusGlyph("running")).toBe("●");
  expect(statusGlyph("done")).toBe("✓");
  expect(statusGlyph("failed")).toBe("✗");
  expect(statusGlyph("stopped")).toBe("■");
});

test("synthetic Codex and Claude events map to readable conversation items", () => {
  for (const [handle, jsonl] of [
    ["abcdef", CODEX],
    ["123abc", CLAUDE],
  ] as const) {
    const items = conversationFromEvents(jsonl, {
      ...THREAD,
      handle,
      promptPreview: "x".repeat(160),
    });
    expect(items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "output",
      "result",
    ]);
    expect(items[0]?.text).toBe("User (truncated): " + "x".repeat(160));
    expect(items[1]?.text.length).toBeGreaterThan(50);
    expect(items[2]?.text.startsWith("▸ ")).toBe(true);
    expect(items[3]?.text.split("\n").length).toBeLessThanOrEqual(3);
    expect(items[3]?.isError).toBe(false);
    expect(items[4]?.text.length).toBeGreaterThan(50);
  }
  const event = { v: 1, handle: THREAD.handle };
  const synthetic = [
    { ...event, type: "text.delta", text: "skip me" },
    { ...event, type: "tool.started", name: "Bash", input: "first\nsecond" },
    {
      ...event,
      type: "tool.finished",
      output: "one\ntwo\nthree\nfour",
      isError: true,
    },
    { ...event, type: "error", message: "failure" },
  ]
    .map((item) => JSON.stringify(item))
    .join("\n");
  const items = conversationFromEvents(synthetic, {
    ...THREAD,
    result: "Final record fallback",
  });
  expect(items.map((item) => item.text)).toEqual([
    "User: Rename a variable",
    "▸ Bash: first",
    "one\ntwo\nthree",
    "failure",
    "Final record fallback",
  ]);
  expect(items[2]?.isError).toBe(true);
  expect(items[3]?.isError).toBe(true);
  expect(() => parseThread({ ...THREAD, depth: -1 })).toThrow();
  expect(() => conversationFromEvents("not JSON", THREAD)).toThrow();
});

test(
  "list, scope buttons, thread conversation and Back render on terminal and desktop",
  { timeoutMs: 20000 },
  async ($, on) => {
    mock.clock(on, { now: Date.parse("2026-01-01T13:00:00Z") });
    on("command.register", () => ({ value: { command: "sr" } }));
    on("session.start", (_, event) => ({ cwd: event.cwd }));
    on("session.id", () => ({ value: OWNER }));
    on("ui.open", () => ({ value: { isPlaced: true } }));
    on("ui.panes", () => ({
      value: [
        {
          id: "smart-router",
          title: "Smart Router",
          isPlaced: true,
          isFocused: true,
          isShown: true,
        },
      ],
    }));
    on("process.run", (_, event) => {
      if (event.argv[1] === "sessions")
        return output(
          JSON.stringify([
            THREAD,
            { ...THREAD, handle: "123abc", owner: "other" },
          ]),
        );
      if (event.argv[1] === "status")
        return output(
          JSON.stringify({
            ...THREAD,
            cwd: "/project",
            route: { pick: "codex:gpt-6.1-sol@high" },
            usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.25 },
            lastAction: "Finished",
          }),
        );
      return output(CODEX);
    });
    await $.session.start({
      cwd: "/",
      surface: "terminal",
      isInteractive: true,
    });
    for (const surface of ["terminal", "desktop"] as const) {
      await $.command.run(command());
      const ui = await $.ui.mount({ ...PANE, surface });
      expect(
        (await ui.find({ type: "Button", key: THREAD.handle }))?.text,
      ).toContain("✓ Rename a variable · Completed");
      expect(
        await ui.find({ type: "Text", text: /Codex · gpt-6.1-sol · high/ }),
      ).toBeDefined();
      expect(await ui.find({ type: "Button", key: "123abc" })).toBeUndefined();
      await ui.press({ key: "all" });
      expect(await ui.find({ type: "Button", key: "123abc" })).toBeDefined();
      await ui.press({ key: THREAD.handle });
      expect(
        (await ui.find({ type: "Text", text: /User: Rename/ }))?.text,
      ).toBe("User: Rename a variable");
      expect(await ui.find({ type: "Text", text: /Assistant:/ })).toBeDefined();
      expect(
        await ui.find({ type: "Text", text: /▸ command_execution:/ }),
      ).toBeDefined();
      expect(await ui.find({ type: "Text", text: /Result:/ })).toBeDefined();
      expect((await ui.find({ type: "Text", text: /Tokens:/ }))?.text).toBe(
        "Tokens: 100 in / 20 out",
      );
      expect((await ui.find({ type: "Text", text: /Cost:/ }))?.text).toBe(
        "Cost: $0.2500",
      );
      await ui.press({ key: "back" });
      expect(await ui.find({ type: "Button", key: "123abc" })).toBeDefined();
      await $.command.run(command(THREAD.handle));
      expect(
        await ui.find({ type: "Text", text: /User: Rename/ }),
      ).toBeDefined();
      await ui.unmount();
    }
  },
);

test(
  "polls only placed panes, refreshes lists at 5s and running threads at 3s, stops at completion and close",
  { timeoutMs: 20000 },
  async ($, on) => {
    const clock = mock.clock(on);
    let placed = false;
    let status = "running";
    const commands: string[] = [];
    on("command.register", () => ({ value: { command: "sr" } }));
    on("session.start", (_, event) => ({ cwd: event.cwd }));
    on("session.id", () => ({ value: OWNER }));
    on("ui.open", () => {
      placed = true;
      return { value: { isPlaced: true } };
    });
    on("ui.close", () => {
      placed = false;
      return { value: undefined };
    });
    on("ui.panes", () => ({
      value: placed
        ? [
            {
              id: "smart-router",
              title: "Smart Router",
              isPlaced: true,
              isFocused: false,
              isShown: true,
            },
          ]
        : [],
    }));
    on("process.run", (_, event) => {
      const command = event.argv[1] ?? "";
      commands.push(command);
      if (command === "sessions")
        return output(JSON.stringify([{ ...THREAD, status }]));
      if (command === "status")
        return output(JSON.stringify({ ...THREAD, status }));
      return output(CODEX);
    });
    await $.session.start({
      cwd: "/",
      surface: "terminal",
      isInteractive: true,
    });
    await clock.advance(6000);
    expect(commands).toEqual([]);
    await $.command.run(command(THREAD.handle));
    expect(commands).toEqual(["sessions", "status", "logs"]);
    await clock.advance(2999);
    expect(commands).toHaveLength(3);
    await clock.advance(1);
    expect(commands).toEqual(["sessions", "status", "logs", "status", "logs"]);
    await clock.advance(2000);
    expect(commands.filter((command) => command === "sessions")).toHaveLength(
      2,
    );
    status = "done";
    await clock.advance(1000);
    expect(commands.filter((command) => command === "status")).toHaveLength(3);
    await clock.advance(6000);
    expect(commands.filter((command) => command === "status")).toHaveLength(3);
    placed = false;
    const count = commands.length;
    await clock.advance(10000);
    expect(commands).toHaveLength(count);
    await $.command.run(command("all"));
    const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
    expect(
      await ui.find({ type: "Button", key: "all", text: "[All]" }),
    ).toBeDefined();
    await clock.advance(5000);
    expect(commands.length).toBeGreaterThan(count);
    await ui.unmount();
  },
);

test("empty state and CLI stderr render as one line", async ($, on) => {
  mock.clock(on);
  let failing = false;
  on("command.register", () => ({ value: { command: "sr" } }));
  on("session.start", (_, event) => ({ cwd: event.cwd }));
  on("session.id", () => ({ value: OWNER }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.panes", () => ({
    value: [
      {
        id: "smart-router",
        title: "Smart Router",
        isPlaced: true,
        isFocused: true,
        isShown: true,
      },
    ],
  }));
  on("process.run", () =>
    failing ? output("", "CLI unavailable\nsecond line", 1) : output("[]"),
  );
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await $.command.run(command());
  const ui = await $.ui.mount({ ...PANE, surface: "terminal" });
  expect(
    await ui.find({
      type: "Text",
      text: "No smart-router threads in this session",
    }),
  ).toBeDefined();
  failing = true;
  await ui.press({ key: "refresh" });
  expect((await ui.find({ type: "Text", text: /CLI unavailable/ }))?.text).toBe(
    "CLI unavailable second line",
  );
  await ui.unmount();
});

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const at = (offset: number) => new Date(T0 + offset).toISOString();

test("rows show label or prompt, colored status, the real model and effort, elapsed and a result preview", () => {
  const running: Thread = {
    ...THREAD,
    label: "research:dji-mic",
    status: "running",
    effort: "medium",
    startedAt: at(0),
  };
  expect(threadRow(running, T0 + 506000)).toEqual({
    title: "research:dji-mic",
    glyph: "●",
    status: "Working",
    color: "suggestion",
    route: "Codex · gpt-6.1-sol · medium · 8m 26s",
    preview: "",
  });
  const done: Thread = {
    ...THREAD,
    harness: "claude",
    model: "claude-opus-5-5",
    effort: "xhigh",
    startedAt: at(0),
    endedAt: at(3720000),
    result: "Found\n  three   mounts",
  };
  expect(threadRow(done, 0)).toMatchObject({
    title: "Rename a variable",
    status: "Completed",
    color: "success",
    route: "Claude · claude-opus-5-5 · xhigh · 1h 2m",
    preview: "Found three mounts",
  });
  const failed: Thread = { ...THREAD, status: "failed", error: "boom" };
  expect(threadRow(failed, 0)).toMatchObject({
    glyph: "✗",
    status: "Failed",
    color: "error",
    route: "Codex · gpt-6.1-sol · high",
    preview: "boom",
  });
  const long = threadRow({ ...THREAD, promptPreview: "y".repeat(160) }, 0);
  expect(long.title).toBe(`${"y".repeat(79)}…`);
  expect(formatDuration(45000)).toBe("45s");
  expect(formatDuration(-5)).toBe("0s");
  expect(
    parseThread({
      ...THREAD,
      label: "research:a",
      phase: "Research",
      resultPreview: "short",
      startedAt: at(0),
      endedAt: null,
    }),
  ).toMatchObject({
    label: "research:a",
    phase: "Research",
    result: "short",
    startedAt: at(0),
    endedAt: undefined,
  });
});

test("threads group under phases with done/total counts and a run footer", () => {
  const threads: Thread[] = [
    { ...THREAD, handle: "aaaaa1", phase: "Research", status: "done" },
    { ...THREAD, handle: "aaaaa2", phase: "Build", status: "running" },
    { ...THREAD, handle: "aaaaa3", phase: "Research", status: "running" },
    { ...THREAD, handle: "aaaaa4", status: "failed" },
  ];
  const groups = groupThreads(threads);
  expect(groups.phases.map(phaseHeader)).toEqual([
    "Research · 1/2",
    "Build · 0/1",
  ]);
  expect(groups.phases[0]?.threads.map((item) => item.handle)).toEqual([
    "aaaaa1",
    "aaaaa3",
  ]);
  expect(groups.ungrouped.map((item) => item.handle)).toEqual(["aaaaa4"]);
  expect(runFooter(threads, T0 + 506000)).toBe("Working 8m 26s · 2/4");
  const finished = threads.map((item) => ({
    ...item,
    status: "done" as const,
    endedAt: at(300000),
  }));
  expect(runFooter(finished, T0 + 999999)).toBe("Finished in 5m 0s · 4/4");
  expect(runFooter([], T0)).toBe("");
});

test("spawn commands match their session by owner, label and start time, never guessing", () => {
  expect(
    spawnCallFromCommand(
      'smart-router spawn "Research mounts" --label research:mounts --detach',
      T0,
    ),
  ).toEqual({ startedAt: T0, label: "research:mounts" });
  expect(
    spawnCallFromCommand(
      'smart-router spawn "x" --label "  two words " --phase R',
      T0,
    )?.label,
  ).toBe("two words");
  expect(
    spawnCallFromCommand("smart-router spawn 'x' --label='quoted'", T0)?.label,
  ).toBe("quoted");
  expect(
    spawnCallFromCommand('smart-router spawn "x" --label "say \\"hi\\""', T0)
      ?.label,
  ).toBe('say "hi"');
  expect(spawnCallFromCommand('smart-router spawn "x"', T0)).toEqual({
    startedAt: T0,
  });
  for (const command of [
    'smart-router spawn "x" --dry-run --label a',
    "smart-router spawn a --label x & smart-router spawn b --label y",
    "smart-router status abcdef",
  ])
    expect(spawnCallFromCommand(command, T0)).toBeUndefined();
  expect(
    spawnOutputHandle({ stdout: '{"handle":"abc123","harness":"codex"}\n' }),
  ).toBe("abc123");
  expect(spawnOutputHandle({ stdout: "Running in background" })).toBe(
    undefined,
  );
  expect(spawnOutputHandle(undefined)).toBeUndefined();
  expect(
    spawnOutputHandle({ stdout: '{"handle":"abc123"}\n{"handle":"def456"}' }),
  ).toBeUndefined();

  const session = (handle: string, label: string, offset: number) => ({
    ...THREAD,
    handle,
    label,
    status: "running" as const,
    createdAt: at(offset),
  });
  // Two spawns with the same prompt are told apart by their labels.
  const parallel = resolveSpawnCalls(
    {
      first: { startedAt: T0, label: "research:a" },
      second: { startedAt: T0 + 100, label: "research:b" },
    },
    [
      session("aaaaaa", "research:a", 3000),
      session("bbbbbb", "research:b", 2500),
    ],
    OWNER,
    T0 + 5000,
  );
  expect(parallel.first?.handle).toBe("aaaaaa");
  expect(parallel.second?.handle).toBe("bbbbbb");
  // No match: another owner, a session older than the call, or no label.
  const unmatched = {
    owned: { startedAt: T0, label: "x" },
    older: { startedAt: T0, label: "y" },
    unlabeled: { startedAt: T0 },
  };
  expect(
    resolveSpawnCalls(
      unmatched,
      [
        { ...session("cccccc", "x", 1000), owner: "other" },
        session("dddddd", "y", -5000),
        session("eeeeee", "z", 1000),
      ],
      OWNER,
      T0 + 5000,
    ),
  ).toEqual(unmatched);
  // Two spawns with the same label in flight: neither gets a card.
  const duplicate = {
    first: { startedAt: T0, label: "dup" },
    second: { startedAt: T0 + 100, label: "dup" },
  };
  expect(
    resolveSpawnCalls(duplicate, [session("ffffff", "dup", 3000)], OWNER, T0),
  ).toEqual(duplicate);
  // A label reused after the first call was pinned matches the new session.
  const sequential = resolveSpawnCalls(
    {
      first: { startedAt: T0, label: "dup", handle: "ffffff" },
      second: { startedAt: T0 + 60000, label: "dup" },
    },
    [session("ffffff", "dup", 3000), session("999999", "dup", 63000)],
    OWNER,
    T0 + 65000,
  );
  expect(sequential.second?.handle).toBe("999999");
  // Past the match window a call stops matching and stops polling.
  const stale = { old: { startedAt: T0 - 11 * 60000, label: "late" } };
  expect(
    resolveSpawnCalls(stale, [session("777777", "late", 0)], OWNER, T0),
  ).toEqual(stale);
  expect(hasPendingSpawns(stale, [], T0)).toBe(false);
  expect(
    hasPendingSpawns({ open: { startedAt: T0, label: "a" } }, [], T0),
  ).toBe(true);
  const pinned = { done: { startedAt: T0, label: "a", handle: "aaaaaa" } };
  expect(hasPendingSpawns(pinned, [session("aaaaaa", "a", 0)], T0)).toBe(true);
  expect(
    hasPendingSpawns(
      pinned,
      [{ ...session("aaaaaa", "a", 0), status: "done" }],
      T0,
    ),
  ).toBe(false);
});

test(
  "the session pane groups phases with a footer; a background spawn row gets a live card that opens /sr",
  { timeoutMs: 20000 },
  async ($, on) => {
    const clock = mock.clock(on, { now: T0 });
    let placed = false;
    let opened = 0;
    let toolUseId = "";
    const sessions: Thread[] = [];
    on("command.register", () => ({ value: { command: "sr" } }));
    on("session.start", (_, event) => ({ cwd: event.cwd }));
    on("session.id", () => ({ value: OWNER }));
    on("ui.open", () => {
      opened++;
      placed = true;
      return { value: { isPlaced: true } };
    });
    on("ui.panes", () => ({
      value: placed
        ? [
            {
              id: "smart-router",
              title: "Smart Router",
              isPlaced: true,
              isFocused: true,
              isShown: true,
            },
          ]
        : [],
    }));
    on("tool.call", (_, event) => {
      toolUseId = event.tool_use_id;
      return { result: { stdout: "Running in background", stderr: "" } };
    });
    on("process.run", (_, event) => {
      if (event.argv[1] === "sessions") return output(JSON.stringify(sessions));
      if (event.argv[1] === "status")
        return output(JSON.stringify(sessions[0]));
      return output("");
    });
    await $.session.start({
      cwd: "/",
      surface: "terminal",
      isInteractive: true,
    });
    const spawnCommand =
      'smart-router spawn "Research DJI mics" --label research:dji-mic --phase Research';
    await $.tool.call({ tool: "Bash", command: spawnCommand });
    expect(toolUseId).not.toBe("");
    const card = (surface: "terminal" | "desktop") =>
      $.ui.mount({
        plugin: "smart-router-threads",
        surface,
        component: "ToolUse",
        requestId: toolUseId,
        props: {
          tool_use_id: toolUseId,
          tool: "Bash",
          input: { command: spawnCommand, run_in_background: true },
          isRunning: false,
          isErrored: false,
          isInterrupted: false,
          output: { stdout: "Running in background", stderr: "" },
        },
      });
    // Before the session exists there is no card.
    let ui = await card("terminal");
    expect(
      await ui.find({ type: "Button", key: "card-abc123" }),
    ).toBeUndefined();
    await ui.unmount();
    sessions.push(
      {
        ...THREAD,
        handle: "abc123",
        label: "research:dji-mic",
        phase: "Research",
        status: "running",
        effort: "medium",
        createdAt: at(-1000),
        startedAt: at(-1000),
      },
      {
        ...THREAD,
        handle: "def456",
        label: "research:iphone-duo",
        phase: "Research",
        harness: "claude",
        model: "claude-opus-5-5",
        effort: "xhigh",
        createdAt: at(-500),
        startedAt: at(-500),
        endedAt: at(58500),
        result: "Apple announced iPhone Duo in September 2026",
      },
    );
    await clock.advance(5000);
    for (const surface of ["terminal", "desktop"] as const) {
      ui = await card(surface);
      expect(
        (await ui.find({ type: "Button", key: "card-abc123" }))?.text,
      ).toContain("● research:dji-mic · Working");
      expect(
        await ui.find({
          type: "Text",
          text: /Codex · gpt-6.1-sol · medium · 2s/,
        }),
      ).toBeDefined();
      await ui.unmount();
    }
    ui = await card("terminal");
    await ui.press({ key: "card-abc123" });
    expect(opened).toBe(1);
    await ui.unmount();
    const group = (isExpanded: boolean) =>
      $.ui.mount({
        plugin: "smart-router-threads",
        surface: "terminal",
        component: "ToolGroup",
        props: {
          calls: [
            {
              tool_use_id: toolUseId,
              tool: "Bash",
              input: { command: spawnCommand },
              isRunning: true,
              isErrored: false,
              isInterrupted: false,
            },
            {
              tool: "Bash",
              input: { command: "ls" },
              isRunning: false,
              isErrored: false,
              isInterrupted: false,
            },
          ],
          isActive: true,
          isExpanded,
        },
      });
    let folded = await group(false);
    expect(
      (await folded.find({ type: "Button", key: "card-abc123" }))?.text,
    ).toContain("● research:dji-mic · Working");
    await folded.unmount();
    folded = await group(true);
    expect(
      await folded.find({ type: "Button", key: "card-abc123" }),
    ).toBeUndefined();
    await folded.unmount();

    await $.command.run(command());
    const pane = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect(
      await pane.find({ type: "Text", text: "Research · 1/2" }),
    ).toBeDefined();
    expect(
      (await pane.find({ type: "Button", key: "def456" }))?.text,
    ).toContain("✓ research:iphone-duo · Completed");
    expect(
      await pane.find({
        type: "Text",
        text: /Claude · claude-opus-5-5 · xhigh · 59s/,
      }),
    ).toBeDefined();
    expect(
      await pane.find({ type: "Text", text: /Apple announced iPhone Duo/ }),
    ).toBeDefined();
    expect(
      await pane.find({ type: "Text", text: "Working 6s · 1/2" }),
    ).toBeDefined();
    await pane.press({ key: "all" });
    expect(
      await pane.find({ type: "Text", text: /Research ·/ }),
    ).toBeUndefined();
    expect(await pane.find({ type: "Button", key: "abc123" })).toBeDefined();
    await pane.unmount();
  },
);

test("a failed foreground spawn is forgotten and never gets a card", async ($, on) => {
  const clock = mock.clock(on, { now: T0 });
  let toolUseId = "";
  let fetches = 0;
  on("session.start", (_, event) => ({ cwd: event.cwd }));
  on("command.register", () => ({ value: { command: "sr" } }));
  on("session.id", () => ({ value: OWNER }));
  on("ui.panes", () => ({ value: [] }));
  on("tool.call", (_, event) => {
    toolUseId = event.tool_use_id;
    return { isError: true, result: "Exit code 1" };
  });
  on("process.run", () => {
    fetches++;
    return output(
      JSON.stringify([
        { ...THREAD, handle: "abc123", label: "x", createdAt: at(1000) },
      ]),
    );
  });
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  const spawnCommand = "smart-router spawn task --label x";
  await $.tool.call({ tool: "Bash", command: spawnCommand });
  await clock.advance(10000);
  expect(fetches).toBe(0);
  const ui = await $.ui.mount({
    plugin: "smart-router-threads",
    surface: "terminal",
    component: "ToolUse",
    requestId: toolUseId,
    props: {
      tool_use_id: toolUseId,
      tool: "Bash",
      input: { command: spawnCommand },
      isRunning: false,
      isErrored: true,
      isInterrupted: false,
    },
  });
  expect(await ui.find({ type: "Button", key: "card-abc123" })).toBeUndefined();
  await ui.unmount();
});

test("rows and spawn tracking expose pending wakes and stuck silence", () => {
  const thread = parseThread({
    ...THREAD,
    wakes: [{ state: "pending", pid: 37328, command: "sessions.sh" }],
    stuck: { reason: "silent", since: THREAD.createdAt },
    activity: { silentSeconds: 2520 },
  });
  expect(threadRow(thread, 0).status).toContain(
    "waiting on pid 37328 · sessions.sh",
  );
  expect(threadRow(thread, 0).status).toContain("silent 42m");
  expect(
    hasPendingSpawns(
      { call: { handle: thread.handle, startedAt: 0 } },
      [thread],
      0,
    ),
  ).toBe(true);
  const settled = parseThread({
    ...THREAD,
    wakes: [{ state: "sent", pid: 37328, command: "sessions.sh" }],
    stuck: null,
  });
  expect(threadRow(settled, 0).status).toBe("Completed");
});

test("T3 launched rows have a marker and retain the picked harness", () => {
  const thread = parseThread({
    ...THREAD,
    runner: "t3",
    status: "launched",
    label: "T3 child",
  });
  const row = threadRow(thread, 0);
  expect(row.route).toContain("T3 · Codex");
  expect(row.title).toBe("T3 child");
  expect(row.status).toBe("Launched");
});

test("rows expose T3 warnings", () => {
  const thread = parseThread({
    ...THREAD,
    runner: "t3",
    warning: "waiting for an answer in T3",
  });
  expect(threadRow(thread, 0).preview).toContain("waiting for an answer in T3");
});
