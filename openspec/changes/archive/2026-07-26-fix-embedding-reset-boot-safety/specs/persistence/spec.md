## MODIFIED Requirements

### Requirement: FTS5 and sqlite-vec virtual tables MUST stay in sync with `memory`

`memory_fts` and `memory_vec` SHALL be maintained automatically as memories are inserted, updated, or transitioned. FTS5 sync SHALL be implemented via SQL triggers on the `memory` table; vector sync SHALL be performed by the in-process embedder (gte-multilingual-base, ONNX q8, 768 dims — the dimension is part of the persistence contract and matches `memory_vec FLOAT[768]`). `memory_vec` rows are derived data: rewriting them during a model backfill does not violate the append-only memory invariant.

#### Scenario: Saving a memory updates FTS5 immediately

- **WHEN** a row is inserted into `memory`
- **THEN** a corresponding row SHALL exist in `memory_fts` with the indexed `content` and `tags` before the transaction commits

#### Scenario: Saving a memory populates memory_vec asynchronously

- **WHEN** a row is inserted into `memory`
- **THEN** the in-process embedder SHALL persist its 768-dim vector into `memory_vec` asynchronously; until then candidate detection degrades to FTS5-only for that row

#### Scenario: Model identity mismatch triggers a backfill

- **GIVEN** the data dir records an embedding-model identity different from the compiled-in model
- **WHEN** the server starts
- **THEN** every non-archived memory SHALL be re-embedded in resumable batches
- **AND** the recorded identity SHALL be settled when the stale-vector wipe commits, NOT when the backfill finishes — a marker asserting the compiled-in identity means "no pre-change vectors remain in the index", not "every row has been re-embedded"
