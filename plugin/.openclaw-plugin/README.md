# Rembric — Native OpenClaw plugin

Self-hosted memory, sessions, and dashboard for AI coding agents. Native OpenClaw memory provider (`kind: "memory"`).

## Install

OpenClaw's `git:` install expects the manifest at the repo root; since this plugin lives at `plugin/.openclaw-plugin/` inside the shared rembric `plugin/` tree, use the `path:` install after a clone:

```sh
git clone https://github.com/susomejias/rembric.git /tmp/rembric
openclaw plugins install path:/tmp/rembric/plugin/.openclaw-plugin
```

For iterative development (symlinks the directory so edits show up without reinstall): `openclaw plugins install --link /tmp/rembric/plugin/.openclaw-plugin`.

Then designate Rembric as your active memory provider in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "slots": { "memory": "rembric" },
    "entries": {
      "rembric": {
        "enabled": true,
        "config": {
          "server_url": "https://memory.example.com",
          "api_token": "rbr_...",
          "autoRecall": true,
          "autoCapture": false,
          "tokenBudget": 1800,
          "project_slug": "my-project",
        },
      },
    },
  },
}
```

Restart OpenClaw. Run `/rembric status` inside an OpenClaw session to verify slot ownership and config.

## What the plugin does

- **Claims OpenClaw's memory slot** (`registerMemoryCapability`) — one active memory plugin per OpenClaw instance; collisions are logged at register time.
- **Auto-recall** (`registerMemoryPromptSection`, gated on `autoRecall`) — calls `memory.search` against the current prompt on every turn and prepends the result up to `tokenBudget` tokens.
- **17 memory tools** (`api.registerTool × 17`) — full `memory_*` and `project_*` surface, mirroring Rembric's MCP tools but consumed natively by OpenClaw (no separate `mcpServers` config required).
- **Session lifecycle hooks** — `session_start` / `session_end` / `before_compaction` / `after_compaction` POST to Rembric's `/api/<slug>/sessions(*)` HTTP API. Session ids appear in `/dashboard/sessions` with `agent=openclaw`.
- **Interactive matcher** — phrases matching `remember|recall|acordate|qué hicimos|what did we do` trigger an explicit memory search.
- **`/rembric status` slash command** — operator visibility into server URL, masked token, and slot ownership.

## Architecture

| File                    | Role                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `openclaw.plugin.json`  | Native manifest (`kind: memory`, configSchema, uiHints, secret hint)   |
| `package.json`          | Declares `openclaw.extensions: ["./plugin.mjs"]`, no deps              |
| `plugin.mjs`            | Entry: `definePluginEntry`-style default export with `register(api)`   |
| `mcp-client.mjs`        | Hand-rolled MCP JSON-RPC client over Streamable HTTP                   |
| `http-client.mjs`       | Rembric `/api/<slug>/sessions(*)` HTTP client + `.rembric` slug parser |
| `tools.mjs`             | 17 `api.registerTool` wrappers forwarding to MCP                       |
| `hooks.mjs`             | Session lifecycle hooks                                                |
| `memory-capability.mjs` | Memory slot + prompt section + interactive matcher                     |
| `commands.mjs`          | `/rembric status` slash command                                        |

Plain ESM JavaScript, no TypeScript, no build step. The OpenClaw plugin SDK (`@openclaw/plugin-sdk`) is `workspace:*` upstream and not installable as an npm package outside the OpenClaw monorepo, so the third-party path is hand-authored ESM. Rationale documented in the `add-openclaw-plugin/design.md` change archive.

## Update

```sh
openclaw plugins update rembric
```

The plugin's `version` is bumped in lock-step with the Claude Code, Codex CLI, and Hermes Agent manifests on every plugin release (see `../CHANGELOG.md`).

## See also

- Full install + troubleshooting docs: [`docs/agents.md::OpenClaw`](../../docs/agents.md#openclaw-native-memory-provider-plugin)
- Rembric server install: [`docs/docker.md`](../../docs/docker.md)
- Plugin development conventions: [`CLAUDE.md::Plugin development discipline`](../../CLAUDE.md)
