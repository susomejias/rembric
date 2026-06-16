## ADDED Requirements

### Requirement: Memory search MUST default to a bounded, retrieval-aligned result count

When `memory.search` is called WITHOUT an explicit `limit`, the system SHALL apply a default of `DEFAULT_SEARCH_LIMIT = 8`, expressed as a single named constant rather than a magic literal. The default SHALL apply identically to BOTH search modes — the hybrid text-query branch and the no-query chronological listing — because the limit-clamping path is shared. An explicit `limit` SHALL still be honored and clamped to `[1, 200]`; the default governs only the omitted case. The value 8 sits within the retrieval-engineering norm for the final result set fed to a model (a low single-digit-to-ten count, beyond which additional rows add noise rather than recall) and is chosen above a tighter 3-5 because no reranker is applied, so the fused ranking near the top is approximate. This default SHALL NOT change the over-fetch rank window, RRF fusion, the FTS branch, or the dense kNN branch; it changes only how many of the already-ranked results are returned when the caller does not specify.

#### Scenario: A text query with no explicit limit returns at most the default count

- **GIVEN** more than 8 active memories in scope match a non-empty text `query`
- **WHEN** `memory.search` is called with that `query` and no `limit`
- **THEN** at most `DEFAULT_SEARCH_LIMIT` (8) results SHALL be returned, ordered by the fused RRF ranking

#### Scenario: A no-query listing with no explicit limit returns at most the default count

- **GIVEN** more than 8 active memories in scope
- **WHEN** `memory.search` is called WITHOUT a text `query` and without `limit`
- **THEN** at most `DEFAULT_SEARCH_LIMIT` (8) results SHALL be returned, in the chronological listing order

#### Scenario: An explicit limit overrides the default in both directions

- **WHEN** `memory.search` is called with an explicit `limit` of 3, or of 50
- **THEN** the result count SHALL be governed by the explicit `limit` (clamped to `[1, 200]`), not by `DEFAULT_SEARCH_LIMIT`
