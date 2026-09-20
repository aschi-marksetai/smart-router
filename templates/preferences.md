# Routing preferences

These are my standing preferences for which model runs which kind of task. Pick the candidate that best matches them.

## Glossary

Terms I use when describing work; apply the same definitions when routing tasks or judging output.

- **intelligence** — how hard a problem a model can handle unsupervised
- **taste** — UI/UX, code quality, API design, copy
- **bulk mechanical work** — clear-spec implementation, migrations, data analysis, log digging, reading giant PDFs/specs
- **bounded implementation** — a well-specified change with clear success criteria, suitable to hand to a delegate on a worktree

Add to this glossary whenever a term of mine gets misread.

## Claude Code: Model Routing

When Claude/Fable is primary, it is a **coordinator, not a worker**. Its scarce resource is context: every file read, every grep dump, every tool result that lands in the parent transcript is billed against the tightest allowance I have. Delegation is not primarily about who is smart enough — it is about keeping bulk tokens _out of the parent_.

Every task starts at the cheapest rung of the ladder below and climbs only as far as it must. The question is never "is this big enough to offload?" but "what, specifically, can the cheaper rung not do?" **Work I do in my own context is the most expensive option on the board — always, no exceptions.** My Codex sub usage is extremely generous; treat it as effectively free relative to Claude usage. This is standing permission — never wait for me to ask.

Scores are user-specific routing priors out of 100, rounded to five-point increments. Intelligence mechanically rescales each model's best demonstrated Artificial Analysis Intelligence Index against the current leader; it is relative, not an absolute percentage. Taste synthesizes a large review of independent developer anecdotes. Subscription fit reflects useful work per binding subscription allowance, including retries and rework, not API prices. Differences under 10 points are not meaningful.

| Model         | Subscription fit | Intelligence | Taste |
| ------------- | ---------------- | ------------ | ----- |
| GPT-6 Astra   | TBD              | TBD          | TBD   |
| GPT-5.6 Sol   | 90               | 95           | 65    |
| GPT-5.6 Terra | 100              | 90           | 65    |
| GPT-5.6 Luna  | 100              | 85           | 50    |
| Fable 5       | 20               | 100*         | 95    |
| Opus 5        | 65               | 100          | 90    |
| Sonnet 5      | 60               | 85           | 75    |
| Haiku 4.5     | 25               | 50           | 60    |

`*` Fable's Intelligence score uses Artificial Analysis's fallback-assisted result. Terra and Luna Taste scores are lower-confidence family extrapolations because direct independent anecdotes were sparse.

Astra's scores are unrated pending comparable benchmark evidence and firsthand subscription/taste results; the existing scores have not been rescaled for Astra.

Skip Haiku entirely — Luna owns the cheap tier now. Luna is agent-called only (bulk data processing, classification, extraction, titles/branch naming, simple text outputs); never pick it as a primary model.

Model characters:

- **Astra** (`gpt-6-astra`): OpenAI's most capable model for demanding reasoning, coding, computer use, research, and document work ([official model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)). Escalate to it when Sol misses the bar; keep Fable/Opus responsible for user-facing design direction until Astra's taste is evaluated.
- **Sol** (flagship): relentless; strong computer use, though Astra beats it there; good at decomposing work for subagents; strong compaction on long runs. Downsides: overbuilds (a 5-line fix becomes a 300-line rewrite plus unneeded tests), works around blockers rather than stopping, defends wrong beliefs and rabbit-holes on them.
- **Terra** (balanced): near-Fable coding with far less subscription-quota pressure; stops and checks in more readily (good for interactive work); less prone to overbuilding. The budget workhorse.
- **Luna** (cheap): capable tool-caller with negligible marginal quota pressure; covers every Haiku/Gemini-Flash-tier use case.

Defaults, not limits — standing permission to override: if a cheaper model's output misses the bar, redo it on a smarter model without asking. Judge the output, not the price tag. Use cheap models to scout and experiment before moving work to expensive ones.

The cost ladder — climb from the bottom, stop at the first rung that holds:

1. **Luna** — mechanical, well-specified, low-judgment work: classification, extraction, naming, summarizing, an edit from an exact spec, running a command and reporting what it printed.
2. **Terra** — bounded implementation with clear success criteria, bulk mechanical work, fast review passes, most investigation. Raise Terra to xhigh/max _before_ leaving this rung; that jump is real and still cheaper than Sol.
3. **Sol**, then **Astra** if Sol misses the bar — long unsupervised runs (>10 min), genuinely hard decomposition, deep review. Computer use skips Sol and enters at Astra.
4. **A native Claude subagent** (Sonnet, then Opus) — work that needs Claude-side tooling, Claude taste, or a second opinion from a different family.
5. **Me, in the parent.** The most expensive rung there is. Reaching it needs its own explicit reason, same as every other step up.

Climbing a rung requires naming the concrete capability the rung below lacks — "Luna cannot judge design direction", "Terra has no browser", "this needs the whole conversation". "This matters", "I want it done well", and "it'll be faster if I do it" are not reasons; every task matters, and my quota is what pays for speed. If I cannot name what the lower rung lacks, the lower rung gets the work.

Prefer failing cheap to guessing expensive. A Luna or Terra attempt that misses the bar costs almost nothing and proves which rung was actually needed; entering at Sol "to be safe" spends that quota whether it was required or not. Judge the output, not the price tag — redo it a rung up without asking.

Rung 5 is not a fallback for "it's easier if I just do it". It is reserved for final synthesis, user-facing design direction, ambiguous product or architectural decisions, judging conflicting findings, pruning overbuilt output, and decisions that need the whole conversation. That is the whole list. Everything else has a rung beneath it.

The one carve-out: work whose _input and output are both small_ — a targeted edit to a file already in context, a single known-path lookup, a one-line `git status`, a decision, a reply. Spawning costs more than doing it. Judge by expected output volume in the parent, not by task difficulty.

These fire automatically and enter at rung 1 or 2 — deliberating about whether to delegate them is itself the mistake:

- **Reading more than ~2 files** to answer something → `Explore` subagent or `codex exec`. Take the conclusion, not the file dumps.
- The exception: whoever makes an edit reads the real file, never a summary of it — summaries drop line numbers and exact text. Delegate the reading behind a decision; never the reading behind an edit. When the edit itself is delegated, hand over paths, not digests.
- **Any search sweep** (grep/glob across a repo, "where is X used", "find all Y") → subagent. Never let raw search output land in the parent.
- **Any bounded implementation with clear success criteria** → Codex. Fable reviews the diff; it does not type it.
- **Any verification** — running tests, reproducing a bug, checking a build, confirming a fix → subagent reports pass/fail plus the failing output only.
- **Any log, dump, PDF, dataset or spec over a screenful** → subagent extracts, parent reads the extract.
- **Anything expected to take more than a few tool calls** → decompose and fan out rather than grinding serially in the parent.

Run delegations in parallel wherever they are independent — several subagents in one message, not a queue. Parallel work is close to free for me and each one keeps its output out of the parent.

- A generic native Claude Code `Agent` subagent is not an OpenAI delegation, but it _is_ still a context win: it keeps tool output out of the parent. Use native subagents freely for search and reading; use Codex when the work needs an independent model or a sandbox. Invoke `codex:codex-rescue`, an installed Codex plugin command, or a bounded `codex exec`. Choose the model and effort autonomously; do not ask me to select them.
- Do not narrate the delegation or ask permission for it. Spawn, wait, report the conclusion.

Routing rules:

- Escalation beyond Sol → Astra on medium/high when Sol's result misses the bar. Give it explicit success criteria, a stopping point, and the same minimal-diff requirements.
- Long or hard autonomous tasks (anything expected to run unsupervised >10 min) → Sol on high.
- Bulk mechanical work → Luna first; Terra on medium when Luna misses; Sol only after Terra at xhigh has missed.
- Two-stage split when quality matters: Sol investigates and writes the spec → Terra implements it (less overbuilding on the code that lands).
- Independent code review of a diff/branch/commit → Terra for the fast pass; Sol for a deep review only when the fast pass shows the diff warrants it. Fable/Opus judges the findings before acting on them.
- Anything user-facing (UI, copy, API/SDK design) requires the top Taste tier → Fable or Opus. The 5.6 family generally has weaker user-facing taste without strong direction — never let it pick the design direction.
- Computer-use / browser / simulator / screenshot verification → Astra, not Sol. Astra is materially better here, so this work enters at Astra rather than escalating to it.
- Anything needing a logged-in session goes through Codex's built-in browser — the bundled `browser`/`chrome` plugins — never the Playwright MCP or another spawned instance. Only the built-in browser carries the existing logins; a spawned one starts logged out and cannot get there.
- In-workflow cheap stages (classification, extraction, naming, summarizing) → Luna via a shim subagent.
- Token-heavy investigation, broad repo reading, long-context digestion → Luna via `codex exec -s read-only`, escalating to Terra if it misses. Size is not difficulty; route by how hard the reasoning is, and let the rung keep the tokens out of the parent either way.
- Never route to a model I already pay a subscription for through OpenRouter. Codex and Claude models come from their own subscriptions; paying per token for flat-rate capacity is strictly worse.

OpenRouter confidentiality rule (hard, no exceptions):

- **Never route AWM or Grainger work through OpenRouter.** Not the code, not the logs, not the configs, not error messages, not infrastructure details, not a paraphrase of the problem. This covers every OpenRouter model; providers reached that way retain prompts, and stealth ones are undisclosed.
- Treat it as AWM/Grainger work if it touches those repos, their infrastructure (`*.awmfric.com`, `*.awm.tech`, the Teleport clusters, OpenBao, the Proxmox estate), their data, their customers, or anything I am doing under either name. When unsure whether something qualifies, it qualifies.
- For that work use the subscription models only — Claude, or the GPT-5.6 family and GPT-6 Astra through Codex — which run under agreements that already cover it.
- This is a contractual boundary, not a preference. Do not weigh it against convenience or token cost, and do not ask me to make an exception for a specific task.

Codex effort: default medium/high. Above high, Sol buys tiny gains for 2–3× the quota consumption; Terra's xhigh/max jump IS meaningful — raise Terra's effort before switching to Sol. Never default to ultra or fast mode; either can burn a weekly usage window in hours.

Sol delegation guardrails:

- Always give Sol explicit success criteria AND a stopping point; without one it keeps going indefinitely.
- Say explicitly: minimal diff, no tests beyond what was asked. Have a Claude model prune the output if it overbuilt anyway.
- Cap the scope numerically — files touched and net lines — alongside the stopping point. Sol overbuilds through the minimal-diff instruction; a number is the form that holds.
- If Sol digs in on a claim you doubt, don't argue with it — pull the work back to Fable.
- Prefer worktrees/sandboxes for autonomous Sol runs: when blocked, it works around obstacles (including permission boundaries) rather than stopping.
- 5.6's safety layer blocks benign work ~10× more than 5.5; if a task gets refused, retry it on Terra before rewording.

When a GPT-5.6 model or GPT-6 Astra is the PRIMARY agent (claudex sessions — Claude Code harness
running an OpenAI model via the local proxy — or any direct Codex session):

- Proactively spawn 1-3 subagents when a nontrivial task clearly benefits from parallel investigation, independent verification, or separated workstreams.
- Do not spawn subagents for simple or tightly bounded work.
- Ask before spawning additional agents beyond the initial set of at most 3.
  (Known Codex bug: subagents inherit the parent's model AND effort — an eager
  Sol spawning Sol-effort agents burns a usage window fast. This restraint rule
  does not apply to Claude/Fable sessions, which manage their own delegation.)

Mechanics:

- From a native Claude/Fable session, reach the 5.6 family and Astra through the Codex CLI or plugin; a generic `Agent` call stays on a Claude model. The parent agent chooses the model and effort without asking: use the cheapest combination likely to meet the bar, then escalate if its output misses. Model flag: `-m gpt-6-astra` / `-m gpt-5.6-sol` / `-m gpt-5.6-terra` / `-m gpt-5.6-luna`. Effort: `-c model_reasoning_effort="medium"` (low|medium|high|xhigh|max|ultra). Pass the selected values to the delegate as runtime controls rather than relying on ambient defaults.
- In a claudex session, `CLAUDE_CODE_SUBAGENT_MODEL=opus` plus `ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-5.6-sol` forces spawned Claude Code `Agent` subagents onto Sol while keeping persisted session metadata on a Claude-recognized alias; that setting chooses the model but does not itself cause an agent to be spawned.
- Prefer the installed codex plugin commands (`/codex:review`, `/codex:adversarial-review`, codex rescue) where they fit; for uncovered investigation or analysis, run `codex exec -s read-only -m <model> "<self-contained prompt>"` directly — add `--skip-git-repo-check` outside a git repo, and redirect stdin (`</dev/null`) when scripting so it doesn't hang waiting for input. `codex review` runs a non-interactive code review.
- Prompt Codex simply. It is not Claude: short, direct, self-contained prompts; no guardrail prose.
- Name the file a delegate should match ("follow `src/foo.ts`") rather than saying to match the codebase. A cheap model copies a named reference well and infers house style badly.
- Instruct Codex: if it finds nothing, say so explicitly and name the target it inspected — this prevents the parent from assuming failure and re-running.
- For Astra, use the same `codex exec` shim as the 5.6 models when a workflow cannot select it directly. Spawn a low-effort Claude subagent that runs the command and reports the results back.
- Prefix labels of subagents/workflow stages that delegate to Codex with `[astra]`, `[sol]`, `[terra]`, `[luna]`, or `[ox]` so delegated work is visible at a glance.
- Codex subagent defaults live in `~/.codex/config.toml` under `[agents]` (`default_subagent_model`, `default_subagent_reasoning_effort`). Unset, a spawned agent falls to the catalog default for its model. They are set cheap; pass anything higher explicitly per delegation.
- `spawn_agent` returning is not the child finishing. Wait for its terminal result before acting on what it produced.
- Codex skills are invoked as `$skill-name`, never `/skill-name`.
- Codex calls can time out — keep delegated prompts bounded and self-contained; split long work into pieces.
