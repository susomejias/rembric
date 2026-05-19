# Rembric plugin for opencode

Memory + session lifecycle for [opencode](https://opencode.ai), backed by a self-hosted Rembric server.

This plugin shares the same HTTP API and MCP bridge as the Claude Code, Codex CLI, and Hermes Agent plugins. Per-project path-scoping uses the same `.rembric` convention.

**v1 scope**: the plugin registers two handlers — `session.created` / `session.deleted` (for session row creation + sub-agent filtering) and `experimental.session.compacting` (for the post-compact `memory.session_summary` reminder). Passive prompt and observation capture (`chat.message`, `tool.execute.after`) are not in v1 because the corresponding HTTP API endpoints (`/prompts/passive`, `/observations/passive`) do not exist yet; they will land in a follow-up change.

## Install

Two steps. Run them in order.

### 1. Run the install script

Clone (or `cd` into) the Rembric checkout, then:

```bash
bash plugin/.opencode-plugin/install.sh
```

The script:

- Copies `plugin.ts` → `~/.config/opencode/plugins/rembric.ts`.
- Copies the shared MCP bridge → `~/.config/rembric/bin/rembric-bridge.mjs`.
- Prints the MCP block you need for step 2.

The script is idempotent — re-run it any time to upgrade.

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

opencode does not cache plugins by version — re-run `bash plugin/.opencode-plugin/install.sh` from an updated checkout. The script overwrites the two installed files. Restart opencode.

## Uninstall

```bash
bash plugin/.opencode-plugin/uninstall.sh
```

Removes the plugin file and bridge file. Does **not** touch `opencode.json` — remove the `mcp.rembric` block manually if you want it gone.

## Troubleshooting

- **Sessions don't appear in the dashboard.** Most likely cause: missing or invalid `.rembric`. Check stderr in opencode's debug log for `[rembric] no project slug for session …`. Add a valid `.rembric` to the repo root.
- **opencode reports an MCP connection error.** Check the bridge can reach the server: `REMBRIC_SERVER_URL='http://...' REMBRIC_API_TOKEN='...' node ~/.config/rembric/bin/rembric-bridge.mjs` should print one diagnostic line and then connect via `mcp-remote`. If it exits 1 with a missing-env error, the placeholders in `opencode.json` weren't filled in.
- **`<private>...</private>` content leaks into Rembric.** The plugin redacts these tags before POSTing. If you see secrets in the dashboard's prompt list, file an issue — the redaction is a hard invariant.
- **Tested with**: opencode CLI ≥ 0.x.y (set by the operator after running the cwd spike, see `openspec/changes/add-opencode-plugin/tasks.md` task 0.1). If you run an older opencode, the event handler API may not match — the plugin will fail to load and opencode will log a TypeScript error.

## Files this plugin owns

```
~/.config/opencode/plugins/rembric.ts        ← lifecycle + passive capture (JS)
~/.config/rembric/bin/rembric-bridge.mjs     ← MCP stdio↔HTTP bridge
~/.config/opencode/opencode.json             ← MCP block (user-edited)
<repo>/.rembric                              ← per-project slug (user-created)
```

opencode.json and `.rembric` files are user-owned. The install/uninstall scripts never edit them.
