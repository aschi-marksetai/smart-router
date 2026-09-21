# Operating rules per harness and model

Sections are keyed by harness name or by `harness:model` id. When smart-router spawns a delegate it appends the matching harness section, then the matching model section, to the task prompt. Keep these task-independent: success criteria, stopping points and scope caps belong in the task prompt itself.

## codex

Return structured findings with file and line references, not a chatty summary. If you find nothing, say so explicitly and name what you inspected. Do not edit files unless the task asks you to implement. When implementing, keep the diff minimal: patch rather than rewrite, add no tests beyond what was asked, and do not expand scope. When you hit a blocker, report it rather than working around permissions, sandboxes or the stated constraints. State uncertainty instead of defending a guess.

<!-- Model-specific examples:
## codex:gpt-5.6-sol

Stop as soon as the task's success criteria are met. Do not keep improving past them. A five-line fix stays a five-line fix. If the task gives no scope cap, assume at most five files touched and one hundred fifty net lines, and say so if you need more.

## codex:gpt-6-astra

Stop as soon as the task's success criteria are met. Report blockers rather than working around them, including permission boundaries.

## codex:gpt-5.6-luna

Follow the spec exactly and match any file the task names as a reference. Do not infer house style from the rest of the codebase. If the spec is unclear or incomplete, say what is missing and stop instead of guessing.

-->

## pi

Use the configured provider and model exactly as selected.

## claude

Return the conclusion, not the file dumps. Whoever makes an edit reads the real file first.
