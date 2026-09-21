export type HarnessOptions = {
  cwd: string;
  model: string;
  effort?: string;
  worktree?: boolean;
  claudePermissionMode?: string;
  codexSandbox?: string;
  codexConfigOverrides?: string[];
  allowedTools?: string;
  schema?: { path: string; content: string };
  binary?: string;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

export type SpawnCommand = { argv: string[]; sessionId?: string };
export type ParsedOutput = {
  sessionId: string;
  result: string;
  usage: Usage | null;
};

export function parseJsonLines(output: string): unknown[] {
  const values: unknown[] = [];
  for (const line of output.split("\n")) {
    try {
      values.push(JSON.parse(line));
    } catch {}
  }
  return values;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function usageFrom(
  value: unknown,
  costUsd: number | null = null,
): Usage | null {
  const usage = record(value);
  if (!usage) return null;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number")
    return null;
  return { inputTokens, outputTokens, costUsd };
}
