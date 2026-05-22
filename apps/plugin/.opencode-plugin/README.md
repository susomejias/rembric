# Rembric plugin for opencode

Memory + session lifecycle for [opencode](https://opencode.ai), backed by a self-hosted Rembric server.

This plugin shares the same HTTP API and MCP bridge as the Claude Code, Codex CLI, and Hermes Agent plugins. Per-project path-scoping uses the same `.rembric` convention.

**Scope**: the plugin handles session lifecycle and compaction signals via the `event` dispatcher (`session.created`, `session.deleted`, `session.compacted`, `server.instance.disposed`), accumulates transcripts via `chat.message` and `message.updated`, flushes summaries on `session.idle` (per-turn debounced) and `session.compacted` (compaction milestone), and injects post-compaction guidance via `experimental.session.compacting`. The `chat.message` handler also appends a recall nudge to `output.parts` when the user prompt matches the cross-client recall regex (`remember|recall|acordate|qué hicimos|what did we do`), for paridad with the Claude Code / Codex CLI `UserPromptSubmit` hook.

## Install

Two steps. Run them in order.

### 1. Run the install script

One-line install — no checkout required:

```bash
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh
```

The script fetches three files from the rembric `main` branch and drops them in place:

- `plugin.ts` → `~/.config/opencode/plugins/rembric.ts` (with the dotenv-lib import path patched to the absolute installed path before writing).
- `rembric-bridge.mjs` → `~/.config/rembric/bin/rembric-bridge.mjs` (the shared stdio↔HTTP MCP bridge).
- `rembric-dotenv.mjs` → `~/.config/rembric/bin/rembric-dotenv.mjs` (single source of truth for slug parsing; the bridge imports this).

Then prints the MCP block you paste in step 2. Idempotent — re-run any time to upgrade.

Inspect before running with `curl … | less`. Developers iterating locally:

```bash
PLUGIN_SRC="$(pwd)/plugin/.opencode-plugin" BIN_SRC="$(pwd)/plugin/bin" \
  sh plugin/.opencode-plugin/install.sh
```

### 2. Paste the MCP block into `opencode.json`

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

The bridge subprocess reads this file at spawn time and connects to `/mcp/my-app` automatically. The same convention is used by Claude Code, Codex CLI, and Hermes Agent — one file, all clients.

Without `.rembric`, the plugin no-ops cleanly: lifecycle POSTs are skipped, the MCP bridge falls back to global `/mcp`, the agent still works but operates user-wide.

The slug regex is `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Invalid slugs are rejected silently with a stderr diagnostic.

## Verify

1. Open opencode in a repo with a valid `.rembric`.
2. Send a message that triggers an MCP-tool call (e.g. "search rembric memory for recent decisions").
3. Open the Rembric dashboard at `/dashboard/sessions`. A new row with `agent='opencode'` should appear.
4. opencode's debug log (path varies by version) should contain one `[rembric] session.created id=…` line per session.

## Update

opencode does not cache plugins by version — re-run the curl-pipe-sh command above. The script fetches the latest files from `main` and overwrites the three installed files. Restart opencode.

## Uninstall

```bash
bash plugin/.opencode-plugin/uninstall.sh
```

Removes the plugin file and bridge file. Does **not** touch `opencode.json` — remove the `mcp.rembric` block manually if you want it gone.

## Troubleshooting

- **Sessions don't appear in the dashboard.** Most likely cause: missing or invalid `.rembric`. Check stderr in opencode's debug log for `[rembric] no project slug for session …`. Add a valid `.rembric` to the repo root.
- **opencode reports an MCP connection error.** Check the bridge can reach the server: `REMBRIC_SERVER_URL='http://...' REMBRIC_API_TOKEN='...' node ~/.config/rembric/bin/rembric-bridge.mjs` should print one diagnostic line and then connect via `mcp-remote`. If it exits 1 with a missing-env error, the placeholders in `opencode.json` weren't filled in.
- **Session never transitions to `'ended'`.** Expected. opencode has no `SessionEnd` event; closure relies on the agent calling `memory.session_summary` voluntarily, or the server's `abandonStale` flipping inactive rows. Same steady state as Codex CLI.
- **Tested with**: opencode CLI ≥ 1.15.5. If you run an older opencode, the event handler API may not match — the plugin will fail to load and opencode will log a TypeScript error.

## Files this plugin owns

```
~/.config/opencode/plugins/rembric.ts        ← session lifecycle + post-compact reminder (JS)
~/.config/rembric/bin/rembric-bridge.mjs     ← MCP stdio↔HTTP bridge
~/.config/opencode/opencode.json             ← MCP block (user-edited)
<repo>/.rembric                              ← per-project slug (user-created)
```

opencode.json and `.rembric` files are user-owned. The install/uninstall scripts never edit them.
