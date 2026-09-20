import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_EFFORT } from "../config.ts";
import { record } from "../files.ts";
import { stateDir } from "../paths.ts";
import { parseJsonLines, run, type HarnessOptions } from "./types.ts";

const PI_BINARY = "pi";
const PRINT_FLAG = "-p";
const MODE_FLAG = "--mode";
const JSON_MODE = "json";
const MODEL_FLAG = "--model";
const THINKING_FLAG = "--thinking";
const SESSION_FLAG = "--session";
const PI_SESSION_PREFIX = "pi-";
const PI_SESSION_SUFFIX = ".json";

// Assumes Pi emits message events with assistant text in message.content text parts.
function finalAssistantText(output: string): string {
  let result = "";
  for (const event of parseJsonLines(output)) {
    const message = record(record(event)?.message);
    if (
      !message ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    )
      continue;
    const text = message.content
      .map(record)
      .filter((part): part is Record<string, unknown> => part !== null)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (text) result = text;
  }
  return result;
}

function command(
  prompt: string,
  sessionId: string,
  options: HarnessOptions,
): string[] {
  return [
    PI_BINARY,
    PRINT_FLAG,
    prompt,
    MODE_FLAG,
    JSON_MODE,
    MODEL_FLAG,
    options.model,
    THINKING_FLAG,
    options.effort ?? DEFAULT_EFFORT,
    SESSION_FLAG,
    sessionId,
  ];
}

export async function spawn(prompt: string, options: HarnessOptions) {
  const sessionId = join(
    stateDir(),
    `${PI_SESSION_PREFIX}${randomUUID()}${PI_SESSION_SUFFIX}`,
  );
  return {
    sessionId,
    result: finalAssistantText(
      await run(command(prompt, sessionId, options), options),
    ),
    resumeCommand: `${PI_BINARY} ${PRINT_FLAG} \"<msg>\" ${MODE_FLAG} ${JSON_MODE} ${MODEL_FLAG} ${options.model} ${THINKING_FLAG} ${options.effort ?? DEFAULT_EFFORT} ${SESSION_FLAG} ${sessionId}`,
  };
}

export async function resume(
  sessionId: string,
  message: string,
  options: HarnessOptions,
) {
  return {
    result: finalAssistantText(
      await run(command(message, sessionId, options), options),
    ),
  };
}
