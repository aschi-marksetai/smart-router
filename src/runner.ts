import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const IGNORE = "ignore";
const STDERR_LINE_LIMIT = 20;
const ERROR_LOG_EXTENSION = ".err";

function lastLines(output: string): string {
  return output.trimEnd().split("\n").slice(-STDERR_LINE_LIMIT).join("\n");
}

export async function runForeground(
  argv: string[],
  cwd: string,
): Promise<string> {
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    stdio: [IGNORE, "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    const stdoutTail = lastLines(stdout);
    const stderrTail = lastLines(stderr);
    throw new Error(
      `Command ${argv[0]} exited with code ${exitCode}: stdout:\n${stdoutTail}\nstderr:\n${stderrTail}`,
    );
  }
  return stdout;
}

export async function runDetached(
  argv: string[],
  cwd: string,
  logPath: string,
): Promise<{ pid: number; errPath: string }> {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFile = openSync(logPath, "a");
  const errPath = join(
    dirname(logPath),
    `${basename(logPath, extname(logPath))}${ERROR_LOG_EXTENSION}`,
  );
  const errFile = openSync(errPath, "a");
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    detached: true,
    stdio: [IGNORE, logFile, errFile],
  });
  closeSync(logFile);
  closeSync(errFile);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error(`Could not start: ${argv[0]}`);
  child.unref();
  return { pid: child.pid, errPath };
}
