## ADDED Requirements

### Requirement: The observability tool descriptions MUST disclose which population their counters cover

`memory.doctor` and `memory.stats` return counters under colliding names over two different populations: doctor's are server-wide (all projects plus global), stats' are resolved against the request context. `memory.stats` carries a top-level `scope` field and `memory.doctor` carries none, but a client SHALL NOT be expected to infer one tool's semantics from the ABSENCE of a field in another. The counters therefore differ in value with nothing on the wire to explain it, and two readers of this codebase have already drawn a wrong conclusion from the collision. The tool description is the surface the model reads before deciding to call, so the disclosure belongs there.

`memory.doctor`'s registered description SHALL:

- state that the report is SERVER-WIDE, covering all projects and the global scope;
- state that `memory.stats` carries the scoped equivalents and that the two sets of numbers WILL differ, so a mismatch reads as intent rather than as one of them being stale;
- name the blocks the report actually returns, including `entities`, `sessions` and `review`, which it currently omits;
- NOT advertise an `llm` block or any other field the output contract forbids (see "The MCP server MUST expose two observability tools", which requires the report to contain no `llm` block). A description that promises a field the tool cannot return misleads a client into treating its absence as a fault — the same hazard that requirement addresses for the output contract, on the surface the model actually reads.

`memory.stats`' registered description SHALL name `needsReviewTotal` and `pendingJudgmentsTotal` among its counters, and SHALL state that `memory.doctor` reports same-named counters server-wide so its numbers will differ. Naming the two totals is load-bearing rather than cosmetic: `memory.doctor`'s disclosure directs the reader to `memory.stats` for the scoped equivalents, and that direction is useless if `memory.stats`' own description never mentions the fields it names.

These disclosures SHALL be expressed in each tool's top-level description text and SHALL NOT be expressed only in a zod `describe()` on the input or output schema, which some clients do not surface to the model — consistent with the identical constraint already placed on `memory.archive` and on the `sessionId` argument.

Both descriptions SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"); if a clause does not fit, prose SHALL be cut from the description rather than the constant raised. Because client truncation is a tail cut, the server-wide disclosure SHALL NOT be the trailing clause of `memory.doctor`'s description.

This requirement constrains description prose only. It SHALL NOT be read as re-scoping any counter: `memory.doctor`'s `sessions.active`, `entities.backlog` and `review` counters remain server-wide as already specified, and no field is added, removed or renamed on either payload.

#### Scenario: `memory.doctor`'s description discloses the server-wide population and its scoped counterpart

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL convey that the report is server-wide across all projects and the global scope
- **AND** the description SHALL name `memory.stats` as the source of the scoped equivalents and SHALL convey that the two will differ
- **AND** the description SHALL name `entities`, `sessions` and `review` among the blocks returned

#### Scenario: `memory.doctor`'s description does not advertise the removed `llm` block

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL NOT contain the substring `LLM` in any letter case
- **AND** a `memory.doctor` call in the same session SHALL return a payload for which `'llm' in payload` is `false`, so the description and the payload agree

#### Scenario: `memory.stats`' description names its queue-depth totals and the divergence

- **WHEN** an MCP client retrieves the tool description for `memory.stats` via `tools/list`
- **THEN** the description SHALL name `needsReviewTotal` and `pendingJudgmentsTotal`
- **AND** the description SHALL still convey that its counters are scoped to the active project or global
- **AND** the description SHALL convey that `memory.doctor`'s same-named counters are server-wide and will differ

#### Scenario: The disclosures live in the top-level description, not a schema `describe()`

- **WHEN** the registered descriptions and schemas for `memory.doctor` and `memory.stats` are inspected
- **THEN** every disclosure this requirement mandates SHALL be present in the string returned as each tool's `description` by `tools/list`
- **AND** neither tool's presence in `tools/list` SHALL depend on a `describe()` call on `doctorOutput` or `statsOutput` to satisfy this requirement

#### Scenario: Both rewritten descriptions stay inside the truncation cap

- **WHEN** an MCP client issues `tools/list` against the server
- **THEN** the descriptions of `memory.doctor` and `memory.stats` SHALL each be at most `DESCRIPTION_MAX_LENGTH` characters measured as `String.length`
- **AND** `memory.doctor`'s server-wide disclosure SHALL appear before its closing usage guidance, so a tail truncation removes the usage hint rather than the disclosure

#### Scenario: The disclosure does not change any counter's value

- **GIVEN** a scope holding one adjudicable pending pair and three pairs with a retired endpoint
- **WHEN** `memory.doctor` and `memory.stats` are both called from a connection resolving to that scope
- **THEN** `memory.doctor`'s `review.pendingJudgments` SHALL remain the unfiltered server-wide count and `memory.stats`' `pendingJudgmentsTotal` SHALL remain 1, exactly as before this change
