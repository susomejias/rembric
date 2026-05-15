# Agent integration

For **Claude Code**, use the bundled plugin — see [`plugin/README.md`](../plugin/README.md). The rest of this doc is for everything else.

## Connection shape

Every MCP client uses the same two values:

```
URL:    http(s)://your-host:8787/mcp[/<project-slug>]
Header: Authorization: Bearer <agent-token>
```

- `/mcp` → global scope. The agent operates user-wide until it calls `project.use({slug})`.
- `/mcp/<slug>` → path-scoped. The agent is locked to that project; `scope=global` saves are rejected with `code: scope_locked`.

Mint per-agent tokens from the dashboard (`/dashboard/tokens`) or `rembric token create <name>`. Plaintext shown exactly once.

The MCP server emits a short `instructions` block at handshake teaching the proactive-save protocol (when to save, when to call `memory.judge`, when to call `memory.session_summary`). Clients that support `initialize.instructions` (Claude Code, Codex CLI) inject it into the system prompt. Other clients still get the same protocol via each tool's description.

## Validated configs

### Claude Code (plain JSON, if not using the plugin)

`~/.claude/mcp.json` or workspace `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "rembric": {
      "type": "http",
      "url": "https://memory.example.com/mcp/my-app",
      "headers": { "Authorization": "Bearer cc-token-XXXXXXXX" }
    }
  }
}
```

### Codex CLI (recommended: bundled plugin)

Use the Codex marketplace install — the plugin ships from the same `plugin/` directory as the Claude Code plugin (one source tree, two manifests):

```bash
codex plugin marketplace add https://github.com/susomejias/rembric.git
codex plugin install rembric
```

The marketplace `source` is `git-subdir` against `./plugin`, so Codex clones the repo subtree on install. Repo access (SSH key / PAT) gates discovery, exactly like the Claude Code plugin.

What the plugin registers for Codex:

- The same `rembric` MCP server (via `plugin/.mcp.json`) that Claude Code uses, invoking the bundled bridge at `${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs`.
- A four-hook subset (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`) sharing scripts with the Claude Code plugin via `${CLAUDE_PLUGIN_ROOT}/scripts/*.sh`. All hooks are `command`-type and POST to Rembric's `/api/<slug>/sessions(*)` HTTP API for session lifecycle — the agent never needs to call `memory.session_start`/`memory.session_summary`/`memory.session_end` manually; the hooks handle creation, summary-on-compact, and end-on-stop.

After install, drop a `.rembric` file at the root of each project to path-scope the slug automatically:

```bash
echo "PROJECT_SLUG=my-app" > .rembric
```

Without that file the bridge connects path-less (`/mcp`) and operates in global scope.

#### Credentials — REQUIRED: shell env vars

Codex does **not** have a `userConfig` keychain prompt like Claude Code, and Codex does **not** substitute `${user_config.*}` placeholders in plugin manifests (verified against `developers.openai.com/codex/plugins/build` and `/codex/hooks`). The plugin therefore reads its credentials from process env.

You **must** `export` the following in the shell that launches `codex`:

```bash
# in ~/.zshrc (or .bashrc, etc.) — required for the Codex plugin to work
export REMBRIC_SERVER_URL="https://memory.example.com"     # no trailing slash, no /mcp suffix
export REMBRIC_API_TOKEN="$(cat ~/.rembric/codex-token)"   # token from `rembric token create`
```

Then restart your terminal (or `source ~/.zshrc`) before launching `codex`. The same two envs feed:

- The **MCP bridge** (`plugin/mcp.json` reads them via env interpolation that does NOT require `${user_config.*}` — it inherits process env).
- The **lifecycle hooks** (`SessionStart`, `PreCompact`, `Stop`) so sessions appear in `/dashboard/sessions` and PreCompact persists a summary.

Symptoms of missing envs:

- `/dashboard/sessions` stays empty even when MCP tool calls work fine.
- `codex --debug` shows `[rembric-bridge] Missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN` (bridge) or `[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST /api/...` (hooks).

#### Using both Claude Code and Codex on the same machine

The two clients pick up credentials from different places — keep both configured:

| Client          | Where to put credentials                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | Install wizard (`/plugin install rembric@rembric`) → keychain. Hooks pick them up automatically via `${user_config.*}` substitution. **No shell exports required.** |
| **Codex CLI**   | `export REMBRIC_SERVER_URL=…` and `export REMBRIC_API_TOKEN=…` in your shell rc. Bridge and hooks both read process env. **No wizard exists.**                      |

If you only use one client, set up just that one. If you use both, you need both — the wizard input does NOT propagate to Codex's process, and the shell exports are NOT consumed by Claude Code's hooks (Claude Code substitutes from the keychain, not from `process.env`). Same Rembric server, same token, two configuration surfaces.

#### Updating the plugin

Codex caches plugins by `version` under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, so the cache invalidates when we bump `plugin/.codex-plugin/plugin.json`. Official commands (`developers.openai.com/codex/plugins`):

```shell
# refresh ALL configured marketplaces
codex plugin marketplace upgrade

# or refresh a specific one
codex plugin marketplace upgrade rembric
```

After the marketplace catalog refresh, Codex picks up the new version on the next plugin load. If Codex reports it's still on the cached version, fall back to a clean cycle from inside Codex's `/plugins` panel: select the plugin, **Uninstall plugin**, then **Install plugin** again (the docs do not yet expose a per-plugin `update` command — this is the supported alternative).

Restart `codex` after the update so the bridge and hooks re-spawn from the new cache path.

### Codex CLI (manual config.toml, no plugin)

If you do not want to install the plugin, wire Codex to Rembric directly over Streamable HTTP. The trade-off: the slug is hardcoded in the URL, so you must edit `~/.codex/config.toml` (or maintain multiple `[mcp_servers.X]` blocks) when switching projects.

`~/.codex/config.toml`:

```toml
[mcp_servers.rembric]
transport = "streamable-http"
url = "https://memory.example.com/mcp/my-app"
headers = { Authorization = "Bearer codex-token-XXXXXXXX" }
```

> Heads-up: the manual path has no Codex hooks, so session lifecycle (creation, summary-on-compact, end-on-stop) depends entirely on the agent's discipline to call `memory.session_start` / `memory.session_summary` / `memory.session_end` over MCP. The plugin install is the recommended path — its hooks POST to `/api/<slug>/sessions(*)` automatically, so sessions are tracked regardless of agent diligence.

## Any other MCP client

Cursor, Windsurf, VS Code Copilot Chat, Gemini CLI, OpenCode, etc. — they all speak Streamable HTTP with the same URL + Bearer shape. Locate their MCP config file in the client's docs and drop in the same block, adjusting field names (`type`, `transport`, `httpUrl`, plain `url`) to match.

If your client is stdio-only, use `mcp-remote` (the same package the Rembric plugin's bridge wraps) as a stdio↔HTTP shim. See its README for the exact spawn command; the Rembric plugin's `bin/rembric-bridge.mjs` is a working reference.

## `project_suggestion_pending`

When you connect to `/mcp` (path-less) and roots-based discovery surfaces a slug that does not yet exist as a project, write tools refuse to silently fall through to global. They return:

```json
{
  "ok": false,
  "code": "project_suggestion_pending",
  "message": "...",
  "suggestedSlugs": ["acme-research"]
}
```

Two resolutions, both belong to the user:

- **Stay global**: re-issue passing `scope: 'global'` explicitly.
- **Mint the project**: `project.use({slug, autocreate: true})`, then re-issue.

Never autocreate or autopin silently.

## Surviving compaction

Long-running agents compact their context. To survive that, two tools fire at specific moments:

- **Before "done" / before compaction**: `memory.session_summary({Goal, Discoveries, Accomplished, Next Steps, Files})` closes the session and persists the state.
- **After compaction / new session**: `memory.context({sessions, prompts, memories})` restores it.

The proactive-save protocol embedded in `initialize.instructions` already tells agents to do this. If your client ignores the field, paste the equivalent into the client's rules file (`AGENTS.md`, `.cursor/rules/`, `.windsurfrules`, `.github/copilot-instructions.md`, `~/.gemini/system.md`, etc.).

## Verifying

After registering, ask the agent to list its tools — you should see the `memory.*` and `project.*` families. Save a test memory, then check `/dashboard/memories` for the row.

## Cross-references

- Tool surface and parameters: each tool's MCP description (call `tools/list` from your client).
- Relation graph and `memory.judge` cadence: [docs/relations.md](./relations.md).
- Session deletion / undelete: dashboard `/dashboard/sessions`, CLI `rembric session list --include-deleted`.
