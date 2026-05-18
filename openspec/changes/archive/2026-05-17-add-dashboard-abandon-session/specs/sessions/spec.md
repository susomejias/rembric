## ADDED Requirements

### Requirement: `AgentSessionsService.markAbandoned()` MUST flip a single active session to abandoned with admin-bypass support

The service method `markAbandoned(sessionId: string, input?: { tokenId?: string; adminBypass?: boolean }): AgentSession` SHALL transition exactly one session row from `status = 'active'` to `status = 'abandoned'`, writing `ended_at = now()` in the same `UPDATE`. The transition rules are:

1. **Row lookup**. The service SHALL `SELECT` the row by `id`. If no row matches, it SHALL throw `DomainError('session_not_found', <message naming the id>)`.

2. **Token check**. When `input?.adminBypass` is not `true`, the service SHALL require `input?.tokenId` to equal the row's `token_id`. On mismatch (including `undefined` vs a row token id), the service SHALL throw `DomainError('forbidden', <message>)`. When `adminBypass: true`, the token check SHALL be skipped — mirroring the established pattern used by `softDelete` and `undelete`.

3. **Terminal-state handling**.
   - If the row's `status` is `'abandoned'`, the service SHALL return the existing row unchanged (idempotent no-op). It SHALL NOT mutate `ended_at`.
   - If the row's `status` is `'ended'`, the service SHALL throw `DomainError('session_already_ended', <message>)`. The reverse transition `ended → abandoned` SHALL NOT be allowed.

4. **Happy path**. When `status === 'active'`, the service SHALL emit an `UPDATE agent_sessions SET status='abandoned', ended_at = now() WHERE id = ?` and SHALL return the post-update row.

The method SHALL NOT mutate `agent`, `token_id`, `started_at`, `project_id`, `summary`, `title`, `summary_final`, `title_final`, or `deleted_at`. The only columns written are `status` and `ended_at`.

The method SHALL NOT call into `abandonStale` and `abandonStale` SHALL NOT call into `markAbandoned`; they are siblings serving distinct call sites (per-id operator surface vs. bulk reconciliation scheduler).

#### Scenario: markAbandoned flips an active session

- **GIVEN** a session with `id = <S>`, `status = 'active'`, `ended_at = NULL`, and `token_id = 't1'`
- **WHEN** `markAbandoned(<S>, { tokenId: 't1' })` is called
- **THEN** the row's `status` SHALL transition to `'abandoned'`
- **AND** `ended_at` SHALL be set to the current timestamp
- **AND** the returned value SHALL be the post-update row

#### Scenario: markAbandoned is idempotent on already-abandoned rows

- **GIVEN** a session with `status = 'abandoned'` and `ended_at = <T>`
- **WHEN** `markAbandoned` is called on it
- **THEN** the call SHALL succeed
- **AND** `ended_at` SHALL still equal `<T>` (no second write)
- **AND** the returned row SHALL be the existing one unchanged

#### Scenario: markAbandoned rejects ended sessions

- **GIVEN** a session with `status = 'ended'`
- **WHEN** `markAbandoned` is called on it
- **THEN** the service SHALL throw `DomainError('session_already_ended', ...)`
- **AND** the row SHALL NOT be mutated

#### Scenario: markAbandoned rejects cross-token without adminBypass

- **GIVEN** a session with `token_id = 't1'`
- **WHEN** `markAbandoned(<S>, { tokenId: 't2' })` is called
- **THEN** the service SHALL throw `DomainError('forbidden', ...)`
- **AND** the row SHALL NOT be mutated

#### Scenario: markAbandoned accepts cross-token with adminBypass

- **GIVEN** a session with `token_id = 't1'` and `status = 'active'`
- **WHEN** `markAbandoned(<S>, { adminBypass: true })` is called (no `tokenId` supplied)
- **THEN** the call SHALL succeed
- **AND** the row's `status` SHALL transition to `'abandoned'`

#### Scenario: markAbandoned throws on unknown id

- **WHEN** `markAbandoned('does-not-exist', { adminBypass: true })` is called
- **THEN** the service SHALL throw `DomainError('session_not_found', ...)`
