## REMOVED Requirements

### Requirement: The `memory.get` tool MUST return the memory and its history
**Reason**: Replaced by an explicit batch-only read preserving deep metadata per item.
**Migration**: Use `memory.get_batch({ ids: [id] })`, read `memories[0]`, and request `relations_limit: 50` for deep annotations. Successful memory batch reads advance their resolved heads' access signals regardless of batch size.

### Requirement: The `memory.confirm` tool MUST follow the supersedes chain
**Reason**: Replaced by batch-only confirmation with unchanged atomic chain-head events.
**Migration**: Use `memory.confirm_batch({ ids: [id], verdict?, reason?, sessionId? })`; success always carries `confirmed`.

### Requirement: The MCP server MUST expose `memory.judge`
**Reason**: Replaced by batch-only judgment with unchanged per-item transactions.
**Migration**: Use `memory.judge_batch({ judgments: [{ judgmentId, relation, reason?, confidence?, evidence? }] })` and inspect `results`.

### Requirement: `memory.search` and `memory.get` MUST expose the annotation bound and its true total
**Reason**: The individual memory read is removed; annotation guidance must name the batch-only deep read.
**Migration**: Use `memory.get_batch({ ids: [id], relations_limit: 50 })` for a deep read; the default remains 10 for batch entries and search.

## ADDED Requirements

### Requirement: The MCP surface SHALL use the explicit batch contracts

The four replacements SHALL obey the `explicit-batch-tools` capability. Old registrations and singular arguments SHALL be absent. Real tools/list schemas SHALL require explicit arrays for mutations; both reads SHALL accept IDs or a period, mutually exclusively. Descriptions SHALL distinguish memory creation dates from session activity spans and state that period results are current records, not historical snapshots. Reads SHALL accept limit(max20)/offset and require collection fields, errors, total and nextOffset in output. Confirmation confirmed and judgment results SHALL be required. Scope and authorization errors SHALL remain top-level failures. Reads SHALL return successful data and associated `{ id, code, message }` entries in `errors`; they SHALL set MCP `isError: true` when attempted items exist but none succeeds, including for a one-item batch. `memory.judge_batch` SHALL apply the same all-failed signaling rule while retaining ordered per-item `results` and independent transactions. Successful memory batch targets SHALL advance their resolved heads' access signals regardless of batch size; reading SHALL NOT clear `needs_review`. Tool descriptions SHALL teach one-item arrays, complete metadata, partial reads, successful memory batch dereference access semantics and unchanged mutation guarantees. All other tools SHALL remain unchanged.

#### Scenario: The same shape serves one and many
- **WHEN** a client executes any replacement with one valid item, then multiple valid items
- **THEN** both responses SHALL use the same collection or count envelope
- **AND** old tool calls and scalar inputs SHALL fail at the MCP boundary

### Requirement: `memory.search` and `memory.get_batch` MUST expose the annotation bound and its true total

A bounded list whose depth is invisible cannot be told from a complete one, and a signal that something was withheld is useless without a way to ask for it. Both tools that project a memory's relation annotations SHALL therefore expose the bound as a parameter and the true count as a response field. (The ordering under that bound belongs to the `memory` capability, "Search results MUST carry relation annotations", and is not restated here.)

`memory.search` and `memory.get_batch` SHALL accept an OPTIONAL `relations_limit` integer that bounds the `relations` array projected per memory. Its DEFAULT SHALL be the surface's existing behaviour — 10 for `memory.search` result rows and `memory.get_batch` entries — so a request that omits it receives exactly the annotations it receives today. Its MAXIMUM SHALL be a single shared value of 50 across both surfaces, being the largest annotation bound the server already serves.

A `relations_limit` above the maximum SHALL be REJECTED as an invalid argument, not silently clamped, consistent with every other numeric bound on this surface (`limit` rejects above 200). Rejection is only safe if the caller is told how to stay inside the bound, so the parameter's description SHALL state: the default; that `relationsTotal` reports how many annotations exist; that the correct follow-up ask is therefore `min(relationsTotal, <maximum>)`; and that a larger value is rejected rather than clamped. A description that instructs the agent to pass a total which may exceed the maximum SHALL be treated as a defect — it is the failure this repo already fixed once, when a tool description documented passing `pendingJudgmentsTotal` into a parameter that rejected it for exactly the queues worth draining.

A per-row bound does not bound a response. `memory.search` accepts `limit` up to 200 and `memory.get_batch` serves at most20 outcomes per page, each independent of `relations_limit`, so the two maxima multiply into a response the specification permitted and no requirement bounded. The multi-row surfaces SHALL therefore ALSO be bounded in aggregate: the product of the requested row count and the effective per-row annotation bound — `limit × effective relations bound` for `memory.search`, `page target count × effective relations bound` for batch `memory.get_batch` — SHALL NOT exceed a single named budget constant. The effective bound is the caller's `relations_limit` when supplied and the surface's default otherwise.

The budget SHALL be the largest annotation count the server already serves to a caller who passes nothing — the largest row count ANY branch serves for an omitted `limit`, times the multi-row default — so that no request relying on DEFAULTS can ever be rejected and the aggregate ceiling introduces no payload regime that is not already shipping. The check SHALL be applied to the EFFECTIVE row count — the number of rows the request would actually serve — and not to the value the caller declared. Where a branch substitutes its own page size for an omitted `limit`, budgeting against the declared value bounds nothing on that branch.

It follows that the budget is a TRADE rather than a reduction: a caller MAY spend it on many rows with few annotations each, or few rows with the maximum annotations each, and any combination whose product is within the budget SHALL be served.

A request whose product exceeds the budget SHALL be REJECTED with an invalid-argument error, on the same terms and for the same reason as an over-maximum `relations_limit`: silently serving fewer annotations than asked for would be indistinguishable from a complete list except by comparison against `relationsTotal`, which is the truncation-flag defect in a new place. The rejection SHALL name both parameters, the budget, and at least one legal combination, so the caller can comply in the same turn. Because the constraint spans two parameters it cannot be declared in a single field's schema; the `relations_limit` description SHALL therefore state that the two bounds are jointly limited and how to trade between them, and SHALL name a one-item `memory.get_batch` with `relations_limit: 50` as the way to read one memory's annotations at the maximum.

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

- **WHEN** `memory.search` or `memory.get_batch` is called with `relations_limit: 51`
- **THEN** the call SHALL fail with an invalid-argument error and SHALL NOT return a clamped result

#### Scenario: A request whose product exceeds the budget is rejected

- **WHEN** `memory.search` is called with the maximum `limit` and the maximum `relations_limit`, whose product exceeds the budget
- **THEN** the call SHALL fail with an invalid-argument error naming both parameters, the budget, and at least one legal combination
- **AND** no partial or reduced-annotation result SHALL be returned

#### Scenario: A default request is never rejected by the budget

- **WHEN** `memory.search` is called at the maximum `limit` without `relations_limit`, or `memory.get_batch` is called with at least20 distinct IDs without `relations_limit`
- **THEN** the request SHALL be served, because the budget is derived from exactly that worst case

#### Scenario: The budget is spendable either way

- **GIVEN** a budget equal to the largest row count any branch serves for an omitted `limit`, times the multi-row default
- **WHEN** the caller asks for few rows with the maximum `relations_limit`, or for the maximum rows at the default annotation bound
- **THEN** both requests SHALL be served, and only a request whose product exceeds the budget SHALL be rejected

#### Scenario: The single-id deep read is unaffected by the budget

- **WHEN** `memory.get_batch` is called with `ids: [id]` and `relations_limit: 50`
- **THEN** the request SHALL be served, its product being one row times the maximum

#### Scenario: The description teaches the bounded ask

- **WHEN** an MCP client retrieves the tool description for `memory.search` or `memory.get_batch`
- **THEN** the `relations_limit` description SHALL state its default, its maximum, that `relationsTotal` reports the true count, that the follow-up ask is `min(relationsTotal, <maximum>)`, and that a larger value is rejected rather than clamped
- **AND** it SHALL state that `relations_limit` and the row count are jointly bounded, how to trade between them, and that a one-item `memory.get_batch` with `relations_limit: 50` reads one memory's annotations at the maximum

#### Scenario: Memory batch reads agree with search

- **GIVEN** a memory carrying more annotations than 10
- **WHEN** it is read via `memory.search`, via `memory.get_batch` with multiple `ids`, and via `memory.get_batch` with `ids: [id]`
- **THEN** all three SHALL report the same `relationsTotal`, and each returned list SHALL be a prefix of the same ordered sequence of annotations, differing only in length according to that surface's default or the caller's `relations_limit` — and, for the `reason` field alone, in whether it is bounded (see "Relation annotation reasons MUST be bounded on multi-row reads")

#### Scenario: The bound does not affect selection

- **GIVEN** two searches differing only in `relations_limit`
- **WHEN** both are executed
- **THEN** they SHALL return the same memories in the same order, differing only in the length of each row's `relations` array

## MODIFIED Requirements

### Requirement: `memory.context` MUST offer a relevance channel alongside recency

`memory.context` SHALL accept an optional `focus` string and SHALL return a `relevantMemories[]` channel. The existing recency channel SHALL be unchanged and the two SHALL be separately labelled in the response, so the model can tell which rows were selected for relevance and which for recency.

`memory.context` is the tool the protocol directs agents to when starting or resuming work, and its recency channel is ordered by activity alone — nothing about the work at hand influences it. Recency answers "what happened lately", which is not the same question as "what bears on this task", and on a corpus spanning several projects the two answers diverge quickly.

The relevance channel is filled in two passes, in this order. First, an **entity pre-pass**: identifiers recognised in the seed text by the deterministic extractor are looked up as exact addresses, and their linked in-scope memories are admitted first, because an exact identifier match is stronger evidence than any ranked score. Second, if the channel is still under its cap, the scoped hybrid search that backs `memory.search` fills the remainder. Rows are deduped by id across both passes, and each row SHALL carry a `via` field (`'entity'` | `'ranked'`) naming the pass that found it, so the two populations stay distinguishable in the response — the same observability `memory.search`'s entity flag provides.

The ranked pass's verdict SHALL NOT be discarded. Withholding it makes an empty or short relevance channel indistinguishable from a channel the search deliberately declined to fill, which is the same defect on this surface as it is on `memory.search`. The response SHALL therefore carry the ranked pass's abstention flag, its reason when abstaining, and its shortening flag, grouped under a single OPTIONAL response field so that one presence check answers "did the ranked pass run at all". Inside that field the flag names SHALL match `memory.search`'s, so the two surfaces read identically.

That field SHALL be present ONLY when the ranked pass actually executed. Two paths skip it — no derivable seed, and an entity pre-pass that already filled the channel to its cap — and reporting `abstained: false` for a search that never ran would assert a verdict the server never measured. Its shortening flag describes the ranked pass's own page against the limit THAT PASS requested, not the channel's cap: the channel MAY therefore be full while the shortening flag is set, and the requirement is that this be stated rather than that the pass's limit be changed.

When `focus` is absent, the server SHALL derive a seed from signals it already holds for the connection — the active project, the session's working directory, and the most recent curated prompts — so an agent that does not know to pass `focus` still receives relevance. When no seed can be derived, the relevance channel SHALL be empty rather than absent, and the recency channel SHALL still be returned.

#### Scenario: An explicit focus drives the relevance channel

- **WHEN** `memory.context` is called with a `focus` describing the task at hand
- **THEN** `relevantMemories[]` SHALL contain scoped results for that text
- **AND** `recentMemories[]` SHALL be unchanged from what the same call returns without `focus`

#### Scenario: An entity in the seed outranks the ranked pass

- **GIVEN** a memory linked to a file path named in the `focus`, and other memories that rank well for the same text
- **WHEN** `memory.context` is called
- **THEN** the linked memory SHALL be admitted, carrying `via: 'entity'`, before any row carrying `via: 'ranked'`

#### Scenario: The ranked pass fills the remainder

- **GIVEN** a `focus` naming one identifier linked to a single memory, and a cap larger than one
- **WHEN** `memory.context` is called
- **THEN** the remaining slots SHALL be filled by the hybrid search, each row carrying `via: 'ranked'`, with no row repeated across the two passes

#### Scenario: A seed with no identifier still returns relevance

- **GIVEN** a `focus` containing no extractable identifier
- **WHEN** `memory.context` is called
- **THEN** `relevantMemories[]` SHALL be filled entirely by the ranked pass

#### Scenario: The ranked pass reports an empty pool

- **GIVEN** a `focus` for which both retrieval branches return no candidate in scope
- **WHEN** `memory.context` is called
- **THEN** `relevantMemories[]` SHALL be empty and the response SHALL report the ranked pass as abstaining, with the empty-pool reason

#### Scenario: The ranked pass reports a gate-shortened page

- **GIVEN** a `focus` for which the relevance filter removes candidates and leaves fewer rows than the ranked pass requested
- **WHEN** `memory.context` is called
- **THEN** the response SHALL report the ranked pass's shortening flag alongside `abstained: false`

#### Scenario: A skipped ranked pass reports nothing

- **GIVEN** an entity pre-pass that fills the relevance channel to its cap
- **WHEN** `memory.context` is called
- **THEN** the ranked-pass field SHALL be absent from the response, rather than reporting `abstained: false`
- **AND** the same SHALL hold when no seed can be derived

#### Scenario: A seed is derived when focus is omitted

- **GIVEN** a connection with an active project, a session carrying a working directory, and at least one recent curated prompt
- **WHEN** `memory.context` is called with no `focus`
- **THEN** the server SHALL derive a seed from those signals and populate `relevantMemories[]`

#### Scenario: No derivable seed still returns recency

- **GIVEN** a connection with no active session and no recent prompts
- **WHEN** `memory.context` is called with no `focus`
- **THEN** `relevantMemories[]` SHALL be present and empty, and `recentMemories[]` SHALL be returned as today

#### Scenario: The relevance channel respects scope

- **WHEN** `memory.context` is called on a connection scoped to one project and another project contains a strongly-matching memory
- **THEN** that memory SHALL NOT appear in `relevantMemories[]`

### Requirement: Relation annotation reasons MUST be bounded on multi-row reads

A judged annotation carries the judgment's `reason`, which `memory.judge` and `memory.compare` accept at up to 2 000 characters. On a read that projects annotations for MANY memories that field is the only term in an annotation that is not fixed-size, and it is multiplied by the row count. It SHALL therefore be bounded on those reads, exactly as `memory.context` already bounds every other stored-text projection it emits in a multi-item list.

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

The annotation term of a response is entirely SCHEMA-derived: it is the product of the row bound (`limit`, or `ids.length`), the per-row annotation bound, and the per-annotation size bound. A product of declared bounds can be bounded in advance and MUST be, because a tool result larger than the caller's context window is not a degraded answer but a guaranteed overflow of the context the memory server exists to protect.

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
