## ADDED Requirements

### Requirement: Being returned by a search MUST NOT be sufficient to confer durability

A memory appearing in a page of search results is evidence that it ranked, not that it was useful. The access signal that drives decay eligibility and the retrieval recency boost SHALL NOT be advanced merely by a row being included in a result page, because doing so makes ranking self-reinforcing: a row that ranks well becomes decay-immune, gains a recency boost that helps it rank well again, and is pinned to the top of subsequent context pulls, with no evidence the agent read past its title.

Whatever signal the system adopts for "accessed", it SHALL be advanced only by an interaction that distinguishes a dereferenced memory from a listed one, and any row that is filtered out before reaching the caller SHALL NOT have its access signal advanced.

#### Scenario: A broad search does not confer durability on every hit

- **GIVEN** a corpus in which a memory is old enough to be decay-eligible
- **WHEN** a search returns that memory in a page of results and the caller does not dereference it
- **THEN** the memory SHALL remain decay-eligible

#### Scenario: A dereferenced memory is treated as accessed

- **WHEN** a memory is fetched by id
- **THEN** its access signal SHALL be advanced

#### Scenario: A row dropped before return is not touched

- **GIVEN** a row retrieved by a retrieval branch but excluded by the live-status re-check before the response is built
- **WHEN** the search completes
- **THEN** that row's access signal SHALL NOT have been advanced

### Requirement: The system MUST accept a negative affirmation, recorded append-only

The only affirmation verb today is positive, and autonomous archival is deliberately forbidden. An agent that surfaces a memory, acts on it, and discovers it is stale or wrong therefore has no way to record that — while the act of retrieving it has advanced its access signal, making it more durable than an untouched memory. The system SHALL accept a refutation against a memory, recorded as an append-only event carrying the refuting agent's reason.

A refutation SHALL NOT advance the memory's access signal, SHALL NOT mutate or delete the memory, and SHALL NOT itself archive it. It SHALL be an input to the read-time derivation of review state, so review state remains derived and never stored.

#### Scenario: A refuted memory needs review immediately

- **GIVEN** an active memory whose derived review state is `fresh`
- **WHEN** an agent refutes it
- **THEN** its derived review state SHALL become `needs_review` without waiting out its type TTL

#### Scenario: A refutation is not an access

- **WHEN** an agent refutes a memory
- **THEN** the memory's access signal SHALL be unchanged

#### Scenario: A refutation preserves the memory

- **WHEN** an agent refutes a memory
- **THEN** the memory's `content`, `title` and `status` SHALL be unchanged, and the refutation SHALL be recoverable as an event

#### Scenario: A refuted memory can be re-affirmed

- **GIVEN** a memory that was refuted and subsequently confirmed
- **WHEN** its review state is derived
- **THEN** the later confirmation SHALL advance the affirmation baseline

### Requirement: The review queue MUST have a terminal state

A memory that is retrieved regularly but never re-affirmed crosses its review TTL and then remains `needs_review` indefinitely: reads deliberately do not clear it, and — because reads advance the access signal — decay cannot archive it either. The two staleness axes do not cover this case, and the affected population only grows.

The system SHALL define what happens to a memory that has been `needs_review` for a bounded multiple of its type TTL, rather than leaving it in indefinite limbo. Whatever escalation is chosen SHALL remain inside the existing guarantee that review state is derived at read time and never stored, and SHALL NOT introduce a new mutation verb.

#### Scenario: A long-unaffirmed but frequently-read memory escalates

- **GIVEN** an active memory that has been `needs_review` for a bounded multiple of its type TTL, and whose access signal has been advanced throughout that period
- **WHEN** its review state is derived
- **THEN** it SHALL be distinguishable from a memory that has only just entered `needs_review`

#### Scenario: Escalation stores no state

- **WHEN** a memory escalates within the review axis
- **THEN** no column SHALL record the escalation and no sweep SHALL be required to produce it

### Requirement: Review and judgment queue depths MUST be observable by the agent

`memory.context` returns only the few oldest memories needing review and no total, and the observability tools report no review or pending-judgment counts, so an agent cannot distinguish a healthy corpus from one with hundreds of unaffirmed memories — even though the count is already computed for the operator sidebar. The agent-facing surfaces SHALL report the total number of memories needing review and the total number of unresolved pending judgments in the effective scope, so an agent can batch-affirm using the existing multi-id form rather than clearing a three-item drip.

#### Scenario: The context response reports queue depth

- **WHEN** `memory.context` is called in a scope with more memories needing review than it returns
- **THEN** the response SHALL include the total count alongside the returned subset

#### Scenario: Stats report both queues

- **WHEN** `memory.stats` is called
- **THEN** the response SHALL include the count of memories needing review and the count of unresolved pending judgments, scoped to the request context
