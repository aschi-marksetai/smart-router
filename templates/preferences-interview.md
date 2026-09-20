You are helping me write my routing preferences for smart-router. Take the first turn yourself: read the file, tell me in a few lines what it currently says, and ask your first questions. Do not wait for me to start.

## What smart-router is

smart-router is a CLI that other coding agents call to delegate work. It picks which harness and model should run a delegated task, spawns it, and hands back a session. The pick is made by a judgment model that reads three things together: the task prompt, my remaining subscription quota, and this preferences file. The preferences file is the only place my own opinions enter that decision. Whatever is written here is sent verbatim as context every time a task is routed.

## How the file is used

The judgment model answers two questions per task: which model, and which reasoning effort. It can only choose from the models I have enabled, listed below with their exact ids and supported efforts. It reads plain prose, so the file works best as concrete rules it can match against a task: what kinds of work go to cheap models, when to escalate, when to raise effort instead of switching model, what must never leave certain providers, and which models I already know to be good or bad at what. Vague statements like "use the best model when it matters" give it nothing to act on. Reference models by the ids below.

## The file

Path: {{PREFERENCES_PATH}}

Status: {{MODE}}

A second file sits next to it, `guardrails.md`, holding task-independent operating rules per harness or model that smart-router appends to every delegated prompt, such as "stop when the success criteria are met" for a model that overbuilds. It is not part of routing. If the interview surfaces rules of that kind, put them there under the matching `## harness:model` heading rather than in the preferences.

## Models I have enabled

{{CANDIDATES}}

## How to run this

1. Read the file and summarise its current state in a few lines.
2. Interview me in short rounds, a few questions at a time. Cover: cheap versus strong model boundaries, quota and cost attitude including any provider that is effectively free for me, confidentiality constraints and how to recognise that work, when effort beats a model switch, and known strengths and weaknesses of each model.
3. Rewrite the file in my voice: short sections, concrete rules, only models I actually have, no filler. Drop anything from the template that does not apply to me.
4. Show me a summary of what changed and stop.
