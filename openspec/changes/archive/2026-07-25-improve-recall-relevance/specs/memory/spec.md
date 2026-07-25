## ADDED Requirements

### Requirement: Recall MUST be able to return nothing

The text-query branch SHALL be able to report that it found nothing relevant, rather than always returning the highest-scoring available rows. A confidently-irrelevant result is worse than an empty one, because the calling agent has no signal to distrust it and will treat it as established project knowledge.

Abstention SHALL be decided by two bounded arithmetic gates over the scores the system already computes: an absolute floor on the best result's normalised score, below which the response is empty, and a gap ratio relative to that best score, below which trailing results are dropped — so result-set size adapts to the score distribution instead of being fixed at the requested limit. The response SHALL carry an explicit abstention flag and reason when the floor rejects everything.

Both gates SHALL be disabled by default and SHALL be enabled only with values calibrated against the evaluation harness, because an uncalibrated floor silently removes recall.

#### Scenario: A query with nothing relevant abstains

- **GIVEN** abstention is enabled with calibrated values, and a scope whose memories are all unrelated to the query
- **WHEN** `memory.search` is called
- **THEN** the response SHALL contain no results and SHALL report abstention with a reason

#### Scenario: A sharp query returns a short result set

- **GIVEN** abstention is enabled, and a scope containing one strongly-matching memory and several weak ones
- **WHEN** `memory.search` is called with a limit larger than one
- **THEN** the weak results below the gap ratio SHALL be omitted, and the response SHALL NOT be padded to the requested limit

#### Scenario: Abstention is off by default

- **WHEN** the system runs without calibrated abstention values configured
- **THEN** the text-query branch SHALL behave exactly as it does today, returning up to the requested limit

### Requirement: Search results MUST be diversified across originating sessions

A single verbose session can supply enough highly-ranked memories to occupy an entire result page, displacing the one memory from a different session that answers the query. The fused, ordered candidate pool SHALL be walked in order and at most a small fixed number of results per originating session SHALL be admitted; when the cap would leave the page under the requested limit, the page SHALL be backfilled from the skipped remainder in fused order, so the cap never reduces the number of results returned.

Memories with no originating session SHALL NOT be grouped together by that absence.

#### Scenario: One session cannot monopolise a page

- **GIVEN** a fused pool whose top eight results all originate in the same session, and further results from other sessions
- **WHEN** the page is assembled at a limit of eight
- **THEN** at most the per-session cap SHALL come from that session, and the remainder SHALL come from other sessions

#### Scenario: The cap never shrinks the result set

- **GIVEN** a fused pool in which every candidate originates in the same session
- **WHEN** the page is assembled at a limit of eight
- **THEN** eight results SHALL still be returned, backfilled in fused order

#### Scenario: Session-less memories are not treated as one session

- **GIVEN** a fused pool containing several memories with a null session id
- **WHEN** the page is assembled
- **THEN** those memories SHALL NOT be capped as though they shared a session

### Requirement: `procedural` MUST be a first-class memory type

Procedural knowledge — how a task is performed in this codebase, a runbook, a workflow — is the highest-value memory class for a coding agent and has a shelf life unlike any existing type. It is currently expressible only as `reference`, which deliberately carries **no** review TTL and a ten-year decay window on the grounds that a reference is a pointer whose staleness surfaces when used. A runbook is not a pointer: it goes stale silently when the underlying process changes, and a stale runbook actively misleads.

The memory-type enum SHALL include `procedural`, with its own review TTL and its own decay window, distinct from `reference`. Existing rows SHALL NOT be reclassified: assigning a type is a content judgement, and the server SHALL NOT make it on the agent's behalf.

#### Scenario: A procedural memory needs review on its own schedule

- **GIVEN** an active `procedural` memory older than its type TTL and never re-affirmed
- **WHEN** its review state is derived
- **THEN** it SHALL be `needs_review`, independently of what a `reference` memory of the same age would report

#### Scenario: Existing reference memories are untouched by the migration

- **GIVEN** a database containing `reference` memories, some of which describe procedures
- **WHEN** the migration introducing `procedural` runs
- **THEN** every existing row SHALL retain its current type

#### Scenario: The type is accepted at the tool boundary

- **WHEN** `memory.save` is called with `type = 'procedural'`
- **THEN** the row SHALL be persisted with that type and SHALL be filterable by it
