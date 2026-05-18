## ADDED Requirements

### Requirement: The `agent_sessions` schema MUST carry a nullable `deleted_at` column

Migration `0006_session_deleted_at.sql` SHALL add a single column to the existing `agent_sessions` table:

```
ALTER TABLE agent_sessions ADD COLUMN deleted_at INTEGER;
```

The column SHALL be declared as Drizzle's `timestamp_ms` mode (matching `started_at` / `ended_at`), nullable, with no default value (NULL = visible). The migration SHALL NOT backfill any existing rows. The migration SHALL NOT alter any other column or index.

#### Scenario: Migration runs against an existing database

- **GIVEN** a Rembric database created under any migration up to and including `0005_relations_and_topic_key.sql`
- **WHEN** migration `0006_session_deleted_at.sql` runs
- **THEN** the `agent_sessions` table SHALL gain a nullable `deleted_at` column
- **AND** every pre-existing row SHALL have `deleted_at = NULL`
- **AND** no other column SHALL be modified

#### Scenario: Migration is idempotent under drizzle's runner

- **WHEN** the migration runner is invoked against a database where `0006_session_deleted_at.sql` has already been applied
- **THEN** the runner SHALL detect the migration as already applied and SHALL NOT re-execute the `ALTER TABLE` statement
