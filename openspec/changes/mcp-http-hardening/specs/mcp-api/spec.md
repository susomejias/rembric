## ADDED Requirements

### Requirement: Unexpected errors on any HTTP-exposed surface MUST NOT leak internals

Any error thrown during request handling that is not a `DomainError` (a recognized, intentional failure with a stable `code`) SHALL be treated as unexpected: the server SHALL generate a correlatable `errorId`, log the real error message and stack server-side (never in the response), and return only a generic message (`'An unexpected error occurred.'`) plus that `errorId` to the caller. This SHALL apply uniformly across every HTTP-exposed surface: MCP tool calls (`errToMcp`), the `/api/<slug>/sessions*` and `/api/<slug>/memory/*` routes (`domainErr`), the `/mcp` transport-level catch-all (`respondInternal`), and `/admin` routes (e.g. `POST /admin/consolidation/run`). A `DomainError`'s own `code` and `message` SHALL continue to be returned verbatim — this requirement governs only the unexpected-error path.

#### Scenario: An MCP tool call throws an unexpected error

- **WHEN** an MCP tool handler throws an error that is not a `DomainError`
- **THEN** the response SHALL be `{ ok: false, code: 'internal_error', message: 'An unexpected error occurred.', errorId: <uuid> }`
- **AND** the real error message and stack SHALL be logged server-side, tagged with the same `errorId`
- **AND** the response SHALL NOT contain the real error message or any stack fragment

#### Scenario: An `/api` session route throws an unexpected error

- **WHEN** a `POST /api/<slug>/sessions*` or `/api/<slug>/memory/*` handler throws an error that is not a `DomainError`
- **THEN** the HTTP response body SHALL follow the same shape and the same non-leak guarantee as the MCP tool-call scenario above

#### Scenario: `POST /admin/consolidation/run` throws an unexpected error

- **WHEN** the manually-triggered consolidation run throws an error that is not a `DomainError`
- **THEN** the response SHALL follow the same shape and the same non-leak guarantee

#### Scenario: A `DomainError` is returned verbatim, not generalized

- **WHEN** any of the surfaces above throws a `DomainError` (e.g. `session_not_found`, `invalid_input`)
- **THEN** the response SHALL carry that error's own `code` and `message`
- **AND** SHALL NOT be replaced with the generic `internal_error` shape
