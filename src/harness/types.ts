export type ProcessRunner = (
  argv: string[],
  options: { cwd: string },
) => Promise<string>;

export type HarnessOptions = {
  cwd: string;
  model: string;
  effort?: string;
  worktree?: boolean;
  claudePermissionMode?: string;
  codexSandbox?: string;
  runner?: ProcessRunner;
};

export function parseJsonLines(output: string): unknown[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export async function run(
  argv: string[],
  options: HarnessOptions,
): Promise<string> {
  if (options.runner) return options.runner(argv, { cwd: options.cwd });
  const process = Bun.spawn(argv, {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0)
    throw new Error(`Command failed: ${argv[0]}`);
  return output;
}
