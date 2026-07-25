# memory-entities Specification

## Purpose

Deterministic, no-LLM extraction of syntactically-recognisable identifiers (file paths, git refs, URLs, error codes, tickets, CVEs, IPv4 addresses, self-hosted hostnames, systemd units, MAC addresses, env vars, UUIDs) from a memory's `title + content`, indexed and scoped like memories themselves. The index backs exact-address retrieval (an index lookup, not a ranked query), a save-time conflict-detection channel for entity overlap, and a precise seed for context relevance — while staying out of the existing hybrid-search RRF fusion, which it must not affect.

## Requirements

### Requirement: Entity extraction MUST be deterministic and MUST NOT use a model

Entities SHALL be extracted from a memory's `title + content` by a pure function with no inference, no model, and no network call, so extraction is reproducible, auditable, and free. Only entity kinds recognisable from syntax with high confidence SHALL be extracted: file paths, git refs, error codes, URLs, ticket-style identifiers, CVE ids, IPv4 addresses, self-hosted hostnames, systemd units, MAC addresses, environment variables, and UUIDs.

A kind SHALL be admitted only when its syntax is closed enough to reject prose without a denylist of English words. Kinds whose shape cannot be bounded that way — symbol identifiers, package names, semver strings, Docker image references, cron expressions — SHALL remain deliberately unsupported until a measured precision case exists for them.

An identifier class whose shape it shares with another class SHALL be separated by an anchor or a closed list, never by pattern order. Specifically: a token in `SCREAMING_SNAKE_CASE` SHALL NOT be typed on shape alone — it is indistinguishable between an error code, an environment variable and an ordinary constant — so `error_code` SHALL match only prefixed families (`ERR_`, `SQLITE_`, `E_`) plus closed name lists, and `env_var` SHALL require a `$`, `${}` or `=` anchor.

#### Scenario: An unanchored SCREAMING_SNAKE token is not typed

- **WHEN** a memory's content reads "export DATABASE_URL before starting"
- **THEN** no entity SHALL be linked for that token

#### Scenario: An anchored environment variable is typed

- **WHEN** a memory's content contains `NODE_ENV=production` or `$DATABASE_URL`
- **THEN** an entity of kind `env_var` SHALL be linked, carrying the bare name

#### Scenario: A UUID does not yield a git ref

- **WHEN** a memory's content contains `550e8400-e29b-41d4-a716-446655440000`
- **THEN** an entity of kind `uuid` SHALL be linked and no `git_ref` SHALL be linked for its segments

Extraction SHALL run inside the same transaction as the save, and an extraction failure SHALL NOT fail the save — the memory is the primary record and the index is derived. Prose that merely resembles an entity SHALL NOT be extracted: precision is preferred over recall, because a false entity link pollutes exact-address lookup, which is the mechanism's whole value.

#### Scenario: A file path in memory content is extracted

- **WHEN** a memory is saved whose content references `apps/server/src/db/migrate.ts`
- **THEN** an entity of kind `path` SHALL be linked to that memory

#### Scenario: Extraction is reproducible

- **WHEN** the extractor runs twice over identical text
- **THEN** it SHALL produce an identical set of entities

#### Scenario: An extraction failure does not fail the save

- **WHEN** extraction throws for a given memory
- **THEN** the memory SHALL still be saved and the failure SHALL be logged

#### Scenario: Ordinary prose does not produce entities

- **WHEN** a memory is saved whose content is prose containing no path, ref, package, identifier, URL, or ticket id
- **THEN** no entity SHALL be linked to it

### Requirement: A kind MUST earn its place against the lexical branch, not merely be plausible

The lexical branch already resolves some identifier classes exactly: FTS5 quotes every query token as a phrase (`sanitizeFtsQuery`), so an identifier whose separators the tokenizer preserves — or which cannot be a prefix or substring of a longer valid identifier of the same class — is already retrieved without false positives. Adding a kind for such an identifier buys enumeration, not precision, and the distinction SHALL be recorded rather than assumed.

A kind SHALL therefore be justified by one of: (a) a measured false-positive rate through the lexical branch, (b) removal of an existing false extraction, or (c) an enumeration or typed-projection capability the lexical branch structurally cannot provide. Measured at introduction against an adversarial corpus:

| kind                           | justification            | evidence                                                                                                          |
| ------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `path`                         | precision                | 67% lexical noise — a path is a prefix (`.bak`) and a suffix (`test/…`) of other valid paths                      |
| `ticket`                       | precision                | 50–75% — the `#` is dropped; `PROJ-1234` is a prefix of `PROJ-1234-B`                                             |
| `ip_address`                   | precision                | 50% — an address is a suffix of a longer dotted string                                                            |
| `hostname`                     | precision                | 50% — the dot is dropped, so `nas.local` matches "the nas local drive"                                            |
| `systemd_unit`                 | precision                | the dot is dropped, so `caddy.service` matches prose; the suffix set is deliberately reduced (see below)          |
| `env_var`                      | fixes a false extraction | unanchored `SCREAMING_SNAKE` was typed `error_code`, so `DATABASE_URL` and `MAX_RETRIES` polluted the error index |
| `uuid`                         | fixes a false extraction | a UUID's first group satisfied the git-SHA shape, yielding a bogus `git_ref`                                      |
| `cve_id`                       | fixes a false extraction | `CVE-2024-3094` yielded a bogus `ticket` of `CVE-2024`                                                            |
| `mac_address`                  | enumeration              | 0% lexical noise, but the lexical branch cannot enumerate devices                                                 |
| `git_ref`, `url`, `error_code` | enumeration              | 0% — these are self-terminating under tokenization                                                                |

A kind's pattern MAY be narrower than the identifier class it names when the excluded shapes collide with ordinary prose. `systemd_unit` omits `.target`, `.path`, `.slice`, `.scope` and `.mount` for this reason: they are also everyday property accessors (`event.target`, `array.slice`, `req.path`, `wrapper.mount`), measuring 8 false positives across 9 lines of ordinary code prose versus 1 with the reduced set.

The runtime cost of the index SHALL stay negligible against the vector index it sits beside; at introduction it measured 0.05% of memory-related storage and under 2ms per memory to extract and index.

#### Scenario: A CVE id does not also yield a ticket entity

- **WHEN** a memory referencing `CVE-2024-3094` is saved
- **THEN** an entity of kind `cve_id` SHALL be linked, and no entity of kind `ticket` SHALL be linked for the same text

#### Scenario: A hostname is not extracted from prose that merely contains its labels

- **WHEN** a memory's content reads "the nas local drive is full"
- **THEN** no entity of kind `hostname` SHALL be linked

#### Scenario: An out-of-range dotted quad is not an address

- **WHEN** a memory's content contains `999.1.1.1`
- **THEN** no entity of kind `ip_address` SHALL be linked

### Requirement: Entities MUST be scoped, and entity lookup MUST respect scope isolation

Each entity SHALL be scoped exactly as memories are — global, or belonging to one project. Retrieval by entity SHALL return only memories the caller's scope permits, and SHALL never return a memory from a different project. An entity string appearing in two projects SHALL NOT join their memories.

#### Scenario: The same path in two projects does not join them

- **GIVEN** memories in project A and project B both referencing `src/index.ts`
- **WHEN** entity retrieval is performed on a connection scoped to project A
- **THEN** only project A's memories SHALL be returned

#### Scenario: Global entities are available to a project-scoped read when requested

- **GIVEN** a global memory referencing a package name and a project memory referencing the same package
- **WHEN** entity retrieval is performed in the project scope including globals
- **THEN** both SHALL be returned, each labelled with its scope

### Requirement: Retrieval by entity MUST bypass ranking

Exact-address retrieval is not a relevance problem: the caller has supplied an exact key. Retrieval by entity SHALL be an index lookup returning every linked memory in the requested scope, ordered chronologically, with no fusion, no rank window, no similarity threshold, and no post-fusion boost. It SHALL therefore be complete within the scope — a memory linked to the entity SHALL NOT be omitted because of a ranking cutoff.

This is deliberately the opposite of the text-query branch, and it exists because the identifier query class is the one where ranked retrieval performs worst.

#### Scenario: Every linked memory is returned

- **GIVEN** twenty memories in scope linked to one entity
- **WHEN** entity retrieval is performed for that entity with a sufficient limit
- **THEN** all twenty SHALL be returned

#### Scenario: A rare identifier is found regardless of embedding distance

- **GIVEN** a memory whose only connection to a query is a rare identifier, and which no text query surfaces in its top results
- **WHEN** entity retrieval is performed on that identifier
- **THEN** the memory SHALL be returned

#### Scenario: Entity retrieval applies no relevance boost

- **WHEN** entity retrieval returns results
- **THEN** the ordering SHALL be chronological and SHALL NOT be modified by confirmation count, recency, or type

### Requirement: Entity overlap MUST be a save-time conflict-detection channel

Two memories can contradict each other while sharing almost no vocabulary and sitting far apart in embedding space — a fix and its reversal, stated in different words about the same file. Lexical and dense similarity both miss that case. A newly saved memory sharing a sufficiently rare entity with an existing active memory in the same scope SHALL therefore be eligible as a save-time candidate, alongside the existing lexical and dense channels.

Candidates surfaced this way SHALL carry a source identifying the entity channel, so the agent judging them knows why they were proposed. Common entities SHALL NOT generate candidates: an entity linked to a large share of the scope's memories carries no signal and would flood the per-save candidate budget.

#### Scenario: A contradiction about the same file is surfaced

- **GIVEN** an active memory stating one approach for a specific file, and a new memory stating an incompatible approach for the same file, with little shared vocabulary
- **WHEN** the new memory is saved
- **THEN** the existing memory SHALL be surfaced as a candidate with the entity channel as its source

#### Scenario: A very common entity generates no candidates

- **GIVEN** an entity linked to a large share of the scope's active memories
- **WHEN** a new memory linked to that entity is saved
- **THEN** that entity alone SHALL NOT generate candidates

#### Scenario: The per-save candidate budget is respected

- **WHEN** the entity channel would surface more candidates than the per-save maximum permits
- **THEN** the total number of candidates SHALL still respect that maximum

### Requirement: The entity index MUST be rebuildable and its drift MUST be observable

Both entity tables are derived data, reconstructible from the append-only memory rows alone — the same class as the search and vector indexes. A rebuild path SHALL exist that recomputes them from `memory`, and the diagnostics surface SHALL report a link-count delta so drift caused by a missed backfill, a failed extraction, or a future table-rebuild migration is visible rather than silent.

#### Scenario: The index is rebuilt from primary data

- **GIVEN** an entity index that has been emptied
- **WHEN** the rebuild runs
- **THEN** the index SHALL be reconstructed and entity retrieval SHALL return the same results as before it was emptied

#### Scenario: Drift is reported

- **GIVEN** memories whose entities were never extracted
- **WHEN** diagnostics are read
- **THEN** a non-zero delta SHALL be reported as a warning

### Requirement: A change to the extraction recipe MUST retroactively correct already-indexed memories

Because the scan bookkeeping records THAT a memory was scanned and not WHICH recipe scanned it, a corrected pattern would otherwise apply only to newly-saved memories, leaving every existing one misclassified forever. A misclassification is therefore not permanent by construction: the extractor SHALL carry a version tag covering its patterns, its normalization and its kind set, and a mismatch against the tag recorded on disk SHALL invalidate the derived index at boot so the ordinary backfill drain recomputes it from the append-only `memory` rows.

The reset SHALL NOT be triggered by an ordinary deployment — only by a recipe change — and SHALL NOT modify any `memory` row. A rebuild SHALL also remain available on demand from the operator dashboard, so a fix need not wait for a release.

The drain SHALL be paced so this window is bounded: entity retrieval is specified as complete within scope, and a corpus-wide rebuild leaves it incomplete until the drain finishes.

#### Scenario: A misclassified memory is corrected by a recipe change

- **GIVEN** a memory indexed under a recipe that classified it incorrectly
- **WHEN** the pattern is fixed and the extractor version is bumped
- **THEN** the incorrect entity link SHALL be gone after the drain, the correct one present, and the memory's `content` unchanged

#### Scenario: An ordinary deployment does not rebuild the index

- **GIVEN** an install whose recorded extractor version matches the compiled-in one
- **WHEN** the server boots
- **THEN** the entity index SHALL NOT be truncated and no re-scan SHALL be scheduled

#### Scenario: A corpus scanned to zero entities is still re-scanned

- **GIVEN** an install whose memories were all scanned under an older recipe but produced no entities
- **WHEN** the extractor version no longer matches
- **THEN** the scan bookkeeping SHALL be cleared so the drain re-scans them

### Requirement: Entity retrieval MUST NOT be added as a fusion stream in this change

Published evidence indicates that adding a graph stream to a BM25-plus-vector fusion **reduced** Recall@5, NDCG@10 and MRR against BM25 alone in its own author's benchmark. Entity retrieval SHALL therefore remain a separate exact-address mechanism and SHALL NOT contribute a ranked list to the text-query branch's Reciprocal Rank Fusion. Introducing such a stream SHALL require a measured improvement on the evaluation harness, recorded in a dedicated change.

#### Scenario: The text-query branch is unchanged

- **WHEN** `memory.search` is called with a text query and no entity filter
- **THEN** the fused result SHALL be identical to what the same query returns without the entity index present
