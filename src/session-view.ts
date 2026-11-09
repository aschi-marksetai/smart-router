import { readFile } from "node:fs/promises";
import {
  EVENT_TYPE,
  normalized,
  type EventState,
  type NormalizedEvent,
} from "./events.ts";
import { getAdapter } from "./harness/index.ts";
import {
  isProcessRunning,
  sessionLogPath,
  SESSION_STATUS,
  type Session,
} from "./sessions.ts";

export function sessionSummary({
  handle,
  owner,
  status,
  harness,
  model,
  effort,
  depth,
  createdAt,
  promptPreview,
}: Session) {
  return {
    handle,
    owner,
    status,
    harness,
    model,
    effort,
    depth,
    createdAt,
    promptPreview,
  };
}

export function sessionStatus(session: Session) {
  const handle = session.handle;
  return {
    ...session,
    running:
      session.status === SESSION_STATUS.running &&
      !!session.pid &&
      isProcessRunning(session.pid),
    outcome: session.status,
    ...(session.status === SESSION_STATUS.stopped ||
    session.status === SESSION_STATUS.failed
      ? {
          error: `session ${handle} was ${session.status}: ${session.error ?? session.status}`,
        }
      : {}),
  };
}

export function createSessionEventStream(
  session: Session,
  emit: (event: NormalizedEvent) => void,
) {
  const tools = new Map<string, string>();
  const state: EventState = { ...session, ts: new Date().toISOString(), tools };
  return {
    line(line: string) {
      state.ts = new Date().toISOString();
      for (const event of getAdapter(session.harness).translateEvents(
        line,
        state,
      )) {
        if (event.type === EVENT_TYPE.result || event.type === EVENT_TYPE.error)
          continue;
        if (event.type === EVENT_TYPE.message) state.text = event.text;
        if (event.type === EVENT_TYPE.toolStarted)
          tools.set(event.toolId, event.name);
        emit(event);
      }
    },
    finish(completed: Session, usage = completed.usage ?? null) {
      state.ts = new Date().toISOString();
      const payload =
        completed.status === SESSION_STATUS.done
          ? { type: EVENT_TYPE.result, text: completed.result ?? "", usage }
          : {
              type: EVENT_TYPE.error,
              message: completed.error ?? completed.status,
              lastAction: completed.lastAction,
            };
      emit(normalized(state, payload));
    },
  };
}

export async function sessionEvents(
  session: Session,
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  const stream = createSessionEventStream(session, (event) =>
    events.push(event),
  );
  const output = await readFile(
    session.logPath ?? sessionLogPath(session.handle),
    "utf8",
  );
  for (const line of output.split("\n")) stream.line(line);
  if (session.status !== SESSION_STATUS.running) stream.finish(session);
  return events;
}
