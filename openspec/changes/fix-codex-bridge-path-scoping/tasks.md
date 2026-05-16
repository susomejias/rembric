## 1. Bridge changes

- [x] 1.1 Edit `plugin/bin/rembric-bridge.mjs`: replace the line `const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();` with a 3-step resolution chain using `||` (not `??`) — `CLAUDE_PROJECT_DIR || PWD || process.cwd()` — and capture the source name in a local variable (`projectDirSource`) for the diagnostic line.
- [x] 1.2 Update the bridge's startup stderr diagnostic from `[rembric-bridge] cwd=<dir> url=<url>` to `[rembric-bridge] projectDir=<dir> (from <source>) url=<url>`, where `<source>` is one of `CLAUDE_PROJECT_DIR`, `PWD`, or `process.cwd()`.

## 2. Manifest changes

- [x] 2.1 Edit `plugin/.codex-plugin/mcp.json`: append `"PWD"` to the `env_vars` array — new value is `["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN", "PWD"]`.
- [x] 2.2 Bump `plugin/.codex-plugin/plugin.json:version` from `0.2.1` to `0.2.2`.
- [x] 2.3 Bump `plugin/.claude-plugin/plugin.json:version` from `0.2.1` to `0.2.2` (CLAUDE.md lockstep rule). Do NOT modify `plugin/.claude-plugin/mcp.json` — it stays byte-for-byte identical.

## 3. CHANGELOG

- [x] 3.1 Edit `plugin/CHANGELOG.md`: add a `## [0.2.2] — unreleased` heading above the current `[0.2.1]` heading. Body bullets:
  - Bridge `projectDir` resolution chain now includes `PWD` between `CLAUDE_PROJECT_DIR` and `process.cwd()`. Fixes path-scoping under Codex, where neither `CLAUDE_PROJECT_DIR` is set nor `process.cwd()` points at the user's project.
  - Bridge resolution now skips empty-string env vars (operator change `??` → `||`). Latent bug — `CLAUDE_PROJECT_DIR=""` previously produced a buggy relative `.rembric` lookup.
  - Bridge startup diagnostic line now shows `projectDir=<dir> (from <source>)` instead of `cwd=<dir>`. Helps debugging by naming which step of the precedence chain produced the result.
  - `plugin/.codex-plugin/mcp.json:env_vars` gains `"PWD"` so Codex (which `env_clear`s the subprocess) forwards the user's shell `PWD` to the bridge.
  - `plugin/.claude-plugin/*` and Claude Code runtime unchanged.

## 4. Spec deltas (drafted under openspec/changes/fix-codex-bridge-path-scoping/specs/)

- [x] 4.1 Confirm `specs/claude-code-plugin/spec.md` contains the MODIFIED "MCP bridge contract" requirement with the new precedence-chain rule, the empty-string-skip rule, the new diagnostic line format, and four scenarios (Claude Code source, Codex/PWD source, full fallback, empty-string skip).
- [x] 4.2 Confirm `specs/codex-distribution/spec.md` contains the MODIFIED "Codex-specific MCP server configuration" requirement with `env_vars: [..., "PWD"]` in the required-fields scenario and a new scenario "env_vars forwards PWD so the bridge can resolve the user's project directory".
- [x] 4.3 Run `openspec validate fix-codex-bridge-path-scoping --strict`. Confirm green.

## 5. Empirical verification (post-push)

- [ ] 5.1 Commit all the above with a single Conventional Commit: `fix(codex): restore bridge path-scoping via PWD fallback`. Body cites `Command::env_clear()` in `stdio_server_launcher.rs` and the bridge resolution chain change.
- [ ] 5.2 User confirms intent to push, then `git push origin main`.
- [ ] 5.3 Confirm `${repo_root}/.rembric` exists with a valid `PROJECT_SLUG=rembric` line (current state — verify with `cat .rembric`).
- [ ] 5.4 Run `codex plugin marketplace upgrade rembric` to pull `0.2.2`.
- [ ] 5.5 Cold-restart `codex` from the repo root with `REMBRIC_*` exported in the shell.
- [ ] 5.6 Tail `~/.codex/log/codex-tui.log` after first MCP activity. Confirm:
  - The bridge stderr line shows `projectDir=/Users/jesus.mejias/Desktop/rembric (from PWD)`.
  - The URL is `http://<host>:<port>/mcp/rembric` (path-scoped, NOT path-less `/mcp`).
  - The server logs (`/dashboard/sessions` or whichever surface) show activity attributed to the `rembric` project, not global scope.
- [ ] 5.7 If 5.6 passes, archive via `/opsx:archive fix-codex-bridge-path-scoping`. If fails, capture exact stderr, diagnose, update the change before archiving.

## 6. Cross-client regression check

- [ ] 6.1 In a subsequent Claude Code session against this repo: confirm Claude Code MCP still authenticates, tool calls succeed, and the bridge stderr (under `claude --debug`) shows `projectDir=<workspace> (from CLAUDE_PROJECT_DIR)`.
- [ ] 6.2 Confirm no unrelated bridge tests / typecheck / lint regressions before pushing — run `pnpm run typecheck` and `pnpm run lint`.
