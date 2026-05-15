## ADDED Requirements

### Requirement: `AgentSessionsService.start()` MUST accept a client-provided id and be idempotent on that id

The service method `start(input: { tokenId, projectId, agent, description?, id? })` SHALL accept an optional `id?: string`. When `id` is supplied:

1. The service SHALL validate `id` against the regex `^[A-Za-z0-9_-]{8,128}$`. Non-matching ids SHALL be rejected with `DomainError('invalid_input', <message naming the contract>)`.
2. The service SHALL `SELECT` the row by `id`. If found AND its `token_id` matches the calling token: return the existing row with `created: false` semantics. The service SHALL NOT mutate `status`, `started_at`, `ended_at`, `summary`, `project_id`, `agent`, or `description` on idempotent hits.
3. If the row was found but its `token_id` does NOT match the calling token: throw `DomainError('id_collision', <message>)`. (Theoretically impossible with UUIDs/ULIDs; this is defense-in-depth.)
4. If no row was found: `INSERT` with the provided id and return with `created: true` semantics.

When `id` is NOT supplied, the service SHALL mint a ULID as today and SHALL return `created: true`. This preserves backwards compatibility with `memory.session_start` (MCP) which does not pass an id.

#### Scenario: start() with a valid client id inserts a new row

- **WHEN** `start({ tokenId: 't1', projectId: 'p1', agent: 'claude-code', id: 'sess-abc12345' })` is called and no row exists for id `'sess-abc12345'`
- **THEN** a new row SHALL be inserted with `id = 'sess-abc12345'`, `token_id = 't1'`, `status = 'active'`
- **AND** the returned value SHALL include `created: true`

#### Scenario: start() with the same client id is idempotent for the same token

- **GIVEN** a previous successful `start({ tokenId: 't1', id: 'sess-abc12345', projectId: 'p1' })`
- **WHEN** `start({ tokenId: 't1', id: 'sess-abc12345', projectId: 'p1' })` is called again
- **THEN** the second call SHALL return the existing row with `created: false`
- **AND** `started_at` SHALL be unchanged from the original insert
- **AND** the table SHALL still contain exactly one row for that id

#### Scenario: start() rejects cross-token id collision

- **GIVEN** a row exists for `(token_id='t1', id='shared-id-12345')`
- **WHEN** `start({ tokenId: 't2', id: 'shared-id-12345', projectId: 'p1' })` is called
- **THEN** the service SHALL throw `DomainError('id_collision', ...)` and SHALL NOT insert or mutate any row
- **AND** the original row for `('t1', 'shared-id-12345')` SHALL be untouched

#### Scenario: start() rejects malformed ids

- **WHEN** `start({ tokenId: 't1', id: 'x', projectId: 'p1' })` is called (too short — fails regex)
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)` and SHALL NOT insert a row

- **WHEN** `start({ tokenId: 't1', id: 'has spaces', projectId: 'p1' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)`

- **WHEN** `start({ tokenId: 't1', id: 'A'.repeat(129), projectId: 'p1' })` is called
- **THEN** the call SHALL throw `DomainError('invalid_input', ...)`

#### Scenario: start() without explicit id preserves ULID-minting behavior

- **WHEN** `start({ tokenId: 't1', projectId: 'p1', agent: 'mcp' })` is called (no `id`)
- **THEN** the service SHALL mint a ULID via `ulid()`, insert, and return a row whose `id` is that ULID
- **AND** the returned value SHALL include `created: true`

## MODIFIED Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session. Lifecycle changes are expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, and by writing the `ended_at` and `summary` columns at most once per session.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `summarize`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

The `id` column is set exactly once at insert time. It MAY originate from a client (via `POST /api/<slug>/sessions` or `start({id})`) or be server-minted (via `memory.session_start` without an explicit id). Once written it SHALL NOT be UPDATEd.

#### Scenario: Code path attempts to physically delete a session

- **WHEN** any service or migration emits a `DELETE FROM agent_sessions` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate an immutable session column

- **WHEN** any service emits an `UPDATE agent_sessions SET agent = ?`, `UPDATE agent_sessions SET started_at = ?`, or `UPDATE agent_sessions SET id = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Two `memory.session_end` (or `/api/.../end`) calls for the same session id

- **WHEN** `memory.session_end` (MCP) or `POST /api/<slug>/sessions/:id/end` (HTTP) is called twice on the same `(token_id, id)`
- **THEN** the second call SHALL fail with code `session_already_ended` and SHALL NOT mutate `ended_at` or `summary`

#### Scenario: deleted_at transitions are tracked

- **WHEN** an operator soft-deletes a session and later undeletes it
- **THEN** `deleted_at` SHALL transition NULL → timestamp → NULL and SHALL be the only column that may revisit its initial value
