export type ThreadStatus =
  "running" | "done" | "failed" | "stopped" | "unknown";
export type Scope = "session" | "all";
export type Thread = {
  handle: string;
  owner?: string;
  status: ThreadStatus;
  harness: string;
  model: string;
  effort: string;
  depth: number;
  createdAt: string;
  promptPreview: string;
  cwd?: string;
  routePick?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  lastAction?: string;
  error?: string;
  result?: string;
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
};

declare module "claude-code" {
  interface PluginState {
    "smart-router-threads": { pane: Shaped<PaneState> };
  }
}
