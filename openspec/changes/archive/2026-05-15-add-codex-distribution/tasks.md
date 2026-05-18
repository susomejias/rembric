## 1. Codex plugin manifest and marketplace

- [x] 1.1 Create `plugin/.codex-plugin/plugin.json` mirroring the Claude Code manifest minus `userConfig` (Codex schema does not declare keychain-style prompts) — declares shared `mcpServers: "./mcp.json"` and Codex-specific `hooks: "./hooks/hooks.codex.json"`
- [x] 1.2 Create `.codex-plugin/marketplace.json` at the repo root with `source: { source: "git-subdir", url: "git@github.com:susomejias/rembric.git", path: "./plugin", ref: "main" }`, `policy.installation: "AVAILABLE"`, `policy.authentication: "ON_INSTALL"`, `category: "Memory"`
- [x] 1.3 Create `plugin/hooks/hooks.codex.json` with four hooks: `SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop` — all `type: "command"`. SessionStart and UserPromptSubmit reuse the existing Claude Code scripts; PreCompact and Stop point at new Codex-specific scripts.
- [x] 1.4 Create `plugin/scripts/pre-compact-codex.sh` — single-line stdout nudge instructing the agent to call `memory.session_summary({ auto: true })` before the next turn. Codex hooks are command-only, so this replaces Claude Code's `mcp_tool` PreCompact.
- [x] 1.5 Create `plugin/scripts/stop-codex.sh` — single-line session-close reminder.
- [x] 1.6 `chmod +x` on both new scripts.

## 2. Documentation updates

- [x] 2.1 Rewrite the Codex section of `docs/agents.md`. Primary path: `codex plugin marketplace add … && codex plugin install rembric`. Fallback: manual `[mcp_servers.rembric]` with `transport = "streamable-http"` and slug-in-URL.
- [x] 2.2 Document the env-var credential requirement (`export REMBRIC_SERVER_URL=…; export REMBRIC_API_TOKEN=…`) in `docs/agents.md` Codex section since Codex's plugin schema has no `userConfig` keychain.
- [x] 2.3 Rewrite `README.md` Codex section to point at the marketplace install.
- [x] 2.4 Update `CLAUDE.md` layered-structure block to document `plugin/.codex-plugin/`, `plugin/hooks/hooks.codex.json`, and the dual-marketplace setup. Add the shared-logic rule and no-comments-by-default rule below the architecture section.

## 3. Local validation

- [x] 3.1 Run `pnpm run typecheck`, `pnpm run lint`, and `pnpm test` end-to-end to confirm no regressions (287/287 tests pass)
- [x] 3.2 Manually validate `plugin/hooks/hooks.codex.json` parses as JSON
- [x] 3.3 Manually validate `plugin/.codex-plugin/plugin.json` parses as JSON
- [x] 3.4 Manually validate `.codex-plugin/marketplace.json` parses as JSON

## 4. Smoke tests (require user execution after release)

- [ ] 4.1 Smoke-test the Codex plugin install: `codex plugin marketplace add git@github.com:susomejias/rembric.git`, `codex plugin install rembric`. Confirm Codex registers the MCP server, the four hooks, and discovers the bridge via `${CLAUDE_PLUGIN_ROOT}`.
- [ ] 4.2 Smoke-test the Claude Code plugin still works post-pivot: `claude --plugin-dir ./plugin`, verify Memory Protocol injection, save+search round-trip.
- [ ] 4.3 Smoke-test the manual config.toml fallback: paste the raw `[mcp_servers.rembric]` block + slug-in-URL, launch Codex, confirm `memory.save` works.
- [ ] 4.4 Smoke-test `PreCompact` for Codex: trigger compaction, confirm the bridge nudge is printed and the agent calls `memory.session_summary` on resume.

## 5. Release (requires explicit user go-ahead)

- [ ] 5.1 Land all the above on a feature branch with conventional-commit messages (`feat(plugin): add codex marketplace manifest`, `docs(codex): pivot to marketplace install`, etc.)
- [ ] 5.2 Open PR; merge after CI green (lint, typecheck, tests)
- [ ] 5.3 Archive the change under `openspec/changes/archive/` via `/opsx:archive`
