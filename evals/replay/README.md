# Routing replay (dry run)

Scores routing policies against sessions that already ran. It never runs a task.

```sh
smart-router stats --days 30 --export sessions.jsonl
bun evals/replay/run.ts sessions.jsonl            # offline
bun evals/replay/run.ts sessions.jsonl --reask    # also asks Jev again (network, a fraction of a cent per session)
bun evals/replay/run.ts sessions.jsonl --json --seed 7
```

For each policy it reports the picks, their estimated list cost and, where the pick is the model that actually ran, the observed outcomes (failed, retried, rated bad, rerun).

| Policy              | Pick                                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recorded`          | What ran.                                                                                                                                                                                                                                                                                                       |
| `jevReasked`        | Jev asked again with the saved prompt, hint, quota snapshot, experiment arms and the preferences snapshot matching the session's `preferencesSha256` (`--reask`). A session without a snapshot is re-asked with today's `preferences.md` and a warning. Model availability is today's. Pinned runs are skipped. |
| `fixedDefault`      | The configured default model, from the recorded shadow pick.                                                                                                                                                                                                                                                    |
| `judgments`         | The judgment policy's recorded shadow pick.                                                                                                                                                                                                                                                                     |
| `costMatchedRandom` | A seeded coin flip between the cheapest and dearest candidate model, weighted so its expected list cost equals what was spent.                                                                                                                                                                                  |
| observed cascade    | Each `retry --up` chain as one task: the cost of every attempt, next to what starting on the final model would have cost.                                                                                                                                                                                       |

## Limits

- **Cost is an estimate.** It prices the recorded tokens at the policy's model. A different model would read and write a different number of tokens.
- **Outcomes exist only where a policy agrees with what ran.** A policy that would have picked another model has no outcome here, so this tool cannot say which policy is better. It shows where policies differ and what each would cost.
- **An execution benchmark is a separate, paid step.** Comparing policies on quality needs a graded task set (tasks with a checkable success test) run under every policy. That spends real quota and money, so it needs the user's budget approval before anyone builds or runs it.
