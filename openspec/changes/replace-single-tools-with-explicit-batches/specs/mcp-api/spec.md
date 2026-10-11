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
