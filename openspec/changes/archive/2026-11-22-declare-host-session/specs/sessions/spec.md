## MODIFIED Requirements

### Requirement: `findActiveForTransport` MUST NOT guess under concurrent ambiguity

`AgentSessionsService.findActiveForTransport({ tokenId, projectId })` (and the repository method behind it) is the fallback used to auto-attach an MCP write (`memory.save`, `memory.confirm`, `memory.session_summary`) or as `memory.session_start`'s first reuse check when the request carries no honoured host-declared session and the caller supplied no explicit `sessionId` (see the `mcp-api` capability, "An honoured host-declared session MUST take precedence over the model's `sessionId`"). It is the only fallback after those two: the server binds no session to a connection or transport. It SHALL query for `status='active'` rows matching `(tokenId, projectId)` and:

1. Return that row when exactly one matches.
2. Return `null` when zero rows match.
3. Return `null` — never an arbitrary pick — when two or more rows match. Two or more concurrently active sessions under the same token+project is genuinely ambiguous; the method SHALL NOT use recency (`started_at`) or any other heuristic to break the tie, since doing so risks attaching to the wrong session, which is a worse outcome than no attachment.

Callers already handle a `null` result: `memory.save`/`memory.confirm` persist with `session_id = NULL`; `memory.session_start`'s reuse logic falls through to minting a fresh session rather than adopting an ambiguous one.

Rules 1–3 are published unchanged for this method itself, and they bind every caller that auto-attaches a write through it — `memory.save`, `memory.confirm`, `memory.session_summary`. (Previously: this requirement was the whole reuse contract for `memory.session_start`, so a `null` from this method meant a mint. That is now the outcome only when no unambiguous `active` candidate exists for the scope at all.)

One caller is carved out, by name: `memory.session_start`. Its reuse precondition is _an unambiguous `active` candidate_, not _an unambiguous `active` candidate that is also inside the staleness window_. When `findActiveForTransport` returns a row, the tool adopts it exactly as it does today. When that lookup returns `null` — including the zero-fresh-rows case, where the only live row for the scope is idle past the staleness window — the tool SHALL consult a SEPARATE lookup, `AgentSessionsService.findSoleActiveForReuse({ tokenId, projectId })`, which SHALL filter the same `(tokenId, projectId)` + `status = 'active'` + `deleted_at IS NULL` set with NO staleness predicate, and SHALL be sole-or-nothing: it returns the row when exactly one matches and `null` when zero or two-or-more match. It SHALL NOT use recency (`started_at`, `last_activity_at`) or any other heuristic to select among two or more rows — rule 3's prohibition applies to both lookups identically, so the carve-out licenses adopting the sole `active` row and never licenses adopting _something_.

No connection binding precedes either reuse lookup: the server keeps no per-connection state, and neither `memory.session_start` nor `memory.session_resume` binds a session to the connection. What can precede them is a per-request host declaration (`X-Rembric-Session`), which is read from each request, never stored, and honoured only when it names the caller's own `active`, non-deleted row in the connection's project; it is not a binding. A client that runs concurrent sessions in one project SHALL therefore declare its session on every request or name it explicitly on every write — the Pi extension passes its own `sessionId` on every tool that declares one (see `pi-plugin`, "The Pi extension SHALL declare its session identity on every session-attaching tool call") — and a write that does neither is resolved by these lookups alone, which return no session rather than a wrong one when the choice is ambiguous. The declaration does not change this method: it is consulted before it, and never selects among the candidates this method sees.

The carve-out SHALL NOT be generalized. `findSoleActiveForReuse` SHALL NOT be reached from, folded into, or substituted for `findActiveForTransport`, and SHALL NOT be consulted by an auto-attaching write, so `memory.save`, `memory.confirm` and `memory.session_summary` keep exactly the resolution semantics they have today when no honoured declaration precedes them, including `session_id = NULL` where they produce one now. Two or more `active` rows remain ambiguity on both paths, and the consequence for `memory.session_start` remains the mint recorded in the unchanged scenario below.

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

- **GIVEN** two `active` sessions exist for the caller's `(tokenId, projectId)`, and one of them was resumed or started earlier on the same connection
- **WHEN** `memory.save` is called without an explicit `sessionId`
- **THEN** the saved row's `session_id` SHALL be `NULL`
- **AND** neither of the two candidate sessions SHALL be chosen

#### Scenario: memory.session_start mints a fresh session instead of reusing an ambiguous one

- **GIVEN** two `active` sessions already exist for the caller's `(tokenId, projectId)`
- **WHEN** `memory.session_start` is called with no explicit project-scoped session to resume
- **THEN** the server SHALL mint a new session row (the reuse-lookup finds no unambiguous candidate) rather than adopting either of the two existing ones

#### Scenario: findSoleActiveForReuse is sole-or-nothing and never breaks a tie by recency

- **GIVEN** two `active`, non-deleted sessions exist for the same `(tokenId, projectId)`, one started before the other and one with more recent activity than the other
- **WHEN** `findSoleActiveForReuse({ tokenId, projectId })` is called
- **THEN** it SHALL return `null`
- **AND** neither session id SHALL be returned, whichever row is more recent by `started_at` or by `last_activity_at`

#### Scenario: findSoleActiveForReuse applies no staleness predicate, and the published method is unaffected

- **GIVEN** exactly one `active`, non-deleted session exists for `(tokenId, projectId)` and its effective last activity is older than the staleness window
- **WHEN** `findSoleActiveForReuse({ tokenId, projectId })` is called
- **THEN** it SHALL return that session
- **AND** `findActiveForTransport({ tokenId, projectId })` called against the same rows SHALL still return `null`, which is the control that the new lookup did not leak into the published method

#### Scenario: A stale sole row is still not adopted by an auto-attaching write

- **GIVEN** exactly one `active` session exists for the caller's `(tokenId, projectId)` and its effective last activity is older than the staleness window
- **WHEN** `memory.save` is called without an explicit `sessionId`
- **THEN** the saved row's `session_id` SHALL be `NULL` — the sole-active reuse lookup SHALL NOT be consulted on this path
- **AND** the pre-existing session SHALL NOT have been adopted, so it keeps its own anchored memories and summary

#### Scenario: An honoured declaration resolves a write before this method is consulted

- **GIVEN** two `active` sessions `<H>` and `<O>` for the caller's `(tokenId, projectId)`, and the request declares `<H>` in `X-Rembric-Session`
- **WHEN** `memory.save` is called without an explicit `sessionId`
- **THEN** the saved row's `session_id` SHALL be `'<H>'`
- **AND** `findActiveForTransport({ tokenId, projectId })` called against the same rows SHALL still return `null`, which is the control that the declaration did not change this method
