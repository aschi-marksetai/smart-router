---
name: smart-router
description: Delegate a task to whichever coding-agent harness and model fits it best, then keep talking to that session by handle.
---

# smart-router

Use this when you delegate work; inside T3 Code, follow the section below. It picks the harness and model from the user's routing preferences and current quota, runs the task, and hands back a session you can continue.

## Inside T3 Code

When T3's `delegate_task` is available, use it instead of `spawn`:

1. Run `smart-router route "<task>" --launch --cwd <repo>` (routing flags still apply).
2. Call `orchestrator_capabilities` once per thread to discover provider instance IDs for Claude/Codex and each model's option names.
3. Call `delegate_task` with `target.providerInstanceId` for `launch.harness`, `target.model` = `launch.model`, the effort entry in `target.options` = `launch.effort`, `task` = `launch.prompt`, and a short title. Request full-access runtime when `launch.sandbox` requires network (`+network`) or full access (`danger-full-access`); children cannot exceed the parent's permissions.

4. Read `launch.handle`, then run `smart-router attach <handle> --t3-thread <childThreadId>` after delegation. The launch is registered after prompt construction succeeds and removed after 15 minutes if not attached.

To retry a T3 child, run `smart-router retry <handle> --launch` (add `--up` to escalate), call `delegate_task` with the returned `launch` exactly as in step 3, then `attach` the new handle. `attach` records a warning on the route when the thread runs a different model than the pick, so pass `launch.model` through unchanged.

Use `status`, `sessions`, `wait`, `send` and `wake` by handle. T3 sends queue without interrupting a busy child. `stop` cancels pending wakes but cannot stop the thread: stop it in T3. The `/sr` All view marks these rows T3. Routine polling reads no messages; settled `status` and `wait` cache the final reply. T3 stuck flags use `updatedAt` silence alone because CPU is unavailable. The CLI defaults to `~/.t3/bin/t3`; override with `SMART_ROUTER_T3_CLI`.

## Delegate

```sh
smart-router spawn "<full task prompt>" --cwd <repo path>
```

Always pass `--cwd` so the delegate works in the right repo. Blocks until the delegate finishes its turn. Stdout is JSON: read `result` for the delegate's final message, `handle` to continue, and `route.pick` plus `route.reason` to tell the user what ran.

For Codex, the sandbox is chosen from the task; pass `--sandbox <policy>` to override it.

Codex `workspace-write` adds SwiftPM/Clang cache roots for Swift/Xcode markers up to the Git root, plus DerivedData for Xcode. `spawn.codexExtraWritableRoots` (default `[]`) adds other toolchain roots and expands `~`. The appended toolchain note directs SwiftPM commands to use `--disable-sandbox` and `xcodebuild` to use both `-IDEPackageSupportDisableManifestSandbox=YES` and `OTHER_SWIFT_FLAGS='$(inherited) -disable-sandbox'` for Swift packages and macro plugins. The manifest flag alone does not disable the compiler's macro plugin sandbox. iOS Simulator, simctl, XCUITest, UI-test execution and WebKit/WKWebView tests need full access: Codex 0.159.0 blocks CoreSimulator service access even with its directory writable, and WebKit content rule-list compilation fails even with `swift test --disable-sandbox`. `autoSandbox` selects full access when `allowFullAccess` is enabled and Jev's score exceeds 0.5. Codex 0.159.0 has no standalone loopback-only workspace-write setting; opt into `spawn.codexLocalhostNeedsNetwork: true` (default `false`) for localhost tests, allowing general outbound networking too. These additions apply only to `workspace-write`.

For repos with effective `commit.gpgsign=true`, Codex `workspace-write` prompts on spawn and resume tell the delegate to stage changes and report `commit not signed: needs overseer`; never use `--no-gpg-sign` or change Git config to disable signing. Codex 0.159.0's Seatbelt blocks the gpg-agent socket even with `~/.gnupg` writable (`IPC connect call failed`, verified with the agent running). Signed commits need `--sandbox danger-full-access` or an overseer commit.

Every prompt states what done looks like and where to stop, for example "Done when `bun test` passes and the endpoint returns paginated results; stop there, do not refactor callers." Some models are configured to refuse a prompt without one, and the refusal tells you to add it and call again. Task-independent operating rules for the chosen model are appended automatically from the user's guardrails file, so do not repeat those.

Unless `--no-guardrails` is set, the delegate also receives a context section with its handle and depth, the maximum-depth rule, and guidance to avoid commands on itself or an ancestor. It explains that a shell yield is not completion and recommends detached helpers with `smart-router wait <child> --timeout 90`.

Codex results require a completed final turn; Claude error result events fail the session. `wait --timeout` exits 124 while the delegate is running, and `status` reports `outcome` while remaining informational for failed or stopped sessions.

Pass repeatable `--mcp-config <file>` with Claude-format MCP JSON and optional `--strict-mcp-config` on spawn or send; paths and strict mode persist for follow-ups (Claude and Codex; pi ignores them).

Optional flags:

- `--hint "<text>"` adds context for the routing decision, such as "needs a browser" or "bulk mechanical work".
- `--browser` enables Claude in Chrome for browser work and persists on `send`.
- `--confidential` drops the models the user excluded for confidential work, for routed picks and for pins.
- `--model harness:model --effort <level>` skips routing and picks directly; some setups disable it. Do not pin to get around quota: limits and the pace tilt are enforced in code, and a pin that works against the balance runs with a warning that is recorded and counted. To stay on one harness, pass `--model <harness>:auto` and let the router choose within it.
- `--no-guardrails` skips the appended operating rules when the prompt already carries its own.
- `--result-limit <chars>` bounds returned result text while retaining the full result in the session.
- `--label "<group>:<name>"` and `--phase "<name>"` (one line, at most 80 characters) name the delegation in Claude Code's `/sr` pane, which groups rows by phase and shows each one's model, effort, status and elapsed time. Pass `--label` on every spawn run in the background: the live card under that spawn call finds its session by label, and an unlabeled background spawn gets no card.

Use `spawn --events` or `send --events` for normalized JSONL progress ending in one result or error event. Use `logs <handle> --follow --events` to follow normalized progress from a detached session, optionally starting with `--tail N` raw lines.

## Balance and escalation

The router enforces quota itself. A pool or model window at its cutoff is excluded, and each candidate is weighted by how far its pool is ahead of or behind its weekly pace, so the pick can differ from the model you expected. `route.reason` says why; relay it with `route.pick`, and relay any `route.warnings`.

- **Escalate with `smart-router retry <handle> --up --note "<what was wrong>"`**, not by spawning again with `--model` one rung up. It reruns the saved prompt on a stronger model or a higher effort, tells the router what the last attempt did, and links the two sessions. Without `--up` it reruns on whatever the router now picks. Spawn's flags apply (`--detach`, `--label`, `--cwd`). A retry keeps the original's confinement, tool limits, permission mode and sandbox, and your flags can only tighten them; with `--up`, an `--effort` on the same model must be higher than before.
- **Rate every delegate once you have judged its result:** `smart-router rate <handle> good` or `bad --note "<why>"`. Ratings are the only quality signal the router's statistics get.
- **Check balance with `smart-router stats`** (`--window current` for this quota week): each pool's share of sessions and cost against its pace, how often picks were pinned or fell back, per-model failure and retry rates, and its share of measured list spend. Check cost coverage: missing costs are unknown, and incomplete spend shares are lower bounds. T3 status refreshes backfill local transcript usage.

When a pool is over pace and another has reserve, native subagents (Claude Code's Agent tool, Codex's `spawn_agent`) are denied by a hook with a message telling you to delegate through smart-router instead. Do that; do not look for another way to start the subagent.

## Continue

```sh
smart-router send <handle> "<follow-up message>"
```

Resumes the same session with its full context. Stdout is JSON with `result`.
Pass `--wait-for-slot <seconds>` to wait for capacity while preserving the handle and session ID. Seconds must be finite and non-negative; a capacity timeout exits 3 without launching the resume.

## Long tasks

Killing your own wait, status or shell never stops a detached delegate; use `smart-router stop <handle>` (or steer) and run `smart-router sessions` to find ones you no longer need. Foreground spawns stop when you interrupt them.

Use `smart-router spawn "<task>" --cwd <repo path> --detach` for work that should outlive this command. Claude Code parents should run `smart-router wait <handle>` as a background task. For bounded waits, pass `--timeout 90`; a timeout means the delegate or a wake is still pending. Do not wait on, stop, send to or steer your own handle or an ancestor. A shell command returning early is a yield, not completion. Stopped or failed waits exit 1 with the last message and action when available. Use `smart-router logs <handle> --tail 50`; use `smart-router stop <handle>` to end a child delegate.
Use `smart-router steer <handle> "<message>"` to redirect a running delegate, detached or foreground. Claude delegates take the message mid-turn, or with `--interrupt` stop the current step first. Codex delegates are always interrupted: the run is stopped and resumed with the message, so any step in progress is lost, and the output is the resumed turn's result.
Exit code 3 with `error: "capacity"` means the configured concurrency or depth cap was reached. Add `--wait-for-slot <seconds>` on spawn or send to opt into waiting for a running slot; depth-limited delegates must do the work themselves. `running` lists only the caller's blockers; `otherOwnersRunning` counts other owners' running sessions. If only other sessions hold the global slots, retry later or use `--wait-for-slot`.

Use `smart-router sessions` to list your sessions (`--all` includes other owners), `rm <handle>` to remove one, or `prune --older-than <days>` for finished sessions.

## Inspect

`smart-router route "<prompt>"` shows the decision without running anything, as the full route record: Jev's probabilities, the pace weights, every excluded candidate with its reason, and the shadow picks of the other policies. `smart-router doctor` lists the harnesses and candidate models the router can see, and `smart-router quota` shows each pool's usage, its pace gap (positive is reserve) and any model-specific windows. If either reports no candidates, ask the user to run `smart-router init`.

### Waiting for detached work

Codex delegates must run long work in the foreground: background processes are stopped when the command that started them ends.

Run `smart-router wake "$SMART_ROUTER_HANDLE" --after-pid <pid>` before ending a delegate turn that started detached work. The watcher makes no model calls while waiting, then sends a follow-up once the process exits and the current turn ends. Use `--message "<text>"` to customize it; `smart-router wake <handle> --cancel [<wake-id>]` cancels pending wakes. Status includes each wake's state. A crash during delivery is reported as failed with an uncertain outcome and is never blindly resent.

`smart-router wait <handle>... [--timeout <seconds>]` waits until all listed sessions are no longer running and have no pending or sending wakes. It prints the result and resume command (an array for multiple handles), exits 0 for successful results, 1 for failed or stopped sessions, 2 when a T3 thread needs an answer, or 124 on timeout. Claude Code parents should run this as a background task when they need notification that a delegate has really finished, including turns started by wakes.

`status`, `sessions` and `/sr` show pending wakes and a separate stuck flag. Running sessions are flagged only after at least 30 minutes of log silence with unchanged process-tree CPU for at least 30 minutes; CPU progress clears the flag. Runtime alone never flags a session.

T3 threads waiting for an answer report `needsInput: true`; `wait` exits 2 so the parent can answer in T3.
