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
- **AND** the `SessionStart` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh` (reused from the Claude Code plugin, which now performs the HTTP session create — Codex inherits that behavior automatically)
- **AND** the `UserPromptSubmit` hook SHALL declare the matcher `remember|recall|acordate|qué hicimos|what did we do` and invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh` (reused from the Claude Code plugin)

#### Scenario: Codex PreCompact wires to a HTTP-summary script

- **WHEN** the `PreCompact` hook fires
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh` (the SAME script as Claude Code, reused — no separate `pre-compact-codex.sh`)
- **AND** the script SHALL read `session_id` and the compact transcript from stdin, parse `.rembric` for the slug, and POST `/api/<slug>/sessions/<session_id>/summary` against the Rembric HTTP API
- **AND** the script SHALL exit zero even on internal error (`trap 'exit 0' ERR`) so a hook failure never aborts compaction
- **AND** the prior `plugin/scripts/pre-compact-codex.sh` SHALL be deleted (its stdout-nudge approach is obsoleted by the HTTP path that works identically for Claude Code and Codex)

#### Scenario: Codex Stop wires to a HTTP-end script

- **WHEN** the `Stop` hook fires
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.sh` (the SAME script as Claude Code — no separate `stop-codex.sh`)
- **AND** the script SHALL POST `/api/<slug>/sessions/<session_id>/end`
- **AND** the script SHALL exit zero even on internal error
- **AND** the prior `plugin/scripts/stop-codex.sh` SHALL be deleted

### Requirement: Codex hooks MUST receive `session_id` from stdin in the same JSON shape as Claude Code

The shared scripts `session-start.sh`, `pre-compact.sh`, and `session-stop.sh` SHALL read the hook stdin as a JSON object containing a `session_id` field (and `cwd` when relevant). Claude Code and Codex CLI both pass the host-session id in stdin JSON for `command`-type hooks.

If Codex passes the id under a different key (e.g. `sessionId`), the scripts SHALL prefer `session_id` and SHALL fall back to `sessionId` so the same script supports both clients without per-client forks. When neither field is present the scripts SHALL skip the HTTP call and exit `0`.

#### Scenario: Script reads stdin in both shapes

- **WHEN** the script receives stdin `{"session_id": "x"}` (Claude shape)
- **THEN** it SHALL extract `x` as the session id

- **WHEN** the script receives stdin `{"sessionId": "x"}` (Codex shape, if it differs)
- **THEN** it SHALL extract `x` as the session id

- **WHEN** the script receives stdin with neither field
- **THEN** it SHALL skip the HTTP call, emit a stderr diagnostic, and exit `0`

#### Scenario: Codex session id format may differ from Claude's

- **WHEN** Codex passes an id like `codex-2026-05-15-abc123`
- **THEN** the server's regex `^[A-Za-z0-9_-]{8,128}$` SHALL accept it
- **AND** the upsert SHALL succeed under the calling token's namespace

#### Scenario: Codex session id outside the allowed format

- **WHEN** Codex passes an id that contains characters outside `[A-Za-z0-9_-]` (theoretical; should not happen in practice)
- **THEN** the server SHALL respond `400 invalid_input`
- **AND** the script SHALL exit `0` (failure is silent at the hook level)

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
