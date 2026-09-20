import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessName } from "./config.ts";
import { sessionsDir } from "./paths.ts";

const HANDLE_BYTES = 3;
const PROMPT_PREVIEW_LENGTH = 160;
const SESSION_FILE_SUFFIX = ".json";

export type Session = {
  handle: string;
  harness: HarnessName;
  model: string;
  effort: string;
  cwd: string;
  sessionId: string;
  createdAt: string;
  promptPreview: string;
};

export type CreateSessionOptions = Omit<
  Session,
  "handle" | "createdAt" | "promptPreview"
> & { prompt: string };

function sessionPath(handle: string): string {
  return join(sessionsDir(), `${handle}${SESSION_FILE_SUFFIX}`);
}

export async function createSession(
  options: CreateSessionOptions,
): Promise<Session> {
  await mkdir(sessionsDir(), { recursive: true });
  const handle = randomBytes(HANDLE_BYTES).toString("hex");
  const session: Session = {
    handle,
    harness: options.harness,
    model: options.model,
    effort: options.effort,
    cwd: options.cwd,
    sessionId: options.sessionId,
    createdAt: new Date().toISOString(),
    promptPreview: options.prompt.slice(0, PROMPT_PREVIEW_LENGTH),
  };
  await writeFile(sessionPath(handle), `${JSON.stringify(session, null, 2)}\n`);
  return session;
}

export async function loadSession(handle: string): Promise<Session> {
  return JSON.parse(await readFile(sessionPath(handle), "utf8"));
}
