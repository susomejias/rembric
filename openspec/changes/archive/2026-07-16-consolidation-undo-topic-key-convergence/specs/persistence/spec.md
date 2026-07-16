## MODIFIED Requirements

### Requirement: The `memory` table MUST gain a `topic_key` column

The schema SHALL add `topic_key TEXT` (nullable) to the `memory` table. A non-unique partial index SHALL serve fast lookups of the active row per topic (retained from migration 0005):

```
CREATE INDEX memory_topic_key_active_idx
  ON memory(scope, project_id, topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL
```

Convergence — at most one `active` row per `(scope, project_id, topic_key)` slot — SHALL additionally be enforced by a UNIQUE partial index so the storage layer rejects a second `active` row regardless of the write path, backing the service-layer convergence guarantee (`memory` capability, upsert-by-topic-key) and the consolidation-undo guarantee (`consolidation` capability) with a database constraint rather than trusting every caller:

```
CREATE UNIQUE INDEX memory_topic_key_active_uidx
  ON memory(scope, COALESCE(project_id, ''), topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL
```

The UNIQUE index SHALL key on `COALESCE(project_id, '')`, NOT the raw `project_id` column: SQLite treats `NULL` as DISTINCT in a UNIQUE index, so a plain UNIQUE index on `(scope, project_id, topic_key)` would fail to constrain global memories (`project_id IS NULL`) — two active global rows sharing a `topic_key` would both be admitted. Coalescing NULL to `''` makes the global slot a concrete key the constraint can enforce. `saveWithTopicKey` supersedes the prior active row and inserts the new one within a single transaction, so it never holds two active rows in a slot simultaneously and is unaffected by the constraint.

The column SHALL allow any TEXT value of length ≤ 128 with no NUL bytes. The empty string SHALL be normalized to `NULL` by the service layer before insert.

The migration that introduces the UNIQUE index SHALL first heal any pre-existing duplicate-active slots (which the non-unique index permitted): for every `(scope, project_id, topic_key)` slot holding more than one `active` row, it SHALL keep the most-recently-created active row (`ORDER BY created_at DESC, id DESC`) and transition the others to `superseded`. This is a status flip only (append-only-safe: no content edit, no delete), confined to slots that already violate convergence, and a no-op on a database that never hit the defect. Adding the index is index-only DDL and requires no table rebuild.

#### Scenario: Migration on an existing v0.1 database

- **WHEN** the migration adding `topic_key` is applied against a database with pre-existing rows
- **THEN** all existing rows SHALL retain `topic_key = NULL`; no backfill SHALL run

#### Scenario: Two simultaneous saves with the same topic_key (race)

- **WHEN** two `memory.save` calls with the same `(scope, project_id, topic_key)` race
- **THEN** SQLite's per-row transaction guarantees serialize them; one wins (its target is superseded), the other's candidate-detection step sees the winner as a candidate, and the response surfaces it for judgment

#### Scenario: The UNIQUE index heals pre-existing duplicate-active slots

- **GIVEN** a database in which a `(scope, project_id, topic_key)` slot holds two `active` rows R1 (older) and R2 (newer)
- **WHEN** the migration introducing the UNIQUE partial index is applied
- **THEN** R2 SHALL remain `active`, R1 SHALL be transitioned to `superseded`, and the UNIQUE index SHALL be created successfully

#### Scenario: The UNIQUE index rejects a second active row in a slot

- **GIVEN** an `active` memory with `topic_key = K` in `(scope, project_id)`
- **WHEN** a write attempts to insert or reactivate a second `active` row with the same `topic_key` in the same `(scope, project_id)` without first superseding the incumbent
- **THEN** SQLite SHALL reject it with a UNIQUE-constraint failure

#### Scenario: Convergence is enforced for global slots (project_id NULL)

- **GIVEN** an `active` global memory (`project_id IS NULL`) with `topic_key = K`
- **WHEN** a write attempts to add a second `active` global row with `topic_key = K` without superseding the incumbent
- **THEN** SQLite SHALL reject it with a UNIQUE-constraint failure (the `COALESCE(project_id, '')` key makes the NULL project_id a concrete slot key)
