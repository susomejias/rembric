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

- The `rembric` MCP server (declared by `plugin/.codex-plugin/mcp.json`, the Codex-specific sibling of Claude Code's `plugin/.claude-plugin/mcp.json`), invoking the bundled bridge at `plugin_root/bin/rembric-bridge.mjs` (resolved via the manifest's `cwd: "."` + relative args).
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

- The **MCP bridge** — `plugin/.codex-plugin/mcp.json` declares `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]`, Codex's native mechanism for reading specific env vars from the parent shell at MCP subprocess spawn time (`create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs`). Codex does NOT inherit the full parent env automatically — `LocalStdioServerLauncher::launch_server` calls `Command::env_clear()` before applying the curated env, so only the names you list under `env_vars` are forwarded, on top of `DEFAULT_ENV_VARS`. The same manifest also uses `cwd: "."` + `args: ["./bin/rembric-bridge.mjs"]` to anchor the bridge path to the plugin root — `${CLAUDE_PLUGIN_ROOT}` substitution does NOT work in MCP args under Codex (only in hook commands), so future contributors should not "simplify" the path back to the Claude Code form.
- The **lifecycle hooks** (`SessionStart`, `PreCompact`, `Stop`) so sessions appear in `/dashboard/sessions` and PreCompact persists a summary.

Symptoms of missing envs:

- `/dashboard/sessions` stays empty even when MCP tool calls work fine.
- `codex --debug` shows `[rembric-bridge] Missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN` (bridge) or `[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST /api/...` (hooks).

#### Enable plugin_hooks and trust hooks (REQUIRED)

MCP authenticates after install + env exports. For lifecycle hooks (session creation, summary-on-compact, end-on-stop) to actually fire under Codex, **two extra one-time steps are mandatory** as of `codex-cli 0.130.0`. Skip them and `/dashboard/sessions` stays empty no matter how many Codex sessions you run.

**Step 1 — enable the `plugin_hooks` feature.** Codex ships this feature as `under development` and disabled by default in `0.130.0`. Verify and enable from any shell:

```bash
codex features list | grep plugin_hooks     # confirms current state
codex features enable plugin_hooks          # writes [features] plugin_hooks = true to ~/.codex/config.toml
```

Newer Codex releases may default this feature on — run `codex features list` first to confirm you actually need the step. If it already reports `plugin_hooks  stable  true`, skip.

**Step 2 — trust the hooks inside Codex.** Restart Codex after step 1. On startup Codex shows a banner of the form _"4 hooks need review before they can run. Open `/hooks` to review them."_ Open `/hooks` from inside Codex and approve each of the four Rembric hooks (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`). The trust persists in `~/.codex/config.toml` under `[hooks.state]`, so this is a one-time-per-hook step — subsequent Codex launches do not re-prompt.

After both steps, the `/plugins` panel for `rembric` shows `Hooks: PreCompact (1), SessionStart (1), UserPromptSubmit (1), Stop (1)` and the first new Codex session will POST to `/api/<slug>/sessions` against the Rembric server (visible at `/dashboard/sessions`).

##### Symptom → cause table

| Symptom in Codex                                                                                                                | Cause                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/dashboard/sessions` stays empty after Codex sessions                                                                          | `plugin_hooks` feature is off (Step 1) **OR** hooks have not been approved via `/hooks` (Step 2). MCP can still work while hooks silently no-op.                                                       |
| `/plugins` panel shows `Hooks: No plugin hooks`                                                                                 | `plugin_hooks` feature is off. The plugin's `hooks.codex.json` is parsed only when the feature is enabled.                                                                                             |
| Startup banner _"N hooks need review"_ keeps appearing across launches                                                          | Step 2 not completed for some hooks. Open `/hooks` and approve any handler whose status is `Untrusted` or `Modified`.                                                                                  |
| Hook fires but Codex reports `error: hook returned invalid session start JSON output` (or `... user prompt submit JSON output`) | Known plugin bug, separate change. Codex requires hook stdout to be JSON `{ hookSpecificOutput: { additionalContext: "..." } }`; plugin scripts currently emit plain text. Tracked for plugin `0.2.3`. |

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

### Hermes Agent (memory provider plugin)

Hermes Agent (Nous Research) loads Rembric as a native Python `MemoryProvider` from `plugin/.hermes-plugin/`. Two pieces compose:

| Piece                            | What it does                                                | Wired via                                                                  |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| **`memory.provider: rembric`**   | Auto session create / summary-on-compact / end-on-close     | The Python provider plugin (this section)                                  |
| **`mcp_servers.rembric`**        | Full memory tool surface (save/search/get/context/judge/…)  | The shared `bin/rembric-bridge.mjs` invoked as a stdio MCP server          |

Install with one shell command — no `git clone` of rembric required:

```sh
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

The script drops three files (`plugin.yaml`, `__init__.py`, `README.md`) into `${HERMES_HOME:-$HOME/.hermes}/plugins/rembric/`. Inspect before running with `curl … | less`. Developers iterating locally: same script, `PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh`.

**Private repo?** Set a GitHub PAT (`repo` scope) in your env and add the auth header to the outer curl — the installer reuses the token for the three internal fetches automatically (`GH_PAT`, `GH_TOKEN`, or `GITHUB_TOKEN`, first non-empty wins):

```sh
export GH_PAT=ghp_xxxxxxxx
curl -fsSL -H "Authorization: Bearer $GH_PAT" \
  https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
hermes plugins enable rembric
```

> **Why curl-pipe-sh, not `hermes plugins install`?** Hermes's installer (`hermes_cli/plugins_cmd.py::_resolve_git_url` at v0.4.x) accepts only `owner/repo` shorthand or a full Git URL — it does NOT support monorepo subpaths. Cloning the whole rembric repo into `~/.hermes/plugins/rembric/` to extract three files would mean tens of MB of unrelated TS source. The curl-installer ships the right artifacts and nothing else.

Then drop this block into `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  rembric:
    command: npx
    args: ["-y", "mcp-remote@latest", "${REMBRIC_SERVER_URL}/mcp", "--header", "Authorization: Bearer ${REMBRIC_API_TOKEN}", "--allow-http"]

memory:
  provider: rembric
```

#### Credentials — use `~/.rembric/.env` (recommended)

Same two env vars Codex uses, same `rembric token create` token. **The recommended path is `~/.rembric/.env`** — Hermes does NOT consistently propagate parent-shell env to the Python provider subprocess, so `export` in `~/.zshrc` may leave the provider seeing an empty env and silently skipping every session POST. The `.env` file is read at module import via `os.environ.setdefault`, which guarantees the values are present when `initialize()` fires regardless of how Hermes was launched (systemd, tmux, plain shell).

```bash
mkdir -p ~/.rembric
cat > ~/.rembric/.env <<'EOF'
REMBRIC_SERVER_URL=http://192.168.20.48:8787
REMBRIC_API_TOKEN=<token-from-rembric-token-create>
REMBRIC_PROJECT_SLUG=<your-slug>
EOF
chmod 600 ~/.rembric/.env
```

Restart Hermes after creating the file. Within seconds of the next session start, a row should appear in `/dashboard/sessions` with `agent=hermes`.

Shell exports DO still take precedence over `~/.rembric/.env` (`setdefault` semantics) — use them only if you have a specific reason to override the file value temporarily.

> **Symptom check**: if MCP tool calls work (memory.save / memory.search round-trip in the dashboard) but `/dashboard/sessions` never gets a row with `agent=hermes`, this is almost always the env-not-propagated issue. The fix is the `.env` file above. Verified live in a Hermes LXC install (2026-05-16).

#### Project slug resolution

The provider needs a project slug for every session-lifecycle POST. Cascade, first valid match wins:

1. `REMBRIC_PROJECT_SLUG` env var.
2. `${HERMES_HOME:-$HOME/.hermes}/rembric.json` → `"project_slug"` (written by `hermes plugins config rembric`).
3. `<cwd>/.rembric` → `PROJECT_SLUG=<slug>` (same dotenv format as the Claude/Codex plugins).
4. Trailing path segment of `REMBRIC_SERVER_URL` if it ends in `/mcp/<slug>`.
5. No slug → all session POSTs skip silently (`[rembric] no project slug …` stderr diagnostic once).

Every candidate is validated against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Pick whichever source matches your workflow — solo / single-project users go with step 1 or 2, multi-project users with `.rembric` files, path-scoped URL users get step 4 automatically.

#### Symptom → cause table

| Symptom in Hermes                                                                                | Cause                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MCP tool calls work but `/dashboard/sessions` never gets a row with `agent=hermes`**           | **Most common cause.** Hermes did not propagate shell env to the Python provider subprocess. **Fix: create `~/.rembric/.env`** (see "Credentials" above) and restart Hermes.                                                                                       |
| `hermes memory status` lists `rembric` as available but `/dashboard/sessions` stays empty        | Token doesn't have `write` permission for the project (`rembric token list` to check — `read` alone returns 403 on session POST, which the provider logs to stderr only). Reissue via `rembric token create --scope project --slug <slug>` (write is the default). |
| stderr shows `[rembric] no project slug for session …; skipping session POST`                    | None of the five cascade sources produced a slug. Set `REMBRIC_PROJECT_SLUG` in `~/.rembric/.env`.                                                                                                                                                                  |
| stderr shows `[rembric] POST /sessions failed: HTTPError 404`                                    | `REMBRIC_SERVER_URL` is path-scoped (e.g. ends in `/mcp/<slug>`). The provider needs the bare server URL — use `REMBRIC_PROJECT_SLUG` for the slug, not the URL.                                                                                                    |
| MCP tools fail and `hermes memory status` reports `rembric: Missing`                             | The Python provider isn't loaded. Confirm `memory.provider: rembric` in `~/.hermes/config.yaml`, then `hermes plugins enable rembric`. Restart Hermes.                                                                                                              |
| Provider tracks slug `A`, MCP bridge tracks slug `B`                                              | Cascade reads from process env / files; the bridge reads from its `args`. Pin `REMBRIC_PROJECT_SLUG` (read by the provider) AND keep the bridge URL aligned, OR set both via env.                                                                                  |
| `hermes plugins update rembric` reports nothing to update                                        | The provider was not installed via `hermes plugins install`. Re-run the curl-installer — it's idempotent and overwrites the three files.                                                                                                                            |

#### Using Hermes alongside Claude Code or Codex on the same machine

Credentials, slug source, and update flow are independent per client. The Rembric server side is identical — same token, same `/api/<slug>/sessions(*)` endpoints. The clients just configure their adapters differently:

| Client          | Credentials from                                  | Slug from                                                          | Update                                                                                        |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Claude Code** | Wizard → keychain (`${user_config.*}`)             | `.rembric` file via the bridge                                     | `/plugin update rembric@rembric`                                                              |
| **Codex CLI**   | Shell env (`export REMBRIC_*`)                     | `.rembric` file via the bridge                                     | `codex plugin marketplace upgrade rembric` + restart                                          |
| **Hermes Agent**| Shell env OR `~/.rembric/.env` preload             | Cascade (env / `rembric.json` / `.rembric` / URL parse)            | Re-run the curl-installer                                                                     |

Both the Hermes MCP bridge entry (`mcp_servers.rembric`) and the Hermes provider read the same shell env, so a single shell rc edit covers them. No keychain (Hermes has no `userConfig` equivalent; `get_config_schema()` is provider-managed storage in `~/.hermes/rembric.json`).

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
