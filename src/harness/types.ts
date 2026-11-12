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

export function turnUsage(
  usage: Usage | null,
  { harness, usage: previous }: { harness: string; usage?: Usage | null },
): Usage | null {
  if (harness !== "codex" || !usage || !previous) return usage;
  // Codex turn.completed reports thread totals, including earlier invocations.
  // Clamped because sessions saved before 0.8.18 summed those totals, so their baseline can exceed the thread's.
  const delta = (current: number | null, prior: number | null) =>
    current === null ? null : Math.max(0, current - (prior ?? 0));
  return {
    inputTokens: Math.max(0, usage.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, usage.outputTokens - previous.outputTokens),
    cachedInputTokens: delta(
      usage.cachedInputTokens,
      previous.cachedInputTokens,
    ),
    cacheWriteTokens: delta(usage.cacheWriteTokens, previous.cacheWriteTokens),
    costUsd: delta(usage.costUsd, previous.costUsd),
  };
}

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
  const reportedInputTokens = usage.input_tokens ?? usage.input;
  const outputTokens = usage.output_tokens ?? usage.output;
  if (
    typeof reportedInputTokens !== "number" ||
    typeof outputTokens !== "number"
  )
    return null;
  // OpenAI includes cache reads in input_tokens; normalize to uncached input.
  const inputTokens =
    typeof usage.cached_input_tokens === "number"
      ? Math.max(0, reportedInputTokens - usage.cached_input_tokens)
      : reportedInputTokens;
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
