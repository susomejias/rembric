## ADDED Requirements

### Requirement: No schema migration is required for client-provided session ids

The `agent_sessions` table SHALL retain its existing `id TEXT PRIMARY KEY NOT NULL` declaration from migration `0003_sessions_and_slugs.sql`. Client-provided ids reuse the same column. Global uniqueness across all tokens is preserved.

Cross-token id collisions (a client tries to create a session with an id already in use by another token) are theoretically possible with non-UUID/ULID id formats but operationally a ~0 probability event with modern clients (Claude Code, Codex CLI both use high-entropy ids). The application layer SHALL detect this case via a `SELECT` before `INSERT` and reject with `id_collision` (see the `sessions` capability).

#### Scenario: Schema is unchanged by this change

- **WHEN** this change set is applied
- **THEN** `agent_sessions.id` SHALL remain a single-column TEXT PRIMARY KEY
- **AND** the existing FK declaration `memory.session_id REFERENCES sessions(id)` (and the analogous `confirmations.session_id`) SHALL remain valid
- **AND** no new SQL migration file is needed for this change

#### Scenario: Existing FK declarations from `0003_sessions_and_slugs.sql` remain enforceable

- **WHEN** a code path attempts `INSERT INTO memory (session_id, ...) VALUES ('never-existed-id', ...)` and no row exists in `sessions` for that id
- **THEN** SQLite SHALL raise a foreign key violation (assuming `PRAGMA foreign_keys=ON`) and the insert SHALL be rejected

#### Scenario: Insert into memory with NULL session_id

- **WHEN** `INSERT INTO memory (session_id, ...) VALUES (NULL, ...)`
- **THEN** the insert SHALL succeed regardless of any sessions row state
