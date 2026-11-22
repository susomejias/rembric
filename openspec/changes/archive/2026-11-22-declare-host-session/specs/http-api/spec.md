## ADDED Requirements

### Requirement: The MCP route MUST read `X-Rembric-Session` into the request context and never refuse on it

The `/mcp` and `/mcp/<slug>` route SHALL read the `X-Rembric-Session` request header, alongside `X-Rembric-Repo-Fingerprint`, and SHALL set `RequestContext.declaredSessionId` to its value when that value matches `^[A-Za-z0-9_-]{8,128}$`, the pattern `POST /api/<slug>/sessions` enforces on `id`. The pattern SHALL be the single exported `SESSION_ID_RE` from `packages/core/src/services/agent-sessions.ts`, not a second copy.

When the header is absent, empty, malformed, or sent more than once (which the `Headers` API joins into one comma-separated value that the pattern rejects), the route SHALL leave `declaredSessionId` undefined and SHALL answer exactly as it would without the header. It SHALL NOT refuse the request, unlike a malformed `X-Rembric-Repo-Fingerprint`, because a session declaration is attribution metadata and never authority. Whether a well-formed declaration is honoured is decided at session resolution, as the `mcp-api` capability specifies. The header name and the pattern SHALL agree with the shared host-binding fixture `apps/plugin/test/host-binding-layout.json` (`header`, `sessionIdPattern`), and a test SHALL assert that agreement.

#### Scenario: A well-formed declaration reaches session resolution

- **GIVEN** a token with two `active` sessions `<D>` and `<O>` in the connection's project
- **WHEN** a `tools/call` for `memory.save` with `sessionId = '<O>'` is POSTed to `/mcp` with `X-Rembric-Session: <D>`
- **THEN** the response SHALL be HTTP 200 and the saved memory's `session_id` SHALL be `'<D>'`
- **AND** the same call without the header SHALL persist `session_id = '<O>'`

#### Scenario: A malformed declaration is ignored, not refused

- **WHEN** the same call carries `X-Rembric-Session` with a value of `short`, 129 characters, `has space id`, or the empty string
- **THEN** the response SHALL be HTTP 200 and the saved memory's `session_id` SHALL be `'<O>'`, exactly as without the header

## MODIFIED Requirements

### Requirement: Sessions registered via HTTP MUST be reachable by MCP tools through an explicit `sessionId` or the sole-active-session lookup

When a session row is created via `POST /api/<slug>/sessions`, MCP tool handlers SHALL reach it — when resolving the Rembric session for a request — through exactly three mechanisms, in this order: (1) a host declaration naming the row in the request's `X-Rembric-Session` header, honoured only under the conditions the `mcp-api` capability specifies in "An honoured host-declared session MUST take precedence over the model's `sessionId`" (the row is the caller's own `active`, non-deleted row in the connection's project); (2) otherwise an explicit `sessionId` argument naming the row, validated for ownership as the `mcp-api` capability specifies; (3) otherwise `findActiveForTransport(token_id, project_id)`, which returns the row only when it is the unambiguous `active` session for the caller's `(token_id, project_id)` (see the `sessions` capability, "`findActiveForTransport` MUST NOT guess under concurrent ambiguity"). The server SHALL NOT bind an HTTP-registered session to an MCP connection, and SHALL keep no per-connection session state for any mechanism to consult: the declaration is read from each request and never stored.

This is the bridge that makes `memory.save` calls (issued by the agent over MCP) attach `session_id` to the row that the hook created via HTTP. The declaration is what lets the client's lifecycle code, which registered the row and always knows its id, name it on every MCP request without relying on the model to carry the id.

#### Scenario: Hook creates session over HTTP, agent saves memory over MCP

- **GIVEN** a client POSTs `{ id: 'sess-abc12345' }` to `/api/foo/sessions` (HTTP) and the session row is created, and it is the only `active` row for `(token_id, foo.id)`
- **AND** the same agent then opens an MCP connection on `/mcp/foo` and calls `memory.save({ type: 'project', content: '...' })` without `sessionId`
- **WHEN** the server resolves the active session for that save call
- **THEN** the resolution SHALL find `sess-abc12345` and the saved memory's `session_id` SHALL equal `'sess-abc12345'`

#### Scenario: Multiple active sessions for the same (token, project)

- **GIVEN** two `status='active'` rows exist for `(token_id, foo.id)` (e.g. user has two Claude Code windows open), both inside the staleness window
- **WHEN** a memory save without `sessionId` attaches via fallback resolution
- **THEN** the save SHALL persist `session_id = NULL` rather than choosing either row by recency
- **AND** the same save carrying `sessionId` of either row SHALL attach to that row, which is how a client with concurrent sessions names its own
- **AND** neither row's eventual `ended_at` / `summary` is affected

#### Scenario: Two windows on one project each reach their own session through the declaration

- **GIVEN** two `status='active'` rows `<A>` and `<B>` for `(token_id, foo.id)`, registered over HTTP by two windows
- **WHEN** each window's MCP requests carry `X-Rembric-Session` naming its own row and call `memory.save` without `sessionId`
- **THEN** the save from the first window SHALL persist `session_id = '<A>'` and the save from the second SHALL persist `session_id = '<B>'`
