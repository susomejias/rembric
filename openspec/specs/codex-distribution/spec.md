# codex-distribution

Distribution and configuration of Rembric for Codex CLI. Defines the dual-manifest layout that lets one `plugin/` source tree serve both the Claude Code and Codex marketplaces, the Codex-specific hook subset, the marketplace declaration, and the credential flow given Codex's lack of a keychain-style `userConfig` prompt.

## Codex plugin manifest

### Requirement: Codex plugin manifest

The repository SHALL host a Codex plugin manifest at `plugin/.codex-plugin/plugin.json`, sibling to the existing `plugin/.claude-plugin/plugin.json`, declaring Codex's view of the shared `plugin/` tree.

#### Scenario: Required fields

- **WHEN** `plugin/.codex-plugin/plugin.json` is loaded
- **THEN** it contains `name: "rembric"`, a `version`, a `description`, `license: "MIT"`, `repository`, `homepage`, and an `author` block matching the Claude Code manifest
- **AND** it declares `mcpServers: "./mcp.json"` referencing the shared MCP config used by the Claude Code plugin
- **AND** it declares `hooks: "./hooks/hooks.codex.json"` referencing the Codex-specific hook file

#### Scenario: No skills declaration

- **WHEN** the Codex manifest is loaded
- **THEN** it SHALL NOT declare a `skills` field — protocol guidance is delivered server-side via `initialize.instructions`, matching the Claude Code plugin's behaviour

## Marketplace declaration

### Requirement: Codex marketplace declaration

The repository SHALL host a Codex marketplace manifest at `.codex-plugin/marketplace.json` at the repo root, installable via `codex plugin marketplace add <repo>`.

#### Scenario: git-subdir source

- **WHEN** `.codex-plugin/marketplace.json` is loaded
- **THEN** it declares exactly one plugin entry named `rembric`
- **AND** the entry's `source` object is `{ "source": "git-subdir", "url": "git@github.com:susomejias/rembric.git", "path": "./plugin", "ref": "main" }`
- **AND** the entry declares `policy.installation: "AVAILABLE"` and `policy.authentication: "ON_INSTALL"` and `category: "Memory"`

#### Scenario: Marketplace metadata

- **WHEN** the marketplace is loaded
- **THEN** the top-level object contains `name: "rembric"` and `interface.displayName: "Rembric"`

## Hook configuration

### Requirement: Codex hook configuration

The repository SHALL host Codex hook configuration at `plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `plugin/hooks/hooks.json`, declaring the four Codex-supported events the plugin wires.

#### Scenario: Hook event coverage

- **WHEN** `plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object declares entries for `SessionStart`, `UserPromptSubmit`, `PreCompact`, and `Stop`
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the `SessionStart` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh` (reused from the Claude Code plugin)
- **AND** the `UserPromptSubmit` hook SHALL declare the matcher `remember|recall|acordate|qué hicimos|what did we do` and invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh` (reused from the Claude Code plugin)

#### Scenario: Codex PreCompact wires to a stdout nudge

- **WHEN** the `PreCompact` hook fires
- **THEN** the hook invokes `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact-codex.sh`
- **AND** the script writes a single-line stdout instruction telling the agent to call `memory.session_summary({ auto: true })` before any other tool call
- **AND** the script SHALL exit zero even on internal error (`trap 'exit 0' ERR`) so a hook failure never aborts compaction

#### Scenario: Codex Stop wires to a session-close reminder

- **WHEN** the `Stop` hook fires
- **THEN** the hook invokes `${CLAUDE_PLUGIN_ROOT}/scripts/stop-codex.sh`
- **AND** the script writes a single-line stdout nudge instructing the agent to call `memory.session_summary` if not already done
- **AND** the script SHALL exit zero even on internal error

## Shared MCP server configuration

### Requirement: Shared MCP server configuration

The Codex plugin SHALL reuse the existing `plugin/mcp.json` (declared by the Claude Code plugin) without duplication.

#### Scenario: Bridge invocation under Codex

- **WHEN** Codex spawns the `rembric` MCP server per `plugin/mcp.json`
- **THEN** the spawn command resolves `${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs` against Codex's plugin-root resolver (which honours the same variable name)
- **AND** the bridge process inherits `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from either `${user_config.server_url}` / `${user_config.api_token}` interpolation (when Codex supports it) or from the shell environment of the process that launched `codex` (when interpolation is unavailable)

## Credential flow

### Requirement: End-user credential flow

Codex install material SHALL document the credential flow given Codex's lack of a `userConfig` keychain prompt.

#### Scenario: Documented env-var fallback

- **WHEN** a user reads `docs/agents.md`'s Codex section
- **THEN** the doc SHALL state that Codex users export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that launches `codex` if Codex's `${user_config.X}` interpolation does not resolve under the plugin
- **AND** the doc SHALL provide a literal `export REMBRIC_SERVER_URL=...; export REMBRIC_API_TOKEN=...` snippet

## Documentation

### Requirement: `docs/agents.md` recommends the plugin install as primary

The Codex section of `docs/agents.md` SHALL recommend the marketplace plugin install as the primary path, with a manual `config.toml` fallback retained for users who do not want the plugin.

#### Scenario: Primary install path

- **WHEN** a reader opens the Codex section of `docs/agents.md`
- **THEN** the first install option SHALL be `codex plugin marketplace add <repo>` followed by `codex plugin install rembric`
- **AND** the section SHALL link to or summarise the env-var credential requirement

#### Scenario: Manual fallback preserved

- **WHEN** the same section is read
- **THEN** a "manual config.toml, no plugin" appendix SHALL document the raw `[mcp_servers.rembric]` block using `transport = "streamable-http"` with a slug-hardcoded URL
- **AND** the appendix SHALL note that this path has no Codex hooks and no slug auto-resolution — the marketplace plugin install is the recommended path for those features
