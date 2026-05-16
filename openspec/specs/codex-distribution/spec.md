# codex-distribution

Distribution and configuration of Rembric for Codex CLI. Defines the dual-manifest layout that lets one `plugin/` source tree serve both the Claude Code and Codex marketplaces, the Codex-specific hook subset, the marketplace declaration, and the credential flow given Codex's lack of a keychain-style `userConfig` prompt.

## Codex plugin manifest

### Requirement: Codex plugin manifest

The repository SHALL host a Codex plugin manifest at `plugin/.codex-plugin/plugin.json`, sibling to the existing `plugin/.claude-plugin/plugin.json`, declaring Codex's view of the shared `plugin/` tree.

#### Scenario: Required fields

- **WHEN** `plugin/.codex-plugin/plugin.json` is loaded
- **THEN** it contains `name: "rembric"`, a `version`, a `description`, `license: "MIT"`, `repository`, `homepage`, and an `author` block matching the Claude Code manifest
- **AND** it declares `mcpServers: "./.codex-plugin/mcp.json"` referencing the Codex-specific MCP config (NOT the Claude Code `mcp.json`)
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

## Codex-specific MCP server configuration

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

#### Scenario: env*vars forwards REMBRIC*\* from the launching shell to the bridge

- **WHEN** Codex spawns the bridge per `plugin/.codex-plugin/mcp.json`
- **THEN** `create_env_for_mcp_server` SHALL read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from Codex's own process env (the shell that launched `codex`)
- **AND** the curated env passed to the bridge subprocess (after `Command::env_clear()`) SHALL contain those names with the user-supplied values
- **AND** the bridge SHALL build a real URL — e.g. `http://192.168.20.48:8787/mcp/<slug>` — not a placeholder literal

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

## Credential flow

### Requirement: End-user credential flow

Codex install material SHALL document the credential flow given Codex's lack of a `userConfig` keychain prompt and Codex's `env_clear` behaviour on MCP subprocesses.

#### Scenario: Documented env-var requirement

- **WHEN** a user reads `docs/agents.md`'s Codex section
- **THEN** the doc SHALL state that Codex users MUST export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that launches `codex` — this is the canonical path under Codex, not a fallback
- **AND** the doc SHALL provide a literal `export REMBRIC_SERVER_URL=...; export REMBRIC_API_TOKEN=...` snippet
- **AND** the doc SHALL explain that the plugin's `env_vars` field is what forwards those vars to the bridge subprocess (citing `create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs` so future readers can verify), AND that Codex's `env_clear()` semantics make `env_vars` mandatory — there is no implicit inheritance from the parent shell

## Documentation

### Requirement: `docs/agents.md` recommends the plugin install as primary

The Codex section of `docs/agents.md` SHALL recommend the marketplace plugin install as the primary path, document the credential flow, document the platform-required enablement steps for plugin hooks (which Codex gates behind an under-development feature flag and a per-hook trust review as of `codex-cli 0.130.0`), and retain a manual `config.toml` fallback for users who do not want the plugin.

#### Scenario: Primary install path

- **WHEN** a reader opens the Codex section of `docs/agents.md`
- **THEN** the first install option SHALL be `codex plugin marketplace add <repo>` followed by `codex plugin install rembric`
- **AND** the section SHALL link to or summarise the env-var credential requirement

#### Scenario: Platform-required hook enablement

- **WHEN** a reader follows the Codex install flow in `docs/agents.md`
- **THEN** the doc SHALL document, after the install + env-var snippets, that two additional platform-required steps are necessary to make plugin-bundled hooks fire under `codex-cli 0.130.0`:
  - **Step 1**: enable the `plugin_hooks` feature with `codex features enable plugin_hooks`. The doc SHALL note that this feature is currently `under development` in Codex (default off) and that future Codex releases may default it on — readers should run `codex features list` to confirm before assuming.
  - **Step 2**: open `/hooks` inside Codex and trust each of the 4 plugin-bundled hooks (`SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`). Codex surfaces a startup banner of the form _"N hooks need review before they can run. Open `/hooks` to review them."_ — until each hook is trusted, it loads but does not execute.
- **AND** the doc SHALL note that the trust persists in `~/.codex/config.toml`'s `[hooks.state]` block; users do not need to re-approve hooks after every Codex restart, only once per hook handler.

#### Scenario: Symptom-to-cause troubleshooting table

- **WHEN** a reader scrolls the Codex section of `docs/agents.md` looking for a fix to a specific symptom
- **THEN** the doc SHALL include a "If you see X, the cause is Y" table covering the failure modes a Codex user actually observes:
  - `/dashboard/sessions` stays empty after running Codex sessions → `plugin_hooks` feature off OR hooks not yet trusted.
  - `/plugins` panel shows "No plugin hooks" → `plugin_hooks` feature off.
  - Startup banner "N hooks need review" appears repeatedly → hooks need `/hooks` review and per-hook approval.
- **AND** the table SHALL link the symptom rows to the relevant remediation step from the previous scenario.

#### Scenario: Manual fallback preserved

- **WHEN** the same section is read
- **THEN** a "manual config.toml, no plugin" appendix SHALL document the raw `[mcp_servers.rembric]` block using `transport = "streamable-http"` with a slug-hardcoded URL
- **AND** the appendix SHALL note that this path has no Codex hooks and no slug auto-resolution — the marketplace plugin install is the recommended path for those features
