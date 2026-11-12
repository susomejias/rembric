## ADDED Requirements

### Requirement: The save-time lexical query MUST read only the saving project's index

The save-time lexical candidate statement SHALL read the saving project's save-time lexical index, not the global `memory_fts`. No other project's postings are then walked, and no other project's rows are looked up.

> Draft (Phase 1). This change proposes it and has measured it, but it is not yet approved for implementation. Once change `prune-common-terms-from-save-time-match` archives, this text becomes MODIFIED of two of its requirements (design D6):
>
> - its "Frequency source" bullet;
> - its "scores … over the whole index" paragraph.

- **Scoring:** bm25 SHALL be computed over the project's index, so its document total, document counts and average row length cover that project's rows only. The statement SHALL keep ordering by bm25 after the status and exclusion filters, with the pool size `CANDIDATE_POOL_SIZE`.
- **Pruning statistics:** the common-term omission SHALL take its per-term document frequencies from that index's vocabulary, and its document total from the count of the project's rows in every status. `COMMON_TERM_DOCUMENT_RATIO`, the phrase rule and the fallback SHALL be unchanged.
- **What stays the same:** the reported `similarity` (token containment), `LEXICAL_CANDIDATE_FLOOR`, and the dense and entity channels.
- **Scope:** the service SHALL still resolve the project and pass it to the repository. The index restricts the reachable rows. It SHALL NOT replace the service-layer scope.

#### Scenario: Rows of other projects do not affect the save-time pool

- **GIVEN** two projects whose memories share a token, with many more rows in the second project
- **WHEN** a memory is saved in the first project
- **THEN** the lexical pool SHALL be computed from the first project's index alone
- **AND** adding rows to the second project SHALL NOT change the first project's pool

#### Scenario: A term common in the project but rare server-wide is omitted

- **GIVEN** a token present in at least half of the saving project's rows, but in fewer than half of all rows
- **WHEN** save-time candidate detection runs
- **THEN** the token SHALL be omitted from the `MATCH`, subject to the fallback

#### Scenario: A near-duplicate is still surfaced

- **GIVEN** a save restating an existing memory of the same project
- **WHEN** save-time candidate detection runs with no embedding available
- **THEN** that memory SHALL be surfaced with `source: 'fts'` and the same `similarity` as before this change
