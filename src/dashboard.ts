import { dashboardHtml } from "./assets.ts";
import {
  sessionEvents,
  sessionStatus,
  sessionSummary,
} from "./session-view.ts";
import {
  listSessions,
  loadSession,
  sessionOwner,
  sweepSessions,
} from "./sessions.ts";

export const DEFAULT_DASHBOARD_PORT = 4517;
export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
export const DASHBOARD_SWEEP_INTERVAL_MS = 5_000;
const MAX_PORT = 65_535;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HANDLE_PATTERN = /^[0-9a-f]{6}$/;
const DASHBOARD_PROBE_TIMEOUT_MS = 10_000;

export async function existingDashboard({
  port = DEFAULT_DASHBOARD_PORT,
  host = DEFAULT_DASHBOARD_HOST,
}: {
  port?: number;
  host?: string;
}) {
  const hostname = host === "::1" ? "[::1]" : host;
  const url = `http://${hostname}:${port}`;
  try {
    const response = await fetch(`${url}/api/sessions`, {
      signal: AbortSignal.timeout(DASHBOARD_PROBE_TIMEOUT_MS),
    });
    const data: unknown = await response.json();
    if (
      response.ok &&
      typeof data === "object" &&
      data !== null &&
      "owner" in data &&
      typeof data.owner === "string" &&
      "sessions" in data &&
      Array.isArray(data.sessions)
    )
      return { url, owner: data.owner, reused: true };
  } catch {
    return undefined;
  }
}

export function startDashboard({
  port = DEFAULT_DASHBOARD_PORT,
  host = DEFAULT_DASHBOARD_HOST,
}: { port?: number; host?: string } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT)
    throw new Error(`--port must be an integer between 0 and ${MAX_PORT}`);
  const owner = sessionOwner();
  const guardHost = host === "::1" || LOOPBACK_HOSTS.has(host);
  let nextSweepAt = 0;
  let sweeping: Promise<unknown> | undefined;
  async function refresh() {
    if (!sweeping && Date.now() >= nextSweepAt) {
      nextSweepAt = Date.now() + DASHBOARD_SWEEP_INTERVAL_MS;
      sweeping = sweepSessions().finally(() => {
        sweeping = undefined;
      });
    }
    await sweeping;
  }
  return Bun.serve({
    hostname: host,
    port,
    async fetch(request, server) {
      const allowedHosts = [...LOOPBACK_HOSTS].map(
        (name) => `${name}:${server.port}`,
      );
      const headers = { "Cache-Control": "no-store" };
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status, headers });
      if (
        guardHost &&
        !allowedHosts.includes(request.headers.get("host")?.toLowerCase() ?? "")
      )
        return json({ error: "Forbidden host" }, 403);
      if (request.method !== "GET")
        return json({ error: "Method not allowed" }, 405);
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(dashboardHtml, {
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        });
      const match = /^\/api\/sessions\/([^/]+)(\/events)?$/.exec(path);
      if (path !== "/api/sessions" && !match)
        return json({ error: "Not found" }, 404);
      if (match && !HANDLE_PATTERN.test(match[1]))
        return json({ error: "Invalid handle" }, 400);
      try {
        await refresh();
        if (!match) {
          const sessions = (await listSessions()).map((session) => ({
            ...sessionSummary(session),
            cwd: session.cwd,
            lastAction: session.lastAction,
          }));
          return json({ owner, sessions });
        }
        const session = await loadSession(match[1]);
        if (match[2]) return json(await sessionEvents(session));
        return json(sessionStatus(session));
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return json({ error: "Not found" }, 404);
        return json({ error: "Unable to read sessions" }, 500);
      }
    },
  });
}
