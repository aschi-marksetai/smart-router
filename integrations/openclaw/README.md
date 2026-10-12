# OpenClaw smart-router plugin

This plugin exposes `smart-router/auto` as an OpenClaw CLI backend. It passes prompts to `smart-router spawn`, resumes with `smart-router send`, and translates JSONL events. smart-router owns routing, sessions, harness execution, and cancellation through its foreground signal handling.

Install smart-router **0.7.0+** and log in to Claude or Codex on the **OpenClaw host**. Run `smart-router init` there. Use a configuration that routes to Claude or Codex: pi ignores the MCP bridge flags. The plugin uses OpenClaw's experimental SDK; local checks use **OpenClaw 2026.10.1** and the [reference source](https://github.com/openclaw/openclaw/tree/48b2ccd28567c3e5f554cde97752511642c4fbf0).

Every smart-router release attaches the packed plugin, versioned with smart-router. On the OpenClaw host:

```sh
base=https://github.com/aschi-marksetai/smart-router/releases/latest/download
curl -fsSLO "$base/openclaw-smart-router.tgz" && curl -fsSLO "$base/openclaw-smart-router.tgz.sha256"
sha256sum -c openclaw-smart-router.tgz.sha256 || shasum -a 256 -c openclaw-smart-router.tgz.sha256
openclaw plugins install ./openclaw-smart-router.tgz --force --accept-capabilities
openclaw plugins inspect smart-router --runtime --json
openclaw models list --all --provider smart-router --json
```

To build it from source instead: `cd integrations/openclaw && npm install --ignore-scripts && npm pack`, then install the resulting `.tgz` the same way. The package contains only the built entry, manifest, package metadata, and README. The model list should contain `smart-router/auto`. `--force` acknowledges the local source trust warning; `--accept-capabilities` consents to the declared CLI backend and provider. Review the source before installing it.

Use the tarball rather than linking this directory when its `node_modules/openclaw` is also the OpenClaw host. OpenClaw 2026.10.1 treats that host's bundled plugin rows as descendants of the linked install path, then rejects their different package ownership with `conflicting child rows`. The link is saved despite exit 1, and `models list --refresh` still fails with `Plugin entry is outside its captured source package`, even with the JavaScript entry. The packed install has no nested host and avoids both errors.

Merge this into your OpenClaw config, then restart the gateway:

```json
{
  "plugins": {
    "allow": ["smart-router"],
    "entries": {
      "smart-router": { "enabled": true, "config": {} }
    }
  },
  "agents": {
    "defaults": {
      "subagents": { "model": "smart-router/auto" },
      "models": {
        "smart-router/auto": { "agentRuntime": { "id": "smart-router" } }
      }
    }
  }
}
```

Preserve other entries in `plugins.allow`. The static manifest catalog makes `auto` discoverable without executing the plugin. The runtime provider reads the same catalog metadata and also pins `models.providers.smart-router.agentRuntime.id` and the `auto` model's `agentRuntime.id` to `smart-router`. Use model-scoped runtime keys, as documented in [runtime configuration](https://docs.openclaw.ai/plugins/sdk-agent-harness/runtime-config); whole-agent `agents.defaults.agentRuntime` is ignored.

Optional plugin config keys: `smartRouterBinary` selects the executable; `cwd` overrides the session workspace; `hint` and `confidential` pass to spawn; positive integer `resultLimit` bounds returned text on spawn and send. Otherwise OpenClaw supplies the workspace at execution time, and smart-router preserves it for resume.

OpenClaw supplies the tools allowed by its **subagent policy** through a per-attempt loopback MCP server. Its [CLI backend bridge](https://docs.openclaw.ai/plugins/cli-backend-plugins) injects `--strict-mcp-config --mcp-config <file>` on spawn and resume, plus `OPENCLAW_MCP_TOKEN` and `OPENCLAW_MCP_CLI_CAPTURE_KEY`. smart-router references those environment variables when it launches Claude or Codex. The plugin does not copy credentials or construct an MCP server.

Limitations: OpenClaw cannot steer a running delegate through this adapter. Native Claude and Codex coding tools execute outside OpenClaw policy; displayed native tool events do not prove host tool execution. Exact restricted-tool runs fail closed because native tools are declared always on. The selected harness and model stay fixed for each subagent session. The catalog's 128k context, 16k output, and zero prices are display metadata; smart-router and the selected harness determine actual limits and usage. Input is text only.

Development checks:

```sh
cd integrations/openclaw
npm install --ignore-scripts
bun run build
bun run test
bun run typecheck
```

The two fixtures are unedited stdout from real `smart-router spawn --events --model codex:gpt-6-luna --effort low --cwd /tmp` runs. `reply.jsonl` uses `Reply with the single word done. Done when replied; stop there.`; `tool.jsonl` uses `Use your shell tool to run printf done, then reply with the single word done. Done when the tool ran and you replied; stop there.`

Scratch verification on 2026.10.1: the packed install exited 0; runtime inspection loaded the backend and provider; model listing returned `smart-router/auto` both before and after `--refresh` (exit 0). Refresh also warned that not all providers could refresh in the fresh, unauthenticated scratch environment. The linked install exited 1 with the ownership error; its non-refresh model list still returned `smart-router/auto` (exit 0).

The relevant OpenClaw rules are [manifest discovery and the entries-only path](https://github.com/openclaw/openclaw/blob/48b2ccd28567c3e5f554cde97752511642c4fbf0/src/plugins/provider-discovery.runtime.ts#L162), [package ownership checks](https://github.com/openclaw/openclaw/blob/48b2ccd28567c3e5f554cde97752511642c4fbf0/src/plugins/installed-plugin-package-ownership.ts#L171), and [captured entry lookup](https://github.com/openclaw/openclaw/blob/48b2ccd28567c3e5f554cde97752511642c4fbf0/src/plugins/plugin-generation-source-lookup.ts#L303).
