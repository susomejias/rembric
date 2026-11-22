## MODIFIED Requirements

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
- **AND** the cached directory SHALL contain `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`, `hooks/hooks.codex.json`, and the relevant `scripts/` files
- **AND** the cached directory SHALL contain `mcp-bridge/`, with `cli.mjs` and every module it imports: Codex spawns the bridge from the installed plugin copy, so this directory is on the MCP path for this client

## REMOVED Requirements

### Requirement: Codex-specific MCP server configuration MUST spawn the pinned bridge through `npx`

**Reason**: The Codex manifest no longer spawns `@rembric/mcp-bridge` through `npx`. It runs `node ./mcp-bridge/cli.mjs` from the installed plugin directory, so the bridge comes from the same commit as the manifest and `@rembric/mcp-bridge` is no longer published. The title names `npx` and the `npx` resolution scenario no longer applies, so the requirement is re-added under a new title, "Codex-specific MCP server configuration MUST spawn the plugin-local bridge with `node`".

**Migration**: None required from users. An installation still running the `npx -y @rembric/mcp-bridge@<x.y.z>` entry keeps resolving that already-published version from npm until its next plugin update replaces the entry with the `node` form. Contributors no longer bump or assert a bridge pin in the Codex manifest.

## ADDED Requirements

### Requirement: Codex-specific MCP server configuration MUST spawn the plugin-local bridge with `node`

The Codex plugin SHALL ship its own MCP server configuration file at `apps/plugin/.codex-plugin/mcp.json`, sibling to the Claude Code plugin's `apps/plugin/.claude-plugin/mcp.json`. The two files diverge for two reasons. First, Codex's `Command::env_clear()` strips parent-env inheritance, so `env_vars` is the only channel by which anything reaches the spawned process (see `codex-rs/rmcp-client/src/utils.rs::create_env_for_mcp_server`). Second, path resolution: the Claude manifest names the bridge through `${CLAUDE_PLUGIN_ROOT}`, while this manifest names it by a path relative to the child's working directory.

The entry SHALL declare `command: "node"`, `args: ["./mcp-bridge/cli.mjs"]` and `cwd: "."`. With `cwd: "."`, Codex starts the child with its working directory set to the installed plugin directory, so the relative path resolves to the bridge shipped in that same plugin copy. The entry SHALL NOT spawn the bridge through `npx` or name a `@rembric/mcp-bridge` package specifier.

The `env_vars` list SHALL forward the user's shell `PWD` so the bridge can resolve the user's project directory: Codex's spawn semantics put `process.cwd()` at the plugin cache directory, which is not the project.

**`PATH` is not assumed.** `node` SHALL be resolved through the `PATH` present in the child's curated environment. Whether the launcher provides it SHALL be verified against a real Codex, and if a Codex release does not, `PATH` SHALL be added to `env_vars`. A manifest that spawns a program the curated environment cannot resolve fails at session start with an error the user cannot interpret.

#### Scenario: Codex MCP config file spawns the plugin-local bridge

- **WHEN** `apps/plugin/.codex-plugin/mcp.json` is loaded
- **THEN** the top-level object contains exactly one entry `mcpServers.rembric`
- **AND** the entry declares `command: "node"`
- **AND** the entry declares `args: ["./mcp-bridge/cli.mjs"]` and no further argument
- **AND** the entry declares `cwd: "."`
- **AND** the entry declares `env_vars` including `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN` and `PWD`
- **AND** the entry SHALL NOT declare an `env` field — Codex would treat any literal map values as opaque overrides that clobber `env_vars` reads

#### Scenario: `node` resolves on `PATH` under Codex's curated environment

- **WHEN** Codex spawns the entry with its `env_clear()` semantics
- **THEN** `node` SHALL be resolved through the `PATH` present in the child's environment
- **AND** if a Codex release stops providing `PATH` to the child, `env_vars` SHALL declare it
- **AND** this SHALL have been verified against a real Codex rather than inferred

#### Scenario: The relative bridge path resolves against the installed plugin directory

- **WHEN** Codex spawns the entry with `cwd: "."`
- **THEN** the child's working directory SHALL be the installed plugin directory under `~/.codex/plugins/cache/`
- **AND** `./mcp-bridge/cli.mjs` SHALL resolve to the bridge shipped in that plugin copy
- **AND** `PWD` in the child's environment SHALL remain the user's project directory, not the plugin directory

#### Scenario: env_vars forwards REMBRIC\_\* from the launching shell

- **WHEN** Codex spawns the bridge per `apps/plugin/.codex-plugin/mcp.json`
- **THEN** `create_env_for_mcp_server` SHALL read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from Codex's own process env
- **AND** the curated env passed to the subprocess SHALL contain those names with the user-supplied values
- **AND** the bridge SHALL build a real URL — e.g. `http://192.0.2.10:8787/mcp/<slug>` — not a placeholder literal

#### Scenario: env_vars forwards PWD so the bridge can resolve the user's project directory

- **WHEN** Codex spawns the bridge AND the shell that launched `codex` has `PWD` set
- **THEN** the curated env SHALL contain `PWD` with the shell's working directory
- **AND** the bridge's project-directory resolution SHALL pick `PWD` as the `projectDir`
- **AND** path-scoping via `${projectDir}/.rembric` SHALL function correctly when the user has launched `codex` from their project root

#### Scenario: The bridge surfaces a useful error when env vars are missing

- **WHEN** the user launches `codex` without exporting `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN`
- **THEN** Codex's `env_vars` mechanism silently skips names it cannot find
- **AND** the bridge SHALL exit non-zero with a clear stderr message instructing the user to export the variables

#### Scenario: The bearer is never in the argument vector

- **WHEN** the spawned process's `/proc/<pid>/cmdline` is inspected during a Codex session
- **THEN** the token's value SHALL NOT appear
- **AND** `args` SHALL contain only the relative bridge path `./mcp-bridge/cli.mjs`

#### Scenario: Claude Code MCP config remains a separate file

- **WHEN** the Claude Code plugin loads
- **THEN** it SHALL continue to load `apps/plugin/.claude-plugin/mcp.json`
- **AND** Claude Code's keychain-driven `${user_config.*}` substitution into the `env` map SHALL remain the canonical credential path under Claude Code

#### Scenario: Codex versions under the unified plugin track

- **WHEN** a contributor merges a commit modifying any file under `apps/plugin/` (a shared asset OR `apps/plugin/.codex-plugin/`)
- **THEN** release-please SHALL bump the single unified `plugin` component (tag `plugin-vX.Y.Z`), updating `apps/plugin/.codex-plugin/package.json::version` and `apps/plugin/.codex-plugin/plugin.json::version` (via the `plugin` component's `extra-files`) to the same version as every other client
