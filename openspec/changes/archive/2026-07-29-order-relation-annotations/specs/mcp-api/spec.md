## ADDED Requirements

### Requirement: `memory.search` and `memory.get` MUST expose the annotation bound and its true total

A bounded list whose depth is invisible cannot be told from a complete one, and a signal that something was withheld is useless without a way to ask for it. Both tools that project a memory's relation annotations SHALL therefore expose the bound as a parameter and the true count as a response field. (The ordering under that bound belongs to the `memory` capability, "Search results MUST carry relation annotations", and is not restated here.)

`memory.search` and `memory.get` SHALL accept an OPTIONAL `relations_limit` integer that bounds the `relations` array projected per memory. Its DEFAULT SHALL be the surface's existing behaviour — 10 for `memory.search` result rows and for `memory.get`'s batch (`ids`) form, 50 for `memory.get`'s single (`id`) form — so a request that omits it receives exactly the annotations it receives today. Its MAXIMUM SHALL be a single shared value of 50 across all three surfaces, being the largest annotation bound the server already serves.

A `relations_limit` above the maximum SHALL be REJECTED as an invalid argument, not silently clamped, consistent with every other numeric bound on this surface (`limit` rejects above 200). Rejection is only safe if the caller is told how to stay inside the bound, so the parameter's description SHALL state: the default; that `relationsTotal` reports how many annotations exist; that the correct follow-up ask is therefore `min(relationsTotal, <maximum>)`; and that a larger value is rejected rather than clamped. A description that instructs the agent to pass a total which may exceed the maximum SHALL be treated as a defect — it is the failure this repo already fixed once, when a tool description documented passing `pendingJudgmentsTotal` into a parameter that rejected it for exactly the queues worth draining.

Every response row carrying `relations` SHALL carry `relationsTotal` alongside it, on the same terms as `pendingJudgmentsTotal`: the count of annotations that exist for that memory, never the returned list's length restated. It SHALL be present whether or not the list was bounded. No companion boolean SHALL be added — truncation is `relationsTotal > relations.length`, and a redundant flag beside a total is duplicated state.

`relations_limit` SHALL NOT alter which memories a read returns, their order, or their scope — it bounds a per-row projection only, like `snippet` and `fields`.

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

#### Scenario: The description teaches the bounded ask

- **WHEN** an MCP client retrieves the tool description for `memory.search` or `memory.get`
- **THEN** the `relations_limit` description SHALL state its default, its maximum, that `relationsTotal` reports the true count, that the follow-up ask is `min(relationsTotal, <maximum>)`, and that a larger value is rejected rather than clamped

#### Scenario: Both `memory.get` forms agree with search

- **GIVEN** a memory carrying more annotations than 10
- **WHEN** it is read via `memory.search`, via `memory.get` with `ids`, and via `memory.get` with `id`
- **THEN** all three SHALL report the same `relationsTotal`, and each returned list SHALL be a prefix of the same ordered sequence, differing only in length according to that surface's default or the caller's `relations_limit`

#### Scenario: The bound does not affect selection

- **GIVEN** two searches differing only in `relations_limit`
- **WHEN** both are executed
- **THEN** they SHALL return the same memories in the same order, differing only in the length of each row's `relations` array
