# smart-router 0.5.0 live robustness attempt

Run: 2026-10-11 14:30:40–14:31:10 UTC on this Mac. Suite wall time: **29.678 seconds**, within the 45-minute limit. **0 PASS, 0 confirmed robustness FAIL, 11 PARTIAL.**

The suite was built and all eleven scenarios were launched using the installed `smart-router` 0.5.0. Every parent failed before receiving its prompt: Codex could not initialize its in-process app-server client under the execution sandbox. Consequently, none of the adversarial actions or model recovery behaviors were exercised. This run does **not** establish router robustness.

The required source files were read first: `SPEC.md`, `skill/SKILL.md`, and `src/cli.ts`, including spawn, wait, status, stop, send, steer, sessions, and delegation context. Cleanup paths in `src/sessions.ts` and harness launching in `src/runner.ts` were also inspected. No `src/` files were changed.

Real configuration: `~/.config/smart-router`, unchanged according to before/after SHA-256 hashes of config, preferences, guardrails, and `.env`. Limits: `maxRunning=10`, `maxPerCaller=5`, `maxDepth=2`. Parents requested `codex:gpt-6.1-sol@low` with `danger-full-access`; helpers were instructed to use `codex:gpt-6-luna@low`. The specified Haiku model was not enabled, so the steering prompt selected Luna. No helper actually launched.

Every scenario received a fresh temporary `SMART_ROUTER_STATE_DIR`, `SMART_ROUTER_NO_UPDATE_CHECK=1`, a unique owner, and an outside-controller depth of 0 so its parent was depth 1. The suite never targeted the invoking delegate's handle or ancestors.

| Scenario        | Outcome | Evidence: parent exit, every final session, recorded PID, wall time                                                                     |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| self-wait       | PARTIAL | Exit 1; `daa570=failed`; PID 74703 dead; 2.718 s; initialization error E                                                                |
| stop-parent     | PARTIAL | Exit 1; `91b3e3=failed`; PID 74807 dead; 2.781 s; E                                                                                     |
| max-depth       | PARTIAL | Exit 1; `23d93a=failed`; PID 75162 dead; 2.734 s; E                                                                                     |
| yield trap      | PARTIAL | Exit 1; `efedad=failed`; PID 75365 dead; 2.631 s; E                                                                                     |
| capacity flood  | PARTIAL | Exit 1; `34af3c=failed`; PID 75501 dead; 2.639 s; E                                                                                     |
| give-up         | PARTIAL | Exit 1; `b8f42a=failed`; PID 75578 dead; 2.634 s; E                                                                                     |
| cascade         | PARTIAL | Detached launch exit 0, terminal `wait` exit 1; `70c2d9=failed`; PID 75603 dead; 3.022 s; E; no helper existed to stop alongside parent |
| send-to-running | PARTIAL | Exit 1; `f58057=failed`; PID 75744 dead; 2.654 s; E                                                                                     |
| steer-nested    | PARTIAL | Exit 1; `0acf97=failed`; PID 75790 dead; 2.626 s; E                                                                                     |
| wait-forever    | PARTIAL | Exit 1; `5bd5a7=failed`; PID 75948 dead; 2.629 s; E                                                                                     |
| kill caller     | PARTIAL | Exit 1; `cb11a5=failed`; PID 75988 dead; 2.604 s; E; no helper existed to trigger outer SIGKILL                                         |

**E**, representative truncated parent CLI error text:

```text
Command codex exited with code 1: stdout:

stderr:
WARNING: proceeding, even though we could not create PATH aliases:
Operation not permitted (os error 1)
Reading additional input from stdin...
Error: failed to initialize in-process app-server client:
Operation not permitted (os error 1)
```

There was no final model answer in any scenario. The cascade `wait` error also includes E; its `parentResult` field says `No parent result`, accurately reflecting the absent answer. All other `parentResult` fields contain the truncated CLI error. Foreground parent exit codes are the actual outer CLI exits. A detached harness's raw exit code is not persisted by smart-router; cascade records the terminal wait exit instead.

For every scenario: no self/ancestor refusal, capacity response, or timeout response appeared; model recovery was not exercised. `sessions --all` recorded exactly the one failed parent listed above, both before and after cleanup. Signal-0 probes found every recorded harness PID dead. `pgrep` failed with `Cannot get process list` / missing sysmond service, and `ps` was denied with `EPERM`; unrecorded descendants therefore could **not** be independently ruled out. Cleanup checks found no recorded live process requiring `stop` or `kill`. The runner's first attempt encountered the same `ps` denial as a spawn exception; the runner was corrected to record that denial, then the full suite completed.

**Confirmed bugs found:** none. The live run did not reach the relevant behaviors. The following ranked source findings are unverified hypotheses for an unrestricted rerun, not claimed live reproductions:

1. **High: resumed helpers inherit their caller's delegation identity.** [src/cli.ts:727](../../src/cli.ts#L727) passes `process.env` directly to a resumed harness. Spawn constructs a child-specific handle, depth, and ancestor chain, whereas send does not. Codex steer reaches this send path at [src/cli.ts:801](../../src/cli.ts#L801). A depth-2 helper resumed by its depth-1 parent can receive the parent's handle and depth, potentially weakening depth and self/ancestor checks. **Exact reproduction to verify:** within one fresh state directory, spawn a depth-1 parent; have it spawn a detached Luna helper at depth 2 and wait for completion; have the parent `send` that helper the message `Print SMART_ROUTER_HANDLE, SMART_ROUTER_DEPTH, and SMART_ROUTER_ANCESTORS from your shell, then stop.` Compare those values to the helper's session handle/depth. Repeat through Codex steer while the helper is running. **Suggested fix:** reuse child-environment construction for spawn and resume, storing enough ancestry metadata to reconstruct the resumed session's identity independently of the caller.

2. **High if stopping a parent is intended to cancel its work: detached descendants are outside orphan cleanup.** [src/sessions.ts:319](../../src/sessions.ts#L319) detects only a dead foreground wrapper. Detached sessions have no wrapper PID, and [src/sessions.ts:448](../../src/sessions.ts#L448) stops only the specified session. There is no persisted parent-handle relationship or traversal. This is consistent with the spec's detached-session exemption, so it needs a product decision before being labeled a defect. **Exact reproduction to verify:** `bun evals/robustness/run.mjs cascade kill-caller`; in each case wait for a depth-2 detached helper, stop the detached parent or SIGKILL its foreground wrapper, then inspect pre-cleanup sessions and recorded processes. **Suggested fix if cancellation is required:** persist `parentHandle`, stop descendants when explicitly stopping a parent, and sweep descendants after a foreground caller dies; retain intentional top-level detached independence.

3. **Medium: explicit stop marks stopped before proving termination.** [src/sessions.ts:448](../../src/sessions.ts#L448) sends one SIGTERM to one PID and immediately saves `stopped`; it does not use the identity check and grace-period/SIGKILL logic in [src/sessions.ts:428](../../src/sessions.ts#L428). It also does not stop process groups. Stopped sessions are skipped by the sweep at [src/sessions.ts:313](../../src/sessions.ts#L313), so a survivor may remain invisible to running-session accounting. **Exact reproduction to verify:** `bun evals/robustness/run.mjs give-up cascade kill-caller`; compare stopped sessions against recorded harness PIDs and descendants before cleanup. These real-harness scenarios may not produce a SIGTERM-resistant process, so absence of a survivor would not prove escalation behavior. **Suggested fix:** use the existing tracked-PID termination path for explicit stop and define how harness subprocesses should be terminated before publishing a terminal status.

The capacity implementation counts all running sessions sharing `owner`, including the parent ([src/cli.ts:226](../../src/cli.ts#L226)). With this config, a running parent leaves four helper slots, not five. The flood scenario intentionally records the actual accepted/refused count; this is documented ownership behavior, not a confirmed cap bug.

Rerun from a terminal/session with permission to initialize Codex and inspect processes:

```sh
bun evals/robustness/run.mjs --check
bun evals/robustness/run.mjs
# Optional individual scenarios:
bun evals/robustness/run.mjs cascade kill-caller
```

The runner enforces a 45-minute admission budget, uses per-scenario deadlines, records skipped scenarios when insufficient time remains, and captures sessions/processes before and after cleanup. Its successful execution paths remain unverified because models did not start. It conservatively leaves successful launches as PARTIAL pending review of the model's actual actions; exit 0 alone cannot establish robustness.

Evidence: [aggregate results](runs/2026-10-11T14-30-40.434Z/results.json) plus one JSON per scenario in that directory. JSON includes launch stdout/stderr, parent result text and exit, session snapshots, recorded PID probes, inspection failures, intervention/cleanup actions, and wall time. The temporary state directories are retained for inspection. The runner and eleven prompt files are standalone; nothing was added to `bun test` or CI. Prompt self-check and scoped Prettier formatting passed. Bun subprocess API usage was checked against the [official Bun documentation](https://bun.sh/docs/runtime/child-process); Context7 was not available in this session.
