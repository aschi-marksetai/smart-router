export type ThreadStatus =
  "launched" | "running" | "done" | "failed" | "stopped" | "unknown";
export type Scope = "session" | "all";
export type Thread = {
  handle: string;
  runner?: "t3";
  warning?: string;
  owner?: string;
  status: ThreadStatus;
  harness: string;
  model: string;
  effort: string;
  depth: number;
  createdAt: string;
  promptPreview: string;
  label?: string;
  phase?: string;
  startedAt?: string;
  endedAt?: string;
  cwd?: string;
  routePick?: string;
  routeDetails?: string[];
  retryLinks?: { label: string; handle: string }[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costSource?: string;
  lastAction?: string;
  error?: string;
  result?: string;
  waiting?: string;
  silentSeconds?: number;
};
export type ConversationItem = {
  kind: "user" | "assistant" | "tool" | "output" | "result" | "error";
  text: string;
  isError: boolean;
};
export type PaneState = {
  scope: Scope;
  view:
    | { kind: "list" }
    | {
        kind: "thread";
        handle: string;
        record: Thread | null;
        items: ConversationItem[];
      };
  threads: Thread[];
  now: number;
  error: string;
  poolBalance?: string;
};

// A Bash call running `smart-router spawn`, keyed by its tool_use_id.
export type SpawnCall = {
  startedAt: number;
  label?: string;
  handle?: string;
};
export type SpawnCalls = Record<string, SpawnCall>;

declare module "claude-code" {
  interface PluginState {
    "smart-router-threads": {
      pane: Shaped<PaneState>;
      spawns: Shaped<SpawnCalls>;
    };
  }
}
