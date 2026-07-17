## ADDED Requirements

### Requirement: The persistence layer MUST maintain a derived `memory_replaces` reverse-edge table

The schema SHALL gain a `memory_replaces` table indexing the reverse direction of `memory.replaces` (a JSON array on each `memory` row, forward-only: "what this row replaces"). `memory_replaces` answers "what replaces this row" without a full-table `json_each` scan.

Columns: `predecessor_id` (TEXT NOT NULL), `successor_id` (TEXT NOT NULL). Primary key `(predecessor_id, successor_id)`. The table SHALL be declared `WITHOUT ROWID` — the composite primary key is the only access path required.

`memory_replaces` is derived data, in the same spirit as `memory_fts` and `memory_vec`: it is never written by application code and is always reconstructible from `memory.replaces`. It SHALL be maintained exclusively by three triggers on `memory`:

- `memory_replaces_ai` (`AFTER INSERT ON memory`): inserts one `(je.value, new.id)` row per element of `new.replaces`.
- `memory_replaces_au` (`AFTER UPDATE OF replaces ON memory`): deletes existing rows where `successor_id = old.id`, then re-inserts from `new.replaces`, the same delete-then-reinsert shape used by the `memory_fts` update trigger.
- `memory_replaces_ad` (`AFTER DELETE ON memory`): deletes rows where `predecessor_id = old.id` OR `successor_id = old.id`, defensively covering both directions the deleted row could participate in.

The migration that introduces this table SHALL backfill it once from every pre-existing row: `INSERT INTO memory_replaces SELECT je.value, m.id FROM memory m, json_each(m.replaces) je`.

This table has no corresponding Drizzle schema file — like the virtual `memory_vec` table, it is queried exclusively via raw SQL from `apps/server/src/db/repositories/memory-repository.ts`.

#### Scenario: Inserting a memory with a non-empty replaces array populates the reverse edge

- **WHEN** a memory `N` is inserted with `replaces: ["<M.id>"]`
- **THEN** `memory_replaces` SHALL contain a row `(predecessor_id='<M.id>', successor_id='<N.id>')` before the transaction commits

#### Scenario: A supersedes judgment's replaces update re-syncs the reverse edge

- **GIVEN** memory `N` was inserted with `replaces: []`
- **WHEN** `RelationsService`'s `supersedes` side effect extends `N.replaces` to `["<M.id>"]` via `setReplaces`
- **THEN** `memory_replaces` SHALL contain a row `(predecessor_id='<M.id>', successor_id='<N.id>')` after the update

#### Scenario: Physically deleting a memory removes its reverse edges in both directions

- **GIVEN** memory `M` is a predecessor of `N` (`memory_replaces` has a row with `predecessor_id='<M.id>'`) and `M` itself has `replaces: ["<K.id>"]` (`memory_replaces` has a row with `successor_id='<M.id>'`)
- **WHEN** `M` is physically deleted from `memory`
- **THEN** both rows SHALL be removed from `memory_replaces`

#### Scenario: The backfill migration reconstructs the table from existing data

- **GIVEN** a pre-existing `memory` table with rows whose `replaces` arrays encode a multi-hop supersede chain
- **WHEN** the migration introducing `memory_replaces` runs
- **THEN** `memory_replaces` SHALL contain exactly the edge set that `SELECT je.value, m.id FROM memory m, json_each(m.replaces) je` would produce over the pre-existing data
