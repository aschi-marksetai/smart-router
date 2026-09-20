# smart-router

Routes coding-agent tasks to a configured harness and preserves session handles.

## Install

```sh
bun link
```

## Setup

```sh
smart-router init
```

`TYPESAFE_API_KEY` can also go in `~/.config/smart-router/.env`.

Agents use these commands:

```sh
smart-router spawn "<task>"
smart-router send <handle> "<message>"
```

Configuration is stored in `~/.config/smart-router/config.json`; routing preferences are in `~/.config/smart-router/preferences.md`.
