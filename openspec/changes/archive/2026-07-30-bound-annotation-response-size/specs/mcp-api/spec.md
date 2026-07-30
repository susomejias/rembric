## ADDED Requirements

### Requirement: Relation annotation reasons MUST be bounded on multi-row reads

A judged annotation carries the judgment's `reason`, which `memory.judge` and `memory.compare`
accept at up to 2 000 characters. On a read that projects annotations for MANY memories that field
is the only term in an annotation that is not fixed-size, and it is multiplied by the row count.
It SHALL therefore be bounded on those reads, exactly as `memory.context` already bounds every
other stored-text projection it emits in a multi-item list.

On the multi-row annotation surfaces — `memory.search` result rows and the batch (`ids`) form of
`memory.get` — each judged annotation's `reason` SHALL be projected through the same truncation
semantics `memory.context` uses (slice to a named character bound and append an ellipsis when the
stored value is longer). The bound SHALL be a single named constant, applied identically at every
multi-row surface, so no two multi-row reads can disagree about how much of a reason they show.

The truncated value SHALL be a PREFIX of the stored value (plus the ellipsis marker), so a bounded
reason can never misrepresent the judgment by rearrangement or summary.

The single-id (`id`) form of `memory.get` SHALL project `reason` VERBATIM. It returns one memory,
so its annotation exposure is the per-row bound rather than the per-row bound times a page, and it
is the read a caller uses to drill into a specific memory — a bound there would make a stored
reason unreachable over MCP. The operator dashboard likewise SHALL continue to show the full
stored reason.

The bound SHALL be a read projection only. No stored `memory_relations.reason` SHALL be rewritten,
shortened or re-validated by this bound, and the input cap on `reason` SHALL NOT change.

#### Scenario: A long reason is bounded in search results

- **GIVEN** a judged annotation on memory M whose stored `reason` is 2 000 characters
- **WHEN** `memory.search` returns M
- **THEN** that annotation's `reason` SHALL be at most the named character bound, SHALL end with the
  ellipsis marker, and its leading characters SHALL match the stored value

#### Scenario: The deep read returns the reason verbatim

- **WHEN** `memory.get` is called with `id` for the same memory M
- **THEN** that annotation's `reason` SHALL be the stored 2 000-character value, untruncated

#### Scenario: Both multi-row surfaces bound it identically

- **WHEN** memory M is read via `memory.search` and via `memory.get` with `ids`
- **THEN** the same annotation's `reason` SHALL be identical in both responses

#### Scenario: A short reason is untouched

- **GIVEN** a judged annotation whose stored `reason` is shorter than the bound
- **WHEN** `memory.search` returns its memory
- **THEN** the returned `reason` SHALL be the stored value with no ellipsis appended

#### Scenario: The stored row is unchanged

- **GIVEN** any number of reads that bound the reason
- **WHEN** the `memory_relations` row is inspected
- **THEN** its `reason` column SHALL hold the full original text

### Requirement: The worst-case annotation payload MUST be bounded by a named ceiling asserted in CI

The annotation term of a response is entirely SCHEMA-derived: it is the product of the row bound
(`limit`, or `ids.length`), the per-row annotation bound, and the per-annotation size bound. A
product of declared bounds can be bounded in advance and MUST be, because a tool result larger
than the caller's context window is not a degraded answer but a guaranteed overflow of the context
the memory server exists to protect.

A single named constant SHALL express the maximum serialized size the annotation projection of any
LEGAL request may reach. A CI test SHALL assert it by constructing the largest legal request at
every annotation surface (`memory.search` rows, batch `memory.get`, single-id `memory.get`) against
a corpus of memories each carrying the maximum number of annotations at the maximum stored `reason`
length, invoking the real tools, and measuring the serialized `CallToolResult`. The measurement
SHALL count EVERY copy of the payload the result carries: the MCP result emits the payload both as
a `text` content block and as `structuredContent`, so a measurement of one copy understates the
transported size.

The ceiling SHALL be derived from that measurement and committed with it. It SHALL NOT be derived
by multiplying the constants, because such an assertion can pass while the serializer disagrees —
JSON indentation, key names and the differing pending/judged annotation shapes are not in the
arithmetic.

A later change that raises the row bound, the per-row annotation bound, the annotation reason bound
or the aggregate budget SHALL cause this assertion to fail rather than silently re-opening the
ceiling. Such a collision SHALL be resolved as an explicit decision — either the change fits under
the ceiling, or it raises the ceiling and records the re-measured worst case — and SHALL NOT be
resolved by weakening the measurement.

This requirement bounds the annotation term ONLY. A memory's `content` has no maximum at save and
is therefore data-derived, not schema-derived; no claim is made here that a response's total size is
bounded, and `snippet`, `fields` and `limit` remain the caller's instruments for that.

#### Scenario: The worst legal request stays inside the ceiling

- **WHEN** the largest legal `memory.search` request is issued against memories each carrying the
  maximum number of annotations at the maximum stored `reason` length
- **THEN** the serialized `CallToolResult`, counting both the `text` block and `structuredContent`,
  SHALL be within the named ceiling

#### Scenario: Every annotation surface is covered

- **WHEN** the CI assertion runs
- **THEN** it SHALL measure `memory.search` rows, batch `memory.get`, and single-id `memory.get`,
  each at its own largest legal request

#### Scenario: Raising a bound fails the assertion

- **GIVEN** a change that raises the per-row annotation bound, the aggregate budget, or the
  annotation reason bound so that the measured worst case exceeds the ceiling
- **WHEN** the test suite runs
- **THEN** the assertion SHALL fail, and the change SHALL either fit under the ceiling or raise it
  and record the re-measured worst case

## MODIFIED Requirements

### Requirement: memory.search response MUST include relation annotations

The `memory.search` response SHALL include a `relations` array on each result row, populated in a single JOIN over `memory_relations`. Annotation kinds: `supersedes`, `superseded_by`, `conflicts_with`, `related`, `compatible`, `scoped`, `pending_conflict`. Each annotation SHALL include the target id and the annotation kind; a judged annotation SHALL additionally carry the judgment's `reason` and `confidence`, and a pending annotation its `judgmentId`. An annotation SHALL NOT carry a snippet of the target's content — no read has ever projected one, and the earlier wording claiming otherwise described a field that does not exist. On the multi-row surfaces the `reason` is bounded (see "Relation annotation reasons MUST be bounded on multi-row reads").

Each result row SHALL additionally carry the derived review metadata for the memory (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`) for `active` rows, and `reviewAfter` when non-null. These fields are informational metadata only — they SHALL NOT change result ordering, scope isolation, or which rows are returned. Rows that are not `active` SHALL omit `reviewState`.

`memory.search` SHALL accept two OPTIONAL projection parameters that shape the returned rows WITHOUT changing which rows are returned or their order: `snippet` (a positive integer) and `fields` (a list of row field names). When `snippet` is supplied, each returned row's `content` SHALL be truncated to at most that many characters using the same truncation semantics as `memory.context` (the snippet helper: slice and append an ellipsis when the content exceeds the cap). When `fields` is supplied, the response SHALL return only the named fields PLUS the always-present identity fields `id`, `type`, and `title` (so every projected row remains identifiable). The two parameters compose: requesting `content` in `fields` together with a `snippet` cap yields a truncated `content`. When NEITHER `snippet` NOR `fields` is supplied, the response SHALL be the unchanged full-content row shape (byte-for-byte back-compatible). Projection SHALL be applied AFTER selection, ranking and scope enforcement — it SHALL NOT alter any of them. Projection touches no timestamp, and neither does the search it projects: `memory.search` advances `last_seen_at` for no row (see the `memory` capability, "Being returned by a search MUST NOT be sufficient to confer durability").

#### Scenario: A search result row reports its relations

- **WHEN** `memory.search` returns memory N which has a judged `supersedes` relation to memory M and a pending relation to memory Q
- **THEN** the result row SHALL include `relations: [{ kind: 'supersedes', targetId: 'M', status: 'judged', reason, confidence }, { kind: 'pending_conflict', targetId: 'Q', status: 'pending', judgmentId }]`

#### Scenario: The annotation set respects the cap

- **GIVEN** memory N has 25 rows in `memory_relations`
- **WHEN** the cap is 10
- **THEN** the response SHALL include the 10 highest-precedence annotations under the ordering the `memory` capability requires (kind tier, then recency, then `judgment_id`) — NOT merely the 10 most recent; the rest are accessible via the dashboard

#### Scenario: A search result row reports its review state

- **GIVEN** an `active` memory N whose derived `reviewState` is `'needs_review'`
- **WHEN** `memory.search` returns N
- **THEN** the result row SHALL include `reviewState: 'needs_review'` and a non-null `reviewAfter`
- **AND** the presence of `reviewState` SHALL NOT alter N's position in the result ordering

#### Scenario: A search with no projection returns full content unchanged

- **GIVEN** `memory.search` is called WITHOUT `snippet` and WITHOUT `fields`
- **WHEN** the response is returned
- **THEN** each row SHALL carry its full untruncated `content` and the same field set as before this change

#### Scenario: A search with a snippet cap truncates content

- **GIVEN** a result row whose `content` is longer than `N` characters
- **WHEN** `memory.search` is called with `snippet: N`
- **THEN** that row's returned `content` SHALL be the content truncated to at most `N` characters using the `memory.context` snippet truncation semantics
- **AND** the set of rows returned and their order SHALL be identical to the same query without `snippet`

#### Scenario: A search with field selection keeps identity fields

- **GIVEN** `memory.search` is called with `fields: ['status']`
- **WHEN** the response is returned
- **THEN** each row SHALL include `status` and the always-present identity fields `id`, `type`, and `title`, and MAY omit fields not requested (e.g. `tags`, `relations`)
- **AND** the set of rows returned and their order SHALL be identical to the same query without `fields`

#### Scenario: A projected search still touches nothing

- **WHEN** `memory.search` is called with `snippet` and `fields` over rows that are decay-eligible
- **THEN** no returned row's `last_seen_at` SHALL have been advanced

### Requirement: `memory.search` and `memory.get` MUST expose the annotation bound and its true total

A bounded list whose depth is invisible cannot be told from a complete one, and a signal that something was withheld is useless without a way to ask for it. Both tools that project a memory's relation annotations SHALL therefore expose the bound as a parameter and the true count as a response field. (The ordering under that bound belongs to the `memory` capability, "Search results MUST carry relation annotations", and is not restated here.)

`memory.search` and `memory.get` SHALL accept an OPTIONAL `relations_limit` integer that bounds the `relations` array projected per memory. Its DEFAULT SHALL be the surface's existing behaviour — 10 for `memory.search` result rows and for `memory.get`'s batch (`ids`) form, 50 for `memory.get`'s single (`id`) form — so a request that omits it receives exactly the annotations it receives today. Its MAXIMUM SHALL be a single shared value of 50 across all three surfaces, being the largest annotation bound the server already serves.

A `relations_limit` above the maximum SHALL be REJECTED as an invalid argument, not silently clamped, consistent with every other numeric bound on this surface (`limit` rejects above 200). Rejection is only safe if the caller is told how to stay inside the bound, so the parameter's description SHALL state: the default; that `relationsTotal` reports how many annotations exist; that the correct follow-up ask is therefore `min(relationsTotal, <maximum>)`; and that a larger value is rejected rather than clamped. A description that instructs the agent to pass a total which may exceed the maximum SHALL be treated as a defect — it is the failure this repo already fixed once, when a tool description documented passing `pendingJudgmentsTotal` into a parameter that rejected it for exactly the queues worth draining.

A per-row bound does not bound a response. `memory.search` accepts `limit` up to 200 and `memory.get` accepts up to 100 `ids`, each independent of `relations_limit`, so the two maxima multiply into a response the specification permitted and no requirement bounded. The multi-row surfaces SHALL therefore ALSO be bounded in aggregate: the product of the requested row count and the effective per-row annotation bound — `limit × effective relations bound` for `memory.search`, `ids.length × effective relations bound` for batch `memory.get` — SHALL NOT exceed a single named budget constant. The effective bound is the caller's `relations_limit` when supplied and the surface's default otherwise.

The budget SHALL be the largest annotation count the server already serves to a caller who passes nothing — the largest row count ANY branch serves for an omitted `limit`, times the multi-row default — so that no request relying on DEFAULTS can ever be rejected and the aggregate ceiling introduces no payload regime that is not already shipping. The check SHALL be applied to the EFFECTIVE row count — the number of rows the request would actually serve — and not to the value the caller declared. Where a branch substitutes its own page size for an omitted `limit`, budgeting against the declared value bounds nothing on that branch.

It follows that the budget is a TRADE rather than a reduction: a caller MAY spend it on many rows with few annotations each, or few rows with the maximum annotations each, and any combination whose product is within the budget SHALL be served.

A request whose product exceeds the budget SHALL be REJECTED with an invalid-argument error, on the same terms and for the same reason as an over-maximum `relations_limit`: silently serving fewer annotations than asked for would be indistinguishable from a complete list except by comparison against `relationsTotal`, which is the truncation-flag defect in a new place. The rejection SHALL name both parameters, the budget, and at least one legal combination, so the caller can comply in the same turn. Because the constraint spans two parameters it cannot be declared in a single field's schema; the `relations_limit` description SHALL therefore state that the two bounds are jointly limited and how to trade between them, and SHALL name single-id `memory.get` as the way to read one memory's annotations at the maximum.

Every response row carrying `relations` SHALL carry `relationsTotal` alongside it, on the same terms as `pendingJudgmentsTotal`: the count of annotations that exist for that memory, never the returned list's length restated. It SHALL be present whether or not the list was bounded. No companion boolean SHALL be added — truncation is `relationsTotal > relations.length`, and a redundant flag beside a total is duplicated state.

`relations_limit` SHALL NOT alter which memories a read returns, their order, or their scope — it bounds a per-row projection only, like `snippet` and `fields`. The aggregate budget SHALL likewise never change a served response: it either admits the request unchanged or rejects it. In particular the budget SHALL NOT be enforced by serving fewer annotations on some rows than on others, which would make a row's `relations` depend on the other rows in the page.

#### Scenario: The default is unchanged

- **WHEN** `memory.search` is called without `relations_limit`
- **THEN** each result row SHALL carry at most 10 annotations, exactly as before this parameter existed
- **AND** each row SHALL carry `relationsTotal`

#### Scenario: A caller raises the bound to the total it was told

- **GIVEN** a search whose result row reports `relationsTotal: 40` beside 10 annotations
- **WHEN** the caller repeats the search with `relations_limit: 40`
- **THEN** that row SHALL carry 40 annotations and `relationsTotal: 40`

#### Scenario: An over-ask is rejected, not clamped

- **WHEN** `memory.search` or `memory.get` is called with `relations_limit: 51`
- **THEN** the call SHALL fail with an invalid-argument error and SHALL NOT return a clamped result

#### Scenario: A request whose product exceeds the budget is rejected

- **WHEN** `memory.search` is called with the maximum `limit` and the maximum `relations_limit`, whose product exceeds the budget
- **THEN** the call SHALL fail with an invalid-argument error naming both parameters, the budget, and at least one legal combination
- **AND** no partial or reduced-annotation result SHALL be returned

#### Scenario: A default request is never rejected by the budget

- **WHEN** `memory.search` is called at the maximum `limit` without `relations_limit`, or `memory.get` is called with the maximum number of `ids` without `relations_limit`
- **THEN** the request SHALL be served, because the budget is derived from exactly that worst case

#### Scenario: The budget is spendable either way

- **GIVEN** a budget equal to the largest row count any branch serves for an omitted `limit`, times the multi-row default
- **WHEN** the caller asks for few rows with the maximum `relations_limit`, or for the maximum rows at the default annotation bound
- **THEN** both requests SHALL be served, and only a request whose product exceeds the budget SHALL be rejected

#### Scenario: The single-id deep read is unaffected by the budget

- **WHEN** `memory.get` is called with `id` and `relations_limit: 50`
- **THEN** the request SHALL be served, its product being one row times the maximum

#### Scenario: The description teaches the bounded ask

- **WHEN** an MCP client retrieves the tool description for `memory.search` or `memory.get`
- **THEN** the `relations_limit` description SHALL state its default, its maximum, that `relationsTotal` reports the true count, that the follow-up ask is `min(relationsTotal, <maximum>)`, and that a larger value is rejected rather than clamped
- **AND** it SHALL state that `relations_limit` and the row count are jointly bounded, how to trade between them, and that single-id `memory.get` reads one memory's annotations at the maximum

#### Scenario: Both `memory.get` forms agree with search

- **GIVEN** a memory carrying more annotations than 10
- **WHEN** it is read via `memory.search`, via `memory.get` with `ids`, and via `memory.get` with `id`
- **THEN** all three SHALL report the same `relationsTotal`, and each returned list SHALL be a prefix of the same ordered sequence of annotations, differing only in length according to that surface's default or the caller's `relations_limit` — and, for the `reason` field alone, in whether it is bounded (see "Relation annotation reasons MUST be bounded on multi-row reads")

#### Scenario: The bound does not affect selection

- **GIVEN** two searches differing only in `relations_limit`
- **WHEN** both are executed
- **THEN** they SHALL return the same memories in the same order, differing only in the length of each row's `relations` array
