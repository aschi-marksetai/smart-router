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

Every prompt states what done looks like and where to stop, for example "Done when `bun test` passes and the endpoint returns paginated results; stop there, do not refactor callers." Some models are configured to refuse a prompt without one, and the refusal tells you to add it and call again. Task-independent operating rules for the chosen model are appended automatically from the user's guardrails file, so do not repeat those.

Optional flags:

- `--hint "<text>"` adds context for the routing decision, such as "needs a browser" or "bulk mechanical work".
- `--confidential` keeps the task off OpenRouter.
- `--model harness:model --effort <level>` skips routing and picks directly, for example `--model harness:model --effort level`.
- `--no-guardrails` skips the appended operating rules when the prompt already carries its own.
- `--result-limit <chars>` bounds returned result text while retaining the full result in the session.

## Continue

```sh
smart-router send <handle> "<follow-up message>"
```

Resumes the same session with its full context. Stdout is JSON with `result`.

## Long tasks

Use `smart-router spawn "<task>" --cwd <repo path> --detach` for work that should outlive this command. Then use `smart-router wait <handle>` or `smart-router status <handle>` and `smart-router logs <handle> --tail 50`; use `smart-router stop <handle>` to end it.

Use `smart-router sessions` to list your sessions (`--all` includes other owners), `rm <handle>` to remove one, or `prune --older-than <days>` for finished sessions.

## Inspect

`smart-router route "<prompt>"` shows the decision without running anything. `smart-router doctor` lists the harnesses and candidate models the router can see, and `smart-router quota` shows remaining subscription quota. If either reports no candidates, ask the user to run `smart-router init`.
