import { T3_NO_LOG } from "./t3.ts";
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

const RESULT_PREVIEW_LENGTH = 160;

function latestTurnTiming({ turns }: Session) {
  const turn = turns?.at(-1);
  return { startedAt: turn?.startedAt, endedAt: turn?.endedAt };
}

export function sessionSummary(session: Session) {
  const {
    handle,
    owner,
    status,
    harness,
    model,
    effort,
    depth,
    createdAt,
    promptPreview,
    label,
    phase,
    lastResult,
  } = session;
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
    label,
    phase,
    ...(session.runner === "t3"
      ? {
          runner: session.runner,
          t3ThreadId: session.t3ThreadId,
          warning: session.warning,
        }
      : {}),
    wakes: session.wakes,
    activity: session.activity,
    stuck:
      session.status === SESSION_STATUS.running
        ? (session.stuck ?? null)
        : null,
    resultPreview: lastResult?.slice(0, RESULT_PREVIEW_LENGTH),
    ...latestTurnTiming(session),
  };
}

export function sessionStatus(session: Session) {
  const handle = session.handle;
  return {
    ...session,
    ...latestTurnTiming(session),
    running:
      session.status === SESSION_STATUS.running &&
      (session.runner === "t3" ||
        (!!session.pid && isProcessRunning(session.pid))),
    outcome: session.status,
    stuck:
      session.status === SESSION_STATUS.running
        ? (session.stuck ?? null)
        : null,
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
    line(line: string, emitEvents = true) {
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
        if (emitEvents) emit(event);
      }
    },
    finish(completed: Session, usage?: Session["usage"]) {
      state.ts = new Date().toISOString();
      const lastTurn = completed.turns?.at(-1);
      const resultUsage = lastTurn ? lastTurn.usage : (completed.usage ?? null);
      const payload =
        completed.status === SESSION_STATUS.done
          ? {
              type: EVENT_TYPE.result,
              text: completed.result ?? "",
              usage: usage === undefined ? resultUsage : usage,
            }
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
  if (session.runner === "t3") throw new Error(T3_NO_LOG);
  const events: NormalizedEvent[] = [];
  const stream = createSessionEventStream(
    { ...session, usage: null },
    (event) => events.push(event),
  );
  const output = await readFile(
    session.logPath ?? sessionLogPath(session.handle),
    "utf8",
  );
  for (const line of output.split("\n")) stream.line(line);
  if (session.status !== SESSION_STATUS.running) stream.finish(session);
  return events;
}
