## MODIFIED Requirements

### Requirement: Sessions MUST be append-only

The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session. Lifecycle changes are expressed exclusively by transitioning the `status` column among `active`, `ended`, and `abandoned`, and by writing the `ended_at` and `summary` columns at most once per session.

The `deleted_at` column is exempt from immutability: it SHALL transition from NULL to a timestamp (soft-delete) or from a timestamp back to NULL (undelete) any number of times. Both transitions SHALL be guarded by the cross-token rule that already protects `end` and `summarize`, unless the caller is an operator-facing surface (CLI or dashboard) that sets `adminBypass: true`.

#### Scenario: Code path attempts to physically delete a session

- **WHEN** any service or migration emits a `DELETE FROM agent_sessions` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Code path attempts to mutate an immutable session column

- **WHEN** any service emits an `UPDATE agent_sessions SET agent = ?` or `UPDATE agent_sessions SET started_at = ?` statement
- **THEN** a CI invariant test SHALL fail and the build SHALL be rejected

#### Scenario: Two `memory.session_end` calls for the same session id

- **WHEN** `memory.session_end` is called twice on the same session id
- **THEN** the second call SHALL fail with code `session_already_ended` and SHALL NOT mutate `ended_at` or `summary`

#### Scenario: deleted_at transitions are tracked

- **WHEN** an operator soft-deletes a session and later undeletes it
- **THEN** `deleted_at` SHALL transition NULL → timestamp → NULL and SHALL be the only column that may revisit its initial value

## ADDED Requirements

### Requirement: Sessions MAY be soft-deleted while preserving the audit trail

The `agent_sessions` table SHALL gain a nullable column `deleted_at TIMESTAMP`. A row with `deleted_at IS NOT NULL` is *soft-deleted*: it remains physically present, its `id` continues to satisfy every existing `memory.session_id` foreign-key reference, but it is hidden from default-visible listings.

`AgentSessionsService` SHALL expose:

- `softDelete(sessionId, {tokenId?, adminBypass?})`: sets `deleted_at` to `now()`. Calling this on an already-deleted row SHALL be a no-op that returns the existing row (idempotent). Without `adminBypass`, the caller's `tokenId` SHALL match the row's `token_id`; mismatches SHALL be rejected with `forbidden`.
- `undelete(sessionId, {adminBypass?})`: clears `deleted_at`. Only admin (operator-facing) callers may invoke this; agent-facing callers SHALL NOT have access.

`AgentSessionsService.list(...)` and `recentForContext(...)` SHALL apply `WHERE deleted_at IS NULL` by default. `list(...)` SHALL accept an `includeDeleted: true` option to surface deleted rows. `recentForContext` SHALL NOT accept such an option — memory-context callers SHALL never see deleted sessions.

`AgentSessionsService.findById(...)` SHALL NOT filter on `deleted_at`. The detail surface must still be able to open and act on (e.g. undelete) a soft-deleted row.

#### Scenario: softDelete sets deleted_at and hides the row from default list

- **GIVEN** an active session with `id = <S>` whose `deleted_at` is NULL
- **WHEN** the operator calls `softDelete(<S>, {adminBypass: true})`
- **THEN** the row's `deleted_at` SHALL be set to the current timestamp
- **AND** a subsequent `list()` SHALL NOT include the row
- **AND** a subsequent `list({includeDeleted: true})` SHALL include the row
- **AND** `findById(<S>)` SHALL still return the row

#### Scenario: softDelete is idempotent

- **GIVEN** a session whose `deleted_at` is already set
- **WHEN** the operator calls `softDelete` on it again
- **THEN** the call SHALL succeed and SHALL NOT modify `deleted_at`
- **AND** the returned row SHALL be the existing soft-deleted row

#### Scenario: undelete clears deleted_at

- **GIVEN** a soft-deleted session
- **WHEN** the operator calls `undelete` on it with `adminBypass: true`
- **THEN** `deleted_at` SHALL transition back to NULL
- **AND** the row SHALL re-appear in the default list

#### Scenario: Memories anchored to a soft-deleted session preserve their session_id

- **GIVEN** a memory whose `session_id` references session `<S>`
- **WHEN** session `<S>` is soft-deleted
- **THEN** the memory's `session_id` SHALL remain unchanged and SHALL continue to point at `<S>`

### Requirement: The CLI MUST expose `rembric session delete <id>` and `--include-deleted`

The CLI SHALL gain:

- `rembric session delete <id>`: soft-deletes the session by calling `softDelete(id, {adminBypass: true})`. SHALL print the updated row as JSON on success. SHALL exit with non-zero status and a stderr message when the session is not found.
- `rembric session list --include-deleted`: surfaces soft-deleted rows alongside active ones. The `--table` rendering SHALL include a `(deleted)` annotation in the status column for deleted rows.

#### Scenario: session delete soft-deletes the row

- **GIVEN** a Rembric database containing a session with `id = <S>` whose `deleted_at` is NULL
- **WHEN** the operator runs `rembric session delete <S>`
- **THEN** the command SHALL exit `0` and print JSON containing `id = <S>` and a non-null `deletedAt`
- **AND** the row SHALL NOT appear in a subsequent `rembric session list`
- **AND** the row SHALL appear in a subsequent `rembric session list --include-deleted`

#### Scenario: session delete on an unknown id exits non-zero

- **WHEN** the operator runs `rembric session delete not-a-real-ulid`
- **THEN** the command SHALL exit with a non-zero status and stderr SHALL contain a message naming the missing id

### Requirement: The dashboard MUST surface Delete + Undelete actions per session

The list view at `/dashboard/sessions` SHALL render an inline `<form action="/dashboard/sessions/<id>/delete" method="post">` per active row with a CSRF input and a `class="warn"` `Delete` button. The handler SHALL call `softDelete(id, {adminBypass: true})` and redirect to `/dashboard/sessions?deleted=<id>`. The list view SHALL render `?deleted=<id>` as a `flash success` containing an inline `Undelete` action.

The list view SHALL accept `?include_deleted=1` and render soft-deleted rows in a separate `<h2>Deleted</h2>` section beneath the Active table, mirroring how `/dashboard/projects` renders Archived projects.

The detail view at `/dashboard/sessions/:id` SHALL render whether the row is soft-deleted (regardless of the query parameter). When soft-deleted, the page SHALL display a `flash error` reading "This session is deleted." and the action area SHALL show an `Undelete` button (CSRF-protected) at `POST /dashboard/sessions/<id>/undelete` instead of `Delete`.

#### Scenario: Operator soft-deletes a session from the list view

- **GIVEN** an authenticated admin session and an active Rembric session row with id `<S>`
- **WHEN** the operator submits the row's Delete form
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions?deleted=<S>`
- **AND** the row SHALL NOT appear in a subsequent GET of `/dashboard/sessions`
- **AND** the row SHALL appear in a subsequent GET of `/dashboard/sessions?include_deleted=1`

#### Scenario: Operator undeletes from the detail view

- **GIVEN** a soft-deleted session at `/dashboard/sessions/<S>` and an authenticated admin
- **WHEN** the operator submits the Undelete form
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions`
- **AND** the row SHALL re-appear in the default list

#### Scenario: Delete without CSRF is rejected

- **GIVEN** an authenticated admin session
- **WHEN** a POST to `/dashboard/sessions/<S>/delete` arrives without the `csrf` field
- **THEN** the response SHALL be `403` with the standard `csrf_invalid` body
