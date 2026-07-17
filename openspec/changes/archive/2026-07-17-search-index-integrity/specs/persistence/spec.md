## ADDED Requirements

### Requirement: `memory_fts` triggers MUST stay in sync with `memory` and never leak a dangling posting

`memory_fts` is a contentless FTS5 virtual table indexing `content`, `tags` (flattened), and `title`, configured with `content='memory'` and `content_rowid='rowid'`. It SHALL be maintained by three triggers on `memory`:

- `memory_ai` (`AFTER INSERT`): inserts a row into `memory_fts` with the new `content`, `coalesce(group_concat(value, ' ') FROM json_each(new.tags), '')`, and `title`.
- `memory_ad` (`AFTER DELETE`): emits a `'delete'` row to `memory_fts` for the old values — `content`, `coalesce(group_concat(value, ' ') FROM json_each(old.tags), '')`, and `title`. The tags value SHALL be the row's real flattened tags, not an empty string, so external-content FTS5 does not leave a dangling posting after a physical purge (`memory.purgeDisconnectedArchived`).
- `memory_au` (`AFTER UPDATE OF content, tags, title`): emits a `'delete'` row for the old values (same real-tags rule as `memory_ad`) then inserts a fresh row for the new values. The trigger SHALL be scoped to exactly these three columns — unlike `prompts_au` (see the `prompts_fts` requirement), `memory`'s lifecycle is expressed entirely via `status` flips and `replaces` links, neither of which touches `content`, `tags`, or `title`; scoping the trigger to the columns that can actually change avoids rewriting the FTS index on every `last_seen_at` touch or status transition.

A migration that changes any of these triggers SHALL run `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` afterward, so an already-deployed database carrying dangling postings from a prior defective trigger is healed on upgrade.

#### Scenario: A physical purge does not leave a dangling tag posting

- **GIVEN** an archived, disconnected memory with a non-empty `tags` array
- **WHEN** `memory.purgeDisconnectedArchived` physically deletes the row
- **THEN** no `memory_fts` row SHALL match any of that memory's tag terms
- **AND** if SQLite later reuses the freed rowid for an unrelated new memory, that new memory's FTS entry SHALL reflect only its own tags, never the purged row's

#### Scenario: A read-only touch does not rewrite the FTS index

- **GIVEN** an existing memory indexed in `memory_fts`
- **WHEN** `touchLastSeen`/`touchLastSeenBatch` updates only `last_seen_at`, or a consolidation sweep updates only `status`
- **THEN** the `memory_au` trigger SHALL NOT fire and `memory_fts` SHALL NOT be rewritten for that row

#### Scenario: A hypothetical content/tags/title change still re-indexes

- **GIVEN** the (currently unused) case where a code path updates `memory.tags`
- **WHEN** that UPDATE statement runs
- **THEN** the `memory_au` trigger SHALL fire, removing the old tag postings and inserting the new ones, keeping `memory_fts` consistent
