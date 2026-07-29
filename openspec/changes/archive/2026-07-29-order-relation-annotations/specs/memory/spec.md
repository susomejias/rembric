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

The same ordering, the same caller-supplied bound, and the same total SHALL apply to every annotation list a memory-returning read projects, including both forms of `memory.get`, so two surfaces can never describe the same memory's relations differently. The one-hop expansion in "Memory search MAY expand results via one-hop relation traversal" reads this same ordered list; its kind set and its own cap of 5 are unchanged, but its input SHALL no longer depend on scan order.

#### Scenario: A judged supersedes relation appears on both sides

- **GIVEN** memory N supersedes memory M (judged)
- **WHEN** `memory.search` includes N or M in its results
- **THEN** N's row SHALL include `{ kind: 'supersedes', targetId: 'M', snippet }` and M's row (when surfaced) SHALL include `{ kind: 'superseded_by', targetId: 'N', snippet }`

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
