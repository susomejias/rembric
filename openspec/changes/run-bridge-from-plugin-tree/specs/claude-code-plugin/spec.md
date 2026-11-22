## MODIFIED Requirements

### Requirement: MCP server declaration

- `apps/plugin/.claude-plugin/mcp.json` SHALL declare a single MCP server entry named `rembric`.
- The server entry SHALL use `command: "node"` with `args: ["${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs"]`, spawning the bridge shipped in the installed plugin copy as a stdio MCP server. Claude Code expands `${CLAUDE_PLUGIN_ROOT}` to the directory of that copy.
- The bridge SHALL receive `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` via `env`, sourced from `${user_config.server_url}` and `${user_config.api_token}` respectively. No other argument or environment value is required, and the bearer SHALL NOT appear in `args` — a process argument vector is readable by any local process via `ps` and `/proc/<pid>/cmdline`.
- The plugin SHALL NOT use a direct `type: "http"` MCP server entry. A stdio child is what allows the URL to be path-scoped with the slug read from `.rembric` at session start, per directory, which a static manifest cannot express — and it is what allows a bearer held in the system keychain to be injected without writing it into a config file.
- Because the manifest and the bridge files both ship inside the plugin tree, a plugin update replaces the entry and the bridge files together, so the bridge a manifest launches always comes from the same commit as that manifest.
- The entry SHALL NOT spawn the bridge through `npx` or name a `@rembric/mcp-bridge` package specifier, so starting the MCP server never depends on a package registry.
- The advisory server-version handshake — one fire-and-forget `GET /healthz`, warn-never-block — is specified by `mcp-bridge`. It SHALL exist exactly once across the plugin tree, inside the bridge, and this capability SHALL NOT restate or duplicate it.

#### Scenario: The manifest spawns the pinned bridge with no arguments beyond the specifier

- **WHEN** `apps/plugin/.claude-plugin/mcp.json` is read
- **THEN** the top-level object SHALL contain exactly one entry `mcpServers.rembric`
- **AND** the entry SHALL declare `command: "node"` and `args: ["${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs"]`, with the bridge script path as the only argument
- **AND** `args` SHALL contain no URL, no `--header` and no `--allow-http`
- **AND** neither `command` nor `args` SHALL name `npx` or a `@rembric/mcp-bridge` package specifier

#### Scenario: Credentials reach the bridge through `env`, not `args`

- **WHEN** the entry is read
- **THEN** `env` SHALL map `REMBRIC_SERVER_URL` to `${user_config.server_url}` and `REMBRIC_API_TOKEN` to `${user_config.api_token}`
- **AND** neither value SHALL appear anywhere in `args`

#### Scenario: No direct HTTP entry

- **WHEN** the manifest is read
- **THEN** it SHALL NOT declare a `type: "http"` server entry
- **AND** the reason SHALL remain that per-directory path scoping and keychain-held bearer injection require a stdio child

#### Scenario: A plugin version is never installable without its bridge

- **WHEN** a plugin release commit lands on `main` and that plugin version becomes installable from the marketplace
- **THEN** the installed plugin copy SHALL contain `mcp-bridge/cli.mjs` and every module it imports, from that same commit
- **AND** the MCP server SHALL start from those files without waiting for any package to be published to a registry

#### Scenario: The advisory version check is not duplicated here

- **WHEN** the Claude Code plugin's shipped files are inspected
- **THEN** none outside `apps/plugin/mcp-bridge/` SHALL issue a `GET /healthz` request
- **AND** the single implementation SHALL be the one inside the bridge in `apps/plugin/mcp-bridge/`

## REMOVED Requirements

### Requirement: The plugin manifests MUST pin the `@rembric/mcp-bridge` version

**Reason**: `apps/plugin/.claude-plugin/mcp.json` no longer spawns the bridge through `npx` and no longer names a package version. It runs `node ${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs`, the bridge shipped in the same plugin tree and commit as the manifest, so there is no floating tag to re-resolve at session start and no pin for release-please to carry. The plugin no longer depends on the published `@rembric/mcp-bridge` package, which stays published for hand-written configurations, and the `mcp.json` pin carrier is removed from release-please `extra-files`. The guarantee that the advisory version check exists once and is not duplicated moves into "MCP server declaration".

**Migration**: None required from users. An installation still running the `npx -y @rembric/mcp-bridge@<x.y.z>` entry keeps resolving that already-published version from npm until its next plugin update replaces the entry with the `node` form. Contributors no longer bump or assert a bridge pin in the Claude manifest.
