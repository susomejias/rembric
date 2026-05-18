## ADDED Requirements

### Requirement: The persistence layer MUST add a `memory_relations` table

The schema SHALL gain a `memory_relations` table that records every judged or pending relation between two memories. The table SHALL be append-only with status transitions (`pending` → `judged` | `orphaned`), in the same spirit as the `memory` table.

Columns:

- `id` (TEXT PRIMARY KEY) — ULID
- `judgment_id` (TEXT UNIQUE NOT NULL) — opaque ID returned by `memory.save` for client callback
- `source_id` (TEXT NOT NULL, FK `memory.id`)
- `target_id` (TEXT NOT NULL, FK `memory.id`)
- `relation` (TEXT, nullable until judged) — enum: `supersedes` | `conflicts_with` | `related` | `compatible` | `scoped` | `not_conflict`
- `status` (TEXT NOT NULL) — enum: `pending` | `judged` | `orphaned`
- `reason` (TEXT, nullable)
- `evidence` (TEXT JSON, nullable)
- `confidence` (REAL, nullable; 0.0–1.0)
- `marked_by_kind` (TEXT, nullable) — `agent` | `agent_topic_key` | `consolidator` | `system`
- `marked_by_actor` (TEXT, nullable) — typically the token name
- `judged_at` (INTEGER timestamp_ms, nullable)
- `created_at` (INTEGER timestamp_ms NOT NULL)

Indexes:

- `(source_id, status)` and `(target_id, status)` for join queries from `memory.search` / `memory.get`
- `(status, created_at)` for the orphan-promotion sweep
- `judgment_id` is unique by constraint

#### Scenario: A judgment row is inserted at save-time

- **WHEN** `memory.save` surfaces a candidate
- **THEN** a row SHALL be inserted with `status = 'pending'`, `relation = NULL`, `judgment_id = ulid()`, `marked_by_kind = NULL`, `created_at = now`

#### Scenario: A judgment is closed

- **WHEN** `memory.judge({judgmentId, relation, reason?, confidence?})` is called
- **THEN** the matching row SHALL transition to `status = 'judged'`, with `relation`, `reason`, `confidence`, `judged_at = now`, `marked_by_kind = 'agent'`, `marked_by_actor = token.name`

#### Scenario: An orphan promotion fires

- **WHEN** the consolidator's promotion pass calls the LLM judge on a pending row older than the threshold and the judge returns a verdict
- **THEN** the row SHALL transition to `status = 'judged'` with `marked_by_kind = 'consolidator'`; if the judge fails or returns low confidence, the row SHALL transition to `status = 'orphaned'`

#### Scenario: Source and target span different scopes

- **WHEN** any code path attempts to INSERT a row whose `source` and `target` memories have different `(scope, project_id)`
- **THEN** the insertion SHALL fail with a domain error and SHALL NOT be persisted; the invariant test SHALL fail in CI if any production path emits such an insert

### Requirement: The `memory` table MUST gain a `topic_key` column

The schema SHALL add `topic_key TEXT` (nullable) to the `memory` table. A partial index SHALL exist for fast lookups of the active row per topic:

```
CREATE INDEX memory_topic_key_active_idx
  ON memory(scope, project_id, topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL
```

The column SHALL allow any TEXT value of length ≤ 128 with no NUL bytes. The empty string SHALL be normalized to `NULL` by the service layer before insert.

#### Scenario: Migration on an existing v0.1 database

- **WHEN** the migration adding `topic_key` is applied against a database with pre-existing rows
- **THEN** all existing rows SHALL retain `topic_key = NULL`; no backfill SHALL run

#### Scenario: Two simultaneous saves with the same topic_key (race)

- **WHEN** two `memory.save` calls with the same `(scope, project_id, topic_key)` race
- **THEN** SQLite's per-row transaction guarantees serialize them; one wins (its target is superseded), the other's candidate-detection step sees the winner as a candidate, and the response surfaces it for judgment

## MODIFIED Requirements

### Requirement: The schema MUST track consolidation operations

The `consolidation_ops` table is retained for the decay and orphan-promotion operations performed by the simplified consolidator. The pre-existing op types `merge`, `supersede`, `decay`, `noop`, `failed` SHALL continue to be valid; the new `orphan_promote` op type SHALL be added to record per-row promotion verdicts emitted by the orphan-promotion sweep.

#### Scenario: An orphan promotion writes a journal entry

- **WHEN** the consolidator promotes a pending relation to `judged` via LLM
- **THEN** a `consolidation_ops` row SHALL exist with `op_type = 'orphan_promote'`, `affected_ids = [sourceId, targetId]`, `reasoning = <llm verdict>`

#### Scenario: An orphan promotion fails

- **WHEN** the consolidator's LLM judge fails on a pending relation
- **THEN** the relation SHALL transition to `status = 'orphaned'` and a `consolidation_ops` row SHALL exist with `op_type = 'failed'`, `reasoning = <error>`
