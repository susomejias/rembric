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
- **AND** it SHALL NOT be required to contain `bin/rembric-bridge.mjs` or a dotenv module: Codex spawns the published bridge through `npx`, so no repository file is on the MCP path for this client

## ADDED Requirements

### Requirement: Codex-specific MCP server configuration MUST spawn the pinned bridge through `npx`

The Codex plugin SHALL ship its own MCP server configuration file at `apps/plugin/.codex-plugin/mcp.json`, sibling to the Claude Code plugin's `apps/plugin/.claude-plugin/mcp.json`. The two files still diverge, but for one reason rather than two: Codex's `Command::env_clear()` strips parent-env inheritance, so `env_vars` is the only channel by which anything reaches the spawned process (see `codex-rs/rmcp-client/src/utils.rs::create_env_for_mcp_server`). The path-resolution divergence disappears — neither manifest names a repository file any more, because both spawn the published `@rembric/mcp-bridge` through `npx`.

The `env_vars` list SHALL forward the user's shell `PWD` so the bridge can resolve the user's project directory: Codex's spawn semantics put `process.cwd()` at the plugin cache directory, which is not the project.

**`PATH` forwarding is not optional and is not assumed.** `command: "node"` working under `env_clear()` is not evidence that `command: "npx"` will: `npx` must itself be locatable and must locate `node`. Whether the launcher's program resolution suffices SHALL be **verified against a real Codex before this manifest is switched**, and if it does not, `PATH` SHALL be added to `env_vars`. A manifest that spawns a program the curated environment cannot resolve fails at session start with an error the user cannot interpret.

#### Scenario: Codex MCP config file spawns the pinned bridge

- **WHEN** `apps/plugin/.codex-plugin/mcp.json` is loaded
- **THEN** the top-level object contains exactly one entry `mcpServers.rembric`
- **AND** the entry declares `command: "npx"`
- **AND** the entry declares `args: ["-y", "@rembric/mcp-bridge@<x.y.z>"]` with an exact version and no further argument
- **AND** the entry declares `env_vars` including `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN` and `PWD`
- **AND** the entry SHALL NOT declare an `env` field — Codex would treat any literal map values as opaque overrides that clobber `env_vars` reads

#### Scenario: `npx` resolves under Codex's curated environment

- **WHEN** Codex spawns the entry with its `env_clear()` semantics
- **THEN** `npx` SHALL be locatable and SHALL be able to spawn `node`
- **AND** if that requires `PATH` in `env_vars`, `env_vars` SHALL declare it
- **AND** this SHALL have been verified against a real Codex rather than inferred from the previous `command: "node"` entry working

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
- **AND** `args` SHALL contain only `-y` and the pinned package specifier

#### Scenario: Claude Code MCP config remains a separate file

- **WHEN** the Claude Code plugin loads
- **THEN** it SHALL continue to load `apps/plugin/.claude-plugin/mcp.json`
- **AND** Claude Code's keychain-driven `${user_config.*}` substitution into the `env` map SHALL remain the canonical credential path under Claude Code
- **AND** the two manifests SHALL agree on the pinned bridge version, both being carriers of the same plugin version

#### Scenario: Codex versions under the unified plugin track

- **WHEN** a contributor merges a commit modifying any file under `apps/plugin/` (a shared asset OR `apps/plugin/.codex-plugin/`)
- **THEN** release-please SHALL bump the single unified `plugin` component (tag `plugin-vX.Y.Z`), updating `apps/plugin/.codex-plugin/package.json::version` and `apps/plugin/.codex-plugin/plugin.json::version` (via the `plugin` component's `extra-files`) to the same version as every other client

## REMOVED Requirements

### Requirement: Codex-specific MCP server configuration

**Reason**: This requirement's whole contract is a relative script path inside the Codex plugin cache — `command: "node"`, `args: ["./bin/rembric-bridge.mjs"]`, `cwd: "."` — and two of its six scenarios exist only to specify how that path resolves. After this change no repository file is on the MCP path for this client at all: the manifest spawns the published `@rembric/mcp-bridge` through `npx`, so there is nothing to anchor to the plugin root and nothing for `cwd` to resolve. The opening paragraph is falsified in the same move — the two client manifests no longer "diverge in path resolution", because neither names a path; only the env-injection divergence survives, and it survives for a different reason than the one recorded here.

A MODIFIED block cannot express that. `openspec archive` refuses to merge a MODIFIED whose block drops a published scenario, and the two path-resolution scenarios cannot honestly be kept: a scenario titled "Bridge resolves under Codex via plugin-root cwd" whose body denies that any resolution happens is worse published text than an explicit removal. This is the same refactor `2026-05-16-fix-codex-mcp-env` performed on this capability when it removed "Shared MCP server configuration" — its premise, that one file works under both clients, having been empirically falsified — and published a differently-titled replacement.

**Migration**: Everything still true is re-published, in this same delta, under "Codex-specific MCP server configuration MUST spawn the pinned bridge through `npx`" (ADDED):

- the file's location and its sibling relationship to `apps/plugin/.claude-plugin/mcp.json`, unchanged;
- the surviving half of the divergence — Codex's `Command::env_clear()` makes `env_vars` the only channel by which anything reaches the spawned process — with its `codex-rs` citation retained;
- the `PWD` forwarding rule and its reason (Codex's spawn semantics put `process.cwd()` at the plugin cache directory, which is not the project), together with the scenario `env_vars forwards PWD so the bridge can resolve the user's project directory` under its published title;
- `env_vars forwards REMBRIC_* from the launching shell to the bridge` and `Bridge surfaces a useful error when env vars are missing`, retitled but unchanged in substance;
- `Claude Code MCP config is unaffected`, as `Claude Code MCP config remains a separate file`. Its `${user_config.*}` keychain clause survives verbatim in substance; its `${CLAUDE_PLUGIN_ROOT}` substitution clause does not, because the Claude Code manifest stops using `${CLAUDE_PLUGIN_ROOT}` in this same change and a scenario asserting that substitution "SHALL keep working" would then be false.

Retired with no replacement, deliberately: `Codex MCP config file declares stdio bridge with plugin-root anchoring` (superseded by `Codex MCP config file spawns the pinned bridge`, which specifies the `npx` form and the absence of a bearer in `args`) and `Bridge resolves under Codex via plugin-root cwd` (nothing is resolved relative to the plugin root once `args` names a package specifier rather than a script). What replaces the second is the new scenario `` `npx` resolves under Codex's curated environment ``, which is the resolution question that actually exists under `env_clear()` and which this change requires to be verified against a real Codex rather than inferred.
