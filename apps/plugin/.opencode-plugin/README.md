# Rembric plugin for opencode

Memory + session lifecycle for [opencode](https://opencode.ai), backed by a self-hosted Rembric server.

This plugin shares the same HTTP API and MCP bridge as the Claude Code, Codex CLI, and Hermes Agent plugins. Per-project path-scoping uses the same `.rembric` convention. Its config hook upgrades legacy launcher entries in memory to the pinned bridge package.

**Scope**: the plugin handles session lifecycle and compaction signals via the `event` dispatcher (`session.created`, `session.deleted`, `session.compacted`, `server.instance.disposed`), accumulates transcripts via `chat.message` and `message.updated`, flushes summaries on `session.idle` (per-turn debounced) and `session.compacted` (compaction milestone), and injects post-compaction guidance via `experimental.session.compacting`. The `chat.message` handler also appends a recall nudge to `output.parts` when the user prompt matches the cross-client recall regex (`remember|recall|acuérdate|qué hicimos|what did we do`), for paridad with the Claude Code / Codex CLI `UserPromptSubmit` hook.

## Install

Use the **TUI installer** — the single recommended path. It runs both manual steps below for you (and handles update/uninstall):

```bash
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/install.sh | sh
# → Plugins → opencode → install
```

### Manual install

Two steps. Run them in order.

#### 1. Run the install script

One-line install — no checkout required:

```bash
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
```

The script fetches the plugin and shared modules from the rembric `main` branch and drops them in place:

- `plugin.ts` → `~/.config/opencode/plugins/rembric.ts` (with shared-module imports patched to their absolute installed paths before writing).
- `rembric-dotenv.mjs` → `~/.config/rembric/bin/rembric-dotenv.mjs` (single source of truth for slug parsing).
- `rembric-plugin-core.mjs` → `~/.config/rembric/bin/rembric-plugin-core.mjs`.

The printed MCP block invokes the exact pinned package. Existing `opencode.json` files are never edited; the config hook upgrades legacy launcher entries in memory. Idempotent — re-run any time to upgrade.

Inspect before running with `curl … | less`. Developers iterating locally:

```bash
PLUGIN_SRC="$(pwd)/apps/plugin/.opencode-plugin" \
BIN_SRC="$(pwd)/apps/plugin/bin" \
MCP_BRIDGE_SRC="$(pwd)/apps/plugin/mcp-bridge" \
  sh apps/plugin/.opencode-plugin/install.sh
```

#### 2. Paste the MCP block into `opencode.json`

The install script prints a snippet at the end. Paste it into one of:

- **Global** (recommended): `~/.config/opencode/opencode.json`
- **Per project**: `./opencode.json` at the repo root

Then edit the two placeholders:

- `<REMBRIC_SERVER_URL>` — your Rembric base URL, e.g. `http://127.0.0.1:8787` (no trailing `/mcp`).
- `<REMBRIC_API_TOKEN>` — bearer token issued from `/dashboard/tokens` (plaintext shown exactly once).

Restart opencode.

## Per-project path-scoping

Drop a `.rembric` file at each repo root:

```
PROJECT_SLUG=my-app
```

The bridge subprocess reads this file at spawn time and connects to `/mcp/my-app` automatically. The same convention is used by every client Rembric ships a plugin for — one file, all clients.

Without `.rembric`, the plugin no-ops cleanly: lifecycle POSTs are skipped, the MCP bridge falls back to path-less `/mcp`, and the agent still works — that connection resolves to the server's default project.

The slug regex is `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Invalid slugs are rejected silently with a stderr diagnostic.

## Verify

1. Open opencode in a repo with a valid `.rembric`.
2. Send a message that triggers an MCP-tool call (e.g. "search rembric memory for recent decisions").
3. Open the Rembric dashboard at `/dashboard/sessions`. A new row with `agent='opencode'` should appear.
4. opencode's debug log (path varies by version) should contain one `[rembric] session.created id=…` line per session.

## Update

Use the TUI installer (`Plugins → opencode → update`). Manual fallback — opencode does not cache plugins by version, so re-run the curl-pipe-sh command above; it fetches the latest files from `main` and overwrites the installed files. Restart opencode.

For a temporary rollback after a broken release, see the [emergency plugin rollback](../../../docs/agents.md#emergency-plugin-rollback) runbook.

## Uninstall

Use the TUI installer (`Plugins → opencode → uninstall`). Manual fallback:

```bash
bash plugin/.opencode-plugin/uninstall.sh
```

Removes the plugin and shared module files. It does **not** touch `opencode.json` or legacy launcher files — remove the `mcp.rembric` block manually if you want it gone.

## Troubleshooting

- **Sessions don't appear in the dashboard.** Most likely cause: missing or invalid `.rembric`. Check stderr in opencode's debug log for `[rembric] no project slug for session …`. Add a valid `.rembric` to the repo root.
- **opencode reports an MCP connection error.** Confirm `mcp.rembric.command` is `['npx', '-y', '@rembric/mcp-bridge@<exact-version>']` and that the environment placeholders are filled. Existing launcher entries are replaced in memory by the installed plugin's config hook.
- **Session never transitions to `'ended'`.** Expected. opencode has no `SessionEnd` event; closure relies on the agent calling `memory.session_summary` voluntarily, or the server's `abandonStale` flipping inactive rows. opencode is now the only client in this state — Codex CLI does have `SessionEnd` and reaches `ended` on a normal close.
- **Tested with**: opencode CLI ≥ 1.15.5. If you run an older opencode, the event handler API may not match — the plugin will fail to load and opencode will log a TypeScript error.

## Files this plugin owns

```
~/.config/opencode/plugins/rembric.ts        ← session lifecycle + post-compact reminder (JS)
~/.config/rembric/bin/rembric-{dotenv,plugin-core}.mjs ← shared modules
~/.config/opencode/opencode.json             ← MCP block (user-edited)
<repo>/.rembric                              ← per-project slug (user-created)
```

opencode.json and `.rembric` files are user-owned. The install/uninstall scripts never edit them.
