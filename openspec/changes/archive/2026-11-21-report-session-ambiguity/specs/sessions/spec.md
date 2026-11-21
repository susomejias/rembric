## ADDED Requirements

### Requirement: Transport resolution MUST distinguish absence from ambiguity

`AgentSessionsService.resolveForTransport({ tokenId, projectId })` SHALL classify the caller's `(tokenId, projectId)` for a session-lifecycle tool that received no explicit `sessionId`, and SHALL return exactly one of:

1. `{ kind: 'sole', session }` when exactly one `active`, non-deleted row is inside the staleness window. This SHALL be the same row `findActiveForTransport` returns for the same input.
2. `{ kind: 'ambiguous' }` when no single row is inside the window and two or more `active`, non-deleted rows exist for the scope with no staleness predicate. Two or more rows inside the window satisfy this, since they are also two or more rows without it.
3. `{ kind: 'none' }` otherwise: no `active` row, or exactly one that is idle past the window.

The classification SHALL NOT select among two or more rows by recency or any other heuristic, and SHALL NOT change what any caller attaches to. It only names the reason no row was chosen. `findActiveForTransport` and `findSoleActiveForReuse` SHALL keep their published sole-or-nothing results, and `memory.save`, `memory.confirm`, `memory.save_prompt` and `memory.capture_passive` SHALL keep resolving through `findActiveForTransport`, including `session_id = NULL` under ambiguity. Reading the set without the staleness window to classify a refusal is not the reuse carve-out in "`findActiveForTransport` MUST NOT guess under concurrent ambiguity": no row is adopted on the strength of it.

The window-free read exists because absence and ambiguity call for opposite remedies. With one idle row, `memory.session_start` adopts it, so `session_not_found` followed by `memory.session_start` reaches the right row. With two or more, `memory.session_start` mints a new row, so the same recovery misfiles the write.

#### Scenario: Two fresh rows classify as ambiguous

- **GIVEN** two `active` rows for `(tokenId, projectId)`, both inside the staleness window
- **WHEN** `resolveForTransport({ tokenId, projectId })` is called
- **THEN** it SHALL return `{ kind: 'ambiguous' }`

#### Scenario: Two idle rows classify as ambiguous, one idle row as none

- **GIVEN** two `active` rows for `(tokenId, projectId)`, both idle past the staleness window
- **WHEN** `resolveForTransport` is called
- **THEN** it SHALL return `{ kind: 'ambiguous' }`
- **AND** with only one such row it SHALL return `{ kind: 'none' }`

#### Scenario: One fresh row beside an idle one is sole

- **GIVEN** one `active` row inside the staleness window and one idle past it, for the same `(tokenId, projectId)`
- **WHEN** `resolveForTransport` is called
- **THEN** it SHALL return `{ kind: 'sole' }` carrying the fresh row
