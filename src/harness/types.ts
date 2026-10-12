export type HarnessOptions = {
  cwd: string;
  model: string;
  effort?: string;
  worktree?: boolean;
  claudePermissionMode?: string;
  browser?: boolean;
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  codexSandbox?: string;
  codexConfigOverrides?: string[];
  codexExtraWritableRoots?: string[];
  allowedTools?: string;
  schema?: { path: string; content: string };
  binary?: string;
  streamInput?: boolean;
  events?: boolean;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
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
  const inputTokens = usage.input_tokens ?? usage.input;
  const outputTokens = usage.output_tokens ?? usage.output;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number")
    return null;
  const cachedInputTokens =
    usage.cached_input_tokens ??
    usage.cache_read_input_tokens ??
    usage.cacheRead;
  const cacheWriteTokens =
    usage.cache_write_input_tokens ??
    usage.cache_creation_input_tokens ??
    usage.cacheWrite;
  return {
    inputTokens,
    outputTokens,
    costUsd,
    cachedInputTokens:
      typeof cachedInputTokens === "number" ? cachedInputTokens : null,
    cacheWriteTokens:
      typeof cacheWriteTokens === "number" ? cacheWriteTokens : null,
  };
}
