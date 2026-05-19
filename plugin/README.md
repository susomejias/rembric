# Rembric — agent plugins

Memory for AI coding agents, backed by your self-hosted [Rembric](https://github.com/susomejias/rembric) server. One source tree, four per-client surfaces:

| Client           | Manifest dir        | Install                                                                                                                                        | Docs                                                                       |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Claude Code**  | `.claude-plugin/`   | `claude plugin marketplace add https://github.com/susomejias/rembric.git && claude plugin install rembric@rembric`                             | this file                                                                  |
| **Codex CLI**    | `.codex-plugin/`    | `codex plugin marketplace add https://github.com/susomejias/rembric.git && codex plugin install rembric`                                       | [`docs/agents.md`](../docs/agents.md#codex-cli-recommended-bundled-plugin) |
| **Hermes Agent** | `.hermes-plugin/`   | `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh \| sh && hermes plugins enable rembric` | [`plugin/.hermes-plugin/README.md`](./.hermes-plugin/README.md)            |
| **opencode**     | `.opencode-plugin/` | `bash plugin/.opencode-plugin/install.sh` (from a rembric checkout), then paste the printed MCP block into `~/.config/opencode/opencode.json`  | [`plugin/.opencode-plugin/README.md`](./.opencode-plugin/README.md)        |

The rest of this file is the Claude Code plugin reference. For Codex see [`docs/agents.md`](../docs/agents.md). For Hermes see [`plugin/.hermes-plugin/README.md`](./.hermes-plugin/README.md). For opencode see [`plugin/.opencode-plugin/README.md`](./.opencode-plugin/README.md).

> **Using Codex CLI?** The same `plugin/` tree ships a Codex manifest too. After `codex plugin install rembric` you also need two one-time Codex-side steps for hooks to fire: run `codex features enable plugin_hooks`, then approve the 4 hooks via `/hooks` inside Codex. Full walk-through (including the `REMBRIC_*` shell-env requirement and the symptom-vs-cause troubleshooting table) lives in [`docs/agents.md`](../docs/agents.md#enable-plugin_hooks-and-trust-hooks-required).

## What you get

- **One MCP server** declared automatically — no hand-editing `.mcp.json`, no plaintext tokens in your settings file. The API token lives in your system keychain.
- **A tiny stdio bridge** (`bin/rembric-bridge.mjs`, ~80 LOC) that reads `PROJECT_SLUG` from a `.rembric` file at the project root and path-scopes the MCP URL to `/mcp/<slug>` so the Rembric server pins the correct project on connect. No agent-side `project.use` call, no router-fallback codepath.
- **Four slash commands** under `/rembric:*` — `remember`, `recall`, `context`, `summary`.
- **Four lifecycle hooks** — all `command`-type, all POST to Rembric's HTTP API directly so sessions are tracked regardless of whether the agent remembers to call them:
  - `SessionStart` reads the host session id from stdin and POSTs `/api/<slug>/sessions` to register the session (idempotent). Also nudges the agent to load recent context.
  - `UserPromptSubmit` (matcher on recall keywords) nudges the agent to search before responding.
  - `PreCompact` POSTs the compact transcript to `/api/<slug>/sessions/<id>/summary` so compaction never silently loses session state.
  - `Stop` POSTs `/api/<slug>/sessions/<id>/end` (async) when the agent stops, closing the session row cleanly.

Proactive memory protocol ("save after decisions, fixes, conventions, preferences, discoveries") is delivered server-side via the Rembric MCP `initialize.instructions` handshake — it applies to every MCP client (Claude Code plugin, Codex CLI, Cursor, …) automatically, with no per-client skill needed.

## Install

### As a teammate (marketplace install)

```bash
claude plugin marketplace add https://github.com/susomejias/rembric.git
claude plugin install rembric@rembric
```

Auth uses your existing git credentials (SSH key or PAT). The repo can stay private — same access pattern as `git clone`.

You will be prompted for two values at install time, both required:

- **Rembric server URL** — base URL of your deployment, **without the `/mcp` suffix**. The bridge appends `/mcp/<slug>` itself.
  - ✓ Good: `https://memory.example.com`, `http://192.168.1.10:8787`
  - ✗ Bad: `https://memory.example.com/mcp`
  - No trailing slash.
- **Rembric API token** — issued from the Rembric dashboard at `/dashboard/tokens` (plaintext shown exactly once). Stored in your system keychain (not in `settings.json`).

That's it — the `userConfig` values flow to both the MCP bridge AND the lifecycle hooks via Claude Code's `${user_config.*}` substitution in the hook manifest. No shell exports required.

### Verifying the hooks reach the server

After install + restart, open a Claude Code session and check `/dashboard/sessions` on your Rembric deployment. A new row should appear within seconds with `agent=claude-code`.

If sessions never appear, fall back to exporting in your shell so we can rule out the substitution path:

```bash
# diagnostic fallback — only if the wizard route does not work
export REMBRIC_SERVER_URL="https://memory.example.com"
export REMBRIC_API_TOKEN="$(security find-generic-password -s rembric -w 2>/dev/null || echo MISSING)"
```

Restart Claude Code and try again. If sessions now appear with the shell exports but not without, the plugin's `${user_config.*}` substitution is misbehaving — open an issue with the Claude Code version. Either way the hook scripts emit a one-line stderr diagnostic (`[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST ...`) when credentials are missing; `claude --debug` shows them.

### Updating to a new version

Claude Code caches plugins by version. When we ship a new `version` in `plugin/.claude-plugin/plugin.json` (e.g. `0.1.0` → `0.2.0`), follow the official update flow:

```shell
# 1. Refresh the marketplace catalog so Claude Code sees the new version
/plugin marketplace update rembric

# 2. Update the installed plugin
/plugin update rembric@rembric

# 3. Apply the new hooks/scripts without restarting
/reload-plugins
```

If `/reload-plugins` is not enough (e.g. when the MCP bridge or `bin/*` changed), restart Claude Code fully so the bridge re-spawns from the new cache.

Third-party marketplaces have **auto-update disabled by default**. To opt in, run `/plugin` → **Marketplaces** tab → select rembric → **Enable auto-update**. Then Claude Code refreshes the catalog and updated installed plugins on startup, prompting `/reload-plugins` when something changed.

If the version field hasn't been bumped but you know new code shipped (or your environment refuses to pick it up), force a clean reinstall:

```shell
/plugin uninstall rembric@rembric
/plugin install rembric@rembric
```

You can also blow away the cache directly: `rm -rf ~/.claude/plugins/cache` (Claude Code rebuilds it on next install).

### As the plugin author (local iteration)

```bash
claude plugin marketplace add ~/path/to/rembric
claude plugin install rembric@rembric -s local
```

Reload after edits with `/reload-plugins`. For deep changes (e.g. editing the bridge), restart Claude Code so the MCP transport reattaches.

## Picking the project per repo

Drop a `.rembric` file in each project's root with `PROJECT_SLUG=<slug>`:

```bash
echo "PROJECT_SLUG=my-app-slug" > .rembric
```

Format is dotenv-style (`KEY=VALUE`, `#` for comments). Reserved for future fields (e.g. `DEFAULT_SCOPE=`, `AUTO_SAVE=`) — today only `PROJECT_SLUG` is read. The bridge parses it on every MCP session start and builds the URL `${server_url}/mcp/my-app-slug`. The Rembric server pins the project from the URL path automatically.

If `.rembric` is missing, unparseable, or `PROJECT_SLUG` is invalid, the bridge falls back to path-less `/mcp` and writes a diagnostic to stderr (visible in `claude --debug`). The session still works — the agent operates in global scope until something else pins a project.

### Whether to commit `.rembric`

- **Commit it** when the whole team should share the same Rembric project for this repo.
- **Gitignore it** if each teammate uses their own memory scope.

### Choosing a slug

Pick something stable, lowercase, hyphen-separated (`acme-foo`, `my-app-api`). For monorepos, one slug per subproject (`acme-foo-frontend`, `acme-foo-api`). Slugs must match `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.

## Token budget

| What                   | Cost     | When                         |
| ---------------------- | -------- | ---------------------------- |
| 4 command listings     | ≤ 40 tok | always-on (per turn)         |
| SessionStart nudge     | ~ 20 tok | once per session             |
| UserPromptSubmit nudge | ~ 20 tok | per matched prompt           |
| PreCompact             | 0 tok    | side effect; no model output |
| Stop                   | 0 tok    | side effect; async           |

The proactive-save protocol travels via the MCP `initialize.instructions` (~500 chars, paid once per connection by every client) — it does not show up in the plugin's per-turn budget.

## Bridge runtime

- **Requires Node 18+** on PATH. Claude Code already needs Node, so this is normally satisfied.
- The bridge uses `npx -y mcp-remote@latest` for the actual stdio↔HTTP MCP transport. First launch downloads `mcp-remote` (~5–15 s, needs network); subsequent launches are instant from the npx cache.
- One bridge process per MCP session (~30 MB residence). Lives only for the session lifetime.
- The bridge does NOT parse or modify MCP frames. Bytes flow through `mcp-remote` unchanged.

## Notes

- This plugin is designed to be the **sole memory layer** for the agent. It does not migrate from or coexist with other memory tools — if one is already installed, uninstall it before enabling this plugin to avoid cross-tool drift.
- The plugin is **client-side only** — it does not modify Rembric's server code.
- Hook scripts are designed to **never block a session**: any error exits 0 with empty stdout.

## License

MIT, same as the server.
