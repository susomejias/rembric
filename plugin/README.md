# Rembric — Claude Code plugin

Memory for Claude Code, backed by your self-hosted [Rembric](https://github.com/susomejias/rembric) server.

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
claude plugin marketplace add git@github.com:susomejias/rembric.git
claude plugin install rembric@rembric
```

Auth uses your existing git credentials (SSH key or PAT). The repo can stay private — same access pattern as `git clone`.

You will be prompted for two values at install time, both required:

- **Rembric server URL** — base URL of your deployment, **without the `/mcp` suffix**. The bridge appends `/mcp/<slug>` itself.
  - ✓ Good: `https://memory.example.com`, `http://192.168.1.10:8787`
  - ✗ Bad: `https://memory.example.com/mcp`
  - No trailing slash.
- **Rembric API token** — issued by `rembric token create` on the server. Stored in your system keychain (not in `settings.json`).

### Required: shell env vars for hooks

The plugin's `userConfig` flows into the MCP server (the bridge) but NOT into hook scripts — Claude Code hooks run as sibling subprocesses and inherit your shell environment, not the bridge's. For the session lifecycle hooks (`SessionStart`, `PreCompact`, `Stop`) to reach the Rembric HTTP API, export the same two values in the shell that launches `claude`:

```bash
# in ~/.zshrc or equivalent
export REMBRIC_SERVER_URL="https://memory.example.com"      # match userConfig
export REMBRIC_API_TOKEN="$(cat ~/.rembric/claude-token)"   # match userConfig
```

Restart Claude Code after exporting. **Without these envs, hooks fail silently** (`_api.sh` exits 0 with a stderr diagnostic), MCP traffic still works fine, but `/dashboard/sessions` stays empty and PreCompact never persists a summary.

You can verify with:

```bash
echo '{"session_id":"smoke-001","cwd":"'$PWD'"}' | bash ~/.claude/plugins/cache/rembric/rembric/*/scripts/session-start.sh
# Expected: only the nudge line on stdout, nothing on stderr.
# If you see "missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN", the envs are not exported.
```

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

- This plugin **replaces** other memory tools (engram, agentmemory, etc.); it does not coexist with them. The author's setup intentionally drops them.
- The plugin is **client-side only** — it does not modify Rembric's server code.
- Hook scripts are designed to **never block a session**: any error exits 0 with empty stdout.

## License

MIT, same as the server.
