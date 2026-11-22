## ADDED Requirements

### Requirement: The persistence layer MUST add an append-only `memory_pin_events` table

Migration `0041_memory_pin_events.sql` SHALL add, as a purely additive migration that touches no existing row:

```
CREATE TABLE memory_pin_events (
  id INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  action TEXT NOT NULL,
  cause TEXT NOT NULL,
  run_id TEXT REFERENCES consolidation_runs(id),
  actor TEXT,
  event_ts INTEGER NOT NULL,
  CONSTRAINT memory_pin_events_action_check CHECK (action IN ('pin', 'unpin'))
);
CREATE INDEX memory_pin_events_memory_idx ON memory_pin_events (memory_id);
CREATE INDEX memory_pin_events_project_idx ON memory_pin_events (project_id, memory_id);
```

The table is a source table, not a derived one: it is the only record of pin state (see the `memory` capability, "An active memory MAY be pinned, with pin state derived from an append-only journal"). It SHALL be append-only: no code path SHALL `UPDATE` or `DELETE` a `memory_pin_events` row, outside the dev seed reset, and a CI invariant test SHALL enforce both. The primary key SHALL be the rowid, so that insertion order defines "latest event" even for events sharing a millisecond. `action` SHALL be closed at the database level; `cause` SHALL be an application-level enum, so that a new retirement cause needs no table rebuild.

`memory_pin_events_memory_idx` serves the latest-event lookup for a set of memory ids and a memory's pin history; `memory_pin_events_project_idx` serves the pinned list of one project. Both SHALL be declared in the Drizzle schema and included in the exact-set index snapshot.

#### Scenario: The migration is additive

- **GIVEN** a populated database at migration `0040`
- **WHEN** `0041_memory_pin_events.sql` is applied
- **THEN** every pre-existing table SHALL keep its row count, `PRAGMA foreign_key_check` SHALL report no violation, and `memory_pin_events` SHALL exist empty

#### Scenario: The action domain is closed

- **WHEN** a row with `action` other than `pin` or `unpin` is inserted into `memory_pin_events`
- **THEN** the insert SHALL fail with a CHECK constraint violation

#### Scenario: The plans select the declared indexes

- **WHEN** the latest-event lookup for a set of ids and the pinned list of a project are planned with `EXPLAIN QUERY PLAN`
- **THEN** the first SHALL search `memory_pin_events` using the covering index `memory_pin_events_memory_idx`
- **AND** the second SHALL search it using the covering index `memory_pin_events_project_idx`

#### Scenario: No code path rewrites or deletes a pin event

- **WHEN** any file outside the dev seed reset emits `UPDATE memory_pin_events` or `DELETE FROM memory_pin_events`, raw or through Drizzle
- **THEN** a CI invariant test SHALL fail
