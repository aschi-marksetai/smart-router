# Robustness suite

Run from the repository root with the installed `smart-router` and enabled parent/helper models. This suite launches real harnesses; it is outside `bun test` and CI.

```sh
bun evals/robustness/run.mjs --check
bun evals/robustness/run.mjs
bun evals/robustness/run.mjs self-wait max-depth
```

Each run writes `results.json` and scenario evidence under `evals/robustness/runs/<timestamp>/`. A successful parent exit is initially PARTIAL until its recorded actions have been reviewed.

Load Langfuse credentials into the shell environment:

```sh
set -a; . ~/.config/markset/langfuse-smart-router.env; set +a
```

The file must define `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL`. The uploader reads these environment variables; an upload fails clearly if any is absent.

```sh
# Preview the complete planned payload without credentials or network requests:
bun evals/robustness/upload-langfuse.mjs evals/robustness/runs/2026-10-11T14-30-40.434Z --dry-run

# Upload existing evidence:
bun evals/robustness/upload-langfuse.mjs evals/robustness/runs/2026-10-11T14-30-40.434Z

# Upload the directory written by a new live run:
bun evals/robustness/run.mjs --upload
```

`--upload` skips upload when credentials are incomplete. The standalone uploader requires them except in dry-run mode. Neither command prints the keys.

Langfuse shows the `smart-router-robustness` dataset with one stable scenario item, its effective prompt, expected safe behaviour, and timeout in seconds. Items are upserted by scenario name. A dataset run named `smart-router-<package version>-<run timestamp>` contains pass/partial/fail counts and a trace for each scenario. Traces share that session name, environment `eval`, package release, and router/robustness/parent model tags. Recorded sessions become child spans or generations with recorded token usage and cost. Trace output includes outcome, reason, and parent result capped at 4 KiB. A separate `robustness/summary` trace contains the Markdown results table. After flushing, the uploader prints the dataset run URL and total trace count including the summary.

Scores are numeric `pass` (1 / 0.5 / 0), categorical `outcome`, and numeric `orphaned_processes` (observed live tracked PIDs before controller cleanup). Failed process inspection is marked in trace metadata; a zero observed count cannot rule out unrecorded processes. `recovered` is emitted only for an explicit boolean `modelRecovery`; the runner's free-text review notes do not establish recovery. Missing session end times remain null in the plan and are rendered as zero-duration observations with `endTimeRecorded: false`, rather than measuring upload time as execution time.

The official Langfuse packages are pinned to JS/TS SDK v4.6.1 in devDependencies. Method signatures were checked against the installed README/type definitions and the [official v4 documentation](https://js-sdk-v4-docs-snapshot.langfuse.com/docs/observability/sdk/overview/). Dataset run linking uses the v3 server dataset-run API supported by SDK v4. The [current public API reference](https://api.reference.langfuse.com/) schedules its removal on Langfuse Cloud for November 16, 2026; Langfuse v4 server deployments require the newer experiments API.
