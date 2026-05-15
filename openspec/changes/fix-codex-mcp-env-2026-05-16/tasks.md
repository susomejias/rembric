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

- [ ] 5.1 Confirm working tree status with `git status` — expect: modified `plugin/.claude-plugin/{plugin.json,mcp.json}`, new `plugin/.codex-plugin/mcp.json`, modified `plugin/.codex-plugin/plugin.json`, modified `plugin/CHANGELOG.md`, modified `CLAUDE.md`, modified `docs/agents.md`, new `openspec/changes/fix-codex-mcp-env-2026-05-16/**`.
- [ ] 5.2 Run `openspec validate fix-codex-mcp-env-2026-05-16 --strict` and confirm green.
- [ ] 5.3 Commit all changes with one Conventional Commit message — `fix(codex): split MCP config per client; use cwd + env_vars`. Body cites both Codex source functions (`normalize_plugin_mcp_server_value`, `create_env_for_mcp_server`, `launch_server`).
- [ ] 5.4 User confirms intent to push, then push to `origin/main`.
- [ ] 5.5 Run `codex plugin marketplace upgrade rembric` to pull `0.2.1` into the local marketplace clone.
- [ ] 5.6 Restart `codex`. Tail `~/.codex/log/codex-tui.log` after first MCP activity. Confirm:
  - The bridge's `[rembric-bridge] cwd=… url=…` line shows a real URL (`http://<host>:<port>/mcp/<slug>`).
  - No `Cannot find module …${CLAUDE_PLUGIN_ROOT}…` error.
  - No `TypeError: Invalid URL`.
  - MCP `initialize` completes; any tool call returns a real response.
- [ ] 5.7 If 5.6 passes, archive via `/opsx:archive fix-codex-mcp-env-2026-05-16`. If fails, diagnose and update the change.

## 6. Cross-client regression check

- [ ] 6.1 On the user's Claude Code install (where the keychain prompt is already wired): confirm `claude plugin marketplace upgrade rembric` followed by `claude` still works and MCP tool calls succeed.
- [ ] 6.2 Confirm Codex hooks panel shows the four hooks after the version bump (the `"No plugin hooks"` previously observed was almost certainly a cache-staleness issue; the bump should retrigger discovery).
- [ ] 6.3 If hooks STILL show as absent post-bump, capture as a separate change — diagnose Codex's hook-loading separately.
