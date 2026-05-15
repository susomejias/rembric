## Why

Codex CLI is a first-class target in Rembric's multi-client positioning. The original Codex install story in `docs/agents.md` was a single manual JSON snippet with a slug-hardcoded URL — it works for one project and breaks when switching repos.

[Agentmemory](https://github.com/rohitg00/agentmemory)'s open-source plugin demonstrates the cleanest path: Codex's plugin marketplace accepts `source: "git-subdir"` and Codex's hook engine honours `${CLAUDE_PLUGIN_ROOT}`, so a single `plugin/` directory can ship both clients with shared scripts and shared MCP config. Two manifests, one source tree, two marketplaces — full feature parity with Claude Code via one install command per client.

This change applies that pattern. The end-user install for Codex collapses to:

```bash
codex plugin marketplace add git@github.com:susomejias/rembric.git
codex plugin install rembric
```

The marketplace clones the `./plugin` subtree; Codex spawns the bundled `plugin/bin/rembric-bridge.mjs` via `${CLAUDE_PLUGIN_ROOT}` (same variable Claude Code uses), so per-project slug auto-resolution from `.rembric` works identically across clients. No separate npm publish, no extra `~/.npmrc` PAT setup beyond what users already have for repo access.

## What Changes

- **`plugin/.codex-plugin/plugin.json`** — new Codex plugin manifest, sibling to the existing `plugin/.claude-plugin/plugin.json`. Same `plugin/` tree, two manifests. Declares the shared `mcpServers: "./mcp.json"` and a Codex-specific `hooks: "./hooks/hooks.codex.json"`.
- **`plugin/hooks/hooks.codex.json`** — new Codex hook configuration. Four-event subset (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`) that maps to events Codex actually supports. Hooks reuse the existing `plugin/scripts/session-start.sh` and `plugin/scripts/prompt-search.sh` from the Claude Code plugin via `${CLAUDE_PLUGIN_ROOT}/scripts/*`.
- **`plugin/scripts/pre-compact-codex.sh` and `plugin/scripts/stop-codex.sh`** — two new Codex-specific scripts. Codex hooks are command-only (no `type: mcp_tool`), so the Claude plugin's `PreCompact` mcp_tool invocation is replaced by a stdout nudge that instructs the agent to call `memory.session_summary` immediately.
- **`.codex-plugin/marketplace.json`** at the repo root — Codex marketplace declaration with `source: "git-subdir"` pointing at `./plugin`. Installable via `codex plugin marketplace add git@github.com:susomejias/rembric.git`.
- **`docs/agents.md`** Codex section is rewritten to recommend the plugin install as the primary path. The manual `config.toml` route stays documented as a slug-hardcoded fallback for users who do not want the plugin.
- **`README.md`** Codex section is rewritten to point at the new install.
- **`CLAUDE.md`** layered-structure block documents the dual-manifest `plugin/` and the two root-level marketplace files. A new "Plugin development discipline" section codifies the shared-logic rule; the existing "Code style highlights" gains an explicit no-comments-by-default convention.

## Out of scope

- **Migrating Claude Code's `PreCompact` hook from `type: "mcp_tool"` to `type: "command"` for parity with Codex.** Claude's direct mcp_tool invocation is strictly better when supported; we keep both implementations and accept that the two hooks have different shapes for the same intent.
- **A keychain-style `userConfig` prompt for Codex.** Codex's plugin schema does not (per our current evidence) support a sensitive-flagged `userConfig`. Codex users export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` as shell env vars before launching `codex`; the bridge inherits them. Documented in `docs/agents.md`.
- **Publishing a separate `@susomejias/rembric-bridge` npm package.** Considered and rejected: the marketplace install already delivers the bundled bridge inside `plugin/bin/`, so publishing a parallel artifact would add release ceremony (multi-package release-please, GitHub Packages PAT setup) for no install-time benefit. The same bridge file is the single source of truth for both clients.
- **Codex skills (`plugin/skills/`).** None for v1. The proactive-save protocol is delivered via the server-side `initialize.instructions` handshake — same as the Claude Code plugin, which also ships no skills. Future change if it becomes useful.
- **Porting Cursor / Windsurf / Gemini / OpenCode** to the same marketplace pattern. They do not (yet) have an equivalent plugin marketplace; documented manual MCP wiring continues to apply for them.

## Capabilities

### New Capabilities

- `codex-distribution`: documents the Codex CLI install contract for Rembric — the dual-manifest `plugin/` layout, the Codex hook subset and command-only event constraint, the `.codex-plugin/marketplace.json` shape with `git-subdir` source, and the shell-env credential flow for users without a keychain prompt.

### Modified Capabilities

- `claude-code-plugin`: the existing plugin directory now coexists with a sibling Codex manifest and Codex hooks file. The Claude Code manifest, hooks, scripts, and `mcp.json` are unchanged in behaviour — but the spec must acknowledge that `plugin/` is a shared tree, not a Claude-Code-exclusive one, and that `plugin/scripts/` are designed to work under both `${CLAUDE_PLUGIN_ROOT}` resolvers (Claude Code's and Codex's, which share the variable name).

## Impact

- **New paths**: `plugin/.codex-plugin/plugin.json`, `plugin/hooks/hooks.codex.json`, `plugin/scripts/pre-compact-codex.sh`, `plugin/scripts/stop-codex.sh`, `.codex-plugin/marketplace.json`.
- **No changes** to `src/`, `dist/`, build pipeline, release-please configuration, npm packaging, or the existing Claude Code plugin's manifest/hooks/scripts/bridge.
- **End-user credential surface for Codex install**: shell env vars (`REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN`) plus SSH/PAT for the marketplace `git-subdir` clone. Documented in `docs/agents.md`.
- **Validation gaps before merge**: two items to verify empirically, neither blocking the proposal but flagged in tasks.md:
  1. Whether `codex plugin marketplace add git@github.com:susomejias/rembric.git` succeeds against a private repo (analogous to Claude Code's marketplace add, which we know works).
  2. Whether the shared `plugin/mcp.json`'s `${user_config.X}` interpolation falls back gracefully to env vars under Codex when no `userConfig` is declared in the Codex manifest. If not, the env-var override path documented above is the supported flow.
