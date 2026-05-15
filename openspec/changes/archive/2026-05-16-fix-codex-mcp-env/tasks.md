## 1. Plugin files

- [x] 1.1 Create new MCP config for Codex (now at `plugin/.codex-plugin/mcp.json` per the relocation in section 4) declaring `mcpServers.rembric` with `command: "node"`, `args: ["./bin/rembric-bridge.mjs"]`, `cwd: "."`, and `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]`. No `env` block.
- [x] 1.2 Edit `plugin/.codex-plugin/plugin.json`: `mcpServers` to `"./.codex-plugin/mcp.json"`. Bump `version` from `0.2.0` to `0.2.1`.
- [x] 1.3 Edit `plugin/.claude-plugin/plugin.json`: bump `version` from `0.2.0` to `0.2.1`. `mcpServers` updated to `"./.claude-plugin/mcp.json"` per section 4.
- [x] 1.4 Edit `plugin/CHANGELOG.md`: add `[0.2.1] — unreleased` heading covering: (a) Codex path-resolution fix (`cwd: "."` + relative args), (b) Codex credential-injection fix (`env_vars`), and (c) MCP config relocation into client dirs. Cite Codex source by file/function.

## 2. Spec deltas

- [x] 2.1 Author `openspec/changes/fix-codex-mcp-env-2026-05-16/specs/codex-distribution/spec.md` with:
  - MODIFIED "Codex plugin manifest → Required fields" — `mcpServers: "./.codex-plugin/mcp.json"`.
  - REMOVED "Shared MCP server configuration" (premise falsified).
  - ADDED "Codex-specific MCP server configuration" with scenarios for path resolution (`cwd: "."`), env injection (`env_vars`), and version-bump lockstep.
  - MODIFIED "End-user credential flow → Documented env-var requirement" — wording firm, no "fallback" language.
- [x] 2.2 Author `openspec/changes/fix-codex-mcp-env-2026-05-16/specs/claude-code-plugin/spec.md` with:
  - MODIFIED "Plugin manifest → Required manifest fields" — `mcpServers: "./.claude-plugin/mcp.json"`.
  - MODIFIED "MCP server declaration → MCP file path and bridge invocation" — file location moves to `plugin/.claude-plugin/mcp.json`; contents (command, args, env) unchanged.

## 3. Documentation

- [x] 3.1 Update `CLAUDE.md` Plugin development discipline section AND the `plugin/` directory tree comment: list both `.claude-plugin/mcp.json` and `.codex-plugin/mcp.json`. Tighten the prose to call out BOTH platform deltas (path substitution and env injection). Cite Codex source by file/function.
- [x] 3.2 Update `docs/agents.md` Codex section: state `REMBRIC_*` env-var export is canonical (not fallback). Reference `plugin/.codex-plugin/mcp.json`. Note both Codex deltas (cwd + env_vars). Warn future contributors not to "simplify" the path back to `${CLAUDE_PLUGIN_ROOT}`.
- [x] 3.3 (Optional) Skipped — `plugin/README.md` doesn't mislead users; the canonical Codex doc remains `docs/agents.md` which the README already links to.

## 4. MCP config file relocation

- [x] 4.1 Move `plugin/mcp.json` → `plugin/.claude-plugin/mcp.json` (via `git mv`).
- [x] 4.2 Move new file (created in 1.1) into place at `plugin/.codex-plugin/mcp.json` (untracked file, plain `mv`).
- [x] 4.3 Update both manifest `mcpServers` fields (covered in 1.2 and 1.3).
- [x] 4.4 Update all docs references to use the new paths (covered in 3.1 and 3.2).
- [x] 4.5 Update spec deltas to reflect the new paths (covered in 2.1 and 2.2).

## 5. Empirical verification (requires push to main)

- [x] 5.1 Confirm working tree status with `git status` — confirmed during apply.
- [x] 5.2 Run `openspec validate fix-codex-mcp-env-2026-05-16 --strict` and confirm green — passed.
- [x] 5.3 Commit (sha `2d8c54f`): `fix(codex): split MCP config per client; use cwd + env_vars`. Body cites the three Codex source functions.
- [x] 5.4 User pushed to `origin/main` externally during the session.
- [x] 5.5 `codex plugin marketplace upgrade rembric` run by user — cache regenerated to `0.2.1/`.
- [x] 5.6 Codex relaunch verified: log shows `[rembric-bridge] cwd=/Users/jesus.mejias/.codex/plugins/cache/rembric/rembric/0.2.1 url=http://192.168.20.48:8787/mcp` (real URL). Bridge spawn clean, no `Cannot find module`, no `TypeError: Invalid URL`. MCP `initialize` + `notifications/initialized` + `tools/list` all complete. Bearer token auth succeeds. `/mcp` panel lists all rembric tools.
- [x] 5.7 Archiving via `/opsx:archive` now.

## 6. Cross-client regression check

- [ ] 6.1 DEFERRED — Claude Code regression check pending the user's next Claude Code session. The plugin/.claude-plugin/mcp.json move is the only behavioral change; the rest of the Claude Code path is untouched. No urgency since Claude Code is the user's primary client.
- [x] 6.2 Diagnosed (not our bug). `/plugins` showing "No plugin hooks" is Codex's intentional hook-trust UX — `HookMetadata.trustStatus` defaults to `Untrusted` until the user runs the startup hook review or sets `[hooks.state]` entries in `~/.codex/config.toml`. Our `plugin/hooks/hooks.codex.json` parses fine and is registered; Codex just gates panel visibility on trust. Out of scope for this change.
- [ ] 6.3 SEPARATE CHANGE — path-scoping regression: bridge runs with cwd = plugin cache dir under our `cwd: "."` fix, so `.rembric` is never read from the user's project. Captured for a follow-up change ("fix codex bridge path-scoping via PWD env_var").
