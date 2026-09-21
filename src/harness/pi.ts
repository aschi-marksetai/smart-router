import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_EFFORT } from "../config.ts";
import { stateDir } from "../paths.ts";
import {
  parseJsonLines,
  record,
  usageFrom,
  type HarnessOptions,
  type ParsedOutput,
  type SpawnCommand,
} from "./types.ts";

const PI_BINARY = "pi";
const PRINT_FLAG = "-p";
const MODE_FLAG = "--mode";
const JSON_MODE = "json";
const MODEL_FLAG = "--model";
const THINKING_FLAG = "--thinking";
const SESSION_FLAG = "--session";
const PI_SESSION_PREFIX = "pi-";
const PI_SESSION_SUFFIX = ".json";

function parseOutput(output: string, sessionId: string): ParsedOutput {
  let outputSessionId = sessionId;
  let result = "";
  let usage = null;
  for (const event of parseJsonLines(output)) {
    const eventRecord = record(event);
    const message = record(eventRecord?.message);
    if (typeof eventRecord?.session_id === "string")
      outputSessionId = eventRecord.session_id;
    if (eventRecord?.usage) usage = usageFrom(eventRecord.usage);
    if (
      !message ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    )
      continue;
    const text = message.content
      .map(record)
      .filter((part): part is Record<string, unknown> => part !== undefined)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (text) result = text;
  }
  return { sessionId: outputSessionId, result, usage };
}

function command(
  prompt: string,
  sessionId: string,
  options: HarnessOptions,
): SpawnCommand {
  return {
    argv: [
      options.binary ?? PI_BINARY,
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
    ],
    sessionId,
  };
}

export function buildSpawn(
  prompt: string,
  options: HarnessOptions,
): SpawnCommand {
  const sessionId = join(
    stateDir(),
    `${PI_SESSION_PREFIX}${randomUUID()}${PI_SESSION_SUFFIX}`,
  );
  return command(prompt, sessionId, options);
}

export function parseSpawnOutput(stdout: string): ParsedOutput {
  return parseOutput(stdout, "");
}

export function buildResume(
  sessionId: string,
  message: string,
  options: HarnessOptions,
): SpawnCommand {
  return command(message, sessionId, options);
}

export function parseResumeOutput(stdout: string): ParsedOutput {
  return parseOutput(stdout, "");
}
