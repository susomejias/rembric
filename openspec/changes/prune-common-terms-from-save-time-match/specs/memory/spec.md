## MODIFIED Requirements

### Requirement: `memory.save` MUST surface candidate conflicts at save-time

After a `memory.save` inserts the new row, the server SHALL run a candidate-detection step over rows in the same `(scope, project_id)`, excluding the newly inserted row and any rows already linked to it via `replaces`. The detection SHALL combine FTS5 lexical neighbors (always), vec kNN neighbors (when the just-saved row has an embedding), and entity-overlap neighbors (see `memory-entities`'s save-time conflict-detection requirement, which owns the gate: an entity common enough to occupy the whole per-save budget contributes nothing, while one linked to fewer memories than that budget holds is not gated at all), apply the internal similarity thresholds (compile-time constants, calibrated for the compiled-in model — not environment-configurable), deduplicate by target id, rank the merged list by the precedence the `memory-entities` capability defines (entity-sourced candidates lead, then the reported `similarity` descending), and return up to `CANDIDATES_PER_SAVE_MAX` (default 5) candidates.

Each detection channel SHALL scan a bounded pool before that ranking is applied, sized by a single named constant (`CANDIDATE_POOL_SIZE`, see "Retrieval and lifecycle constants MUST be named and bounded in one place"). The pool bound is therefore UPSTREAM of the cap: the merged, ranked list is itself bounded, and no scope-wide count of related memories is available at save time. Consequently the count the response reports (see the `mcp-api` capability, "`memory.save` MUST report how many candidates its detection produced") SHALL be specified as a LOWER BOUND on how many memories in scope resemble the saved row, and SHALL NOT be specified as a total. A count that happens to be exact — which it is whenever the scope holds fewer comparable rows than the pool bound — SHALL NOT be relied upon as exact, because that exactness is a property of corpus size and not of the count.

The lexical pass SHALL build its FTS5 `MATCH` expression from the tokens of the SAME Unicode-aware builder used by interactive `memory.search` (see the `mcp-api` hybrid-retrieval contract): it SHALL keep whole Unicode word tokens and SHALL NOT split a token at a non-ASCII character, SHALL NOT drop a token because it is entirely non-ASCII (accented or CJK text), and SHALL apply a bounded term cap so a long save body cannot build an unbounded `MATCH` expression. Within that cap, a token SHALL be omitted only by the document-frequency rule of "The save-time lexical `MATCH` MUST omit terms present in at least half of the index", which reads a token's frequency in the index and never its script; a kept token SHALL keep the builder's quoting and order. Consequently, save-time candidate detection SHALL NOT silently degrade to vector-only for non-ASCII content: a non-ASCII memory body SHALL produce a non-empty `MATCH` expression and SHALL be eligible to surface `source: 'fts'` candidates. Whenever the builder yields at least one token the `MATCH` expression SHALL be non-empty, whatever that rule omits. The lexical pass SHALL still skip only when the builder yields no usable tokens at all.

The detection SHALL additionally exclude any target id that was already judged `relation = 'not_conflict'` against the new memory's `replaces` ancestry. That ancestry is the TRANSITIVE closure of `replaces[]`, bounded by its own constant — see "Dismissal suppression MUST bound its ancestry walk with its own named constant", which owns the depth, the order and the bound. It is NOT the array's own elements: `replaces[]` alone is one hop, and one hop loses a dismissal made two or more saves back on the same topic, which is the case this suppression exists for. This suppresses the re-surfacing of a pair the agent already dismissed as a false positive on an earlier save of the same evolving topic. Because `memory_relations` has no topic column and each save mints a fresh `source_id`, the dismissal SHALL be carried forward by walking that ancestry, NOT by the new row's own id (which no prior relation references). Only `not_conflict` SHALL be suppressed; other judged relations (notably `conflicts_with`) SHALL continue to surface so an unresolved contradiction re-confronts the agent on the next save.

For each candidate surfaced, a `memory_relations` row SHALL be inserted with `status = 'pending'`, `source_id = <new row>`, `target_id = <candidate>`, and a generated `judgment_id`.

Candidates that were detected but fall outside `CANDIDATES_PER_SAVE_MAX` SHALL NOT be recorded: no `memory_relations` row, no `judgment_id`, no journal entry. This is not an information loss, and the requirement states why so that a future change does not "fix" it by recording them.

A candidate pair is DERIVED: its two endpoints and its `similarity` are a function of `memory.title` and `memory.content` — immutable under "Memories MUST be append-only" — together with recipes pinned in the shipped image behind version markers (the FTS5 tokenizer, the entity extractor behind `EXTRACTOR_VERSION`, and the embedding identity behind `EMBEDDING_INPUT_VERSION` and the pinned model constants, per "Embeddings MUST be computed in-process by a model loaded at boot" and "Stale vectors MUST be re-embedded after a model change"). It therefore satisfies the same test the `persistence` capability applies to its own derived tables (`memory_fts`, `memory_vec`, `memory_replaces`, and the entity tables, which that capability requires to be "declared derived, never primary"): dropping it loses nothing that cannot be recomputed from rows still in the database. An agent's VERDICT on a pair is the opposite — SOURCE data, recomputable by nothing — which is precisely what earns a row.

Dropping a candidate therefore discards a prompt, not a fact, and the prompt is re-derivable at any time from the surviving inputs via `memory.search` over the memory's own text (lexical and dense channels) and `memory.search` with an `entity` filter (entity channel).

That re-derivability SHALL be specified as re-derivability and NOT as reproducibility. A re-derived candidate set is the CURRENT one, not the save-time one: rows created since the save are included, `superseded` and `archived` rows are absent, and a change to the pinned embedding recipe changes the vectors. Nor is it identical in shape: `memory.search` is a fused ranked read that returns memories, not pairs carrying `judgment_id`s, so recording a verdict on a re-derived pair is `memory.compare`. No requirement SHALL claim that a dropped candidate can be reconstructed as it stood at save time.

#### Scenario: A save finds two strong candidates

- **GIVEN** two existing active memories M1 and M2 in the same scope each exceed the internal vec threshold against the just-saved row N
- **WHEN** `memory.save({...})` returns
- **THEN** the response SHALL include `candidates: [{ judgmentId, targetId: M1, snippet, similarity, source }, { judgmentId, targetId: M2, ... }]` and `judgmentRequired: true`; two `memory_relations` rows SHALL exist with `status = 'pending'`

#### Scenario: A save finds zero candidates

- **WHEN** no existing memory exceeds the thresholds
- **THEN** the response SHALL include `candidates: []` and `judgmentRequired: false`; no `memory_relations` rows SHALL be inserted

#### Scenario: The just-saved row has no embedding

- **GIVEN** the inline embedding of the just-saved row failed (logged, drain will retry)
- **WHEN** `memory.save` runs candidate detection
- **THEN** only FTS5-derived candidates SHALL be considered; each candidate in the response SHALL carry `source: 'fts'`

#### Scenario: Candidate count exceeds the cap

- **GIVEN** `CANDIDATES_PER_SAVE_MAX = 5` and 12 candidates exceed the thresholds
- **WHEN** `memory.save` returns
- **THEN** the response SHALL include the top 5 by the ranking precedence above; the remaining 7 SHALL NOT have `memory_relations` rows inserted and SHALL NOT surface to the agent; and the response SHALL report the detected count so the truncation is not silent

#### Scenario: The number of pending rows equals the number of surfaced candidates

- **GIVEN** a save whose detection ranked more candidates than `CANDIDATES_PER_SAVE_MAX`
- **WHEN** the save completes
- **THEN** the number of `memory_relations` rows inserted for that save SHALL equal the length of the returned `candidates[]`, and SHALL NOT equal the reported detected count

#### Scenario: The detected count is taken before the cap, not after

- **GIVEN** a save whose detection ranked 12 candidates with `CANDIDATES_PER_SAVE_MAX = 5`
- **WHEN** the save completes
- **THEN** the reported detected count SHALL be 12, and the returned `candidates[]` SHALL hold 5 entries which SHALL be the first 5 of that same ranked order

#### Scenario: A topic-key save's superseded predecessor is neither surfaced nor counted

- **GIVEN** a save carrying a `topic_key` that supersedes a previously-active row P in the same slot
- **WHEN** candidate detection runs for the new row
- **THEN** P SHALL NOT appear in `candidates[]` and SHALL NOT be included in the reported detected count, because P is in the new row's `replaces[]` and is therefore excluded from every channel's pool

#### Scenario: Candidate detection respects scope

- **GIVEN** the just-saved row is in scope `project:'A'`
- **WHEN** candidate detection runs
- **THEN** every candidate's `project_id` SHALL match `'A'`; rows in any other project SHALL NOT be considered, regardless of similarity

#### Scenario: The detected count respects scope

- **GIVEN** memories in another project that would resemble the just-saved row
- **WHEN** candidate detection runs for a row in scope `project:'A'`
- **THEN** the reported detected count SHALL count only pairs whose target lies in `project:'A'`

#### Scenario: A previously dismissed `not_conflict` pair is not re-surfaced

- **GIVEN** an earlier memory M0 (with `topic_key = 'arch/auth'`) for which the agent judged a candidate target X as `relation = 'not_conflict'`
- **AND** a new save N for the same topic whose `replaces[]` includes M0 (so M0 is N's predecessor)
- **WHEN** `memory.save` runs candidate detection for N and X would otherwise exceed the similarity thresholds
- **THEN** X SHALL NOT appear in N's `candidates[]` and NO new pending `memory_relations` row SHALL be inserted for the `(N, X)` pair

#### Scenario: A previously judged `conflicts_with` pair still surfaces

- **GIVEN** an earlier memory M0 for which the agent judged a candidate target Y as `relation = 'conflicts_with'`
- **AND** a new save N for the same topic whose `replaces[]` includes M0
- **WHEN** `memory.save` runs candidate detection for N and Y exceeds the similarity thresholds
- **THEN** Y SHALL still appear in N's `candidates[]` with a fresh pending `memory_relations` row — only `not_conflict` dismissals are suppressed, not unresolved conflicts

#### Scenario: Suppression keys on the ancestry, not the new id

- **GIVEN** a target X dismissed as `not_conflict` only against M0, and a new save N whose `replaces[]` does NOT include M0 (an unrelated save)
- **WHEN** `memory.save` runs candidate detection for N and X exceeds the thresholds
- **THEN** X SHALL still surface for N — the suppression follows the `replaces` ancestry, so a save that does not inherit M0's chain is unaffected by M0's prior dismissal

#### Scenario: A non-ASCII save participates in the lexical pass

- **GIVEN** an existing active memory whose content is non-ASCII (e.g. CJK or accented text) in scope `project:'A'`, and a just-saved row N in the same scope whose content lexically overlaps it
- **WHEN** `memory.save` runs candidate detection
- **THEN** the FTS5 `MATCH` expression built from N's content SHALL be non-empty (it SHALL NOT degrade to skipping the lexical pass), and the overlapping memory SHALL be eligible to surface as a `source: 'fts'` candidate when it clears the FTS threshold

#### Scenario: Omitting common tokens never empties the lexical pass

- **GIVEN** a just-saved row N in scope `project:'A'` whose every builder token occurs in at least half of the indexed rows, and an existing memory in the same scope that is byte-identical to N
- **WHEN** `memory.save` runs candidate detection with no embedding available
- **THEN** the FTS5 `MATCH` expression SHALL be non-empty, the lexical pass SHALL run, and the identical memory SHALL be eligible to surface as a `source: 'fts'` candidate

#### Scenario: A dropped candidate is re-derivable but not reproducible

- **GIVEN** a save whose detection ranked more candidates than the cap, and a later session that wants the pairs which were not surfaced
- **WHEN** the agent re-derives them by calling `memory.search` with the memory's own text and with an `entity` filter
- **THEN** the pairs SHALL be reachable, and the re-derived set SHALL reflect the CURRENT corpus — including memories saved after the original save and excluding rows now `superseded` or `archived` — rather than the set that existed at save time

## ADDED Requirements

### Requirement: The save-time lexical `MATCH` MUST omit terms present in at least half of the index

Before it builds its FTS5 `MATCH` expression, the save-time lexical pass SHALL omit every COMMON token: a token whose document frequency is at least `COMMON_TERM_DOCUMENT_RATIO` times the document total. The comparison SHALL be inclusive.

The pass ORs its capped builder tokens into one `MATCH`, and FTS5 ranks that match set by bm25 before the query's project, status and limit filters apply. The match set is the union of every token's documents across every project, so one token present in most memories made the pass score and sort the entire index on every save. bm25 gives such a token almost no weight: its inverse document frequency is `ln((N − n + 0.5) / (n + 0.5))`, which is at most zero exactly when `n >= N/2`, and FTS5 replaces every such value with the constant `1e-6`. That is also why the comparison is inclusive: at exactly half the index FTS5 already applies the constant. The token's only effect on the result was to enlarge the set being ranked.

- **Frequency source:** the document frequencies and the document total SHALL be read from the index exactly as "The relevance level's term statistics MUST come from the search index" requires: per-term counts over every indexed row, against a total of every row the index covers, in every scope and status. The just-saved row is already indexed when detection runs, so it counts in both, as it does in the bm25 the pass then computes.
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
