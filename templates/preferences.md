# Routing preferences

These are my standing preferences for which model runs which kind of delegated task. The router reads this file together with the task prompt, my remaining quota, and the list of models I have enabled, then picks one model and one reasoning effort. Concrete rules keyed to model ids work best; vague statements give it nothing to act on.

Replace every section below with your own rules, or run `smart-router init --section preferences` and let an interview write them for you.

## Models and what they are for

For each model you enabled, one or two lines: what it is good at, what it is bad at, and how expensive it is for you. Example shape:

- `harness:model` is my cheap workhorse for mechanical, well-specified work: renames, classification, extraction, running a command and reporting the output.
- `harness:model` is my default for bounded implementation with clear success criteria and for most investigation.
- `harness:model` is reserved for long unsupervised runs, hard decomposition, and deep review.
- `harness:model` owns anything user-facing: UI, copy, API design, and ambiguous product or architecture decisions.

## Cost ladder

Start at the cheapest model that could plausibly do the task and climb only when the cheaper one cannot. Say what counts as a reason to climb, for example needing a browser, needing a second model family, or a task expected to run unsupervised for more than ten minutes. Say whether raising reasoning effort on the same model should come before switching to a stronger one.

## Quota

How you weigh subscription quota against quality. Name any provider that is effectively free for you and any whose weekly window you want protected. The router sees current usage percentages and reset times alongside these rules.

## Confidentiality

Work that must never leave certain providers, and how to recognise it: repository names, hostnames, client names. Callers can also mark a task confidential explicitly.

## Known strengths and weaknesses

Anything you have learned about specific models: which one overbuilds, which one stops and checks in, which one defends wrong beliefs, which one has the best taste. These are the most useful lines in the file.
