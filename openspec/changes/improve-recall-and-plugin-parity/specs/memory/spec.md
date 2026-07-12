## MODIFIED Requirements

### Requirement: Memory search MUST implement standard hybrid retrieval on the text-query branch

When `memory.search` is called with a non-empty text `query`, the system SHALL implement the standard hybrid-search pattern used by mainstream search engines: run an independent **lexical retriever** (FTS5/BM25 ranked ids) and **dense retriever** (vector k-nearest-neighbor ranked ids), then combine their ranked lists using Reciprocal Rank Fusion (RRF): `score(id) = Σ 1/(rank_constant + rank_branch(id))` over the branches in which the id appears. Each child retriever SHALL over-fetch into a bounded **rank window** (at least `limit + offset`, clamped to a fixed ceiling set strictly above the maximum `limit` so an unbounded `offset` cannot force a near-full partition scan) so that fusion is not artificially recall-capped. When `memory.search` is called WITHOUT a text `query`, the system SHALL use the existing chronological listing path unchanged (ordered by `created_at`, with exact `limit`/`offset`). The dense branch SHALL NOT apply a similarity threshold — fusion orders results, it does not filter them. The text query SHALL be sanitized before it is passed to the FTS5 `MATCH` so that an arbitrary natural-language query cannot raise an FTS5 syntax error or be reinterpreted as an FTS5 query expression. The sanitizer SHALL keep whole Unicode word tokens (it SHALL NOT split a token at a non-ASCII character nor drop tokens that are entirely non-ASCII — e.g. accented or CJK text), SHALL strip FTS5 metacharacters and balance quotes, and SHALL neutralize FTS5 bareword operators (`AND`, `OR`, `NOT`, `NEAR`) so a phrase like "coffee OR tea" matches literal terms rather than being parsed as a boolean expression. (The FTS tokenizer folds diacritics, so a sanitized accented or ASCII-folded token matches accented stored content either way; the binding requirement is to preserve whole tokens and neutralize operators, not to special-case accents.) A failure of either branch SHALL degrade gracefully to the other branch rather than failing the whole search. Filters SHALL have explicit guarantees: `status` and `type` apply to BOTH branches; `tag` is exact on the lexical branch and post-filters dense candidates inside the bounded rank window (so no wrong-tag rows are returned, but dense+tag recall is bounded by the rank window rather than globally complete). Result rows SHALL carry the same shape as today (including the `relations` array and the `last_seen_at` touch).

After RRF produces the fused, ordered candidate pool for the over-fetched rank window, the system SHALL apply a bounded post-fusion multiplier before truncating to the top `limit` results: `finalScore(id) = rrfScore(id) * boost(id)`, where `boost(id)` is a compile-time-constant function of the candidate row's `confirmationCount`, time since `last_seen_at`, and `type`, clamped to a fixed range (approximately `[0.7, 1.4]`) so it can re-order candidates within the fused pool but SHALL NOT let a boosted weaker match outrank a strongly-fused one by more than that bound. This boost applies ONLY to the text-query (fused hybrid-search) branch; the no-query chronological listing path is UNCHANGED and continues to use exact chronological order with no boost applied. The boost multiplier SHALL NOT be exposed as a per-request tunable — it is a fixed constant, matching the existing style of `RANK_CONSTANT` and the rank-window ceiling.

#### Scenario: A cross-lingual query surfaces a memory stored in another language

- **GIVEN** an `active` memory whose content is in English (e.g. "user prefers black coffee, no sugar")
- **WHEN** `memory.search` is called with a Spanish query expressing the same meaning (e.g. "¿cómo toma el café?") in the same scope
- **THEN** the FTS branch SHALL NOT raise a syntax error on the punctuation/accents, and the English memory SHALL appear in the fused results via the vector branch even though no query terms overlap lexically

#### Scenario: An exact proper-noun query ranks the lexical match

- **GIVEN** an `active` memory containing a proper noun or identifier (e.g. "Sobrino de Botín")
- **WHEN** `memory.search` is called with a query containing that exact token (e.g. "Botín")
- **THEN** the lexically-matching memory SHALL be ranked highly in the fused results via the FTS branch

#### Scenario: A memory consensually ranked by both branches wins

- **GIVEN** two `active` memories where one is surfaced by BOTH the vector and FTS branches and another by only one branch
- **WHEN** the two ranked lists are fused with RRF
- **THEN** the memory present in both branches SHALL receive the higher fused score, all else equal

#### Scenario: A memory without an embedding is still found lexically

- **GIVEN** an `active` memory whose embedding has not yet been computed (inline embed failed, drain lag, or mid-backfill)
- **WHEN** `memory.search` is called with a text query that lexically matches it
- **THEN** the memory SHALL appear in the fused results via the FTS branch, and search correctness SHALL NOT depend on full embedding coverage

#### Scenario: Archived text-query search degrades to lexical only

- **GIVEN** an `archived` memory still present in storage
- **WHEN** `memory.search` is called with `status = 'archived'` and a text query that lexically matches it
- **THEN** the lexical branch SHALL still be allowed to return it
- **AND** the search SHALL NOT require a vector hit for correctness because archived rows are outside the semantic-search guarantee after model changes

#### Scenario: The no-query listing branch keeps exact pagination

- **WHEN** `memory.search` is called WITHOUT a text query and with `limit` and `offset`
- **THEN** the results SHALL be the chronological listing with exact SQL `LIMIT`/`OFFSET` semantics, identical to prior behavior
- **AND** no post-fusion boost SHALL be applied (the boost only applies to the fused hybrid-search branch)

#### Scenario: BREAKING — offset is best-effort on the hybrid branch

- **WHEN** `memory.search` is called WITH a text query and a non-zero `offset`
- **THEN** `offset` SHALL be applied best-effort over the in-memory fused result pool (which is over-fetched beyond `limit + offset`) rather than as a SQL `OFFSET`; an `offset` beyond the fused pool SHALL yield an empty page rather than an error, and this divergence from the listing branch SHALL be documented as a contract change

#### Scenario: A heavily-confirmed fresh memory outranks a stale unconfirmed one within the fused pool

- **GIVEN** two `active` memories both present in the fused RRF pool with close raw RRF scores, one confirmed multiple times and recently seen, the other never confirmed and not seen in months
- **WHEN** `memory.search` applies the post-fusion boost
- **THEN** the confirmed, recently-seen memory SHALL rank at or above the other, but the reordering SHALL NOT move a memory absent from the fused pool into the returned results (the boost reorders the pool; it does not expand it)

## ADDED Requirements

### Requirement: Memory search MAY expand results via one-hop relation traversal

`memory.search` SHALL accept an optional `include_relations` boolean parameter (default `false`). When `true`, after the normal top-`limit` fused (or chronological) result set is computed, the system SHALL inspect each result row's `relations[]` annotations (see "Search results MUST carry relation annotations") for `kind` in (`supersedes`, `superseded_by`, `conflicts_with`) and, for each such `targetId` not already present in the result set, fetch that memory (respecting the same scope-isolation rule as the primary search) and append it to the response under a separate `expanded` array, each entry carrying `{ ...memoryRow, expandedFrom: <originId>, relationKind }`. The `expanded` array SHALL be capped at 5 entries total regardless of how many primary results carry annotations, and entries in `expanded` SHALL NOT count against the caller's `limit` and SHALL NOT be re-ranked into the primary `results` ordering.

#### Scenario: A superseded hit's head is co-surfaced

- **GIVEN** memory M is `superseded_by` memory N (judged), and a text-query search returns M as a primary result but not N
- **WHEN** `memory.search` is called with `include_relations = true`
- **THEN** the response SHALL include M in `results` and N in `expanded` with `{ expandedFrom: M.id, relationKind: 'superseded_by' }`

#### Scenario: Expansion is capped

- **GIVEN** a primary result set whose combined relation annotations reference more than 5 distinct memories not already in the result set
- **WHEN** `memory.search` is called with `include_relations = true`
- **THEN** `expanded` SHALL contain at most 5 entries

#### Scenario: Expansion is opt-in and off by default

- **WHEN** `memory.search` is called without `include_relations` (or with it explicitly `false`)
- **THEN** the response SHALL NOT contain an `expanded` field
