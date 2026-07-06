## ADDED Requirements

### Requirement: The bridge MUST pin the `mcp-remote` version

The bridge (`apps/plugin/bin/rembric-bridge.mjs`) SHALL spawn `mcp-remote` at an exact pinned version (`mcp-remote@<x.y.z>`), never a floating tag such as `@latest`. The pinned version SHALL be bumped deliberately as part of plugin releases. (Archive note: the "MCP bridge contract" prose bullet naming `npx -y mcp-remote@latest` is updated to the pinned form at archive-time sync.)

#### Scenario: Session start does not re-resolve `latest`

- **WHEN** the bridge spawns the transport
- **THEN** the npx argument SHALL name an exact `mcp-remote@<x.y.z>` version, so a newly published upstream release cannot change behavior without a Rembric plugin release

#### Scenario: Upstream publishes a broken release

- **WHEN** a broken `mcp-remote` version is published to npm
- **THEN** existing Rembric installations SHALL be unaffected (they keep spawning the pinned version)
