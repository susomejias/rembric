## MODIFIED Requirements

### Requirement: The save-time lexical `MATCH` MUST omit terms present in at least half of the index

Before it builds its FTS5 `MATCH` expression, the save-time lexical pass SHALL omit every COMMON token: a token whose document frequency is at least `COMMON_TERM_DOCUMENT_RATIO` times the document total. The comparison SHALL be inclusive.

The pass ORs its capped builder tokens into one `MATCH`, and FTS5 ranks that match set by bm25 before the query's project, status and limit filters apply. The match set is the union of every token's documents across every project, so one token present in most memories made the pass score and sort the entire index on every save. bm25 gives such a token almost no weight: its inverse document frequency is `ln((N − n + 0.5) / (n + 0.5))`, which is at most zero exactly when `n >= N/2`, and FTS5 replaces every such value with the constant `1e-6`. That is also why the comparison is inclusive: at exactly half the index FTS5 already applies the constant. The token's only effect on the result was to enlarge the set being ranked.

- **Frequency source:** the per-term document frequencies SHALL be read from the vocabulary of the saving project's save-time lexical index, and the document total SHALL be the count of that project's rows, in every status. The just-saved row is already indexed when detection runs, so it counts in both, as it does in the bm25 the pass then computes.
- **Tokenisation:** each token SHALL be tokenised by the index's own tokenizer, one token at a time, as "Term-statistics lookups MUST be keyed on the index's own terms" requires. The pass therefore knows each token's terms and SHALL NOT reproduce the tokenizer to find them.
- **Phrases:** a token the tokenizer turns into exactly one term is common when that term's document frequency reaches the ratio. A token it turns into more than one term instance is matched by FTS5 as a phrase. bm25 weights a phrase by the phrase's own document frequency, which the term statistics do not hold, so such a token SHALL NOT be omitted.
- **Fallback:** when no kept token can occur in a row other than the saved one, the pass SHALL keep every token, exactly as the builder produced them. A single-term token can occur elsewhere only when its document frequency exceeds 1. A phrase can occur elsewhere only when every one of its terms has a document frequency above 1. The condition also holds when no token is kept. Keeping every token rather than only the rarest is a measured choice: each token the fallback restores occurs in at least half of the index, so no number of them makes the fallback's query cheap, and keeping fewer than all of them lost near-duplicates of such saves that keeping every token still finds (see this change's measurements).
- **Cost bound:** the frequency read SHALL be bounded by the builder's term cap and SHALL NOT scale with the saved body's length.
- **What the rule decides:** only which rows the bm25 ranking considers. It SHALL NOT change the reported `similarity`, `LEXICAL_CANDIDATE_FLOOR` or `CANDIDATE_POOL_SIZE`, and it SHALL NOT apply to the dense or entity channels.
- **Statistics as a read channel:** term statistics SHALL only remove rows from the match set. No candidate SHALL reach the pool except by matching a kept token, and no response SHALL expose a statistic, a ratio or the omitted tokens.
- **The constant:** `COMMON_TERM_DOCUMENT_RATIO` SHALL be `0.5`, declared once as a named constant in the module that owns save-time detection. It SHALL NOT be operator-configurable, readable from the environment or settable per request. Its value is derived from FTS5's bm25 rather than calibrated. A change to it therefore SHALL carry, in the same change:
  - the save-time calibration sweep;
  - the retrieval evaluation;
  - a measurement of `memory.save` latency at 1 000, 20 000 and 50 000 rows,

  because below half the index a token carries real weight, and omitting it changes the ranking.

- **Reads on the save path:** this rule adds the term-statistics read to the save path. The lexical floor still adds no read of its own.

#### Scenario: A token present in at least half of the index is omitted

- **GIVEN** an index in which one token of a save occurs in at least half of all rows and another occurs in fewer
- **WHEN** save-time candidate detection runs for that save
- **THEN** the `MATCH` expression SHALL contain the rarer token and SHALL NOT contain the common one

#### Scenario: The ratio is inclusive

- **GIVEN** a save sharing a token with other rows, and an index of N rows
- **WHEN** the token's document frequency is exactly N/2
- **THEN** the token SHALL be omitted
- **AND** when its document frequency is one less, the token SHALL be kept

#### Scenario: A multi-term token is never omitted

- **GIVEN** a save token that the index's tokenizer splits into several terms, each present in every row
- **WHEN** save-time candidate detection runs
- **THEN** that token SHALL remain in the `MATCH` expression

#### Scenario: A save whose every token is common keeps every token

- **GIVEN** a save whose every builder token occurs in at least half of all rows
- **WHEN** save-time candidate detection runs
- **THEN** the `MATCH` expression SHALL be the builder's unmodified expression

#### Scenario: Tokens that exist only in the saved text do not count as kept

- **GIVEN** a save whose tokens are either common or present in no row other than the saved one, and an existing memory in the same scope sharing its common tokens
- **WHEN** save-time candidate detection runs with no embedding available
- **THEN** the `MATCH` expression SHALL be the builder's unmodified expression, and that memory SHALL be eligible to surface as a `source: 'fts'` candidate

#### Scenario: A near-duplicate sharing a rarer token is still surfaced

- **GIVEN** a scope in which some tokens occur in at least half of all rows, and a save that restates an existing memory, sharing at least one rarer token with it
- **WHEN** save-time candidate detection runs with no embedding available
- **THEN** that memory SHALL be surfaced with `source: 'fts'` and the same `similarity` as without the omission

#### Scenario: The ratio is not configuration

- **WHEN** the environment schema and every MCP tool input schema are inspected
- **THEN** `COMMON_TERM_DOCUMENT_RATIO` SHALL NOT be readable from the environment and SHALL NOT be settable per request

#### Scenario: A term common in the project but rare server-wide is omitted

- **GIVEN** a token present in at least half of the saving project's rows, but in fewer than half of all rows
- **WHEN** save-time candidate detection runs
- **THEN** the token SHALL be omitted from the `MATCH`, subject to the fallback

### Requirement: The save-time lexical query MUST score only the saving project's matches

The save-time lexical candidate statement SHALL read the saving project's save-time lexical index, not the global `memory_fts`. No other project's postings are walked, and no other project's rows are looked up. It SHALL order its pool by bm25 computed after the status and exclusion filters have been applied, and SHALL NOT order by FTS5's `rank` column, because FTS5 consumes `ORDER BY rank` itself and then scores and sorts every match before the query's own filters run.

- **Scoring:** bm25 SHALL be computed over the project's index. Its document total, document counts and average row length therefore cover that project's rows only. The statement SHALL keep the pool size `CANDIDATE_POOL_SIZE`. For the project's rows, the returned `(id, score)` list SHALL be identical to the list from an FTS5 index holding only those rows.
- **What stays the same:** the reported `similarity` (token containment), `LEXICAL_CANDIDATE_FLOOR`, and the dense and entity channels.
- **Scope:** the service SHALL still resolve the project and pass it to the repository. The index restricts which rows can be reached, but it SHALL NOT replace the service-layer scope.

#### Scenario: Rows of other projects do not affect the save-time pool

- **GIVEN** two projects whose memories share a token, with many more rows in the second project
- **WHEN** a memory is saved in the first project
- **THEN** the lexical pool SHALL be computed from the first project's index alone
- **AND** adding rows to the second project SHALL NOT change the first project's candidates or their similarities

#### Scenario: Scores equal those of an index of the project alone

- **GIVEN** a project whose rows share tokens with another project's rows
- **WHEN** the save-time lexical statement runs for the first project
- **THEN** its rows, order and scores SHALL equal those of an FTS5 index built from the first project's rows only

#### Scenario: A near-duplicate is still surfaced

- **GIVEN** a save restating an existing memory of the same project
- **WHEN** save-time candidate detection runs with no embedding available
- **THEN** that memory SHALL be surfaced with `source: 'fts'` and the same `similarity` as before this change
