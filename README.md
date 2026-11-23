# smart-router

smart-router routes coding-agent tasks to the best configured harness and model. It preserves a session handle so you can continue a delegate later. Preferences and guardrails stay under your control.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/aschi-marksetai/smart-router/main/scripts/install.sh | sh
```

Homebrew: `brew install aschi-marksetai/tap/smart-router`. Binaries are also on [GitHub Releases](https://github.com/aschi-marksetai/smart-router/releases).

## Updating

Homebrew users run `brew upgrade smart-router`. Other installs can run `smart-router update` (or `smart-router update --check` to only check). Route and spawn check once daily and print stderr notices for updates and newly available models; disable them with `updates.check: false` or `SMART_ROUTER_NO_UPDATE_CHECK`. Release automation pushes the regenerated formula to the tap over a deploy key stored as the `TAP_DEPLOY_KEY` repository secret.

## Quickstart

```sh
smart-router init
smart-router install-skill
smart-router spawn "implement the feature" --cwd "$PWD"
smart-router send <handle> "run the tests and fix failures"
```

| Command                    | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `init`                     | Configure harnesses, models, rules, and preferences                          |
| `install-skill`            | Install the Claude Code skill                                                |
| `doctor`                   | Show installed harnesses and candidates                                      |
| `route <prompt>`           | Preview a routing decision                                                   |
| `spawn <prompt>`           | Delegate a task                                                              |
| `send <handle> <message>`  | Continue a session                                                           |
| `steer <handle> <message>` | Redirect a running detached session (`--interrupt` to stop the current turn) |
| `quota`                    | Show subscription quota                                                      |

Config lives in `~/.config/smart-router` (override with `SMART_ROUTER_CONFIG_DIR`); sessions live in `~/.local/state/smart-router`. Jev can route through OpenRouter by setting `jev.provider` to `openrouter` and `jev.apiKeyEnv` to `OPENROUTER_API_KEY`. Set `jev.zdr` to require zero data retention for Jev routing calls.

OpenClaw host integration: [smart-router plugin](integrations/openclaw/README.md).

For OpenClaw, `spawn --confined` restricts the child to the `openclaw` MCP bridge. Claude runs with built-in tools disabled; supported Codex installations must pass a feature check and run with a read-only sandbox. Confinement, intersected allowlists, and denied tools persist across `send` turns. Only one HTTP loopback bridge is accepted; other MCP servers are removed, and unsupported configurations fail closed. Codex retains `apply_patch`, `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource`: the read-only sandbox with `approval_policy="never"` blocks writes, and resource access is limited to the bridge.

## Claude Code plugin

The `smart-router-threads` plugin adds `/sr` to browse this session's delegate conversations in a pane; `/sr all` shows all sessions and `/sr <handle>` opens a thread.

In Claude Code, install it with:

```text
/plugin install smart-router-threads --marketplace aschi-marksetai/smart-router
```

Answer `y` to add the marketplace, then choose an install scope. For local development, run from this repo:

```sh
claude --plugin-dir plugins/smart-router-threads
```

## Session dashboard

Run `smart-router dashboard` to browse delegate sessions and read conversations in a local, read-only web page. It runs in the foreground at `http://127.0.0.1:4517` until Ctrl-C. The first stdout line contains its URL and launcher owner as JSON. Use `--port 0` for an available port, `--port <n>` for another fixed port, or `--host <addr>` to change the bind address (which can expose private transcripts).

If a smart-router dashboard already uses the requested port, the command prints its URL and owner with `"reused": true` and exits successfully.

Each thread header shows routed, pinned, and resumed turn counts alongside uncached input, cached input, and the cache percentage.

In T3 Code, add a project script with command `smart-router dashboard` and Preview URL `http://localhost:4517`, then run it and open the preview browser tab. Choose **Launcher session**, **All** (newest 50), or an owner to filter sessions; the selected thread and scope can be bookmarked.

## Development

```sh
bun link
bun test
bun run typecheck
bun run eval
bun run build
```

Run `bun run coverage` for the coverage report; tests require 97% line and 95% function coverage.

After a release, run `bun run formula v0.1.0 > ../homebrew-tap/Formula/smart-router.rb`.

The eval suite uses the maintainer's model ids and may need adapting for your setup.

### Waiting for detached work

Codex delegates must run long work in the foreground: background processes are stopped when the command that started them ends.

Run `smart-router wake "$SMART_ROUTER_HANDLE" --after-pid <pid>` before ending a delegate turn that started detached work. The watcher makes no model calls while waiting, then sends a follow-up once the process exits and the current turn ends. Use `--message "<text>"` to customize it; `smart-router wake <handle> --cancel [<wake-id>]` cancels pending wakes. Status includes each wake's state. A crash during delivery is reported as failed with an uncertain outcome and is never blindly resent.

`smart-router wait <handle>... [--timeout <seconds>]` waits until all listed sessions are no longer running and have no pending or sending wakes. It prints the result and resume command (an array for multiple handles), exits 0 for successful results, 1 for failed or stopped sessions, 2 when a T3 thread needs an answer, or 124 on timeout. Claude Code parents should run this as a background task when they need notification that a delegate has really finished, including turns started by wakes.

`status`, `sessions` and `/sr` show pending wakes and a separate stuck flag. Running sessions are flagged only after at least 30 minutes of log silence with unchanged process-tree CPU for at least 30 minutes; CPU progress clears the flag. Runtime alone never flags a session.

Wakes armed during a turn started by an older smart-router binary can be lost when that binary saves the session.

### T3 children

In T3 Code, `smart-router route "<task>" --launch --cwd <repo>` registers a session and returns `launch.handle`. After `delegate_task`, run `smart-router attach <handle> --t3-thread <childThreadId>`. Use `status`, `sessions`, `wait`, `send` and `wake` by handle; T3 sends queue when busy. Unattached launches are removed after 15 minutes. `stop` cancels pending wakes and asks you to stop the thread in T3. T3 sessions do not consume smart-router spawn capacity. The CLI defaults to `~/.t3/bin/t3`, overridable with `SMART_ROUTER_T3_CLI`. Routine polling uses zero messages; settled status/wait reads cache the final reply. T3 stuck detection uses `updatedAt` silence alone, without CPU. `/sr` shows a T3 marker.

T3 threads waiting for an answer report `needsInput: true`; `wait` exits 2 so the parent can answer in T3.

A T3 child's own smart-router spawns do not inherit depth limits.

A foreground owner suspended for over two minutes after its child exits can lose its result when the sweep completes the session from the log.
