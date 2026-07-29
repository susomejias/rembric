## MODIFIED Requirements

### Requirement: Search results MUST carry relation annotations

`memory.search` SHALL include a `relations` array on each result row, sourced from `memory_relations` in a single JOIN (no N+1). The annotations SHALL cover `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped` (judged), and `pending_conflict` (status = 'pending'). The bound is 10 annotations per memory by default, raisable per request by the caller up to a fixed maximum (see the `mcp-api` capability, "`memory.search` and `memory.get` MUST expose the annotation bound and its true total"); excess annotations are visible via the dashboard.

Which annotations survive the bound SHALL NOT depend on the order a database scan returns rows. The annotation list SHALL be ordered before it is bounded, by:

1. **Kind tier**, most decision-relevant first — `conflicts_with`, then `supersedes`, then `superseded_by` (load-bearing: a contradiction the reader must resolve, and the two lifecycle edges telling the reader the row is not current), then `pending_conflict`, then `scoped`, `compatible`, `related` (informational).
2. **The relation's creation time, most recent first.**
3. **The relation's `judgment_id`.**

The ordering SHALL be a **total** order: because `judgment_id` is unique, no two annotations can compare equal, so a batch of judgments sharing a creation timestamp is still ordered deterministically rather than left to scan order.

Consequently a memory carrying more relations than the bound SHALL surface its load-bearing edges rather than an arbitrary sample: neither a large number of informational edges nor a backlog of unjudged candidates SHALL be able to displace a `conflicts_with`, `supersedes` or `superseded_by` annotation. Repeated reads of unchanged data SHALL return the same annotations in the same order, and raising the bound SHALL only extend the list — it SHALL NOT reorder the annotations already returned at a lower bound.

Every row carrying `relations` SHALL also carry `relationsTotal`: the number of annotations that exist for that memory after the `not_conflict` and `orphaned` exclusions and BEFORE the bound is applied. It SHALL be present whether or not the list was bounded, and it SHALL NEVER be the returned list's length restated — when the list was cut, `relationsTotal` SHALL be strictly greater. Computing it SHALL NOT cost an additional query: the underlying reads are unbounded, so the complete count is already available at the moment the list is bounded.

The same ordering, the same caller-supplied bound, and the same total SHALL apply to every annotation list a memory-returning read projects, including both forms of `memory.get`, so two surfaces can never describe the same memory's relations differently. That agreement is about WHICH annotations a read shows and in what order; the SIZE of an annotation's body is a separate, per-surface projection decision. A read that projects annotations for many memories MAY bound the judged `reason` field where the single-memory deep read does not (see the `mcp-api` capability, "Relation annotation reasons MUST be bounded on multi-row reads"), because that field is the only unbounded term in an annotation and it is multiplied by the row count. Where it is bounded, the returned value SHALL be a prefix of the stored one, and no OTHER field, the ordering, the bound, or `relationsTotal` SHALL differ between surfaces. The one-hop expansion in "Memory search MAY expand results via one-hop relation traversal" reads this same ordered list; its kind set and its own cap of 5 are unchanged, but its input SHALL no longer depend on scan order.

#### Scenario: A judged supersedes relation appears on both sides

- **GIVEN** memory N supersedes memory M (judged)
- **WHEN** `memory.search` includes N or M in its results
- **THEN** N's row SHALL include `{ kind: 'supersedes', targetId: 'M', status: 'judged' }` and M's row (when surfaced) SHALL include `{ kind: 'superseded_by', targetId: 'N', status: 'judged' }`, each carrying the judgment's `reason` and `confidence`

#### Scenario: A pending judgment surfaces as `pending_conflict`

- **GIVEN** a save-time candidate between N and M was inserted as `status='pending'` and not yet judged
- **WHEN** `memory.search` returns N
- **THEN** N's `relations` SHALL include `{ kind: 'pending_conflict', targetId: 'M', judgmentId }`

#### Scenario: No relations on a clean memory

- **WHEN** a memory has no rows in `memory_relations`
- **THEN** the search result row SHALL include `relations: []` (the field is always present, never omitted)

#### Scenario: A contradiction is not evicted by informational edges

- **GIVEN** memory M carries twelve judged `related` relations and one judged `conflicts_with` relation, the `conflicts_with` row created before the `related` rows
- **WHEN** `memory.search` returns M at the default bound
- **THEN** M's `relations` SHALL contain 10 entries, the first of which is the `conflicts_with` annotation, and `relationsTotal` SHALL be 13

#### Scenario: A pending backlog cannot evict a judged load-bearing edge

- **GIVEN** memory M carries twenty `pending_conflict` candidates and one judged `supersedes` relation
- **WHEN** `memory.search` returns M
- **THEN** M's `relations` SHALL contain the `supersedes` annotation ahead of every `pending_conflict` annotation

#### Scenario: Repeated reads agree, including on a same-timestamp batch

- **GIVEN** memory M carries more relations than the bound, several of which were judged in one transaction and therefore share a creation timestamp
- **WHEN** `memory.search` returns M twice with no intervening write
- **THEN** both responses SHALL carry the same annotations in the same order

#### Scenario: The true total is reported, bounded or not

- **GIVEN** memory M carries 40 annotations and memory Q carries 3
- **WHEN** `memory.search` returns both at the default bound of 10
- **THEN** M's row SHALL carry 10 annotations and `relationsTotal: 40`, and Q's row SHALL carry 3 annotations and `relationsTotal: 3`

#### Scenario: Raising the bound extends the list without reordering it

- **GIVEN** memory M carries 40 annotations
- **WHEN** `memory.search` is called for M at the default bound and again at a bound of 25
- **THEN** the 25-entry list SHALL begin with exactly the 10 entries the default returned, in the same order, and `relationsTotal` SHALL be 40 in both responses

#### Scenario: Surfaces agree on which annotations, not on how long a reason is

- **GIVEN** memory M carries a judged annotation whose stored `reason` exceeds the multi-row reason bound
- **WHEN** M is read via `memory.search` and via `memory.get` with `id`
- **THEN** both responses SHALL report the same `relationsTotal` and the same annotations in the same order, with the same `kind`, `targetId`, `status` and `confidence`
- **AND** the only difference SHALL be that the search row's `reason` is a bounded prefix of the value `memory.get` returns in full

### Requirement: Retrieval and lifecycle constants MUST be named and bounded in one place

Ranking, projection and lifecycle behaviour is governed by a set of compile-time constants that no requirement previously named, which made each one invisible to review and free to drift. None SHALL be operator-configurable or exposed as a per-request tunable, and each SHALL be declared once, as a named constant, in the module that owns the behaviour:

- `RANK_WINDOW_MARGIN` — the over-fetch added to `limit + offset` before the floor and ceiling are applied, so a page near a window edge still fuses over more candidates than it returns.
- `RANK_WINDOW_CEILING` — the hard cap on that window, set strictly above the maximum `limit`. It doubles as the entity path's page size when no `limit` is given (see `mcp-api`), so exact-address retrieval is complete-within-a-bound rather than truncated to a ranked default.
- `RELATIVE_LEVEL_RATIO` — the relative-filter ratio applied against the fused pool's highest relevance level. Named for what it measures; it is not a consecutive-pair gap ratio and SHALL NOT be described as one.
- `RELEVANCE_LIMIT` — the cap on `memory.context`'s relevance channel, shared by its entity pre-pass and its ranked pass.
- `CANDIDATE_POOL_SIZE` — the per-channel pool each save-time candidate channel scans BEFORE the merged list is ranked and capped. It is the bound that makes the reported detected count a lower bound rather than a total, and for the lexical channel it IS the admission rule (see "Save-time lexical candidate scoring MUST increase with match quality"), so exposing it as configuration would make an admission rule operator-settable. It is applied per channel, and the entity channel applies it once per extracted entity, so the merged pool — and therefore the detected count — MAY exceed it.
- `ENTITY_RARITY_THRESHOLD` — the maximum share of a scope's active memories an entity may be linked to before it stops proposing save-time candidates. A proportion, not an absolute count, so it does not become inert as a corpus grows.
- `ENTITIES_PROJECTION_CAP` — the per-memory bound on the `entities[]` projection. The reads behind it carry no `LIMIT`, so the complete per-memory count is in hand where the bound is applied and SHALL be reported as a count rather than as an indication that the bound was hit. Unlike `CANDIDATE_POOL_SIZE` above there is no pool upstream of it, so that count is exact and MAY carry a `Total` suffix.
- `PREDECESSOR_CAP` — the bound on the supersedes-chain walk.
- `ESCALATION_MULTIPLIER` — the multiple of its own TTL a memory sits `needs_review` before `reviewEscalated` derives true.
- `REBUILD_MAX_BATCHES` — the bound on one operator-triggered derived-index rebuild pass, so the rebuild cannot become an unbounded blocking loop.
- `ANNOTATION_REASON_CHARS` — the character bound applied to a judged annotation's `reason` on the multi-row annotation surfaces. It bounds a READ PROJECTION only: the stored `reason` and its input cap are untouched, and the single-memory deep read projects the value verbatim (see the `mcp-api` capability, "Relation annotation reasons MUST be bounded on multi-row reads").
- `RELATION_ANNOTATION_RESPONSE_BUDGET` — the maximum number of annotations one multi-row response may project, bounding `row count × per-row annotation bound`. It SHALL be derived from shipped default behaviour (the maximum `limit` times the multi-row default bound) so that no request relying on defaults can be rejected by it. It is not itself a per-request tunable: it bounds the product of two request parameters, and a request exceeding it is rejected rather than served with a reduced projection.
- The annotation payload ceiling — the maximum serialized size the annotation projection of any legal request may reach, asserted in CI against a measured worst-case response rather than against the product of the constants above (see the `mcp-api` capability, "The worst-case annotation payload MUST be bounded by a named ceiling asserted in CI").

Three gates ship disabled (`null`): the abstention floor and `RELATIVE_LEVEL_RATIO` (see "Recall MUST be able to return nothing"), and the per-session `DIVERSITY_CAP`. Their disabled state is not itself the contract — an uncalibrated gate silently removes recall, so what is contracted is the evidence a commit must carry to enable one.

Enabling the abstention floor or `RELATIVE_LEVEL_RATIO` SHALL require, in the same change:

1. a committed sweep across a grid of candidate values, produced by the evaluation harness rather than asserted;
2. an over-abstention rate of zero at every committed `k` — no query with a gold answer returns nothing;
3. an abstention false-positive rate at or below its committed cap;
4. precision, recall and MRR at or above their committed floors at every committed `k`;
5. the chosen value in the interior of a plateau at least two grid steps wide on each of the criteria above, so a value that holds at exactly one grid point is rejected as a cliff edge rather than accepted as a calibration.

Enabling `DIVERSITY_CAP` SHALL additionally require a session-labelled evaluation fixture, because it is applied to the whole fused pool before the page is sliced — a held-back row is replaced by whatever ranked next in a 64–400 row pool rather than by a comparable row, which on a single-topic session measurably swaps most of page 1 for noise — and the current corpus cannot see that regression, every corpus row carrying a null session id, which is never grouped.

#### Scenario: A constant is not reachable as a request parameter

- **WHEN** any MCP tool input schema is inspected
- **THEN** none of the constants above SHALL be settable per request

#### Scenario: The candidate pool size is not operator-configurable

- **WHEN** the environment schema is inspected
- **THEN** `CANDIDATE_POOL_SIZE` SHALL NOT be readable from the environment, and `CANDIDATES_PER_SAVE_MAX` SHALL remain the only operator knob over save-time candidate surfacing

#### Scenario: The annotation payload constants are declared once

- **WHEN** the modules owning the annotation projection are inspected
- **THEN** `ANNOTATION_REASON_CHARS` and `RELATION_ANNOTATION_RESPONSE_BUDGET` SHALL each be declared exactly once, alongside `RELATION_ANNOTATION_MAX`, and every enforcement site SHALL read them from that declaration rather than restating a literal

#### Scenario: A disabled gate stays disabled without a calibration

- **WHEN** the abstention floor, `RELATIVE_LEVEL_RATIO`, or the diversity cap is enabled
- **THEN** the change SHALL be accompanied by a measurement on the evaluation harness, and for the diversity cap by a session-labelled fixture the harness can see the regression through

#### Scenario: A gate is enabled without a committed sweep

- **WHEN** a change sets the abstention floor or `RELATIVE_LEVEL_RATIO` to a non-null value without a committed harness sweep across a grid of candidate values
- **THEN** the change SHALL be rejected

#### Scenario: A candidate value that costs recall is rejected

- **GIVEN** a swept candidate value at which any query with a gold answer returns nothing
- **WHEN** that value is proposed for the abstention floor
- **THEN** it SHALL be rejected regardless of its abstention false-positive rate

#### Scenario: A candidate value that holds at only one grid point is rejected

- **GIVEN** a swept candidate value that meets every criterion at its own grid point and fails at both adjacent grid points
- **WHEN** that value is proposed
- **THEN** it SHALL be rejected as a cliff edge, and the gate SHALL remain disabled

#### Scenario: Re-enabling the diversity cap without a session-labelled fixture

- **WHEN** `DIVERSITY_CAP` is set to a non-null value while every row in the evaluation corpus carries a null session id
- **THEN** the change SHALL be rejected, because the harness cannot observe the regression the cap causes
