## ADDED Requirements

### Requirement: `findActiveForTransport` MUST NOT guess under concurrent ambiguity

`AgentSessionsService.findActiveForTransport({ tokenId, projectId })` (and the repository method behind it) is the fallback used to auto-attach an MCP write (`memory.save`, `memory.confirm`, `memory.session_summary`) or to decide session reuse (`memory.session_start`) when the caller supplied no explicit `sessionId` and no `SessionRouter` entry exists for the calling transport. It SHALL query for `status='active'` rows matching `(tokenId, projectId)` and:

1. Return that row when exactly one matches.
2. Return `null` when zero rows match.
3. Return `null` — never an arbitrary pick — when two or more rows match. Two or more concurrently active sessions under the same token+project is genuinely ambiguous; the method SHALL NOT use recency (`started_at`) or any other heuristic to break the tie, since doing so risks attaching to the wrong session, which is a worse outcome than no attachment.

Callers already handle a `null` result: `memory.save`/`memory.confirm` persist with `session_id = NULL`; `memory.session_start`'s reuse logic falls through to minting a fresh session rather than adopting an ambiguous one.

#### Scenario: Exactly one active session resolves normally

- **GIVEN** exactly one `active` session exists for `(tokenId, projectId)`
- **WHEN** `findActiveForTransport({ tokenId, projectId })` is called
- **THEN** it SHALL return that session

#### Scenario: No active session resolves to null

- **GIVEN** zero `active` sessions exist for `(tokenId, projectId)`
- **WHEN** `findActiveForTransport({ tokenId, projectId })` is called
- **THEN** it SHALL return `null`

#### Scenario: Two concurrently active sessions resolve to null, not the most recent

- **GIVEN** two `active` sessions exist for the same `(tokenId, projectId)`, one started before the other
- **WHEN** `findActiveForTransport({ tokenId, projectId })` is called
- **THEN** it SHALL return `null`
- **AND** neither session id SHALL be returned, regardless of which started more recently

#### Scenario: A memory.save with no explicit sessionId saves unattached under ambiguity

- **GIVEN** two `active` sessions exist for the caller's `(tokenId, projectId)` and no `SessionRouter` entry exists for the calling transport
- **WHEN** `memory.save` is called without an explicit `sessionId`
- **THEN** the saved row's `session_id` SHALL be `NULL`
- **AND** neither of the two candidate sessions SHALL be chosen

#### Scenario: memory.session_start mints a fresh session instead of reusing an ambiguous one

- **GIVEN** two `active` sessions already exist for the caller's `(tokenId, projectId)`
- **WHEN** `memory.session_start` is called with no explicit project-scoped session to resume
- **THEN** the server SHALL mint a new session row (the reuse-lookup finds no unambiguous candidate) rather than adopting either of the two existing ones
