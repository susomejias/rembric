# mcp-api Specification

## MODIFIED Requirements

### Requirement: The `memory.confirm` tool MUST follow the supersedes chain

`memory.confirm` SHALL accept EITHER a single `id` OR an `ids: string[]` (the batch form) and SHALL insert a `confirmations` row for the current head of the supersedes chain reachable from each id. The tool SHALL NOT mutate any `memory` row.

In the single form (`{ id }`), the response SHALL be `{ ok: true }`, unchanged from the prior contract.

In the batch form (`{ ids }`), the server SHALL de-duplicate the ids, record one confirmation per distinct id against its chain head inside ONE transaction, and respond with `{ ok: true, confirmed: <count of distinct ids confirmed> }`. The batch form exists so that the up-to-3 ids returned by `memory.context.needsReview` can be re-affirmed in a single round-trip instead of N. Authorization SHALL be checked once against the resolved scope before any write. When any id is missing or outside the active scope, the call SHALL fail with code `not_found` and the transaction SHALL be rolled back (no partial confirmation), so the agent can re-issue with the valid subset. Exactly one of `id` or `ids` SHALL be supplied; supplying both or neither SHALL be rejected with `invalid_input`.

#### Scenario: Confirming an outdated id

- **GIVEN** memory A is superseded by M
- **WHEN** an authenticated client calls `memory.confirm('A')`
- **THEN** a row SHALL be inserted into `confirmations` with `memory_id = 'M'` and no `memory` row SHALL be updated

#### Scenario: Batch-confirming the needsReview ids in one call

- **GIVEN** `memory.context.needsReview` returned ids `[X, Y, Z]`, each the head of its chain
- **WHEN** an authenticated client calls `memory.confirm({ ids: ['X', 'Y', 'Z'] })`
- **THEN** within one transaction a `confirmations` row SHALL be inserted for each of X, Y, and Z, no `memory` row SHALL be updated, and the response SHALL be `{ ok: true, confirmed: 3 }`

#### Scenario: Batch confirm de-duplicates repeated ids

- **WHEN** an authenticated client calls `memory.confirm({ ids: ['X', 'X'] })`
- **THEN** exactly ONE `confirmations` row SHALL be inserted for X's chain head and the response SHALL be `{ ok: true, confirmed: 1 }`

#### Scenario: Batch confirm rejects an out-of-scope id atomically

- **GIVEN** ids `[X, Q]` where Q belongs to a different scope (or does not exist)
- **WHEN** an authenticated client calls `memory.confirm({ ids: ['X', 'Q'] })`
- **THEN** the call SHALL fail with code `not_found`, and NO `confirmations` row SHALL be inserted for X either (the transaction is rolled back)

#### Scenario: memory.confirm rejects supplying both `id` and `ids`

- **WHEN** an authenticated client calls `memory.confirm({ id: 'X', ids: ['Y'] })` or `memory.confirm({})`
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT insert any `confirmations` row

### Requirement: The MCP server MUST expose `memory.judge`

The server SHALL register a `memory.judge` tool that closes pending judgments surfaced by `memory.save`. The schema SHALL accept EITHER a single judgment `{ judgmentId: string, relation: enum, reason?: string, confidence?: number, evidence?: any }` OR a batch `{ judgments: Array<{ judgmentId, relation, reason?, confidence?, evidence? }> }` (the array SHALL be non-empty and capped at 25 items; an empty array is rejected with `invalid_input`). Exactly one of the single fields or `judgments` SHALL be supplied; supplying both or neither SHALL be rejected with `invalid_input`. When `relation = 'supersedes'`, the server SHALL transition the target memory to `status = 'superseded'` and append the target's id to the source's `replaces[]`. Other relations SHALL only update the `memory_relations` row.

The batch form exists so an agent can close every entry in `memory.save.candidates[]` in one round-trip. Each item in a batch SHALL run in its OWN judge transaction (the same per-call transaction the single form uses); there SHALL be NO outer transaction spanning the batch, so a failing item SHALL NOT roll back the others. The single-form response is unchanged: `{ ok: true, judgmentId, relation, status, judgedAt }`. The batch-form response SHALL be `{ ok: true, results: Array<{ ok: true, judgmentId, relation, status, judgedAt } | { ok: false, judgmentId, code, message }> }`, in input order, one entry per submitted item, where the error `code` is whatever `DomainError.code` that item raised (e.g. `memory_not_found` for an unknown id, `conflict` for an already-closed row).

#### Scenario: Judging supersedes mutates the target memory

- **GIVEN** a pending row J with source N (active) and target M (active)
- **WHEN** the agent calls `memory.judge({judgmentId: J, relation: 'supersedes', confidence: 0.95})`
- **THEN** within one transaction: M SHALL transition to `status = 'superseded'`, N's `replaces` SHALL include M's id, the relation row SHALL transition to `status = 'judged'` with `relation = 'supersedes'`, `marked_by_kind = 'agent'`

#### Scenario: Judging conflicts_with does not mutate memory rows

- **WHEN** the agent calls `memory.judge({judgmentId, relation: 'conflicts_with', reason})`
- **THEN** only the `memory_relations` row SHALL change; both `memory` rows SHALL remain `active`

#### Scenario: Judging `not_conflict` acknowledges and closes

- **WHEN** the agent calls `memory.judge({judgmentId, relation: 'not_conflict'})`
- **THEN** the relation row SHALL transition to `status = 'judged'` with `relation = 'not_conflict'`; no `memory` row SHALL be mutated; the annotation SHALL NOT surface in `memory.search` (`not_conflict` is hidden from default search annotations)

#### Scenario: Judging an already-judged row

- **WHEN** `memory.judge` is called (single form) on a row whose `status` is already `'judged'`
- **THEN** the call SHALL fail and the original verdict SHALL remain unchanged

#### Scenario: Judging with a bogus judgmentId

- **WHEN** `judgmentId` matches no row (single form)
- **THEN** the call SHALL fail and no row SHALL be mutated

#### Scenario: Batch judge closes every candidate from one save

- **GIVEN** three pending rows `[J1, J2, J3]` surfaced by one `memory.save`
- **WHEN** the agent calls `memory.judge({ judgments: [{ judgmentId: J1, relation: 'not_conflict' }, { judgmentId: J2, relation: 'related', confidence: 0.8 }, { judgmentId: J3, relation: 'supersedes', confidence: 0.95 }] })`
- **THEN** the response SHALL be `{ ok: true, results: [...] }` with three entries in input order, each `{ ok: true, judgmentId, relation, status: 'judged', judgedAt }`, and J3's target SHALL be `status = 'superseded'`

#### Scenario: A bad item in a batch does NOT sink the others

- **GIVEN** a batch `[{ judgmentId: J1, relation: 'not_conflict' }, { judgmentId: 'BOGUS', relation: 'related' }, { judgmentId: J3, relation: 'compatible' }]` where J1 and J3 are valid pending rows and `BOGUS` matches no row
- **WHEN** the agent calls `memory.judge({ judgments })`
- **THEN** the response `results` SHALL be `[{ ok: true, judgmentId: J1, ... }, { ok: false, judgmentId: 'BOGUS', code, message }, { ok: true, judgmentId: J3, ... }]`, and J1 and J3 SHALL be `status = 'judged'` (NOT rolled back by the failed middle item)

#### Scenario: Batch judge rejects an empty or oversized array

- **WHEN** the agent calls `memory.judge({ judgments: [] })`, or with more than 25 items
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate any row

#### Scenario: memory.judge rejects mixing the single and batch forms

- **WHEN** the agent calls `memory.judge({ judgmentId: J1, relation: 'related', judgments: [...] })` or `memory.judge({})`
- **THEN** the call SHALL be rejected with code `invalid_input` and SHALL NOT mutate any row
