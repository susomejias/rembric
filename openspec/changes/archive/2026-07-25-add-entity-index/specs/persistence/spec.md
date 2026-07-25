## ADDED Requirements

### Requirement: The entity tables MUST be declared derived, never primary

The entity table and its link table SHALL be documented and treated as derived data, in the same class as the search and vector indexes: recomputable in full from the append-only memory rows, and never the sole record of anything. No agent-supplied information SHALL exist only in the entity index — everything in it is recoverable by re-running extraction over `title + content`.

This classification is what permits the index to be truncated and rebuilt, and it SHALL be stated where the tables are defined so a future contributor does not begin storing primary information there.

#### Scenario: The index is truncated and rebuilt with no loss

- **GIVEN** a populated entity index
- **WHEN** both tables are emptied and the rebuild is run
- **THEN** the resulting index SHALL be equivalent to the one that was emptied

#### Scenario: Losing the index loses no agent-supplied information

- **WHEN** the entity tables are dropped entirely
- **THEN** every memory's `title`, `content`, `tags`, `topic_key`, `status` and `replaces` SHALL be unaffected

### Requirement: The entity backfill MUST be batched and resumable

Introducing the index over an established corpus requires extracting entities for every existing memory. That backfill SHALL run in batches and SHALL be resumable across process restarts, in the same shape as the embedding backfill, so a large corpus does not require a long blocking migration. The server SHALL serve requests throughout, and entity retrieval SHALL work over whatever portion is already indexed.

Because the entity index is not required for correctness of any existing read, an incomplete backfill SHALL degrade coverage rather than fail a request.

#### Scenario: The backfill resumes after a restart

- **WHEN** the process restarts mid-backfill
- **THEN** the backfill SHALL resume over the remaining unindexed memories rather than starting over

#### Scenario: Requests are served during the backfill

- **WHEN** the backfill is in progress
- **THEN** `memory.save`, `memory.search` and `memory.context` SHALL all continue to function

#### Scenario: Partial coverage degrades rather than errors

- **GIVEN** a backfill that has covered part of the corpus
- **WHEN** entity retrieval is performed
- **THEN** it SHALL return the indexed matches without error
