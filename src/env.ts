import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMissingFile, isPermissionDenied } from "./files.ts";

const DOT_ENV_FILE_NAME = ".env";
const COMMENT_PREFIX = "#";
const ASSIGNMENT_SEPARATOR = "=";
const EXPORT_PREFIX = "export ";
const DOT_ENV_FILE_MODE = 0o600;

export async function writeDotEnvValue(
  filePath: string,
  key: string,
  value: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  let contents = "";
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const lines = contents.split(/(\r?\n)/);
  let replaced = false;
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    if (line.trimStart().startsWith(`${key}=`)) {
      lines[index] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (contents && !contents.endsWith("\n")) lines.push("\n");
    lines.push(`${key}=${value}`);
  }
  await writeFile(filePath, lines.join(""), { mode: DOT_ENV_FILE_MODE });
  await chmod(filePath, DOT_ENV_FILE_MODE);
}

function unquote(value: string): string {
  const quote = value.at(0);
  const isQuoted = (quote === '"' || quote === "'") && value.at(-1) === quote;
  return isQuoted ? value.slice(1, -1) : value;
}

export async function loadDotEnv(cwd: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(join(cwd, DOT_ENV_FILE_NAME), "utf8");
  } catch (error) {
    if (isMissingFile(error) || isPermissionDenied(error)) return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    const separatorIndex = trimmedLine.indexOf(ASSIGNMENT_SEPARATOR);
    if (
      !trimmedLine ||
      trimmedLine.startsWith(COMMENT_PREFIX) ||
      separatorIndex < 1
    )
      continue;
    const assignment = trimmedLine.startsWith(EXPORT_PREFIX)
      ? trimmedLine.slice(EXPORT_PREFIX.length)
      : trimmedLine;
    const assignmentSeparatorIndex = assignment.indexOf(ASSIGNMENT_SEPARATOR);
    if (assignmentSeparatorIndex < 1) continue;
    const key = assignment.slice(0, assignmentSeparatorIndex).trim();
    const value = unquote(
      assignment.slice(assignmentSeparatorIndex + 1).trim(),
    );
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
