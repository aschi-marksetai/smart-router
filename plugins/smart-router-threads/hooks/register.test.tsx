import { expect, mock, test } from "claude-code/testing";
import {
  conversationFromEvents,
  parseThread,
  relativeAge,
  selectThreads,
  statusGlyph,
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
  expect(
    relativeAge(THREAD.createdAt, Date.parse(THREAD.createdAt) + 120000),
  ).toBe("2m");
  expect(relativeAge(THREAD.createdAt, 0)).toBe("0s");
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
      ).toContain("✓ abcdef codex:gpt-6.1-sol@high");
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
