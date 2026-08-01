## ADDED Requirements

### Requirement: A pending judgment MUST be withheld from the agent queue once either endpoint is retired

A save-time candidate pair asks the agent one question: how does this memory relate to that one. Once either memory has left `active` — retired by a `topic_key` supersede, by a `supersedes` verdict, by `memory.archive`, or by the decay pass — that question has no answer worth an agent's attention, and the verdict that would matter most is refused outright (see the `mcp-api` capability, "A `supersedes` verdict MUST be refused when either endpoint is no longer active").

The scoped agent-facing pending reads SHALL therefore surface a `memory_relations` row with `status = 'pending'` only while its source AND its target are both `status = 'active'`. The restriction SHALL be derived at read time from the endpoints' current `status`. No column SHALL be added, no row SHALL be written, and no new sweep or mutation verb SHALL be introduced — this is the same derivation discipline the review axis already follows.

Filtering the target as well as the source is required, not incidental: a candidate against a memory that has since been archived or superseded is as unadjudicable as one whose source is gone.

The restriction SHALL apply to the paging read and to the count that accompanies it identically, so that the reported depth is always a depth the paging read can reach. Because the restriction is derived, the reported depth MAY decrease without any judgment being recorded — retiring an endpoint removes its pairs from the queue. That is the specified behaviour of a derived queue depth, not a lost judgment.

The rows themselves SHALL NOT be hidden from the operator, retired earlier, or otherwise altered:

- The unscoped `admin*` reads that back `/dashboard/judgments` and the server-wide counters SHALL keep returning them, with their existing per-row orphan action. The operator is the audience for the fact that they exist.
- The deterministic sweep SHALL remain the only mechanism that closes them: its own selection of aged pending rows SHALL NOT apply this restriction, so a withheld pair still reaches `status = 'orphaned'` at `JUDGMENT_ORPHAN_DEADLINE_MS` (see the `consolidation` capability). A pair that is invisible to the agent and also invisible to the sweep would be immortal.
- The relation ANNOTATIONS attached to a memory (`pending_conflict` and its siblings on `memory.get` and `memory.search`) SHALL be unaffected, and they DO remain actionable: a `pending` annotation carries the pair's `judgmentId`, and a non-`supersedes` verdict against that handle still succeeds. That is required, not tolerated — it is the only MCP path left to the handle once the queue withholds the pair, and the `mcp-api` capability requires those verdicts to stay closable on a retired endpoint. What this requirement removes is the agent's queue SLOT, not the pair's reachability, so the two surfaces disagree by design and a scenario below pins the disagreement.

#### Scenario: A pending pair whose source was superseded is withheld

- **GIVEN** an active memory A holding `topic_key = 't'` with a pending candidate pair A→X, and a later `memory.save` with `topic_key = 't'` that supersedes A
- **WHEN** the scoped agent-facing pending list and the scoped pending count are read
- **THEN** the pair A→X SHALL appear in neither, while any pending pair whose source is the new active row SHALL appear in both

#### Scenario: A pending pair whose target was archived is withheld

- **GIVEN** a pending pair S→T where S is `active` and T has been archived
- **WHEN** the scoped agent-facing pending list and count are read
- **THEN** the pair SHALL appear in neither

#### Scenario: The list and the count cannot disagree

- **GIVEN** any mix of adjudicable and retired-endpoint pending pairs in one scope, with the paging limit set above the number of rows and the age filter lifted
- **WHEN** both scoped reads are taken
- **THEN** the count SHALL equal the number of rows the list returned — a total the list can never reach is a defect, in either direction

#### Scenario: The operator's view of the same rows is unchanged

- **GIVEN** a pending pair withheld from the agent queue because its source is `superseded`
- **WHEN** an operator opens `/dashboard/judgments` with the `pending` status filter
- **THEN** the row SHALL be listed, SHALL be counted in that view's total, and SHALL still offer its orphan action

#### Scenario: A withheld pair is still orphaned at the deadline

- **GIVEN** a pending pair withheld from the agent queue, whose `created_at` is older than `JUDGMENT_ORPHAN_DEADLINE_MS`
- **WHEN** the consolidation sweep runs for that scope
- **THEN** the row SHALL transition to `status = 'orphaned'` with a journaled op, exactly as an adjudicable pair of the same age would

#### Scenario: A withheld pair stays reachable and closable through its annotation

- **GIVEN** an aged pending pair whose source has been superseded by a `topic_key` revision and whose target is still `active`
- **WHEN** an agent calls `memory.context` and then `memory.get` on the still-active target
- **THEN** `pendingJudgmentsTotal` SHALL be 0 and `pendingJudgments` SHALL be empty
- **AND** the `memory.get` response SHALL still carry a `pending` relation annotation for the pair, including its `judgmentId`
- **AND** `memory.judge` on that `judgmentId` with a non-`supersedes` relation SHALL succeed and return `status = 'judged'`

#### Scenario: The server-wide diagnostic count still includes them

- **GIVEN** a scope holding one adjudicable pending pair and three pairs with a retired endpoint
- **WHEN** the scoped agent-facing pending count and the server-wide `memory.doctor` pending counter are both read
- **THEN** the scoped count SHALL be 1 and the server-wide counter SHALL be 4 — the divergence is deliberate: the server-wide figure is a table inventory for the operator (already specified as server-wide rather than scope-resolved), while the scoped figure is a work queue for the agent

## MODIFIED Requirements

### Requirement: Review and judgment queue depths MUST be observable by the agent

`memory.context` returns only the few oldest memories needing review and no total, and the observability tools report no review or pending-judgment counts, so an agent cannot distinguish a healthy corpus from one with hundreds of unaffirmed memories — even though the count is already computed for the operator sidebar. The agent-facing surfaces SHALL report the total number of memories needing review and the total number of unresolved pending judgments in the effective scope, so an agent can batch-affirm using the existing multi-id form rather than clearing a three-item drip.

_Unresolved_ here means ADJUDICABLE: a pending judgment whose source and target are both still `status = 'active'`, per "A pending judgment MUST be withheld from the agent queue once either endpoint is retired". A count that included pairs the agent is not shown and cannot usefully close would not be a queue depth — it would be an inventory the agent has no way to drain, which is the failure this requirement exists to prevent.

The scoped guarantee binds `memory.context` and `memory.stats`. The equivalent field in the `memory.doctor` report SHALL be server-wide rather than scope-resolved, deliberately matching the precedent that `memory.doctor`'s `sessions.active` is already server-wide while `memory.stats`'s session counter is scoped — and, for the same reason, that field SHALL remain an unfiltered count of pending rows.

#### Scenario: The context response reports queue depth

- **WHEN** `memory.context` is called in a scope with more memories needing review than it returns
- **THEN** the response SHALL include the total count alongside the returned subset

#### Scenario: Stats report both queues

- **WHEN** `memory.stats` is called
- **THEN** the response SHALL include the count of memories needing review and the count of unresolved pending judgments, scoped to the request context

#### Scenario: Stats and context agree on the pending depth

- **GIVEN** a scope holding both adjudicable and retired-endpoint pending pairs
- **WHEN** `memory.stats` and `memory.context` are called on the same connection
- **THEN** both SHALL report the same pending total, counting only the adjudicable pairs — the two tools SHALL NOT apply different definitions of the queue
