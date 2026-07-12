## MODIFIED Requirements

### Requirement: The bridge MUST pin the `mcp-remote` version

The bridge (`apps/plugin/bin/rembric-bridge.mjs`) SHALL spawn `mcp-remote` at an exact pinned version (`mcp-remote@<x.y.z>`), never a floating tag such as `@latest`. The pinned version SHALL be bumped deliberately as part of plugin releases.

Before spawning `mcp-remote`, the bridge SHALL perform one `GET ${REMBRIC_SERVER_URL}/healthz` request (reusing the same bearer token it holds for the MCP connection) with a short timeout (2 seconds). On success, the bridge SHALL compare the response's `version` field against a `MIN_SERVER_VERSION` constant bumped alongside the plugin's own version. When the server's version is older than `MIN_SERVER_VERSION` (semver comparison), the bridge SHALL print exactly one line to stderr naming both versions and pointing at the dashboard self-update flow / `docs/updates.md`, then proceed to spawn `mcp-remote` unchanged — the check is advisory only and SHALL NOT block or delay the connection. When the `/healthz` request fails for any reason (network error, timeout, non-200, malformed body), the bridge SHALL silently skip the check and proceed exactly as if no check existed — this MUST NOT introduce a new failure mode for environments where `/healthz` is unreachable but `/mcp` is fine (e.g. transient DNS blips, a reverse proxy exposing only `/mcp`).

This bridge is shared unmodified by the Codex CLI plugin (`.codex-plugin/mcp.json` spawns the same `rembric-bridge.mjs`) and by the opencode plugin's stdio-transport reuse (`opencode-plugin/spec.md`'s "MCP transport reuses the existing stdio bridge" requirement); both clients inherit this version-handshake behavior with no client-specific spec text needed, since the check is entirely internal to the shared bridge script.

#### Scenario: Session start does not re-resolve `latest`

- **WHEN** the bridge spawns the transport
- **THEN** the npx argument SHALL name an exact `mcp-remote@<x.y.z>` version, so a newly published upstream release cannot change behavior without a Rembric plugin release

#### Scenario: Upstream publishes a broken release

- **WHEN** a broken `mcp-remote` version is published to npm
- **THEN** existing Rembric installations SHALL be unaffected (they keep spawning the pinned version)

#### Scenario: Bridge warns on an outdated server

- **GIVEN** `/healthz` responds successfully with a `version` older than the bridge's `MIN_SERVER_VERSION`
- **WHEN** the bridge starts
- **THEN** it SHALL print exactly one stderr line naming both the server's version and the expected minimum, and pointing at the update flow
- **AND** it SHALL still spawn `mcp-remote` and connect normally

#### Scenario: Bridge is silent when the server meets the minimum version

- **GIVEN** `/healthz` responds successfully with a `version` at or above `MIN_SERVER_VERSION`
- **WHEN** the bridge starts
- **THEN** no version-related stderr line SHALL be printed

#### Scenario: A healthz failure does not block or warn

- **GIVEN** the `/healthz` request times out, errors, or returns a non-200 status
- **WHEN** the bridge starts
- **THEN** no version-related stderr line SHALL be printed
- **AND** the bridge SHALL proceed to spawn `mcp-remote` exactly as it would without this requirement
