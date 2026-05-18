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

- [x] 5.1 Commit sha `f1313bd` — `fix(codex): restore bridge path-scoping via PWD fallback`. Body cites `Command::env_clear()` in `stdio_server_launcher.rs` and the bridge resolution chain change.
- [x] 5.2 Push to `origin/main` confirmed (local + remote both at `f1313bd`).
- [x] 5.3 Confirmed: `.rembric` exists with `PROJECT_SLUG=rembric`.
- [x] 5.4 Cache regenerated to `0.2.2/` (verified `~/.codex/plugins/cache/rembric/rembric/0.2.2/.codex-plugin/{plugin.json,mcp.json}` have new content).
- [x] 5.5 Codex relaunched from repo root with `REMBRIC_*` exported.
- [x] 5.6 Log confirms all three checks:
  - `[rembric-bridge] projectDir=<repo> (from PWD) url=http://192.0.2.10:8787/mcp/rembric` ✓
  - URL path-scoped to `/mcp/rembric` (verified via `Connecting to remote server: http://192.0.2.10:8787/mcp/rembric` line) ✓
  - MCP handshake completes (`Local→Remote initialize` → `Remote→Local 0` → `notifications/initialized` → `tools/list` → `Remote→Local 1`) ✓
  - Server-side `/dashboard/sessions` attribution pending: needs user to trigger a tool call to confirm.
- [x] 5.7 5.6 passed end-to-end. Verified by user: agent inside Codex called `rembric.project.current({})` and got `{"slug": "rembric", "source": "url-path"}` — the `source: "url-path"` field proves the bridge built `/mcp/rembric` correctly and the server pinned the project from the URL slug. `memory.context` returned real project-scoped data. Archiving now.

## 6. Cross-client regression check

- [ ] 6.1 DEFERRED — Claude Code regression check pending the user's next Claude Code session. Risk surface is small: only the bridge's `projectDir` resolution chain changed (CLAUDE_PROJECT_DIR keeps winning under Claude Code), `plugin/.claude-plugin/mcp.json` is unchanged, no test infra exists. To validate when next using Claude Code: `claude --debug` and look for `projectDir=<workspace> (from CLAUDE_PROJECT_DIR)` in the bridge stderr.
- [x] 6.2 Pre-commit hooks (`tsc --noEmit --incremental`, lint-staged Prettier+ESLint) ran on the apply commit `f1313bd` and passed. No regressions caught.
