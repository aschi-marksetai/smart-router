---
name: smart-router
description: Delegate a task to whichever coding-agent harness and model fits it best, then keep talking to that session by handle.
---

# smart-router

Use this instead of your native subagent tool when you delegate work. It picks the harness and model from the user's routing preferences and current quota, runs the task, and hands back a session you can continue.

## Delegate

```sh
smart-router spawn "<full task prompt>" --cwd <repo path>
```

Always pass `--cwd` so the delegate works in the right repo. Blocks until the delegate finishes its turn. Stdout is JSON: read `result` for the delegate's final message, `handle` to continue, and `route.pick` plus `route.reason` to tell the user what ran.

For Codex, the sandbox is chosen from the task; pass `--sandbox <policy>` to override it.

Codex `workspace-write` adds SwiftPM/Clang cache roots for Swift/Xcode markers up to the Git root, plus DerivedData for Xcode. `spawn.codexExtraWritableRoots` (default `[]`) adds other toolchain roots and expands `~`. SwiftPM's nested macOS sandbox may still fail independently of cache permissions. Codex 0.159.0 has no standalone loopback-only workspace-write setting; opt into `spawn.codexLocalhostNeedsNetwork: true` (default `false`) for localhost tests, allowing general outbound networking too. These additions apply only to `workspace-write`.

Every prompt states what done looks like and where to stop, for example "Done when `bun test` passes and the endpoint returns paginated results; stop there, do not refactor callers." Some models are configured to refuse a prompt without one, and the refusal tells you to add it and call again. Task-independent operating rules for the chosen model are appended automatically from the user's guardrails file, so do not repeat those.

Unless `--no-guardrails` is set, the delegate also receives a context section with its handle and depth, the maximum-depth rule, and guidance to avoid commands on itself or an ancestor. It explains that a shell yield is not completion and recommends detached helpers with `smart-router wait <child> --timeout 90`.

Codex results require a completed final turn; Claude error result events fail the session. `wait --timeout` exits 124 while the delegate is running, and `status` reports `outcome` while remaining informational for failed or stopped sessions.

Pass repeatable `--mcp-config <file>` with Claude-format MCP JSON and optional `--strict-mcp-config` on spawn or send; paths and strict mode persist for follow-ups (Claude and Codex; pi ignores them).

Optional flags:

- `--hint "<text>"` adds context for the routing decision, such as "needs a browser" or "bulk mechanical work".
- `--browser` enables Claude in Chrome for browser work and persists on `send`.
- `--confidential` keeps the task off OpenRouter.
- `--model harness:model --effort <level>` skips routing and picks directly, for example `--model harness:model --effort level`; some setups disable it, so use `--hint` for escalation instead.
- `--no-guardrails` skips the appended operating rules when the prompt already carries its own.
- `--result-limit <chars>` bounds returned result text while retaining the full result in the session.

Use `spawn --events` or `send --events` for normalized JSONL progress ending in one result or error event. Use `logs <handle> --follow --events` to follow normalized progress from a detached session, optionally starting with `--tail N` raw lines.

## Continue

```sh
smart-router send <handle> "<follow-up message>"
```

Resumes the same session with its full context. Stdout is JSON with `result`.

## Long tasks

Killing your own wait, status or shell never stops a detached delegate; use `smart-router stop <handle>` (or steer) and run `smart-router sessions` to find ones you no longer need. Foreground spawns stop when you interrupt them.

Use `smart-router spawn "<task>" --cwd <repo path> --detach` for work that should outlive this command. Then use `smart-router wait <handle> --timeout 90` in a loop, checking status between waits; a timeout means the delegate is still running. Do not wait on, stop, send to or steer your own handle or an ancestor. A shell command returning early is a yield, not completion. Stopped or failed waits exit 1 with the last message and action when available. Use `smart-router logs <handle> --tail 50`; use `smart-router stop <handle>` to end a child delegate.
Use `smart-router steer <handle> "<message>"` to redirect a running detached delegate. Claude delegates take the message mid-turn, or with `--interrupt` stop the current step first. Codex delegates are always interrupted: the run is stopped and resumed with the message, so any step in progress is lost, and the output is the resumed turn's result.
Exit code 3 with `error: "capacity"` means the configured concurrency or depth cap was reached. Add `--wait-for-slot <seconds>` to opt into waiting for a running slot; depth-limited delegates must do the work themselves.

Use `smart-router sessions` to list your sessions (`--all` includes other owners), `rm <handle>` to remove one, or `prune --older-than <days>` for finished sessions.

## Inspect

`smart-router route "<prompt>"` shows the decision without running anything. `smart-router doctor` lists the harnesses and candidate models the router can see, and `smart-router quota` shows remaining subscription quota. If either reports no candidates, ask the user to run `smart-router init`.
