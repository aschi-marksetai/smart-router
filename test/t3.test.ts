import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  loadSession,
  saveSession,
  saveT3Session,
  sweepSessions,
  processStartTime,
  sessionPath,
  expireT3Launch,
  type Session,
} from "../src/sessions.ts";
import {
  attachT3Session,
  refreshT3Session,
  sendT3Session,
  t3Result,
  t3State,
  T3_ATTACH_TIMEOUT_MS,
  T3_REFRESH_CONCURRENCY,
} from "../src/t3.ts";
import { sessionStatus, sessionSummary } from "../src/session-view.ts";
import { watchWake } from "../src/wakes.ts";

let directory: string, session: Session, fixture: string, calls: string;
const saved = {
  state: process.env.SMART_ROUTER_STATE_DIR,
  config: process.env.SMART_ROUTER_CONFIG_DIR,
  cli: process.env.SMART_ROUTER_T3_CLI,
};
const TEST_T3_THREAD_ID =
  "thread:delegated-task:command%3Amcp%3A88e0911f-136c-4cff-a770-b45d4445e762%3Adelegate-task%3A6d558d53-1fee-496d-8fd6-80a6c093db42";
const updatedAt = new Date().toISOString();
async function view(values: Record<string, unknown> = {}) {
  await writeFile(
    fixture,
    JSON.stringify({
      thread: {
        status: "running",
        updatedAt,
        activeRunId: null,
        latestRunId: "run-1",
        ...values,
      },
      messages: [{ role: "assistant", runId: "run-1", text: "final reply" }],
    }),
  );
}
function cli(args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
    { env: process.env },
  );
  return {
    exitCode: result.exitCode,
    json: JSON.parse(result.stdout.toString()),
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "smart-router-t3-"));
  fixture = join(directory, "fixture.json");
  calls = join(directory, "calls.jsonl");
  process.env.SMART_ROUTER_STATE_DIR = directory;
  process.env.SMART_ROUTER_CONFIG_DIR = join(directory, "config");
  const binary = join(directory, "fake-t3");
  process.env.SMART_ROUTER_T3_CLI = binary;
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import {readFileSync,appendFileSync,writeFileSync} from "node:fs";
const argv=process.argv.slice(2), file=${JSON.stringify(fixture)}, calls=${JSON.stringify(calls)};
const input=await Bun.stdin.text(), value=JSON.parse(readFileSync(file,"utf8"));
appendFileSync(calls,JSON.stringify({argv,input,start:Date.now()})+"\\n");
if(value.delayMs){await Bun.sleep(value.delayMs);appendFileSync(calls,JSON.stringify({argv,input,end:Date.now()})+"\\n");}
if(value.fail||(argv[1]==="send"&&value.failSend)||(argv.at(-1)==="1"&&value.failResult)){console.error(value.failSend??value.failResult??(typeof value.fail==="string"?value.fail:"fake T3 failure"));process.exit(1);}
if(argv[1]==="show"&&value.views?.length){const shown=value.views.shift();writeFileSync(file,JSON.stringify(value));if(argv.at(-1)==="0")shown.messages=[];console.log(JSON.stringify(shown));process.exit(0);}
if(argv[1]==="send"){
 value.thread.status="running";value.thread.latestRunId="run-2";value.thread.updatedAt=new Date().toISOString();
 writeFileSync(file,JSON.stringify(value));console.log(JSON.stringify(value.sendReply??{runId:"run-2",delivery:"queued"}));
}else {if(argv.at(-1)==="0")value.messages=[];console.log(JSON.stringify(value));}
`,
  );
  await chmod(binary, 0o755);
  await view();
  session = await createSession({
    harness: "claude",
    model: "test",
    effort: "high",
    cwd: directory,
    prompt: "task",
    runner: "t3",
    t3ThreadId: "",
    status: "launched",
  });
});
afterEach(async () => {
  for (const [name, value] of [
    ["SMART_ROUTER_STATE_DIR", saved.state],
    ["SMART_ROUTER_CONFIG_DIR", saved.config],
    ["SMART_ROUTER_T3_CLI", saved.cli],
  ]) {
    if (value === undefined) delete process.env[name!];
    else process.env[name!] = value;
  }
  await rm(directory, { recursive: true, force: true });
});
async function history(): Promise<{ argv: string[]; input: string }[]> {
  return (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((call) => !call.end);
}
test("attach validates and unattached launches expire", async () => {
  expect(cli(["wait", session.handle, "--timeout", "0"]).exitCode).toBe(124);
  const attached = cli([
    "attach",
    session.handle,
    "--t3-thread",
    TEST_T3_THREAD_ID,
  ]);
  expect(attached.exitCode).toBe(0);
  expect(attached.json.t3ThreadId).toBe(TEST_T3_THREAD_ID);
  expect(cli(["attach", session.handle, "--t3-thread", "other"]).exitCode).toBe(
    1,
  );
  const orphan = await createSession({
    ...session,
    handle: undefined,
    prompt: "unattached",
  });
  orphan.createdAt = new Date(
    Date.now() - T3_ATTACH_TIMEOUT_MS - 1,
  ).toISOString();
  await saveSession(orphan);
  await sweepSessions();
  expect(await Bun.file(sessionPath(orphan.handle)).exists()).toBe(false);
  expect(
    cli(["attach", orphan.handle, "--t3-thread", TEST_T3_THREAD_ID]).json.error,
  ).toContain("unknown or expired handle");
  expect((await history()).every((call) => call.argv.at(-1) === "0")).toBe(
    true,
  );
});
test("maps every bundle status, active runs, children and unknown statuses", () => {
  for (const status of [
    "preparing",
    "queued",
    "starting",
    "running",
    "waiting",
    "idle",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "rolled_back",
    "future-status",
  ]) {
    const result = t3State({ status, updatedAt, messages: [] });
    if (["idle", "completed"].includes(status))
      expect(result.status).toBe("done");
    else if (["interrupted", "cancelled", "rolled_back"].includes(status))
      expect(result.status).toBe("stopped");
    else if (status === "failed") expect(result.status).toBe("failed");
    else expect(result.status).toBe("running");
    if (status === "future-status") expect(result.warning).toContain("Unknown");
  }
  expect(
    t3State({
      status: "completed",
      updatedAt,
      messages: [],
      activeRunId: "active",
    }).status,
  ).toBe("running");
});
test("routine sweeps read zero messages; settled status caches result for wait and preview", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await sweepSessions();
  expect((await history()).every((call) => call.argv.at(-1) === "0")).toBe(
    true,
  );
  await view({ status: "completed" });
  const status = cli(["status", session.handle]);
  expect(status.json.result).toBe("final reply");
  expect(status.json.running).toBe(false);
  expect(cli(["wait", session.handle]).json.result).toBe("final reply");
  expect(cli(["sessions", "--all"]).json[0].resultPreview).toBe("final reply");
  expect(
    (await history()).filter((call) => call.argv.at(-1) === "1"),
  ).toHaveLength(2);
});
test("T3 send queues while busy and wake sends without waiting for the current turn", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  expect(cli(["send", session.handle, "queued message"]).json.sent).toBe(true);
  session = await loadSession(session.handle);
  session.wakes = [
    {
      id: "wake",
      pid: 999999,
      startTime: "gone",
      command: "job",
      armedAt: updatedAt,
      state: "pending",
      watcherPid: process.pid,
      watcherStartTime: processStartTime(process.pid),
    },
  ];
  await saveSession(session, "claim");
  await watchWake(
    session.handle,
    "wake",
    async (message) =>
      sendT3Session(await loadSession(session.handle), message, "wake"),
    async () => {
      throw new Error("must not wait for turn");
    },
  );
  expect((await loadSession(session.handle)).wakes![0].state).toBe("sent");
  const sends = (await history()).filter((call) => call.argv[1] === "send");
  expect(sends).toHaveLength(2);
  expect(sends[0].input).toBe("queued message");
  expect(sends[1].input).toContain("job");
  await view({ status: "completed", latestRunId: "run-2" });
  expect(cli(["wait", session.handle, "--timeout", "1"]).exitCode).toBe(0);
});
test("stop refuses T3 termination but cancels pending wakes", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  session.wakes = [
    {
      id: "wake",
      pid: process.pid,
      startTime: processStartTime(process.pid)!,
      command: "job",
      armedAt: updatedAt,
      state: "pending",
      watcherPid: process.pid,
      watcherStartTime: processStartTime(process.pid),
    },
  ];
  await saveSession(session, "claim");
  const stopped = cli(["stop", session.handle]);
  expect(stopped.exitCode).toBe(1);
  expect(stopped.json.error).toBe("stop it in T3");
  expect((await loadSession(session.handle)).wakes![0].state).toBe("cancelled");
  expect((await loadSession(session.handle)).status).toBe("running");
});
test("T3 stuck uses updatedAt silence, unknown state warns, and missing CLI does not abort sweep", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await view({
    updatedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    status: "new-state",
  });
  await refreshT3Session(session);
  expect(session.warning).toContain("Unknown");
  expect(session.stuck?.reason).toContain("CPU unavailable");
  expect(session.activity?.cpuSeconds).toBeNull();
  await view();
  await refreshT3Session(session);
  expect(session.stuck).toBeNull();
  process.env.SMART_ROUTER_T3_CLI = join(directory, "missing");
  const local = await createSession({
    harness: "codex",
    model: "test",
    effort: "high",
    cwd: directory,
    prompt: "local",
    status: "done",
  });
  await sweepSessions();
  expect((await loadSession(session.handle)).warning).toContain(
    "T3 CLI not found",
  );
  expect((await loadSession(local.handle)).status).toBe("done");
});
test("invalid CLI state and send errors are reported", async () => {
  await expect(sendT3Session(session, "unattached")).rejects.toThrow("attach");
  for (const thread of [
    { status: 1, updatedAt },
    { status: "running", updatedAt: "bad" },
  ]) {
    await writeFile(fixture, JSON.stringify({ thread }));
    await expect(
      attachT3Session(session.handle, TEST_T3_THREAD_ID),
    ).rejects.toThrow("Invalid T3");
  }
  await view();
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  for (const messages of [{}, [{ role: "assistant" }]]) {
    await writeFile(
      fixture,
      JSON.stringify({ thread: { status: "completed", updatedAt }, messages }),
    );
    session.status = "done";
    expect((await t3Result(session)).warning).toContain("Invalid T3");
  }
  await view();
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.fail = true;
  await writeFile(fixture, JSON.stringify(data));
  await refreshT3Session(session);
  expect(session.warning).toContain("fake T3 failure");
  await view();
  data.fail = false;
  data.sendReply = {};
  await writeFile(fixture, JSON.stringify(data));
  await expect(sendT3Session(session, "uncertain")).rejects.toThrow(
    "delivery uncertain",
  );
});
test("T3 writes reject stale revisions and removed records", async () => {
  const stale = structuredClone(session);
  await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  expect(await saveT3Session({ ...stale, status: "failed" }, stale)).toBe(
    false,
  );
  await rm(sessionPath(session.handle));
  expect(await saveT3Session({ ...session }, session)).toBe(false);
});

test("direct result reads cache final text and reject stale thread views", async () => {
  expect(await t3Result(session)).toBe(session);
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  expect(sessionStatus(session).running).toBe(true);
  await view({ status: "completed" });
  await refreshT3Session(session);
  const completed = await t3Result(session);
  expect(completed.result).toBe("final reply");
  expect(sessionSummary(completed)).toMatchObject({
    runner: "t3",
    t3ThreadId: TEST_T3_THREAD_ID,
    resultPreview: "final reply",
  });
  expect((await t3Result(completed)).result).toBe("final reply");
  completed.t3ResultKey = undefined;
  await view({ status: "running" });
  expect(await t3Result(completed)).toBe(completed);
  await view({ status: "completed", latestRunId: "different" });
  expect(await t3Result(completed)).toBe(completed);
});
test("stale sends and attachment races cannot overwrite a newer revision", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  const stale = structuredClone(session);
  await refreshT3Session(session);
  await sendT3Session(stale, "manual message");
  expect(
    (await history()).filter((call) => call.argv[1] === "send"),
  ).toHaveLength(1);
});

test("result uses its own settled view and only the matching assistant run", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await view({ status: "completed" });
  await refreshT3Session(session);
  await t3Result(session);
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.thread.latestRunId = "run-2";
  data.thread.updatedAt = new Date(Date.now() + 1000).toISOString();
  await writeFile(fixture, JSON.stringify(data));
  expect((await t3Result(session)).result).toBe("");
  data.messages = [{ role: "assistant", runId: "run-2", text: "new reply" }];
  await writeFile(fixture, JSON.stringify(data));
  expect((await t3Result(session)).result).toBe("new reply");
});
test("wait loops when the result view is no longer settled", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  const data = JSON.parse(await readFile(fixture, "utf8"));
  const terminal = (id: string, answer: string) => ({
    thread: { status: "completed", updatedAt, latestRunId: id },
    messages: [{ role: "assistant", runId: id, text: answer }],
  });
  data.views = [
    terminal("old", "old reply"),
    {
      thread: {
        status: "running",
        updatedAt,
        latestRunId: "new",
        activeRunId: "new",
      },
      messages: [],
    },
    terminal("new", "new reply"),
    terminal("new", "new reply"),
  ];
  await writeFile(fixture, JSON.stringify(data));
  expect(cli(["wait", session.handle, "--timeout", "4"])).toMatchObject({
    exitCode: 0,
    json: { result: "new reply" },
  });
});
test("transient CLI errors preserve terminal statuses; gone threads fail", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  for (const status of ["completed", "failed", "cancelled"]) {
    await view({ status });
    await refreshT3Session(session);
    const previous = session.status;
    const data = JSON.parse(await readFile(fixture, "utf8"));
    data.fail = true;
    await writeFile(fixture, JSON.stringify(data));
    await refreshT3Session(session);
    expect(session.status).toBe(previous);
    expect(session.warning).toContain("fake T3 failure");
  }
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.fail = `Thread ${TEST_T3_THREAD_ID} is no longer available`;
  await writeFile(fixture, JSON.stringify(data));
  await refreshT3Session(session);
  expect(session.status).toBe("failed");
  expect(session.error).toContain("no longer available");
});
test("sweep refreshes only active T3 records with a maximum of four CLI calls", async () => {
  for (let index = 0; index < 9; index++)
    await createSession({
      ...session,
      handle: undefined,
      prompt: "parallel",
      status: index < 7 ? "running" : "done",
      t3ThreadId: `${TEST_T3_THREAD_ID}%3A${index}`,
    });
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.delayMs = 40;
  await writeFile(fixture, JSON.stringify(data));
  await sweepSessions();
  expect(
    (await history()).filter((call) => call.argv[1] === "show"),
  ).toHaveLength(7);
  const events = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  let active = 0,
    maximum = 0;
  for (const event of events) {
    active += event.end === undefined ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  expect(maximum).toBeLessThanOrEqual(T3_REFRESH_CONCURRENCY);
  expect(maximum).toBeGreaterThan(1);
});
test("unchanged refreshes do not write or increment the revision", async () => {
  const { stat } = await import("node:fs/promises");
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await refreshT3Session(session);
  const revision = session.t3Revision,
    modified = (await stat(sessionPath(session.handle))).mtimeMs;
  await Bun.sleep(20);
  await refreshT3Session(session);
  expect(session.t3Revision).toBe(revision);
  expect((await stat(sessionPath(session.handle))).mtimeMs).toBe(modified);
});
test("result read failure keeps the cached reply and warns in status and wait", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await view({ status: "completed" });
  await refreshT3Session(session);
  await t3Result(session);
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.failResult = "result unavailable";
  await writeFile(fixture, JSON.stringify(data));
  expect(cli(["status", session.handle]).json).toMatchObject({
    status: "done",
    result: "final reply",
    warning: expect.stringContaining("result unavailable"),
  });
  expect(cli(["wait", session.handle])).toMatchObject({
    exitCode: 0,
    json: {
      result: "final reply",
      warning: expect.stringContaining("result unavailable"),
    },
  });
});
test("human requests stop wait with exit 2 and expose warning and needsInput", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await view({ pendingRequestCount: 1 });
  await refreshT3Session(session);
  expect(session.needsInput).toBe(true);
  const result = cli(["wait", session.handle]);
  expect(result.exitCode).toBe(2);
  expect(result.json).toMatchObject({
    needsInput: true,
    warning: "waiting for an answer in T3",
    stuck: { reason: "waiting for an answer in T3" },
  });
  expect((await history()).every((call) => call.argv.at(-1) === "0")).toBe(
    true,
  );
});
test("stale wake claims reload before sending, and certain non-delivery retries", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  const binary = process.env.SMART_ROUTER_T3_CLI!;
  for (const failure of [
    "missing",
    "No running T3 Code server found.",
    "No running T3 Code server uses /tmp/t3. Start T3 Code, then retry.",
    "Could not reach the T3 Code server: connect ECONNREFUSED 127.0.0.1",
  ]) {
    session = await loadSession(session.handle);
    session.wakes = [
      {
        id: "retry",
        pid: 999999,
        startTime: "gone",
        command: "job",
        armedAt: updatedAt,
        state: "pending",
        watcherPid: process.pid,
        watcherStartTime: processStartTime(process.pid),
      },
    ];
    await saveSession(session, "claim");
    const stale = structuredClone(session);
    await refreshT3Session(session);
    if (failure === "missing")
      process.env.SMART_ROUTER_T3_CLI = join(directory, "missing");
    else {
      const data = JSON.parse(await readFile(fixture, "utf8"));
      data.failSend = failure;
      await writeFile(fixture, JSON.stringify(data));
    }
    let retries = 0;
    await watchWake(
      session.handle,
      "retry",
      async (message) => sendT3Session(stale, message, "retry"),
      async (delay) => {
        expect(delay).toBe(2000);
        expect((await loadSession(session.handle)).wakes![0].state).toBe(
          "pending",
        );
        retries++;
        process.env.SMART_ROUTER_T3_CLI = binary;
        const data = JSON.parse(await readFile(fixture, "utf8"));
        delete data.failSend;
        await writeFile(fixture, JSON.stringify(data));
      },
    );
    expect(retries).toBe(1);
    expect((await loadSession(session.handle)).wakes![0].state).toBe("sent");
  }
}, 15000);
test("gone-thread sends fail a wake immediately", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  session.wakes = [
    {
      id: "gone",
      pid: 999999,
      startTime: "gone",
      command: "job",
      armedAt: updatedAt,
      state: "pending",
      watcherPid: process.pid,
      watcherStartTime: processStartTime(process.pid),
    },
  ];
  await saveSession(session, "claim");
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.failSend = `Thread ${TEST_T3_THREAD_ID} is no longer available`;
  await writeFile(fixture, JSON.stringify(data));
  await expect(
    watchWake(
      session.handle,
      "gone",
      async (message) =>
        sendT3Session(await loadSession(session.handle), message, "gone"),
      async () => {
        throw new Error("must not retry");
      },
    ),
  ).rejects.toThrow("no longer available");
  expect((await loadSession(session.handle)).wakes![0].state).toBe("failed");
  expect((await loadSession(session.handle)).status).toBe("failed");
});
test("attach rejects flag-like or invalid thread ids without invoking T3", async () => {
  for (const id of [
    "-thread",
    "thread\ncontrol",
    "thread\u0000control",
    "thread\u007fcontrol",
    "has space",
    "",
  ])
    await expect(attachT3Session(session.handle, id)).rejects.toThrow(
      "invalid T3 thread id",
    );
  expect(await Bun.file(calls).exists()).toBe(false);
});

test("expiry cannot remove an attached successor and tolerates an already removed record", async () => {
  const old = structuredClone(session);
  await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  expect(await expireT3Launch(old)).toBe(false);
  expect((await loadSession(session.handle)).t3ThreadId).toBe(
    TEST_T3_THREAD_ID,
  );
  await rm(sessionPath(session.handle));
  expect(await expireT3Launch(old)).toBe(true);
});

test("attach reports expired handles and rejects malformed input counts", async () => {
  await expect(attachT3Session("missing", TEST_T3_THREAD_ID)).rejects.toThrow(
    "unknown or expired handle",
  );
  await view({ pendingRequestCount: -1 });
  await expect(
    attachT3Session(session.handle, TEST_T3_THREAD_ID),
  ).rejects.toThrow("pending request count");
  await view();
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await expect(
    attachT3Session(session.handle, TEST_T3_THREAD_ID),
  ).rejects.toThrow("not an unattached T3 launch");
});

test("attach accepts the exact encoded id emitted for real delegated children", async () => {
  const attached = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  expect(attached.t3ThreadId).toBe(TEST_T3_THREAD_ID);
  expect((await history())[0].argv[2]).toBe(TEST_T3_THREAD_ID);
});
test("all thread-not-found variants fail a wake without retry", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  for (const failure of [
    `Thread ${TEST_T3_THREAD_ID} was not found.`,
    `Thread '${TEST_T3_THREAD_ID}' was not found.`,
    "The thread was not found.",
    "thread_not_found",
  ]) {
    session = await loadSession(session.handle);
    session.status = "running";
    session.wakes = [
      {
        id: "missing",
        pid: 999999,
        startTime: "gone",
        command: "job",
        armedAt: updatedAt,
        state: "pending",
        watcherPid: process.pid,
        watcherStartTime: processStartTime(process.pid),
      },
    ];
    await saveSession(session, "claim");
    const data = JSON.parse(await readFile(fixture, "utf8"));
    data.failSend = failure;
    await writeFile(fixture, JSON.stringify(data));
    await expect(
      watchWake(
        session.handle,
        "missing",
        async (message) =>
          sendT3Session(await loadSession(session.handle), message, "missing"),
        async () => {
          throw new Error("must not retry");
        },
      ),
    ).rejects.toThrow(failure);
    expect((await loadSession(session.handle)).wakes![0].state).toBe("failed");
  }
});
test("send and wake keep their expected run while show still reports the old result", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  for (const wake of [false, true]) {
    await view({ status: "completed", latestRunId: "run-1" });
    session = await loadSession(session.handle);
    await refreshT3Session(session);
    await t3Result(session);
    if (wake) {
      session.wakes = [
        {
          id: "resume",
          pid: 999999,
          startTime: "gone",
          command: "job",
          armedAt: updatedAt,
          state: "pending",
          watcherPid: process.pid,
          watcherStartTime: processStartTime(process.pid),
        },
      ];
      await saveSession(session, "claim");
      await watchWake(session.handle, "resume", async (message) =>
        sendT3Session(await loadSession(session.handle), message, "resume"),
      );
    } else await sendT3Session(session, "new turn");
    await view({
      status: "completed",
      latestRunId: "run-1",
      pendingRequestCount: 1,
    });
    session = await loadSession(session.handle);
    await refreshT3Session(session);
    expect(session).toMatchObject({
      status: "running",
      t3LatestRunId: "run-2",
      t3ExpectedRunId: "run-2",
      needsInput: false,
    });
    expect(cli(["wait", session.handle, "--timeout", "0"]).exitCode).toBe(124);
    await view({ status: "completed", latestRunId: "run-2" });
    const data = JSON.parse(await readFile(fixture, "utf8"));
    data.messages = [{ role: "assistant", runId: "run-2", text: "new result" }];
    await writeFile(fixture, JSON.stringify(data));
    expect(cli(["wait", session.handle, "--timeout", "1"])).toMatchObject({
      exitCode: 0,
      json: { result: "new result" },
    });
    expect((await loadSession(session.handle)).t3ExpectedRunId).toBeUndefined();
  }
});
test("a stale run count keeps the sent run pending; a later run supersedes it", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await view({ status: "completed", latestRunId: "run-1", runCount: 1 });
  await sendT3Session(await loadSession(session.handle), "new turn");
  session = await loadSession(session.handle);
  expect(session).toMatchObject({
    t3ExpectedRunId: "run-2",
    t3BaselineRunCount: 1,
  });
  await view({ status: "completed", latestRunId: "run-1", runCount: 1 });
  await refreshT3Session(session);
  expect(session.status).toBe("running");
  await view({ status: "completed", latestRunId: "run-3", runCount: 3 });
  session = await loadSession(session.handle);
  await refreshT3Session(session);
  expect(session.status).toBe("done");
  expect(session.t3ExpectedRunId).toBeUndefined();
  expect(session.t3BaselineRunCount).toBeUndefined();
});
test("a failed view does not reuse needsInput from an older read", async () => {
  session = await attachT3Session(session.handle, TEST_T3_THREAD_ID);
  await view({ pendingRequestCount: 1 });
  await refreshT3Session(session);
  expect(session.needsInput).toBe(true);
  const data = JSON.parse(await readFile(fixture, "utf8"));
  data.fail = "No running T3 Code server found.";
  await writeFile(fixture, JSON.stringify(data));
  expect(cli(["wait", session.handle, "--timeout", "0"]).exitCode).toBe(124);
  expect(await loadSession(session.handle)).toMatchObject({
    needsInput: false,
    warning: expect.stringContaining("No running T3 Code server"),
  });
  await view({ pendingRequestCount: 1 });
  expect(cli(["wait", session.handle]).exitCode).toBe(2);
});
