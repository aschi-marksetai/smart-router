import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFile } from "./files.ts";
import { parseJsonLines, record } from "./harness/types.ts";
import { stateDir } from "./paths.ts";

export const PIN_WARNINGS_LOG = "pin-warnings.jsonl";

// Append-only JSONL files in the state dir; one small line per audited decision.
export async function appendAuditLine(
  fileName: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await appendFile(join(stateDir(), fileName), `${JSON.stringify(entry)}\n`);
}

export async function readAuditLines(
  fileName: string,
): Promise<Record<string, unknown>[]> {
  try {
    const lines = await readFile(join(stateDir(), fileName), "utf8");
    return parseJsonLines(lines).flatMap((line) => {
      const entry = record(line);
      return entry ? [entry] : [];
    });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}
