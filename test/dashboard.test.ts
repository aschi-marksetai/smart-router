import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardHtml } from "../src/assets.ts";
import {
  DASHBOARD_SWEEP_INTERVAL_MS,
  DEFAULT_DASHBOARD_PORT,
  startDashboard,
} from "../src/dashboard.ts";
import {
  createSessionEventStream,
  sessionEvents,
  sessionStatus,
  sessionSummary,
} from "../src/session-view.ts";
import {
  createSession,
  loadSession,
  saveSession,
  sessionLogPath,
  sessionPath,
  type Session,
} from "../src/sessions.ts";
import type { NormalizedEvent } from "../src/events.ts";

let directory: string;
let server: ReturnType<typeof startDashboard>;
let session: Session;
let previousState: string | undefined;
let previousOwner: string | undefined;

beforeEach(async () => {
  previousState = process.env.SMART_ROUTER_STATE_DIR;
  previousOwner = process.env.SMART_ROUTER_OWNER;
  directory = await mkdtemp(join(tmpdir(), "smart-router-dashboard-"));
  process.env.SMART_ROUTER_STATE_DIR = directory;
  process.env.SMART_ROUTER_OWNER = "dashboard-launcher";
  session = await createSession({
    handle: "abcdef",
    harness: "claude",
    model: "opus",
    effort: "high",
    cwd: "/project",
    prompt: "<script>private prompt</script>",
    status: "done",
    result: "done",
    lastAction: "Bash",
    depth: 1,
    route: { pick: "claude:opus@high", reason: "test" },
  });
  session.createdAt = "2026-01-01T00:00:00Z";
  await saveSession(session);
  await writeFile(
    sessionLogPath(session.handle),
    await Bun.file(`${import.meta.dir}/fixtures/events/claude.jsonl`).text(),
  );
  server = startDashboard({ port: 0 });
});

afterEach(async () => {
  await server.stop(true);
  if (previousState === undefined) delete process.env.SMART_ROUTER_STATE_DIR;
  else process.env.SMART_ROUTER_STATE_DIR = previousState;
  if (previousOwner === undefined) delete process.env.SMART_ROUTER_OWNER;
  else process.env.SMART_ROUTER_OWNER = previousOwner;
  await rm(directory, { recursive: true, force: true });
});

function request(path: string, options?: RequestInit) {
  return fetch(new URL(path, server.url), options);
}

function withoutTimestamps(events: NormalizedEvent[]) {
  return events.map(({ ts, ...event }) => event);
}

test("serves embedded HTML and lists all owners newest first with dashboard fields", async () => {
  process.env.SMART_ROUTER_OWNER = "other-owner";
  const newer = await createSession({
    ...session,
    handle: "123abc",
    prompt: "newer",
  });
  const page = await request("/");
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.has("access-control-allow-origin")).toBe(false);
  expect(await page.text()).toBe(dashboardHtml);
  expect(dashboardHtml).toContain("<!doctype html>");
  expect(dashboardHtml).not.toContain("innerHTML");
  const response = await request("/api/sessions");
  expect(await response.json()).toEqual({
    owner: "dashboard-launcher",
    sessions: [newer, session].map((item) => ({
      ...sessionSummary(item),
      cwd: item.cwd,
      lastAction: item.lastAction,
    })),
  });
});

test("status and normalized events use the shared CLI projections", async () => {
  const status = await request("/api/sessions/abcdef");
  expect(await status.json()).toEqual(
    JSON.parse(JSON.stringify(sessionStatus(session))),
  );
  const response = await request("/api/sessions/abcdef/events");
  const events: NormalizedEvent[] = await response.json();
  expect(withoutTimestamps(events)).toEqual(
    withoutTimestamps(await sessionEvents(session)),
  );
  expect(events.map((event) => event.type)).toEqual([
    "session.started",
    "tool.started",
    "tool.finished",
    "message",
    "usage",
    "result",
  ]);
  expect(events[2]).toMatchObject({ name: "Bash", output: "file.txt" });
  expect(events.at(-1)).toMatchObject({
    type: "result",
    text: "done",
    usage: null,
  });
  expect(sessionSummary(session)).toEqual({
    handle: "abcdef",
    owner: "dashboard-launcher",
    status: "done",
    harness: "claude",
    model: "opus",
    effort: "high",
    depth: 1,
    createdAt: session.createdAt,
    promptPreview: session.promptPreview,
  });
});

test.each(["ABCDEF", "abcde", "abcdefg", "xyz123", "%2e%2e%2fprivate"])(
  "rejects invalid handle %s",
  async (handle) => {
    for (const suffix of ["", "/events"])
      expect((await request(`/api/sessions/${handle}${suffix}`)).status).toBe(
        400,
      );
  },
);

test("unknown sessions/routes, methods, and unreadable state", async () => {
  for (const path of [
    "/api/sessions/000000",
    "/api/sessions/000000/events",
    "/missing",
    "/api/sessions/abcdef/other",
  ])
    expect((await request(path)).status).toBe(404);
  expect((await request("/api/sessions", { method: "POST" })).status).toBe(405);
  await writeFile(sessionPath(session.handle), "invalid JSON");
  expect((await request("/api/sessions/abcdef")).status).toBe(500);
});

test("rejects rebinding and wrong/missing ports; accepts all loopback hosts", async () => {
  for (const host of [
    "evil.example",
    `evil.example:${server.port}`,
    "localhost",
    "localhost:1",
    `localhost:${server.port}.evil.example`,
  ])
    expect(
      (await request("/api/sessions", { headers: { Host: host } })).status,
    ).toBe(403);
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    expect(
      (await request("/", { headers: { Host: `${host}:${server.port}` } }))
        .status,
    ).toBe(200);
});

test("explicit non-loopback bind allows other hosts", async () => {
  await server.stop(true);
  server = startDashboard({ port: 0, host: "0.0.0.0" });
  const response = await fetch(`http://127.0.0.1:${server.port}/`, {
    headers: { Host: `preview.example:${server.port}` },
  });
  expect(response.status).toBe(200);
});

test("fixed default port and invalid ports", () => {
  expect(DEFAULT_DASHBOARD_PORT).toBe(4517);
  for (const port of [-1, 65536, 1.5, NaN])
    expect(() => startDashboard({ port })).toThrow("--port");
});

test("sweep is throttled across list, status and events, including concurrent requests", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    await Promise.all([
      request("/api/sessions"),
      request("/api/sessions/abcdef"),
    ]);
    session.status = "running";
    session.pid = 999999999;
    await saveSession(session);
    await Promise.all([
      request("/api/sessions"),
      request("/api/sessions/abcdef/events"),
    ]);
    expect((await loadSession(session.handle)).status).toBe("running");
    clock.mockReturnValue(Date.now() + DASHBOARD_SWEEP_INTERVAL_MS);
    expect((await (await request("/api/sessions/abcdef")).json()).status).toBe(
      "done",
    );
  } finally {
    clock.mockRestore();
  }
});

test("shared status and event stream handle running, failed and stopped sessions", async () => {
  session.status = "running";
  session.pid = process.pid;
  expect(sessionStatus(session)).toMatchObject({
    running: true,
    outcome: "running",
  });
  session.pid = 999999999;
  expect(sessionStatus(session).running).toBe(false);
  const running = await sessionEvents(session);
  expect(running.some((event) => event.type === "result")).toBe(false);
  for (const status of ["failed", "stopped"] as const) {
    session.status = status;
    session.error = "something failed";
    expect(sessionStatus(session)).toMatchObject({
      running: false,
      outcome: status,
      error: `session abcdef was ${status}: something failed`,
    });
    expect((await sessionEvents(session)).at(-1)).toMatchObject({
      type: "error",
      message: "something failed",
      lastAction: "Bash",
    });
  }
  delete session.error;
  expect(sessionStatus(session).error).toBe(
    "session abcdef was stopped: stopped",
  );
  const events: NormalizedEvent[] = [];
  const stream = createSessionEventStream(session, (event) =>
    events.push(event),
  );
  stream.finish(session);
  expect(events[0]).toMatchObject({ type: "error", message: "stopped" });
});
