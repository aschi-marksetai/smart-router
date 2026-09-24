# smart-router — spec

A CLI that picks which coding-agent harness and model should run a task, spawns it, and lets the caller keep talking to that session. The decision is made by Jev (TypeSafe's structured-judgment API) against the user's own routing preferences; the wrapper only enforces the rules the user enabled.

## Stack

- Bun 1.4 runtime, TypeScript, ESM. No build step: `bun run src/cli.ts`. Tests: `bun test`.
- `commander` for flags, `@clack/prompts` for the wizard (same pair openclaw uses).
- `@typesafe-ai/sdk` for the Jev call: `new TypeSafeClient()` reads `TYPESAFE_API_KEY`; `client.systemOne({ state, model, questions })`; `choice(instructions, criteria)` where `criteria` is a map of option id → description (or null); `noul(instructions)`. A choice answer is `{ choice, confidence, probabilities }`. `@earendil-works/pi-ai` for the offline model registry.
- Config is JSON (stdlib read/write). No TOML dependency.
- Formatter: prettier.

## Files on disk

| Path                                                 | Purpose                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `~/.config/smart-router/config.json`                 | Everything the wizard writes (shape below).                        |
| `~/.config/smart-router/preferences.md`              | The user's routing prose. Sent to Jev verbatim as part of `state`. |
| `~/.local/state/smart-router/sessions/<handle>.json` | One file per spawned session.                                      |

`SMART_ROUTER_CONFIG_DIR` and `SMART_ROUTER_STATE_DIR` override the two roots (tests use this).

## config.json

```jsonc
{
  "version": 1,
  "harnesses": {
    "claude": {
      "enabled": true,
      "auth": "subscription",
      "binary": "claude",
      "capabilities": "browser via Chrome DevTools MCP and the user's logged-in Chrome when the extension is authorized; full local tool use",
    }, // auth is also "api-key"; binary and capabilities are optional
    "codex": { "enabled": true, "auth": "subscription" }, // auth is also "api-key"
    "pi": { "enabled": false, "auth": "api-key" }, // auth may also be "subscription"
  },
  "providers": {
    // API-key providers, used by pi (and by claude/codex when auth = "api-key")
    "openai": { "apiKeyEnv": "OPENAI_API_KEY" },
    "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY" },
    "openrouter": { "apiKeyEnv": "OPENROUTER_API_KEY" },
  },
  "models": [
    // only models the user enabled in the wizard
    {
      "id": "claude:opus",
      "harness": "claude",
      "model": "opus",
      "efforts": ["low", "medium", "high"],
    },
    {
      "id": "codex:gpt-5.6-terra",
      "harness": "codex",
      "model": "gpt-5.6-terra",
      "efforts": ["low", "medium", "high", "xhigh"],
    },
    {
      "id": "pi:openrouter/deepseek-v4",
      "harness": "pi",
      "model": "openrouter/deepseek-v4",
      "efforts": ["medium"],
    },
  ],
  "ignoredModels": [], // models deliberately left disabled in init
  "rules": {
    // all optional; anything absent is left to Jev
    "quotaCutoffPercent": { "claude": 85, "codex": 90 }, // per subscription provider; codexbar weekly window usedPercent >= cutoff removes that harness
    "confidentialPathGlobs": ["**/awm/**", "**/grainger/**"], // cwd matching any glob excludes every openrouter model
    "confidentialExcludedProviders": ["openrouter"], // provider prefixes excluded for confidential tasks
    "stoppingPointRequiredFor": ["codex:gpt-5.6-sol", "codex:gpt-6-astra"], // spawn refuses these picks when the prompt states no stopping point
    "confidenceFloor": 0.35, // below this, use defaultModelId instead of Jev's pick; 0.35 default because confidence is how peaked the distribution is and a 9-option choice rarely exceeds 0.6
    "directModel": "allow", // allow (default) or deny caller-provided --model and --effort picks
  },
  "quota": {
    "enabled": true,
    "providers": { "claude": "claude", "codex": "codex" }, // codexbar provider names; omitted harnesses have no quota
  },
  "defaultModelId": "codex:gpt-5.6-terra",
  "defaultEffort": "medium",
  "spawn": {
    "claudePermissionMode": "bypassPermissions",
    "codexSandbox": "workspace-write",
    "autoSandbox": true,
    "allowFullAccess": true,
  },
  "jev": { "model": "jev-latest", "apiKeyEnv": "TYPESAFE_API_KEY" },
}
```

Model `id` is always `harness:model`. A candidate is `harness:model@effort`.
Absent capability notes default to Claude's browser and local tools, Codex CLI web fetch and search without browser or screenshots, and pi without browser.

Env vars are read from the process environment; the CLI also loads `.env` from the config directory and then from the current directory if present (dotenv-style parse, stdlib; existing variables are never overridden). `init` writes the TypeSafe key to the config directory's `.env` when it is missing.

## Commands

### Updates

The CLI caches the latest-release check for 24 hours. `route` and `spawn` print a newer-version notice and newly available models on stderr unless `updates.check` is false or `SMART_ROUTER_NO_UPDATE_CHECK` is set. `update` downloads and verifies the matching release asset; `update --check` reports without changing files. Homebrew installations must use `brew upgrade smart-router`.

All commands print JSON on stdout and a one-line human summary on stderr. Exit code 0 on success, 1 on any error with `{ "error": "..." }` on stdout.

### `smart-router doctor`

Read-only. Detects and prints:

```json
{
  "harnesses": { "claude": { "installed": true, "version": "2.1.278", "authed": true }, "codex": {...}, "pi": {...} },
  "providers": { "openai": { "apiKeySet": false }, ... },
  "codexbar": { "installed": true },
  "candidates": ["claude:opus@high", "codex:gpt-5.6-terra@medium", ...],   // from config.models × efforts, filtered to installed+authed harnesses
  "availableModels": ["claude:new-model", ...] // enumerated enabled+authed models not in config.models; best effort
}
```

`availableModels` lists best-effort enumerated models from enabled, authenticated harnesses that are neither configured nor in `ignoredModels`.

Detection: `Bun.which` for binaries (a `command -v` subprocess is not portable to Linux), `--version` for versions. Authed: claude → `~/.claude/cache/model-catalog/*.json` or `~/.claude/.credentials.json` exists; codex → `~/.codex/models_cache.json` or `~/.codex/auth.json` exists, or `CODEX_API_KEY` set; pi → any provider key set. Never read auth/credential files.

### `smart-router init [--section auth|models|rules|preferences] [--reset]`

The wizard. Sections in order: auth, models, rules, preferences. On an existing config every prompt prefills the current value and each section opens with "Keep as is" preselected. `--section` runs one section. `--reset` starts from empty.

At the start of every init run, prompt for a missing TypeSafe API key and store a non-blank answer in the config directory's `.env` file.

- **auth**: for claude, codex, pi: enabled? auth by subscription or API key? Each enabled harness gets a "Capabilities note for routing" text prompt prefilled with its current or default value. For API-key providers (openai, anthropic, openrouter, google, plus any provider pi's registry knows): which env var holds the key (default to the conventional name; show whether it is currently set).
- **models**: for each enabled harness, call `enumerate(harness)` (below), show a multi-select with a first row "Enable all" that selects everything. Rows are labeled `<name>  <model id>` and sorted by name with natural numeric ordering. Then per selected model, effort levels come from the enumeration data (do not prompt).
- **rules**: per subscription harness "cutoff at what percent used? (blank = none)". Confidential path globs and excluded provider prefixes (comma-separated, blank = none). Confidence floor (default 0.35). Default model + effort chosen from enabled candidates.
- **preferences**: if `preferences.md` is missing, seed it from `templates/preferences.md`, then offer to open it in `$EDITOR`, edit it through an interactive Claude Code or Codex interview when that binary is installed, or skip editing.

### `smart-router route "<prompt>" [--cwd <dir>] [--hint <text>] [--confidential] [--dry-run]`

Decision only. Output:

```json
{
  "pick": "codex:gpt-5.6-terra@xhigh",
  "confidence": 0.82,
  "probabilities": { "codex:gpt-5.6-terra": 0.82, "claude:opus": 0.11, ... },
  "effortProbabilities": { "xhigh": 0.7, "high": 0.2, ... },
  "needsBrowser": 0.05,
  "needsNetwork": 0.05,
  "needsFullAccess": 0.05,
  "statesStoppingPoint": 0.9,
  "reason": "bounded implementation; codex weekly window 34% used",
  "fellBack": false,
  "candidates": [...]
}
```

Pipeline:

1. Candidates = `config.models` (each with its supported efforts), keep only those whose harness is installed and authed (doctor logic).
2. Apply enabled rules only: `quotaCutoffPercent` (needs codexbar; if codexbar is missing, skip this rule and note it in `reason`), `confidentialPathGlobs` or `--confidential` (drop `openrouter/*` models).
3. Build Jev `state`: `{ preferences: <preferences.md>, task: <prompt, truncated to 8k chars>, hint, cwd, quota: <normalized codexbar snapshot or null>, candidates: [{ id, harness, model, efforts, auth, capabilities }] }`.
4. One Jev call with five questions. `model`: a Choice over the eligible model ids (`harness:model`, no effort), instructions "Pick the model that should run this task according to the user's preferences", criteria map = model id → one-line description (harness, auth, supported efforts, capabilities). `effort`: a Choice over the union of effort levels the eligible models support, instructions "Pick the reasoning effort this task needs". `needsBrowser`, `needsNetwork`, `needsFullAccess`, and `statesStoppingPoint` are Noul scores. All are returned as numbers and do not affect the pick. The pick is `model@effort`; if the chosen model does not support the chosen effort, use the highest effort it supports below it. Effort is asked separately so probability mass is not split across tiers of the same model.
5. If the `model` answer's `confidence < rules.confidenceFloor` or its choice is not a candidate, pick `defaultModelId@defaultEffort` and set `fellBack: true`.
6. If the Jev call itself fails (network, auth, rate limit), do not error: pick `defaultModelId@defaultEffort`, set `fellBack: true`, put the error message in `reason`, and set the Noul scores to null.
7. `--dry-run` prints the state that would be sent instead of calling Jev.

### `smart-router spawn "<prompt>" [route flags] [--model <harness:model>] [--effort <e>] [--worktree] [--no-guardrails]`

`route` (skipped when `--model` is given), then the harness adapter's `spawn`. Blocks until the turn finishes. As soon as the pick is known, before the delegate starts, spawn prints one stderr line `Routed to <harness:model@effort> (confidence <n>)` (or `(caller override)` with `--model`) so a caller tailing stderr sees the choice immediately. When `rules.directModel` is `deny`, `--model` and `--effort` cause spawn to exit 1 before routing; otherwise `--model` and its effort must be enabled in `config.models`, or spawn exits 1 and directs the caller to `smart-router init --section models`.

Automatic sandbox: for Codex, `spawn.autoSandbox` uses the route's `needsFullAccess`, `needsBrowser`, and `needsNetwork` scores (threshold 0.5) to select `danger-full-access` for full-access or browser tasks or to keep the configured sandbox with `sandbox_workspace_write.network_access=true` for network tasks. The scores survive a confidence fallback; only a Jev outage leaves them null, which means the configured sandbox. `--sandbox` always overrides it. `spawn.allowFullAccess` disables automatic full access when false. The chosen sandbox and network override persist in the session and apply to `send` unless `--sandbox` overrides them.

For Claude, `--browser` passes `--chrome` and persists for `send`; a routed Claude pick also enables it when `needsBrowser` exceeds 0.5. Other harnesses ignore `--browser` with a stderr note.

Before spawning: if the picked model id is listed in `rules.stoppingPointRequiredFor` and the route's `statesStoppingPoint` is below 0.5, exit 1 with `{ "error": "codex:gpt-5.6-sol needs a stated stopping point: add success criteria and where to stop to the prompt, then call spawn again" }`. The check runs only when routing ran (not with `--model`) and not when the route fell back.

Then, unless `--no-guardrails`, append the guardrails text for the picked model (see "Guardrails") to the prompt as a trailing section headed `## Operating rules`. `send` never appends guardrails.

Output:

```json
{
  "handle": "k3f9a2",
  "harness": "codex", "model": "gpt-5.6-terra", "effort": "xhigh",
  "route": { ...route output... },
  "resumeCommand": "codex exec resume 7b1c... \"<msg>\"",
  "result": "<final assistant message text>"
}
```

### Detached spawns: `--detach`, `status`, `logs`, `wait`, `stop`

`spawn --detach` does everything a foreground spawn does up to launching the delegate (routing, stopping-point check, guardrails, the `Routed to` stderr line), then starts the harness process detached from the CLI with its stdout redirected to `<sessions dir>/<handle>.log`, records `pid`, `status: "running"` and `logPath` in the session file, prints `{ handle, harness, model, effort, route, logPath }` and exits immediately. The child must outlive the CLI (node `child_process.spawn` with `detached: true`, `unref()`, and file descriptors for stdio).

The child's stderr is written to the sibling `<handle>.err` file and recorded as `errPath`.

To make one runner serve both modes, each harness adapter exposes `buildSpawn(prompt, opts) → { argv, sessionId? }` and `parseSpawnOutput(stdout) → { sessionId, result, usage }`, and likewise `buildResume` / `parseResumeOutput`. The CLI runs the argv itself, foreground or detached.

- `status <handle>` prints the session file plus `running: boolean` (pid alive check with signal 0). If the process has exited and the session is still `running`, it parses the log with the adapter's `parseSpawnOutput`, stores `result`, `usage`, `sessionId` and `status: "done"` (or `"failed"` when parsing finds no result), then prints.
- `logs <handle> [--tail <n>]` prints the raw log file, last `n` lines when given. The log is the harness's own JSON event stream, so callers can read progress.
- `logs <handle> --err` prints the detached process's stderr file.
- `wait <handle>` polls `status` every second until the session is no longer running, then prints exactly what a foreground spawn would have printed, but exits 1 with `{ error }` when the session failed.
- `stop <handle>` sends SIGTERM to the pid, marks `status: "stopped"`, prints the session.
- `send` on a session that is still `running` exits 1 with `{ "error": "session <handle> is still running; wait or stop it first" }`.

### Usage accounting

Spawn, send, wait and status include `usage: { inputTokens, outputTokens, costUsd | null }` parsed from the harness output: claude's result object `usage` and `total_cost_usd`; codex's `turn.completed` event `usage` (`input_tokens`, `output_tokens`; cost null); pi's final event usage when present, else null. The session file keeps a cumulative `usage` across spawn and every send.

### Result limits

`spawn`, `send` and `wait` accept `--result-limit <chars>`. When a result exceeds it, stdout includes its first `chars` characters plus `resultTruncated: true` and `resultChars`; the full result remains in `lastResult` in the session file. The default is unlimited.

### Session ownership and cleanup

Sessions record `owner` as `SMART_ROUTER_OWNER`, else `CLAUDE_CODE_SESSION_ID` (set by Claude Code in every Bash call, so one Claude session keeps one owner across calls), else `process.ppid`. `sessions` lists the current owner's session summaries newest first; `sessions --all` includes all owners. `rm <handle>` removes its JSON, log and error files; `prune --older-than <days>` removes only finished sessions older than the threshold.

### Per-spawn passthrough flags

`spawn` and `send` accept `--permission-mode <mode>` (claude only, overrides `config.spawn.claudePermissionMode`), `--sandbox <policy>` (codex only), `--browser` (claude `--chrome`), `--allowed-tools <list>` (claude `--allowedTools`; ignored for other harnesses with a note in the stderr summary), and `--schema <file>` (claude `--json-schema` with the file contents, codex `--output-schema <file>`; ignored for pi with a note). Ignored flags never fail the command.

### `smart-router send <handle> "<message>"`

Loads the session file, calls the adapter's `resume`, prints `{ "handle", "result" }`.

### `smart-router quota`

Prints the normalized codexbar snapshot: `{ claude: { weeklyUsedPercent, weeklyResetsAt, fiveHourUsedPercent, pace }, codex: {...} }`. `weeklyUsedPercent` and `weeklyResetsAt` come from `usage.secondary`, `fiveHourUsedPercent` from `usage.primary` or null when codexbar reports `usage.primary` as null (it does for codex), `pace` from `pace.secondary.summary` using `codexbar usage --format json --provider claude|codex`. `pace` is codexbar's `pace.secondary.summary` string. Missing codexbar → `{ "error": "codexbar not installed" }`.

## Harness adapters

One module per harness, all exposing `spawn(prompt, opts) → { sessionId, result, resumeCommand }` and `resume(sessionId, message, opts) → { result }`. `opts` carries `cwd`, `model`, `effort`, `worktree`.

- **claude**: spawn `claude -p <prompt> --output-format json --model <model> --session-id <uuid generated by us> --permission-mode <config.spawn.claudePermissionMode> [--worktree]`, cwd set. Spawn passes `--append-system-prompt` with the delegate preamble directing the delegate to use its own tools and never delegate through smart-router. Browser mode adds `--chrome` and an isolated Chrome DevTools MCP config to avoid the shared-profile lock. Effort passes through as `--effort <effort>`. Result = `.result` of the JSON object. Resume: `claude -p --resume <id> <message> --output-format json`.
- **codex**: spawn `codex exec --json -C <cwd> -m <model> -c model_reasoning_effort="<effort>" -s <config.spawn.codexSandbox> [--worktree] <prompt>` (`codex exec` is already non-interactive; it has no `-a` flag); `thread_id` from the first `thread.started` event; result = text of the last `item.completed` agent message. Resume: `codex exec resume <id> --json -m <model> -c sandbox_mode="<config.spawn.codexSandbox>" <message>`. Add `--skip-git-repo-check` when cwd is not inside a git repo.
- **pi**: spawn `pi -p <prompt> --mode json --model <provider/model> --thinking <effort> --session <path under state dir>`; result = final assistant text from the JSON events. Resume: same command with the same `--session` path. Model ids for pi are `provider/model`.

Session file: `{ handle, owner, harness, model, effort, cwd, sessionId, createdAt, promptPreview, status, browser?, sandbox?, usesNetworkAccess?, pid?, logPath?, result?, lastResult?, error?, usage? }`. The optional `error` stores the failure message for failed sessions. `status` is `running`, `done`, `failed` or `stopped`; foreground spawns write `done` directly. Handle = 6 lowercase alphanumerics.

## Model enumeration (`src/enumerate.ts`)

`enumerate(harness, config) → Array<{ id, model, name, efforts }>`:

- **claude, subscription**: read the newest `~/.claude/cache/model-catalog/*.json`; models at `catalog.config.models[]`; `model` = `id` (what `claude --model` accepts), `name` = `short_name`; efforts = `thinking.effort_options[].id` (fallback `["low","medium","high"]`).
- **claude, api-key**: `GET https://api.anthropic.com/v1/models` with `x-api-key` and `anthropic-version: 2023-06-01`; efforts from `capabilities.effort` if present.
- **codex**: `codex debug models` JSON (fallback: `~/.codex/models_cache.json`); `model` = `slug`; efforts = `supported_reasoning_levels[].effort`; skip entries whose `visibility` is not `"list"` (real values are `list` and `hide`).
- **pi**: providers whose key env var is set → `GET /v1/models` for openai/anthropic, `GET https://openrouter.ai/api/v1/models` for openrouter, otherwise `@earendil-works/pi-ai` `getBuiltinModels()` filtered to that provider. `model` = `provider/id`. Efforts: `["low","medium","high"]` when the registry says `reasoning: true`, else `["medium"]`.

Enumeration failures are per-source: report the error in the wizard and continue.

## Guardrails

`guardrails.md` is Markdown with `## <key>` sections where key is a harness name (`codex`) or a model id (`codex:gpt-5.6-sol`). `guardrailsFor(modelId)` returns the harness section followed by the model section, each only if present, joined by a blank line; empty string when neither exists. Seeded from `templates/guardrails.md` by `init` when missing. The preferences interview prompt mentions the file so one interview session can refine both files.

Rules for models that need a stopping point are chosen in the `init` rules section: a multiselect "Models that must be given a stopping point" over enabled model ids, prefilled from `rules.stoppingPointRequiredFor`.

## Skill file

`skill/SKILL.md`: tells a calling agent (Claude Code or Codex) to use `smart-router spawn` instead of its native subagent tool for delegations, to read `handle` and `result` from stdout JSON, and to continue with `smart-router send <handle> "<msg>"`, and that every spawn prompt must state what done looks like and where to stop. Under 50 lines.

## Out of scope for v1

Per-repo config overrides, streaming to the caller's terminal, Jev-derived capability requirements affecting the pick.
