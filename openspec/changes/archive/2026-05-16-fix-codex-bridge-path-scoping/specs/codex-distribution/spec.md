## MODIFIED Requirements

### Requirement: Codex-specific MCP server configuration

The Codex plugin SHALL ship its own MCP server configuration file at `plugin/.codex-plugin/mcp.json`, sibling to the Claude Code plugin's `plugin/.claude-plugin/mcp.json`. The two files diverge in path resolution and env injection mechanism because Codex and Claude Code expose different MCP loader contracts (Codex does not substitute `${CLAUDE_PLUGIN_ROOT}` in `args`, and `Command::env_clear()` strips parent-env inheritance — see `codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` and `codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server`). The Codex-specific `env_vars` list also forwards the user's shell `PWD` so the bridge can resolve the user's project directory (Codex's spawn semantics put `process.cwd()` at the plugin cache dir, which is not the project).

#### Scenario: Codex MCP config file declares stdio bridge with plugin-root anchoring

- **WHEN** `plugin/.codex-plugin/mcp.json` is loaded
- **THEN** the top-level object contains exactly one entry `mcpServers.rembric`
- **AND** the entry declares `command: "node"`
- **AND** the entry declares `args: ["./bin/rembric-bridge.mjs"]` — a relative path under the plugin root
- **AND** the entry declares `cwd: "."` so Codex's `normalize_plugin_mcp_server_value` resolves the working directory to the plugin root (`plugin_root.join(".") = plugin_root`)
- **AND** the entry declares `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN", "PWD"]`
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
- **AND** the bridge SHALL build a real URL — e.g. `http://192.0.2.10:8787/mcp/<slug>` — not a placeholder literal

#### Scenario: env_vars forwards PWD so the bridge can resolve the user's project directory

- **WHEN** Codex spawns the bridge per `plugin/.codex-plugin/mcp.json` AND the shell that launched `codex` has `PWD` set (POSIX shell convention — `bash`, `zsh`, `fish` all set it)
- **THEN** `create_env_for_mcp_server` SHALL read `PWD` from Codex's own process env
- **AND** the curated env passed to the bridge subprocess SHALL contain `PWD` with the shell's working directory
- **AND** the bridge's project-directory resolution (per the `claude-code-plugin` capability's MCP bridge contract) SHALL pick `PWD` as the `projectDir` (since Codex never sets `CLAUDE_PROJECT_DIR`)
- **AND** path-scoping via `${projectDir}/.rembric` SHALL function correctly when the user has launched `codex` from their project root

#### Scenario: Bridge surfaces a useful error when env vars are missing

- **WHEN** the user launches `codex` without exporting `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN`
- **THEN** Codex's `env_vars` mechanism silently skips names it cannot find (per `env::var_os(var).map(...)`)
- **AND** the bridge SHALL exit non-zero with a clear stderr message instructing the user to export the variables — preserving the diagnostic contract from the `claude-code-plugin` spec's "MCP bridge contract" requirement

#### Scenario: Claude Code MCP config is unaffected

- **WHEN** the Claude Code plugin loads
- **THEN** it SHALL continue to load `plugin/.claude-plugin/mcp.json` (unchanged behaviour)
- **AND** Claude Code's `${CLAUDE_PLUGIN_ROOT}` substitution in args SHALL keep working
- **AND** Claude Code's keychain-driven `${user_config.*}` substitution into the `env` map SHALL remain the canonical credential path under Claude Code

#### Scenario: Both plugin manifests version-bump in lockstep on every mcp config change

- **WHEN** either `plugin/.claude-plugin/mcp.json` or `plugin/.codex-plugin/mcp.json` is modified
- **THEN** the `version` field in BOTH `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json` SHALL be bumped in the same commit
- **AND** `plugin/CHANGELOG.md` SHALL gain a matching `[X.Y.Z] — <date>` heading describing the change
- **AND** the bump SHALL follow SemVer: patch for bug fixes, minor for new behaviour, major for breaking changes to the credential or transport contract
