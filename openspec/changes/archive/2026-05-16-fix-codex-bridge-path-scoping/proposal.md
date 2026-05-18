## Why

After the previous change (`2026-05-16-fix-codex-mcp-env`) shipped `plugin/.codex-plugin/mcp.json` with `cwd: "."` to anchor the bundled bridge path, an unintended regression emerged: under Codex, the bridge subprocess runs with `cwd = plugin cache dir` (`~/.codex/plugins/cache/rembric/rembric/0.2.1`). The bridge reads `${projectDir}/.rembric` from `process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`. Codex does not set `CLAUDE_PROJECT_DIR`, and `process.cwd()` returns the cache dir. So `.rembric` is never found and the bridge always falls back to path-less `/mcp` (global scope) even when the user has a valid `PROJECT_SLUG` in their project root. Path-scoping breaks entirely under Codex.

Verified live: bridge stderr shows `[rembric-bridge] No .rembric in <home>/.codex/plugins/cache/rembric/rembric/0.2.1; using path-less /mcp.` immediately after the install fix landed.

## What Changes

- **`plugin/bin/rembric-bridge.mjs`** — extend the project-directory resolution chain from `CLAUDE_PROJECT_DIR ?? cwd()` to `CLAUDE_PROJECT_DIR || PWD || cwd()`. The shell-set `PWD` env var becomes the canonical signal under Codex (where Codex's `env_clear()` strips inheritance unless explicit). Switch `??` to `||` to also skip empty-string env values (latent bug fix — `CLAUDE_PROJECT_DIR=""` is currently treated as "set" and produces a relative `.rembric` lookup against process cwd).
- **`plugin/bin/rembric-bridge.mjs` diagnostic line** — update the existing `[rembric-bridge] cwd=<dir>` stderr trace to also report which source won (`CLAUDE_PROJECT_DIR | PWD | cwd`). Useful for debugging future setups; no behavioural change.
- **`plugin/.codex-plugin/mcp.json`** — append `"PWD"` to the `env_vars` array. This is the only mechanism that makes Codex pass `process.env.PWD` (the user's shell cwd) through to the bridge subprocess given Codex's `env_clear()` semantics (`codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server`).
- **`plugin/.claude-plugin/mcp.json`** — UNCHANGED. Under Claude Code, `CLAUDE_PROJECT_DIR` wins the precedence chain in the bridge, so adding PWD as a middle fallback doesn't affect Claude Code's resolved path.
- **`plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json`** — bump `version` from `0.2.1` to `0.2.2` in lockstep (CLAUDE.md rule for any user-visible `plugin/` change).
- **`plugin/CHANGELOG.md`** — new `[0.2.2] — unreleased` entry describing the path-scoping fix.

## Capabilities

### New Capabilities

_(none — this change does not introduce new capabilities)_

### Modified Capabilities

- `claude-code-plugin`: the MCP bridge contract's project-directory resolution rule changes (adds `PWD` as a middle fallback, fixes empty-string handling, augments the startup diagnostic line). The slug-selection contract itself is unchanged; only the source-of-truth resolution gains a step.
- `codex-distribution`: the Codex-specific MCP server configuration grows by one entry in `env_vars` (`PWD`) to enable the bridge's shell-cwd fallback under Codex. The `cwd: "."` + `args: ["./bin/rembric-bridge.mjs"]` + `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]` shape is otherwise unchanged.

## Impact

- **Touched paths**: `plugin/bin/rembric-bridge.mjs` (4-line change), `plugin/.codex-plugin/mcp.json` (env_vars list +1), `plugin/.claude-plugin/plugin.json` (version), `plugin/.codex-plugin/plugin.json` (version), `plugin/CHANGELOG.md` (new entry).
- **No changes** to `plugin/.claude-plugin/mcp.json`, `src/` (server-side), `dist/`, tests (no bridge tests exist today), build pipeline, release-please, or the Codex hooks/scripts subset.
- **End-user impact (Codex)**: users who already have a `.rembric` in their project root will see path-scoping start working on the next `codex` launch after `marketplace upgrade rembric` pulls `0.2.2`. Bridge stderr will show `[rembric-bridge] projectDir=<their-project> (from PWD) url=…/mcp/<slug>`. Users who launch `codex` from a directory without a `.rembric` see the same path-less behaviour as today (no regression).
- **End-user impact (Claude Code)**: zero behavioural change. `CLAUDE_PROJECT_DIR` continues to win the precedence chain.
- **Validation**: empirical smoke test after push — `codex plugin marketplace upgrade rembric` + relaunch from a project dir with `.rembric`, confirm `~/.codex/log/codex-tui.log` shows the real `/mcp/<slug>` URL and that the bridge picked the correct `projectDir`.
