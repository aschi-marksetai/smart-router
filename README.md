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

| Command                     | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `init`                      | Configure harnesses, models, rules, and preferences                           |
| `install-skill` (`install`) | Install the skill for Claude Code and Codex, and the Codex guard hook         |
| `doctor`                    | Show installed harnesses and candidates                                       |
| `route <prompt>`            | Preview a routing decision                                                    |
| `spawn <prompt>`            | Delegate a task                                                               |
| `send <handle> <message>`   | Continue a session                                                            |
| `steer <handle> <message>`  | Redirect a running detached session (`--interrupt` to stop the current turn)  |
| `retry <handle> [--up]`     | Run a session's saved prompt again; `--up` only on a stronger model or effort |
| `rate <handle> good\|bad`   | Record whether a delegate's result was good                                   |
| `stats`                     | Report pool balance, pick sources, outcomes, list cost and the feature audit  |
| `guard subagent`            | Decide whether a native subagent call may run (used by the hooks)             |
| `quota`                     | Show subscription quota, pace gaps and model windows                          |

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

Version 0.3.0 adds route reasons, kind, warnings, tilt/confidence flags, retry navigation and ratings to thread details. The pane header shows pool usage and reserve from `smart-router quota`, cached for five minutes; failed quota requests stay hidden.

The plugin also guards native `Agent` calls (`Task` on older Claude Code versions) with a [PreToolUse hook](https://code.claude.com/docs/en/hooks#pretooluse) that runs `smart-router guard subagent --hook claude`. It needs `smart-router` on PATH. See [Native-subagent guard](#native-subagent-guard) for the rule.

## Balancing

Jev judges which model fits a task. Quota is enforced in code, because advice in a prompt was not enough: a pool at 100% kept getting picked.

**Hard limits.** A candidate is dropped when its pool, or a model window that covers it, is at or over its cutoff. `rules.quotaCutoffPercent` defaults to `{ "claude": 95, "codex": 95 }` and `rules.modelWindowCutoffPercent` to 95. Overrides merge per pool, so `{ "claude": 90 }` leaves Codex at 95; `null` turns one pool's cutoff off. A model window is a quota CodexBar reports for specific models, such as Claude's "Fable only" window. If the limits would remove every candidate, they are dropped for that route and only the pool with the lowest weekly usage stays, so a spent week still routes somewhere (`limitsRelaxed: true`). The confidential, confined and harness-scope filters are never relaxed.

**Pace tilt.** `smart-router quota` reports each pool's `paceGap`: expected minus used percent, so positive is reserve and negative is over pace. Each candidate's Jev probability is multiplied by `exp(rules.paceTilt × gap / 100)` and the highest product wins. The gap is the pool's, or a covering model window's when that is smaller. `paceTilt` defaults to 1; 0 turns the tilt off. With Claude 25 points over pace and Codex 50 in reserve, a Codex model at 0.22 beats a Claude model at 0.43.

**Fallback.** The default model runs only when Jev fails or returns an unusable reply. An unavailable default no longer overrides a valid Jev pick, and a pick under `rules.confidenceFloor` is kept and flagged `lowConfidence`.

**Pins.** `--model harness:model` still skips Jev. It must pass the confidential filters or it fails. It reads quota and warns, without blocking, when the pinned pool or model window is over its cutoff, or when the pinned pool is more than 10 points over pace while another enabled pool has more than 10 in reserve. Warnings go to stderr, the JSON output and the session's route record. Use `<harness>:auto` to stay on one harness and still be balanced within it.

Quota comes from one cache, `quota-cache.json` in the state directory. Routes and pins accept a reading up to 60 seconds old and the guard up to 5 minutes, so a burst of spawns makes one `codexbar` call. The age used is recorded as `inputs.quotaAgeMs`.

The default `jev.model` is a pinned release (`jev-1.14.0` on TypeSafe, `typesafe/jev-1.14-20261014` on OpenRouter) so routing does not change when `jev-latest` moves.

## Retry, rate, stats

`smart-router retry <handle>` runs the session's saved prompt as a new session and tells Jev about the previous attempt: its model, effort, status, error, the last 2000 characters of its result and your `--note`. `--up` keeps only stronger candidates: a higher tier, or the same model at a higher effort. Tiers come from `tier` on each model in the config (1 cheapest to 4 strongest); known model names get defaults and `taste` marks models suited to UI, copy and API design. Quota limits and the tilt still apply, and so do spawn's concurrency and depth rules. `--launch` returns a T3 launch like `route --launch`. The retry stores `retryOf` (and `escalated` with `--up`); `status` and `sessions` show the reverse link as `retriedBy`, derived from the retries, so there is one stored link and nothing to fall out of step.

A retry is never less restricted than its original. It inherits the original's confinement, denied and allowed tools, permission mode, MCP config and browser setting, and a Codex retry runs in the original's sandbox and network setting. Caller flags merge the way a resume merges them: confinement sticks, denied tools add up, allowed tools intersect, and an explicit `--sandbox` is the one override. A retry cannot loosen a saved permission mode to `bypassPermissions`, an inherited allow-list keeps the retry on Claude, and `--launch` is refused when the original carried confinement, tool limits or a permission mode, because a T3 thread cannot apply them. With `--up`, an `--effort` on the same model must be higher than the original's.

`smart-router rate <handle> good|bad [--note <text>]` records your judgment of a result.

`smart-router stats [--days N | --window current|previous] [--json] [--export <file>]` reports:

- each pool's share of sessions and cost next to its weekly usage and pace gap;
- pick sources: routed, pinned, fallback, tilt changed, low confidence, limits relaxed, pin warnings issued and how many of those pins ran anyway;
- per model: runs, failure %, retried %, escalated-from %, follow-up sends, ratings and cost;
- runs and cost per caller, label and phase (a retry counts under its original's label and phase);
- a feature audit: for each feature, the outcome rates where it fired against where it did not;
- native-subagent guard decisions per harness;
- a warning when one model takes 90% or more of at least 10 routed picks;
- smart-router's share of all Claude and Codex list spend CodexBar measured, which exposes spend that bypassed it.

A cost is harness-reported or list price, and each row is labelled with its source (see below). `stats` reads saved records without sweeping or refreshing sessions. Backfill older finished T3 records first with `status <handle>` or `wait <handle>`; these commands refresh the named handles.

`--window current` is the weekly quota window. Pools reset on different days, so it starts at the earliest pool's current start and covers every pool's window; `previous` is the 7 days before that. Without either flag the report covers the last 7 days.

A session's outcome is derived when read, never stored: its status, whether it was retried, its follow-up sends, its rating, and whether the same prompt was started again within 24 hours without `retry` (a manual rerun).

Each session's cost is what the harness reported when it reports one (Claude Code does; Codex does not), and otherwise its list cost: token usage at list prices from CodexBar's models.dev cache (`~/Library/Caches/codexbar/model-pricing/models-dev-v1.json`), including cache-read and cache-write rates. Every row says which it is: harness-reported, list price, both, or no cost. No price is built in: without that file, or for a model it does not list, a session with no harness cost is counted as having no cost.

A session stores token totals, not each request's context size, so smart-router cannot tell which requests crossed a long-context price tier. The report gives an upper bound by pricing every token at the catalog's highest context rate. Claude cache writes use separate five-minute and one-hour rates when the duration split is recorded; older records without the split use the catalog's single cache-write rate. The export keeps the computed `listCostUsd` beside `costUsd` and `costSource`, so the replay tool compares models on one basis.

## Experiments and the judgment policy

These are less proven than the balancing above, so each one is recorded on every route and compared in `stats`. None changes which model runs unless you turn it on.

**Shadow picks.** Every routed decision records what other policies would have picked, without running them: `shadow.rawJev` (Jev's own choice), `shadow.weighted` (after the pace tilt), `shadow.fixedDefault` (always the default model) and `shadow.judgments`. `stats` shows how often each agrees with what ran and the outcomes on both sides.

**Judgment policy.** In the same request Jev also rates the task's difficulty (trivial, bounded, hard, frontier) and whether it needs taste. With `rules.policy: "judgments"`, code picks the model: difficulty sets the minimum tier (1 to 4), taste above 0.5 limits the pick to `taste` models, and among the models at the lowest tier that qualifies the pool with more reserve wins, then config order. The default `"jev"` keeps the weighted pick; the other is always recorded as the shadow. Quota never erases the requirement: when every model that meets it is over a cutoff, the limits are relaxed among those models (`limitsRelaxed`). Only when no model meets it at all does the weighted Jev pick run, recorded as `policyRelaxed: true` with a warning.

**Experiments.** `rules.experiments` gives each feature the probability of its "on" arm, drawn per route with crypto randomness and recorded as `experiments`. 0 or 1 pins an arm.

| Experiment        | Default | "on" adds to what Jev sees                                                                                  |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `repoContext`     | 0.5     | tracked file count, top five extensions and whether tests exist, from `git ls-files` (skipped after 300 ms) |
| `outcomeFeedback` | 0.5     | each candidate's last 14 days: runs, failed, retried, escalated from, rated good, rated bad                 |

[evals/replay](evals/replay/README.md) replays recorded sessions under each policy as a dry run. It never runs a task; an execution benchmark needs a graded task set and your budget approval.

## Native-subagent guard

Native subagents (Claude Code's Agent tool, Codex's `spawn_agent`) run on the parent's pool and skip routing. `smart-router guard subagent --harness claude|codex [--subagent-type <t>] [--model <m>] [--session <id>] [--cwd <dir>]` prints `{"decision": "allow"|"deny"|"warn", "message": "..."}` and exits 0. It fires when that harness's pace gap is below -10 and another enabled pool's is above +10; the message tells the agent to delegate through `smart-router spawn`, or `route --launch` in T3.

- `rules.nativeSubagentGuard`: `"block"` (default) denies, `"warn"` allows with the message as context, `"off"` disables it.
- `rules.nativeSubagentAllowTypes` (default `["claude-code-guide", "statusline-setup"]`) always pass.
- It fails open: no quota, an error or a quota read slower than 5 seconds all allow the call.
- Every decision is appended to `native-subagents.jsonl` in the state directory, and `stats` counts them.

`--hook claude|codex` reads the harness's PreToolUse payload on stdin and prints its hook output: a deny as `permissionDecision: "deny"` with the reason, a warning as `additionalContext`, and nothing for an allow. A warning carries no `permissionDecision`, because `"allow"` would skip Claude Code's own permission prompt and Codex 0.169 rejects it without `updatedInput`.

- **Claude Code:** the `smart-router-threads` plugin registers the hook for `Agent` and `Task`.
- **Codex:** `smart-router install` adds it to `${CODEX_HOME:-~/.codex}/hooks.json` for `spawn_agent` (also matched as `Agent`). It keeps existing hooks, copies the file to `hooks.json.bak-<timestamp>` before changing it, and does nothing when the hook is already there. Restart Codex and approve the hook with `/hooks`; until then it does not run. Codex CLI 0.169.0 runs PreToolUse hooks for `spawn_agent` ([hook reference](https://learn.chatgpt.com/docs/hooks), [tool registry](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/registry.rs)).

In both harnesses only a deny or exit code 2 blocks a call. A missing `smart-router` binary, any other exit code, a timeout or malformed output lets the subagent run.

## Audit trail

Every session saves a route record (`route`, version 2), whether it was routed, pinned, launched for T3 or retried. `smart-router route` prints the same record and `status <handle>` shows it.

| Field                                                     | Meaning                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `kind`                                                    | `routed`, `pinned` or `fallback`                                                                   |
| `pick`, `reason`                                          | what ran, and why in one line built from the fields below                                          |
| `rawPick`, `probabilities`, `confidence`, `lowConfidence` | Jev's own answer                                                                                   |
| `weights`, `weightedScores`, `tiltChanged`                | the pace tilt and whether it changed the pick                                                      |
| `excluded`, `limitsRelaxed`                               | each dropped candidate with its reason and kind (`quota`, `scope`, `confidential`, `escalation`)   |
| `warnings`                                                | pin warnings, a T3 thread running a different model than planned, a judgment policy without a pick |
| `policy`, `judgments`, `shadow`, `experiments`            | which policy picked, Jev's task judgments, the other policies' picks and the experiment arms       |
| `inputs`                                                  | hint, quota snapshot and its age, preferences SHA-256, Jev model asked and served, latencies       |

Session records also carry `promptSha256`, `retryOf`, `escalated`, `rating` and a caller-chosen `permissionMode`. `session.started` events and `sessions` rows carry a short route summary (`kind`, `pick`, `reason`, `warnings`, `tiltChanged`, `lowConfidence`). `stats --export <file>` writes one JSON line per session with the route record and its outcome.

Everything lives in the state directory (`~/.local/state/smart-router`, or `SMART_ROUTER_STATE_DIR`):

| Path                            | Contents                                                                                    | Size                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `sessions/<handle>.json`        | session record with the route record                                                        | about 5 KB each, plus the result text                   |
| `sessions/<handle>.prompt.md`   | the task prompt as given, for `retry`                                                       | the size of the prompt                                  |
| `preferences/<sha256>.md`       | the preferences text a route was decided with, once per distinct text, for `replay --reask` | the size of `preferences.md` per edit of it             |
| `sessions/<handle>.log`, `.err` | the harness's event log                                                                     | the largest files: tens of KB to several MB per session |
| `pin-warnings.jsonl`            | one line per pin warning                                                                    | about 250 bytes a line                                  |
| `native-subagents.jsonl`        | one line per guard decision                                                                 | about 300 bytes a line, one per native subagent call    |
| `quota-cache.json`              | the last complete quota reading                                                             | under 1 KB, overwritten                                 |

`smart-router prune --older-than <days>` removes finished sessions with their prompt and logs. The preferences snapshots and the two `.jsonl` logs are not pruned: at 300 bytes a line, 10,000 guard decisions are about 3 MB. Delete or truncate them when you no longer need the history.

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
