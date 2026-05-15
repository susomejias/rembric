## MODIFIED Requirements

### Requirement: Codex plugin manifest

The repository SHALL host a Codex plugin manifest at `plugin/.codex-plugin/plugin.json`, sibling to the existing `plugin/.claude-plugin/plugin.json`, declaring Codex's view of the shared `plugin/` tree.

#### Scenario: Required fields

- **WHEN** `plugin/.codex-plugin/plugin.json` is loaded
- **THEN** it contains `name: "rembric"`, a `version`, a `description`, `license: "MIT"`, `repository`, `homepage`, and an `author` block matching the Claude Code manifest
- **AND** it declares `mcpServers: "./mcp.codex.json"` referencing the Codex-specific MCP config (NOT the Claude Code `mcp.json`)
- **AND** it declares `hooks: "./hooks/hooks.codex.json"` referencing the Codex-specific hook file

#### Scenario: No skills declaration

- **WHEN** the Codex manifest is loaded
- **THEN** it SHALL NOT declare a `skills` field — protocol guidance is delivered server-side via `initialize.instructions`, matching the Claude Code plugin's behaviour

### Requirement: End-user credential flow

Codex install material SHALL document the credential flow given Codex's lack of a `userConfig` keychain prompt and Codex's `env_clear` behaviour on MCP subprocesses.

#### Scenario: Documented env-var requirement

- **WHEN** a user reads `docs/agents.md`'s Codex section
- **THEN** the doc SHALL state that Codex users MUST export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that launches `codex` — this is the canonical path under Codex, not a fallback
- **AND** the doc SHALL provide a literal `export REMBRIC_SERVER_URL=...; export REMBRIC_API_TOKEN=...` snippet
- **AND** the doc SHALL explain that the plugin's `env_vars` field is what forwards those vars to the bridge subprocess (citing `create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs` so future readers can verify), AND that Codex's `env_clear()` semantics make `env_vars` mandatory — there is no implicit inheritance from the parent shell

## REMOVED Requirements

### Requirement: Shared MCP server configuration

**Reason**: The previous spec required Codex and Claude Code to share `plugin/.claude-plugin/mcp.json`. Empirical verification against `codex-cli 0.130.0` and the authoritative Codex source proves this is impossible for two distinct reasons:

1. **Path substitution diverges.** Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in the `args` field of mcp.json. Codex does not — `codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` only resolves the `cwd` field against `plugin_root`. `${CLAUDE_PLUGIN_ROOT}` is injected as an env var only for hook commands (`codex-rs/hooks/src/engine/discovery.rs`). Node spawned with `args: ["${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs"]` under Codex receives the literal placeholder string and fails at module resolution.

2. **Env injection diverges.** Claude Code substitutes `${user_config.*}` in the `env` map at install time from keychain values. Codex has no `userConfig` schema and no `${user_config.*}` interpolation — values are passed verbatim. Worse: Codex does not inherit the full parent shell env into MCP subprocesses; `codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server` calls `Command::env_clear()` before applying a curated env built from `DEFAULT_ENV_VARS` + `env_vars` names + literal `env` map. So even removing the `${user_config.*}` block does not cause shell-env inheritance.

The shared-file assumption is replaced by the "Codex-specific MCP server configuration" requirement under ADDED.

**Migration**: install `plugin/.codex-plugin/mcp.json` (new file) and update `plugin/.codex-plugin/plugin.json:mcpServers` to reference it. The Claude Code `plugin/.claude-plugin/mcp.json` is unchanged.

## ADDED Requirements

### Requirement: Codex-specific MCP server configuration

The Codex plugin SHALL ship its own MCP server configuration file at `plugin/.codex-plugin/mcp.json`, sibling to the Claude Code plugin's `plugin/.claude-plugin/mcp.json`. The two files diverge in path resolution and env injection mechanism because Codex and Claude Code expose different MCP loader contracts.

#### Scenario: Codex MCP config file declares stdio bridge with plugin-root anchoring

- **WHEN** `plugin/.codex-plugin/mcp.json` is loaded
- **THEN** the top-level object contains exactly one entry `mcpServers.rembric`
- **AND** the entry declares `command: "node"`
- **AND** the entry declares `args: ["./bin/rembric-bridge.mjs"]` — a relative path under the plugin root
- **AND** the entry declares `cwd: "."` so Codex's `normalize_plugin_mcp_server_value` resolves the working directory to the plugin root (`plugin_root.join(".") = plugin_root`)
- **AND** the entry declares `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"]`
- **AND** the entry SHALL NOT declare an `env` field — Codex would treat any literal map values as opaque overrides that clobber `env_vars` reads

#### Scenario: Bridge resolves under Codex via plugin-root cwd

- **WHEN** Codex spawns the bridge per `plugin/.codex-plugin/mcp.json`
- **THEN** `LocalStdioServerLauncher::launch_server` SHALL set `current_dir` on the spawned `Command` to the plugin root (resolved from `cwd: "."`)
- **AND** node SHALL receive `./bin/rembric-bridge.mjs` as its script argument and resolve it relative to the cwd → `plugin_root/bin/rembric-bridge.mjs`
- **AND** the bridge SHALL start without `Cannot find module` errors

#### Scenario: env_vars forwards REMBRIC_* from the launching shell to the bridge

- **WHEN** Codex spawns the bridge per `plugin/.codex-plugin/mcp.json`
- **THEN** `create_env_for_mcp_server` SHALL read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from Codex's own process env (the shell that launched `codex`)
- **AND** the curated env passed to the bridge subprocess (after `Command::env_clear()`) SHALL contain those names with the user-supplied values
- **AND** the bridge SHALL build a real URL — e.g. `http://192.168.20.48:8787/mcp/<slug>` — not a placeholder literal

#### Scenario: Bridge surfaces a useful error when env vars are missing

- **WHEN** the user launches `codex` without exporting `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN`
- **THEN** Codex's `env_vars` mechanism silently skips names it cannot find (per `env::var_os(var).map(...)`)
- **AND** the bridge SHALL exit non-zero with a clear stderr message instructing the user to export the variables — preserving the diagnostic contract from the `claude-code-plugin` spec's "MCP bridge contract" requirement

#### Scenario: Claude Code MCP config is unaffected

- **WHEN** the Claude Code plugin loads
- **THEN** it SHALL continue to load `plugin/.claude-plugin/mcp.json` (unchanged)
- **AND** Claude Code's `${CLAUDE_PLUGIN_ROOT}` substitution in args SHALL keep working
- **AND** Claude Code's keychain-driven `${user_config.*}` substitution into the `env` map SHALL remain the canonical credential path under Claude Code

#### Scenario: Both plugin manifests version-bump in lockstep on every mcp config change

- **WHEN** either `plugin/.claude-plugin/mcp.json` or `plugin/.codex-plugin/mcp.json` is modified
- **THEN** the `version` field in BOTH `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json` SHALL be bumped in the same commit
- **AND** `plugin/CHANGELOG.md` SHALL gain a matching `[X.Y.Z] — <date>` heading describing the change
- **AND** the bump SHALL follow SemVer: patch for bug fixes (this change), minor for new behaviour, major for breaking changes to the credential or transport contract
