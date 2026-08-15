## MODIFIED Requirements

### Requirement: MCP server declaration

- `apps/plugin/.claude-plugin/mcp.json` SHALL declare a single MCP server entry named `rembric`.
- The server entry SHALL use `command: "npx"` with `args: ["-y", "@rembric/mcp-bridge@<x.y.z>"]`, spawning the published bridge as a stdio MCP server. The version SHALL be exact (see "The plugin manifests MUST pin the `@rembric/mcp-bridge` version" below).
- The bridge SHALL receive `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` via `env`, sourced from `${user_config.server_url}` and `${user_config.api_token}` respectively. No other argument or environment value is required, and the bearer SHALL NOT appear in `args` — a process argument vector is readable by any local process via `ps` and `/proc/<pid>/cmdline`.
- The plugin SHALL NOT use a direct `type: "http"` MCP server entry. A stdio child is what allows the URL to be path-scoped with the slug read from `.rembric` at session start, per directory, which a static manifest cannot express — and it is what allows a bearer held in the system keychain to be injected without writing it into a config file.
- Because the manifest ships inside the plugin tree, a plugin update replaces the entry and the pin together, so the version named here and the version published for that release are written by the same release.

#### Scenario: The manifest spawns the pinned bridge with no arguments beyond the specifier

- **WHEN** `apps/plugin/.claude-plugin/mcp.json` is read
- **THEN** the top-level object SHALL contain exactly one entry `mcpServers.rembric`
- **AND** the entry SHALL declare `command: "npx"` and `args: ["-y", "@rembric/mcp-bridge@<x.y.z>"]` with an exact version
- **AND** `args` SHALL contain no URL, no `--header` and no `--allow-http`

#### Scenario: Credentials reach the bridge through `env`, not `args`

- **WHEN** the entry is read
- **THEN** `env` SHALL map `REMBRIC_SERVER_URL` to `${user_config.server_url}` and `REMBRIC_API_TOKEN` to `${user_config.api_token}`
- **AND** neither value SHALL appear anywhere in `args`

#### Scenario: No direct HTTP entry

- **WHEN** the manifest is read
- **THEN** it SHALL NOT declare a `type: "http"` server entry
- **AND** the reason SHALL remain that per-directory path scoping and keychain-held bearer injection require a stdio child

### Requirement: The plugin manifests MUST pin the `@rembric/mcp-bridge` version

Every place the plugin spawns the bridge SHALL name an exact pinned version (`@rembric/mcp-bridge@<x.y.z>`), never a floating tag such as `@latest`. For this capability that means `apps/plugin/.claude-plugin/mcp.json`; the Codex manifest and the opencode compatibility launcher carry the same obligation in their own capabilities, and the obligation itself is owned by `mcp-bridge`.

`npx` re-resolves a floating tag on every session start, so with `@latest` a compromise of the publishing account would be arbitrary code execution on every user machine at the next session start. Owning the package makes this stricter, not laxer.

The pin SHALL be written by release-please as a version carrier of the unified `plugin` component, never bumped by hand, so a manifest cannot name a version that was never published. Where the file format cannot carry a release-please annotation, the pin SHALL still be asserted equal to `apps/plugin/package.json::version` by an executable check rather than left to review.

The advisory server-version handshake this requirement previously specified — one fire-and-forget `GET /healthz`, warn-never-block — has moved to the bridge and is specified by `mcp-bridge`. It SHALL exist exactly once across the plugin tree, and this capability SHALL NOT restate or duplicate it.

#### Scenario: Session start does not re-resolve `latest`

- **WHEN** the Claude Code plugin manifest is read
- **THEN** the npx argument SHALL name an exact `@rembric/mcp-bridge@<x.y.z>` version, so a newly published release cannot change behavior without a Rembric plugin release

#### Scenario: A compromised publish does not reach existing installations

- **WHEN** a malicious or broken `@rembric/mcp-bridge` version is published to npm
- **THEN** existing Rembric installations SHALL be unaffected (they keep spawning the pinned version)
- **AND** reaching them SHALL require a deliberate plugin release that bumps the pin

#### Scenario: The pin is written by release-please, not by hand

- **WHEN** a plugin release is cut
- **THEN** the manifest's pinned version and `apps/plugin/mcp-bridge/package.json::version` SHALL both be updated to the new plugin version
- **AND** they SHALL agree with each other and with the `plugin-vX.Y.Z` tag

#### Scenario: The advisory version check is not duplicated here

- **WHEN** the Claude Code plugin's shipped files are inspected
- **THEN** none SHALL issue a `GET /healthz` request
- **AND** the single implementation SHALL be the one inside `@rembric/mcp-bridge`

## REMOVED Requirements

### Requirement: MCP bridge contract

**Reason**: This requirement described `rembric-bridge.mjs` as a wrapper around a third-party transport engine — a script whose job was to compute a URL for a program that could not be told to read a `.rembric` file itself. With the engine owned and published as `@rembric/mcp-bridge`, that wrapper has no independent purpose, and it carried real cost: `spawn`, a `stdio: 'inherit'` relay, spawn-error handling, exit-code forwarding, terminating-signal re-raising, and one extra node process per session (`node(rembric-bridge.mjs) → npx → node(mcp-remote)` becomes `npx → node(@rembric/mcp-bridge)`).

**Migration**: Every behaviour this requirement specified is re-homed in the `mcp-bridge` capability — the same role under the same name, now owned by the published package rather than by a local script — unchanged in effect: the `CLAUDE_PROJECT_DIR > PWD > process.cwd()` chain with empty-string skipping; `.rembric` parsing and slug validation against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`; the path-scoped `${REMBRIC_SERVER_URL}/mcp/<slug>` URL; the fall-back-to-path-less-never-abort rule with its one-line stderr diagnostic; the startup diagnostic naming which step of the chain resolved the directory; and the non-zero exit with a clear message when `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` is missing.

Three items do **not** carry over, deliberately. The child-process behaviours (exit-code forwarding and signal re-raising) have no subject, since nothing is spawned. `--allow-http` is deleted with no replacement: the bridge accepts plain HTTP unconditionally, because LAN deployments are canonical here and a flag whose value never varies is not a control. And the bearer is no longer passed as a `--header` argument — it is read from `REMBRIC_API_TOKEN` in the inherited environment, which removes it from the process argument vector.

`apps/plugin/bin/rembric-bridge.mjs` continues to exist as a deprecated on-disk launcher for opencode installs whose `opencode.json` already names it; that launcher's contract is specified by `opencode-plugin`, which is its only consumer.
