## Why

The Codex plugin install completes successfully (marketplace add + plugin install) but the bridge **never starts**. The bridge subprocess crashes at `node` module resolution because Codex passes the path literal — `${CLAUDE_PLUGIN_ROOT}` is not substituted — and `env_vars` is missing so credentials can't reach the bridge anyway.

Diagnosed live against `codex-cli 0.130.0` (stderr captured in `~/.codex/log/codex-tui.log`):

```
2026-05-15T23:24:44 INFO MCP server stderr (node): Error: Cannot find module '<repo>/${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs'
```

Two distinct bugs, both confirmed against [openai/codex source](https://github.com/openai/codex/tree/main/codex-rs):

### Bug 1 — `${CLAUDE_PLUGIN_ROOT}` not substituted in `args`

`codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` is the only place plugin-loaded MCP configs get path resolution. It resolves the `cwd` field against `plugin_root`, but leaves `command` and `args` untouched. `CLAUDE_PLUGIN_ROOT` is injected as an ENV var elsewhere (`codex-rs/hooks/src/engine/discovery.rs`) but **only for hook commands**, not for MCP subprocesses.

Therefore `args: ["${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs"]` is passed verbatim to node. Node treats it as a relative path against its own cwd (the user's shell cwd) and resolves to `<cwd>/${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs` — a literal path that does not exist.

The original assumption (in CLAUDE.md and the archived `2026-05-15-add-codex-distribution` design.md: "Codex's hook engine honours `${CLAUDE_PLUGIN_ROOT}`") was over-extended from hooks to MCP. Hooks work because Codex sets `CLAUDE_PLUGIN_ROOT` as an env var visible to the shell-invoked hook command — the shell expands it. MCP servers are launched without a shell (direct `Command::new`), so no expansion happens.

### Bug 2 — credentials don't reach the bridge

Even if the path resolved correctly, the bridge would fail at URL construction because `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` would be missing.

`codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server` calls **`env_clear()`** before applying the configured env to the MCP subprocess. The subprocess does NOT inherit the parent shell's env. It only sees:

1. The curated `DEFAULT_ENV_VARS` (e.g. `PATH`, `HOME`).
2. Names listed in `env_vars` (each read from the parent shell at spawn via `env::var_os`).
3. Literal pairs from the `env` map.

The shared `plugin/.claude-plugin/mcp.json` uses `env: { REMBRIC_*: "${user_config.*}" }` — a Claude-Code-specific substitution syntax. Codex treats those as literal strings. So even without bug 1, Codex would set `REMBRIC_API_TOKEN=${user_config.api_token}` literally on the bridge, and the bridge would crash on the placeholder URL.

There is no `${user_config.*}` interpolation in the Codex binary — `userConfig` literally does not exist as a concept (verified by grepping the binary for both `user_config` and `userConfig`).

## What Changes

- **`plugin/.codex-plugin/mcp.json`** — NEW file, Codex-specific MCP server config. Two delta vs the shared `plugin/.claude-plugin/mcp.json`:
  - `cwd: "."` so Codex normalises the working directory to the plugin root, and `args: ["./bin/rembric-bridge.mjs"]` so node resolves the bridge path against that cwd (works around Codex's lack of `${CLAUDE_PLUGIN_ROOT}` substitution in args).
  - `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]` instead of an `env` map with `${user_config.*}` placeholders. Codex's documented mechanism for forwarding shell env vars into MCP subprocesses, given `env_clear()` strips inheritance otherwise.
- **`plugin/.codex-plugin/plugin.json`** — `mcpServers` field changes from `"./.claude-plugin/mcp.json"` to `"./.codex-plugin/mcp.json"`. Version bumps to `0.2.1`.
- **`plugin/.claude-plugin/plugin.json`** — version bumps to `0.2.1` (CLAUDE.md lockstep rule).
- **`plugin/CHANGELOG.md`** — `[0.2.1] — unreleased` entry capturing both bugs and their fixes.
- **`plugin/.claude-plugin/mcp.json`** — UNCHANGED. The `${user_config.*}` env block AND the `${CLAUDE_PLUGIN_ROOT}` args path are canonical Claude Code syntax and stay as-is.
- **`openspec/specs/codex-distribution/spec.md`** — see spec delta. The "Shared MCP server configuration" requirement is removed (its premise — that one file works under both clients — is now empirically falsified). Replaced by "Codex-specific MCP server configuration" with the correct `cwd` + `args` + `env_vars` contract.
- **`CLAUDE.md`** "Plugin development discipline" section already lists `mcp.codex.json` as a forced-divergence file. Tighten the prose to call out BOTH platform deltas (path substitution AND env injection), citing Codex's source by file/function.
- **`docs/agents.md`** Codex section — already reaffirms the env-var export. Add a note that path resolution depends on the plugin manifest's `cwd: "."` trick so future contributors don't try to "fix" it back to `${CLAUDE_PLUGIN_ROOT}`.

## Out of scope

- **Removing the `${user_config.*}` block from `plugin/.claude-plugin/mcp.json`.** Claude Code's keychain integration depends on it; the Claude Code install today works correctly and stays untouched.
- **Removing `${CLAUDE_PLUGIN_ROOT}` from `plugin/.claude-plugin/mcp.json` args.** Same reason — it's the canonical Claude Code syntax for the bridge path.
- **Adding a Codex-side keychain or wizard.** Codex's binary has no `userConfig` schema; nothing to opt into.
- **Migrating Claude Code to `cwd: "."` + relative args** for symmetry. Could be done, but introduces regression risk on the keychain prompt UX which threads through `${user_config.*}` in `env`.
- **Investigating "No plugin hooks" panel display.** Likely cache invalidation; the version bump will retrigger. If it persists, separate change.
- **Publishing `@susomejias/rembric-bridge` to npm.** Out of scope.

## Capabilities

### Modified Capabilities

- `codex-distribution` — the MCP server configuration requirement is replaced; the Codex plugin manifest's required-fields scenario gets the new mcpServers path.

## Impact

- **New paths**: `plugin/.codex-plugin/mcp.json`.
- **Touched paths**: `plugin/.codex-plugin/plugin.json` (mcpServers + version), `plugin/.claude-plugin/plugin.json` (version), `plugin/CHANGELOG.md`, `openspec/specs/codex-distribution/spec.md` (one requirement replaced, one tweaked), `CLAUDE.md` (plugin-discipline prose tighten), `docs/agents.md` (Codex section note).
- **No changes** to `src/`, `dist/`, tests, build pipeline, release-please, npm packaging, or the Claude Code plugin runtime path.
- **End-user impact**: Codex users currently seeing `Cannot find module '…${CLAUDE_PLUGIN_ROOT}…'` will need to `codex plugin marketplace upgrade rembric` once `0.2.1` lands on `main`, then re-launch `codex`. Provided `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are exported in the launching shell, the bridge will start and authenticate.
- **Validation**: empirical smoke test against `main` after push — `codex plugin marketplace upgrade rembric` followed by `codex`, confirm `~/.codex/log/codex-tui.log` shows `[rembric-bridge] cwd=… url=http://<host>:<port>/mcp/<slug>` and no node module errors. The cache-patching approach we tried fails because Codex regenerates the cache from the marketplace clone on launch.
