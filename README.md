# smart-router

smart-router routes coding-agent tasks to the best configured harness and model. It preserves a session handle so you can continue a delegate later. Preferences and guardrails stay under your control.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/aschi-marksetai/smart-router/main/scripts/install.sh | sh
```

Homebrew: `brew install aschi-marksetai/tap/smart-router`. Binaries are also on [GitHub Releases](https://github.com/aschi-marksetai/smart-router/releases).

## Updating

Homebrew users run `brew upgrade smart-router`. Other installs can run `smart-router update` (or `smart-router update --check` to only check). Route and spawn check once daily and print stderr notices for updates and newly available models; disable them with `updates.check: false` or `SMART_ROUTER_NO_UPDATE_CHECK`. Release automation pushes the regenerated formula to the tap over a deploy key stored as the `TAP_DEPLOY_KEY` repository secret.

## Quickstart

```sh
smart-router init
smart-router install-skill
smart-router spawn "implement the feature" --cwd "$PWD"
smart-router send <handle> "run the tests and fix failures"
```

| Command                   | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `init`                    | Configure harnesses, models, rules, and preferences |
| `install-skill`           | Install the Claude Code skill                       |
| `doctor`                  | Show installed harnesses and candidates             |
| `route <prompt>`          | Preview a routing decision                          |
| `spawn <prompt>`          | Delegate a task                                     |
| `send <handle> <message>` | Continue a session                                  |
| `quota`                   | Show subscription quota                             |

Config lives in `~/.config/smart-router` (override with `SMART_ROUTER_CONFIG_DIR`); sessions live in `~/.local/state/smart-router`.

## Development

```sh
bun link
bun test
bun run typecheck
bun run eval
bun run build
```

After a release, run `bun run formula v0.1.0 > ../homebrew-tap/Formula/smart-router.rb`.

The eval suite uses the maintainer's model ids and may need adapting for your setup.
