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
    "claude": { "enabled": true, "auth": "subscription" }, // or "api-key"
    "codex": { "enabled": true, "auth": "subscription" }, // or "api-key"
    "pi": { "enabled": false },
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
  "rules": {
    // all optional; anything absent is left to Jev
    "quotaCutoffPercent": { "claude": 85, "codex": 90 }, // per subscription provider; codexbar weekly window usedPercent >= cutoff removes that harness
    "confidentialPathGlobs": ["**/awm/**", "**/grainger/**"], // cwd matching any glob excludes every openrouter model
    "stoppingPointRequiredFor": ["codex:gpt-5.6-sol", "codex:gpt-6-astra"], // spawn refuses these picks when the prompt states no stopping point
    "confidenceFloor": 0.35, // below this, use defaultModelId instead of Jev's pick; 0.35 default because confidence is how peaked the distribution is and a 9-option choice rarely exceeds 0.6
  },
  "defaultModelId": "codex:gpt-5.6-terra",
  "defaultEffort": "medium",
  "spawn": {
    "claudePermissionMode": "bypassPermissions",
    "codexSandbox": "workspace-write",
  },
  "jev": { "model": "jev-latest", "apiKeyEnv": "TYPESAFE_API_KEY" },
}
```

Model `id` is always `harness:model`. A candidate is `harness:model@effort`.

Env vars are read from the process environment; the CLI also loads `.env` from the current directory if present (dotenv-style parse, stdlib) so the TypeSafe key can live next to the project.

## Commands

All commands print JSON on stdout and a one-line human summary on stderr. Exit code 0 on success, 1 on any error with `{ "error": "..." }` on stdout.

### `smart-router doctor`

Read-only. Detects and prints:

```json
{
  "harnesses": { "claude": { "installed": true, "version": "2.1.278", "authed": true }, "codex": {...}, "pi": {...} },
  "providers": { "openai": { "apiKeySet": false }, ... },
  "codexbar": { "installed": true },
  "candidates": ["claude:opus@high", "codex:gpt-5.6-terra@medium", ...]   // from config.models × efforts, filtered to installed+authed harnesses
}
```

Detection: `command -v` for binaries, `--version` for versions. Authed: claude → `~/.claude/cache/model-catalog/*.json` exists; codex → `~/.codex/models_cache.json` exists or `CODEX_API_KEY` set; pi → any provider key set. Never read auth/credential files.

### `smart-router init [--section auth|models|rules|preferences] [--reset]`

The wizard. Sections in order: auth, models, rules, preferences. On an existing config every prompt prefills the current value and each section opens with "Keep as is" preselected. `--section` runs one section. `--reset` starts from empty.

- **auth**: for claude, codex, pi: enabled? auth by subscription or API key? For API-key providers (openai, anthropic, openrouter, google, plus any provider pi's registry knows): which env var holds the key (default to the conventional name; show whether it is currently set).
- **models**: for each enabled harness, call `enumerate(harness)` (below), show a multi-select with a first row "Enable all" that selects everything. Then per selected model, effort levels come from the enumeration data (do not prompt).
- **rules**: per subscription harness "cutoff at what percent used? (blank = none)". Confidential path globs (comma-separated, blank = none). Confidence floor (default 0.6). Default model + effort chosen from enabled candidates.
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
  "statesStoppingPoint": 0.9,
  "reason": "bounded implementation; codex weekly window 34% used",
  "fellBack": false,
  "candidates": [...]
}
```

Pipeline:

1. Candidates = `config.models` (each with its supported efforts), keep only those whose harness is installed and authed (doctor logic).
2. Apply enabled rules only: `quotaCutoffPercent` (needs codexbar; if codexbar is missing, skip this rule and note it in `reason`), `confidentialPathGlobs` or `--confidential` (drop `openrouter/*` models).
3. Build Jev `state`: `{ preferences: <preferences.md>, task: <prompt, truncated to 8k chars>, hint, cwd, quota: <normalized codexbar snapshot or null>, candidates: [{ id, harness, model, efforts, auth }] }`.
4. One Jev call with three questions. `model`: a Choice over the eligible model ids (`harness:model`, no effort), instructions "Pick the model that should run this task according to the user's preferences", criteria map = model id → one-line description (harness, auth, supported efforts). `effort`: a Choice over the union of effort levels the eligible models support, instructions "Pick the reasoning effort this task needs". `needsBrowser`: a Noul "does this task need a browser or screenshots". `statesStoppingPoint`: a Noul "does this task state what finished looks like or where to stop". Both are returned as numbers and do not affect the pick. The pick is `model@effort`; if the chosen model does not support the chosen effort, use the highest effort it supports below it. Effort is asked separately so probability mass is not split across tiers of the same model.
5. If the `model` answer's `confidence < rules.confidenceFloor`, pick `defaultModelId@defaultEffort` and set `fellBack: true`.
6. If the Jev call itself fails (network, auth, rate limit), do not error: pick `defaultModelId@defaultEffort`, set `fellBack: true`, put the error message in `reason`, and set `needsBrowser` and `statesStoppingPoint` to null.
7. `--dry-run` prints the state that would be sent instead of calling Jev.

### `smart-router spawn "<prompt>" [route flags] [--model <harness:model>] [--effort <e>] [--worktree] [--no-guardrails]`

`route` (skipped when `--model` is given), then the harness adapter's `spawn`. Blocks until the turn finishes.

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

### `smart-router send <handle> "<message>"`

Loads the session file, calls the adapter's `resume`, prints `{ "handle", "result" }`.

### `smart-router quota`

Prints the normalized codexbar snapshot: `{ claude: { weeklyUsedPercent, weeklyResetsAt, fiveHourUsedPercent, pace }, codex: {...} }`. `weeklyUsedPercent` and `weeklyResetsAt` come from `usage.secondary`, `fiveHourUsedPercent` from `usage.primary` or null when codexbar reports `usage.primary` as null (it does for codex), `pace` from `pace.secondary.summary` using `codexbar usage --format json --provider claude|codex`. `pace` is codexbar's `pace.secondary.summary` string. Missing codexbar → `{ "error": "codexbar not installed" }`.

## Harness adapters

One module per harness, all exposing `spawn(prompt, opts) → { sessionId, result, resumeCommand }` and `resume(sessionId, message, opts) → { result }`. `opts` carries `cwd`, `model`, `effort`, `worktree`.

- **claude**: spawn `claude -p <prompt> --output-format json --model <model> --session-id <uuid generated by us> --permission-mode <config.spawn.claudePermissionMode> [--worktree]`, cwd set. Effort maps to `--effort`? No: there is no such flag in 2.1.278; put effort into `--append-system-prompt "Reasoning effort: <effort>"` only if `effort` is set. Result = `.result` of the JSON object. Resume: `claude -p --resume <id> <message> --output-format json`.
- **codex**: spawn `codex exec --json -C <cwd> -m <model> -c model_reasoning_effort="<effort>" -s <config.spawn.codexSandbox> [--worktree] <prompt>` (`codex exec` is already non-interactive; it has no `-a` flag); `thread_id` from the first `thread.started` event; result = text of the last `item.completed` agent message. Resume: `codex exec resume <id> --json <message>`. Add `--skip-git-repo-check` when cwd is not inside a git repo.
- **pi**: spawn `pi -p <prompt> --mode json --model <provider/model> --thinking <effort> --session <path under state dir>`; result = final assistant text from the JSON events. Resume: same command with the same `--session` path. Model ids for pi are `provider/model`.

Session file: `{ handle, harness, model, effort, cwd, sessionId, createdAt, promptPreview }`. Handle = 6 lowercase alphanumerics.

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

Detached spawns, streaming output, cost tracking, per-repo config overrides, Jev-derived capability requirements affecting the pick.
