## ADDED Requirements

### Requirement: The server surface a released bridge depends on MUST stay backward compatible

A bridge that is already installed is not updated when the server is: a hand-written `npx` configuration, a Hermes install updated outside the installer, and any plugin its user has not updated all keep running an older bridge against a newer server. The server SHALL therefore keep the surface those bridges use backward compatible. That surface is:

- the MCP endpoints `/mcp` and `/mcp/<slug>` over Streamable HTTP, including acceptance of the MCP protocol version `2025-06-18`;
- `POST /api/repositories/resolve`, in the request and response fields a released bridge sends and reads;
- the request headers `X-Rembric-Repo-Fingerprint` and `X-Rembric-Session`, in name and in accepted value format;
- bearer authentication through the `Authorization` header.

Additions to that surface are allowed. Removing, renaming or narrowing any part of it is a breaking change and SHALL NOT land without an OpenSpec change that names the released bridge versions it breaks.

The repository SHALL keep a frozen copy of `@rembric/mcp-bridge@0.45.1`, the last version published before the plugins stopped spawning the npm package and so the version that installs which never update keep running, as a test fixture, and CI SHALL run that frozen bridge as a subprocess against the current server. The fixture SHALL NOT be edited to make the test pass.

#### Scenario: The frozen 0.45.1 bridge still works against the current server

- **WHEN** the frozen `0.45.1` bridge fixture is spawned against a server built from the current tree, with a valid token and a project slug
- **THEN** `initialize`, `tools/list` and a `tools/call` round-trip SHALL succeed through the bridge
- **AND** the call SHALL land in the project named by the slug

#### Scenario: The frozen bridge resolves a project from a repository fingerprint

- **WHEN** the frozen bridge runs inside a git repository whose fingerprint is bound to a project, with no slug configured
- **THEN** its `POST /api/repositories/resolve` request SHALL be answered in a shape it understands
- **AND** it SHALL connect to that project's `/mcp/<slug>` endpoint

#### Scenario: A server change that breaks released bridges fails CI

- **WHEN** a change removes, renames or narrows a part of the surface listed above
- **THEN** the frozen-bridge test SHALL fail
- **AND** the change SHALL NOT merge without an OpenSpec change naming the bridge versions it breaks

#### Scenario: The fixture matches what npm serves

- **WHEN** the frozen fixture's files are compared with the `@rembric/mcp-bridge@0.45.1` tarball's recorded checksums
- **THEN** every file SHALL match
