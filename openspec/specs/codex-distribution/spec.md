# codex-distribution

## Purpose

Distribution and configuration of Rembric for Codex CLI. Defines the dual-manifest layout that lets one `apps/plugin/` source tree serve both the Claude Code and Codex marketplaces, the Codex-specific hook subset, the marketplace declaration, and the credential flow given Codex's lack of a keychain-style `userConfig` prompt.

## Requirements

### Requirement: Codex plugin manifest

The repository SHALL host a Codex plugin manifest at `apps/plugin/.codex-plugin/plugin.json`, sibling to the existing `apps/plugin/.claude-plugin/plugin.json`, declaring Codex's view of the shared `apps/plugin/` tree.

#### Scenario: Required fields

- **WHEN** `apps/plugin/.codex-plugin/plugin.json` is loaded
- **THEN** it contains `name: "rembric"`, a `version`, a `description`, `license: "MIT"`, `repository`, `homepage`, and an `author` block matching the Claude Code manifest
- **AND** it declares `mcpServers: "./.codex-plugin/mcp.json"` referencing the Codex-specific MCP config (NOT the Claude Code `mcp.json`)
- **AND** it declares `hooks: "./hooks/hooks.codex.json"` referencing the Codex-specific hook file

#### Scenario: No skills declaration

- **WHEN** the Codex manifest is loaded
- **THEN** it SHALL NOT declare a `skills` field — protocol guidance is delivered server-side via `initialize.instructions`, matching the Claude Code plugin's behaviour

### Requirement: Codex marketplace declaration

The repository SHALL host a Codex marketplace manifest at `.codex-plugin/marketplace.json` at the repo root, installable via `codex plugin marketplace add <repo>`. The `source.path` entry SHALL point at `./apps/plugin` so the marketplace's `git-subdir` extraction targets the relocated plugin tree.

#### Scenario: git-subdir source

- **WHEN** `.codex-plugin/marketplace.json` is loaded
- **THEN** it declares exactly one plugin entry named `rembric`
- **AND** the entry's `source` object is `{ "source": "git-subdir", "url": "https://github.com/susomejias/rembric.git", "path": "./apps/plugin", "ref": "main" }`
- **AND** the entry declares `policy.installation: "AVAILABLE"` and `policy.authentication: "ON_INSTALL"` and `category: "Memory"`

#### Scenario: Marketplace metadata

- **WHEN** the marketplace is loaded
- **THEN** the top-level object contains `name: "rembric"` and `interface.displayName: "Rembric"`

#### Scenario: Marketplace install resolves the relocated plugin tree

- **GIVEN** a clean Codex CLI installation with no `rembric` plugin cached
- **WHEN** the user runs `codex plugin marketplace add https://github.com/susomejias/rembric.git` followed by `codex plugin add rembric@rembric`
- **THEN** Codex SHALL clone the repo, extract the subtree at `./apps/plugin` per the `source.path`, and cache it under `~/.codex/plugins/cache/rembric/<version>/`
- **AND** the cached directory SHALL contain `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`, `bin/rembric-bridge.mjs`, `bin/rembric-dotenv.mjs`, `hooks/hooks.codex.json`, and the relevant `scripts/` files

### Requirement: Codex hook configuration

The repository SHALL host Codex hook configuration at `apps/plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `apps/plugin/hooks/hooks.json`, declaring the Codex-supported events the plugin wires.

Codex's hook surface differs from Claude Code's in ways the platform forces, and has evolved since this requirement was first written:

- Codex has no `SessionEnd` event (verified against `developers.openai.com/codex/hooks`).
- Codex DOES support `PreCompact` and `PostCompact` events as of current `codex-cli` releases (verified against `codex-rs/hooks/src/schema.rs` at `codex-cli` 0.142.3+); the plugin wires both.
- Codex's `SessionStart` stdin carries a `source` field (`startup|resume|clear|compact`), and the dispatcher matches `SessionStart` matchers against it — so, as of current `codex-cli`, a `matcher: "compact"` group behaves the same way it does for Claude Code (stdout injected as developer context, no HTTP side effect). The plugin wires a second `SessionStart` matcher group for `"compact"`, reusing the same `post-compact.sh` script Claude Code's `SessionStart(compact)` hook uses, so Codex gets the same "persist the summary after compaction" model directive.
- Codex's `Stop` hook REQUIRES JSON on stdout: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event." Per official docs.

Codex's mapping of lifecycle events to HTTP endpoints still diverges from Claude Code's where the platform forces it (no `SessionEnd`; Codex sessions stay `active` until the `abandonStale` job flips them to `abandoned` — this remains the steady state for Codex sessions), but no longer diverges on compaction-related hook support.

#### Scenario: Hook event coverage

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL declare entries for `SessionStart` (with two matcher groups — one for the default/unmatched case, one for `"compact"`), `UserPromptSubmit`, `Stop`, `PreCompact`, and `PostCompact`
- **AND** the `hooks` object SHALL NOT contain `SessionEnd` (Codex does not support this event)
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the default `SessionStart` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh codex-cli` (reused from the Claude Code plugin; the `agent` arg differs)
- **AND** the `SessionStart` `"compact"` matcher group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh` (the same script Claude Code's `SessionStart(compact)` hook uses)
- **AND** the `UserPromptSubmit` hook SHALL declare the matcher `remember|recall|acuérdate|qué hicimos|what did we do` and invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh` (reused); because Codex's dispatcher does not filter `UserPromptSubmit` by matcher (unlike Claude Code's), `prompt-search.sh` itself SHALL apply the same keyword regex against the hook's stdin `prompt` field before proceeding, so the declared matcher and the script's own filtering agree on both clients
- **AND** the `PreCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh codex-cli`
- **AND** the `PostCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`

#### Scenario: Codex Stop wires to a per-turn summary writer

- **WHEN** the `Stop` hook fires (which it does once per agent turn under Codex semantics)
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.sh codex-cli` (Codex-only — Claude Code does NOT wire `Stop` in this version)
- **AND** the script SHALL read `session_id`, `cwd`, and `transcript_path` from stdin
- **AND** SHALL read `${cwd}/.rembric` for the slug
- **AND** SHALL read `transcript_path` if readable, format it via `_transcript.sh`, derive a title from the first non-empty assistant message (≤100 chars)
- **AND** SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}` — note: `/summary` NOT `/end`, because Codex Stop is per-turn and the session must stay `active` for the next turn to keep updating
- **AND** SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout; plain text is invalid per docs)
- **AND** SHALL exit zero even on internal error

#### Scenario: Codex sessions remain active until abandoned by sweep

- **GIVEN** a Codex session where Stop has fired N times
- **WHEN** the user closes Codex CLI
- **THEN** the session row SHALL remain `status='active'` (no SessionEnd signal to transition it)
- **AND** the `abandonStale` job (running per `SESSION_ABANDON_AFTER_MS`, default 24h) SHALL eventually flip the row to `status='abandoned'`
- **AND** the row's `summary` and `title` SHALL reflect the most recent Stop's POST (the latest transcript)

#### Scenario: Codex Stop output without JSON would fail the hook

- **GIVEN** a script that POSTs `/summary` correctly but emits plain text to stdout
- **WHEN** Codex receives that stdout
- **THEN** Codex SHALL flag the hook output as invalid (per the "Stop expects JSON" contract) and the hook SHALL be considered failed for that turn

#### Scenario: prompt-search.sh self-filters on Codex

- **GIVEN** the `UserPromptSubmit` hook fires on Codex for a prompt that does NOT match the recall-intent keywords
- **WHEN** `prompt-search.sh` runs (invoked regardless of the declared matcher, because Codex's dispatcher does not filter by matcher for this event)
- **THEN** the script SHALL detect the non-match against the prompt text from stdin and exit without emitting the recall nudge
- **AND** on Claude Code, where the matcher already filters invocation, the same script's self-filter SHALL be a harmless no-op re-check that still passes for matching prompts

#### Scenario: Compaction hooks are all correctly wired

- **WHEN** the repository is at HEAD after this change
- **THEN** `apps/plugin/scripts/pre-compact.sh`, `apps/plugin/scripts/post-compaction.sh`, and `apps/plugin/scripts/post-compact.sh` SHALL all exist
- **AND** `hooks.codex.json` SHALL reference `pre-compact.sh` from its `PreCompact` entry, `post-compaction.sh` from its `PostCompact` entry, and `post-compact.sh` from its `SessionStart` `"compact"` matcher group

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

### Requirement: Codex-specific MCP server configuration

The Codex plugin SHALL ship its own MCP server configuration file at `apps/plugin/.codex-plugin/mcp.json`, sibling to the Claude Code plugin's `apps/plugin/.claude-plugin/mcp.json`. The two files diverge in path resolution and env injection mechanism because Codex and Claude Code expose different MCP loader contracts (Codex does not substitute `${CLAUDE_PLUGIN_ROOT}` in `args`, and `Command::env_clear()` strips parent-env inheritance — see `codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` and `codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server`). The Codex-specific `env_vars` list also forwards the user's shell `PWD` so the bridge can resolve the user's project directory (Codex's spawn semantics put `process.cwd()` at the plugin cache dir, which is not the project).

#### Scenario: Codex MCP config file declares stdio bridge with plugin-root anchoring

- **WHEN** `apps/plugin/.codex-plugin/mcp.json` is loaded
- **THEN** the top-level object contains exactly one entry `mcpServers.rembric`
- **AND** the entry declares `command: "node"`
- **AND** the entry declares `args: ["./bin/rembric-bridge.mjs"]` — a relative path under the plugin root
- **AND** the entry declares `cwd: "."` so Codex's `normalize_plugin_mcp_server_value` resolves the working directory to the plugin root (`plugin_root.join(".") = plugin_root`)
- **AND** the entry declares `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN", "PWD"]`
- **AND** the entry SHALL NOT declare an `env` field — Codex would treat any literal map values as opaque overrides that clobber `env_vars` reads

#### Scenario: Bridge resolves under Codex via plugin-root cwd

- **WHEN** Codex spawns the bridge per `apps/plugin/.codex-plugin/mcp.json`
- **THEN** `LocalStdioServerLauncher::launch_server` SHALL set `current_dir` on the spawned `Command` to the plugin root (resolved from `cwd: "."`)
- **AND** node SHALL receive `./bin/rembric-bridge.mjs` as its script argument and resolve it relative to the cwd → `plugin_root/bin/rembric-bridge.mjs`
- **AND** the bridge SHALL start without `Cannot find module` errors

#### Scenario: env*vars forwards REMBRIC*\* from the launching shell to the bridge

- **WHEN** Codex spawns the bridge per `apps/plugin/.codex-plugin/mcp.json`
- **THEN** `create_env_for_mcp_server` SHALL read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from Codex's own process env
- **AND** the curated env passed to the bridge subprocess SHALL contain those names with the user-supplied values
- **AND** the bridge SHALL build a real URL — e.g. `http://192.0.2.10:8787/mcp/<slug>` — not a placeholder literal

#### Scenario: env_vars forwards PWD so the bridge can resolve the user's project directory

- **WHEN** Codex spawns the bridge per `apps/plugin/.codex-plugin/mcp.json` AND the shell that launched `codex` has `PWD` set
- **THEN** `create_env_for_mcp_server` SHALL read `PWD` from Codex's own process env
- **AND** the curated env passed to the bridge subprocess SHALL contain `PWD` with the shell's working directory
- **AND** the bridge's project-directory resolution SHALL pick `PWD` as the `projectDir`
- **AND** path-scoping via `${projectDir}/.rembric` SHALL function correctly when the user has launched `codex` from their project root

#### Scenario: Bridge surfaces a useful error when env vars are missing

- **WHEN** the user launches `codex` without exporting `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN`
- **THEN** Codex's `env_vars` mechanism silently skips names it cannot find
- **AND** the bridge SHALL exit non-zero with a clear stderr message instructing the user to export the variables

#### Scenario: Claude Code MCP config is unaffected

- **WHEN** the Claude Code plugin loads
- **THEN** it SHALL continue to load `apps/plugin/.claude-plugin/mcp.json` (unchanged behaviour)
- **AND** Claude Code's `${CLAUDE_PLUGIN_ROOT}` substitution in args SHALL keep working
- **AND** Claude Code's keychain-driven `${user_config.*}` substitution into the `env` map SHALL remain the canonical credential path under Claude Code

#### Scenario: Codex versions under the unified plugin track

- **WHEN** a contributor merges a commit modifying any file under `apps/plugin/` (a shared asset OR `apps/plugin/.codex-plugin/`)
- **THEN** release-please SHALL bump the single unified `plugin` component (tag `plugin-vX.Y.Z`), updating `apps/plugin/.codex-plugin/package.json::version` and `apps/plugin/.codex-plugin/plugin.json::version` (via the `plugin` component's `extra-files`) to the same version as every other client
- **AND** there SHALL be no separate `codex-plugin` component, no `codex-plugin-v*` tag, and no `node-workspace` cascade
- **AND** the server image SHALL NOT be rebuilt

### Requirement: End-user credential flow

Codex install material SHALL document the credential flow given Codex's lack of a `userConfig` keychain prompt and Codex's `env_clear` behaviour on MCP subprocesses.

#### Scenario: Documented env-var requirement

- **WHEN** a user reads `docs/agents.md`'s Codex section
- **THEN** the doc SHALL state that Codex users MUST export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that launches `codex` — this is the canonical path under Codex, not a fallback
- **AND** the doc SHALL provide a literal `export REMBRIC_SERVER_URL=...; export REMBRIC_API_TOKEN=...` snippet
- **AND** the doc SHALL explain that the plugin's `env_vars` field is what forwards those vars to the bridge subprocess (citing `create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs` so future readers can verify), AND that Codex's `env_clear()` semantics make `env_vars` mandatory — there is no implicit inheritance from the parent shell

### Requirement: `docs/agents.md` recommends the plugin install as primary

The Codex section of `docs/agents.md` SHALL recommend the **TUI installer** (`apps/plugin/install.sh` / the root shim) as the primary install path. It SHALL retain the Codex marketplace plugin install (`codex plugin marketplace add … && codex plugin add rembric@rembric`) and the manual `config.toml` fallback, but both SHALL appear under an explicitly-labelled "Manual / advanced" subsection, not as the lead instruction. The section SHALL document the credential flow, and the platform-required per-hook trust review (Codex hooks are stable and enabled by default as of current `codex-cli` releases; no feature flag needs to be enabled). The "trust each of the N plugin-bundled hooks" guidance SHALL enumerate the FIVE hook event types (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`).

#### Scenario: Codex section leads with the TUI installer

- **WHEN** a reader opens the Codex section of `docs/agents.md`
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** the `codex plugin marketplace add` / `codex plugin add` commands and the manual `config.toml` SHALL appear only under a manual / advanced heading

#### Scenario: Platform-required hook trust review enumerates five hook types

- **WHEN** a reader follows the Codex install flow in `docs/agents.md`
- **THEN** the doc SHALL document, after the install + env-var snippets, that opening `/hooks` inside Codex and trusting each of the 5 plugin-bundled hook types (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`) is the only platform-required step remaining — Codex surfaces a startup banner of the form _"N hooks need review before they can run. Open `/hooks` to review them."_ — until each hook type is trusted, it loads but does not execute
- **AND** the doc SHALL NOT instruct readers to run `codex features enable plugin_hooks` (that feature flag was removed upstream; hooks are stable and on by default)
- **AND** the doc SHALL note that the trust persists in `~/.codex/config.toml`'s `[hooks.state]` block; users do not need to re-approve hooks after every Codex restart, only once per hook handler

(Other scenarios within this requirement remain unchanged.)
