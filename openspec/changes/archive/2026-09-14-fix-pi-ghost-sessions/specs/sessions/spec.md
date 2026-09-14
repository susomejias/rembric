## MODIFIED Requirements

### Requirement: `findActiveForTransport` MUST NOT guess under concurrent ambiguity

`AgentSessionsService.findActiveForTransport({ tokenId, projectId })` (and the repository method behind it) is the fallback used to auto-attach an MCP write (`memory.save`, `memory.confirm`, `memory.session_summary`) or as `memory.session_start`'s first reuse check when the caller supplied no explicit `sessionId` and no `SessionRouter` entry exists for the calling transport. It SHALL query for `status='active'` rows matching `(tokenId, projectId)` and:

1. Return that row when exactly one matches.
2. Return `null` when zero rows match.
3. Return `null` — never an arbitrary pick — when two or more rows match. Two or more concurrently active sessions under the same token+project is genuinely ambiguous; the method SHALL NOT use recency (`started_at`) or any other heuristic to break the tie, since doing so risks attaching to the wrong session, which is a worse outcome than no attachment.

Callers already handle a `null` result: `memory.save`/`memory.confirm` persist with `session_id = NULL`; `memory.session_start`'s reuse logic falls through to minting a fresh session rather than adopting an ambiguous one.

Rules 1–3 are published unchanged for this method itself, and they bind every caller that auto-attaches a write through it — `memory.save`, `memory.confirm`, `memory.session_summary`. (Previously: this requirement was the whole reuse contract for `memory.session_start`, so a `null` from this method meant a mint. That is now the outcome only when no unambiguous `active` candidate exists for the scope at all.)

One caller is carved out, by name: `memory.session_start`. Its reuse precondition is _an unambiguous `active` candidate_, not _an unambiguous `active` candidate that is also inside the staleness window_. When `findActiveForTransport` returns a row, the tool adopts it exactly as it does today. When that lookup returns `null` — including the zero-fresh-rows case, where the only live row for the scope is idle past the staleness window — the tool SHALL consult a SEPARATE lookup, `AgentSessionsService.findSoleActiveForReuse({ tokenId, projectId })`, which SHALL filter the same `(tokenId, projectId)` + `status = 'active'` + `deleted_at IS NULL` set with NO staleness predicate, and SHALL be sole-or-nothing: it returns the row when exactly one matches and `null` when zero or two-or-more match. It SHALL NOT use recency (`started_at`, `last_activity_at`) or any other heuristic to select among two or more rows — rule 3's prohibition applies to both lookups identically, so the carve-out licenses adopting the sole `active` row and never licenses adopting _something_.

Both reuse lookups are consulted only when the calling transport carries no reusable `SessionRouter` binding. Binding precedence for `memory.session_start` is specified in the `mcp-api` capability, "The MCP server MUST expose four session-lifecycle tools"; a binding names an id, so it is a pin rather than a tiebreak and is untouched by this requirement. A client MAY establish that binding itself at start-up by resuming its own row by id — the Pi extension does exactly that (see `pi-plugin`, "The Pi extension SHALL declare its session identity on the MCP transport") — and on such a transport neither lookup below is ever reached, so the mixed-fresh case (one conversation's row resumed while another's is still fresh) cannot attach to the wrong row. These two lookups remain the whole story for clients that declare no identity — the Claude Code and Codex hooks and opencode — and their contracts are unchanged by that declaration.

The carve-out SHALL NOT be generalized. `findSoleActiveForReuse` SHALL NOT be reached from, folded into, or substituted for `findActiveForTransport`, and SHALL NOT be consulted by an auto-attaching write, so `memory.save`, `memory.confirm` and `memory.session_summary` keep exactly the resolution semantics they have today, including `session_id = NULL` where they produce one now. Two or more `active` rows remain ambiguity on both paths, and the consequence for `memory.session_start` remains the mint recorded in the unchanged scenario below.

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

- **GIVEN** exactly one `active` session exists for the caller's `(tokenId, projectId)`, its effective last activity is older than the staleness window, and no `SessionRouter` entry exists for the calling transport
- **WHEN** `memory.save` is called without an explicit `sessionId`
- **THEN** the saved row's `session_id` SHALL be `NULL` — the sole-active reuse lookup SHALL NOT be consulted on this path
- **AND** the pre-existing session SHALL NOT have been adopted, so it keeps its own anchored memories and summary

### Requirement: Session rows MUST record last activity, and stale-active retirement MUST be periodic

Transport-based session resolution refuses to guess when two or more `active` rows match a `(token_id, project_id)` — a deliberate rule that MUST be preserved. But nothing currently makes that ambiguity transient: stale-active retirement runs only at process boot and no activity signal exists on the row, so a single client killed without a lifecycle call (SIGKILL, OOM, a closed terminal) leaves an `active` row for the entire process lifetime. Every subsequent write that does not carry an explicit session id then persists with a null session id, for as long as the server runs.

Session rows SHALL carry a `last_activity_at` timestamp, updated by the session-lifecycle HTTP writes and by MCP writes that resolve to the session. Stale-active retirement SHALL run periodically — not only at boot — and SHALL key on `COALESCE(last_activity_at, started_at)`, the same single query the startup pass uses (see "Server restart MUST mark in-flight sessions as abandoned"); keying on `last_activity_at` alone would leave a row written before the column existed unretirable forever. Transport-based resolution — the `findActiveForTransport` fallback behind auto-attaching writes and behind `memory.session_start`'s first reuse check — SHALL exclude rows whose effective last activity is older than a short staleness window, so a zombie row stops creating ambiguity **without** introducing a recency tiebreak among genuinely-concurrent sessions.

That exclusion is scoped to those callers. The one place in this contract where a stale-but-`active` row may legitimately be adopted is `memory.session_start`'s sole-active reuse lookup, `findSoleActiveForReuse`, named in "`findActiveForTransport` MUST NOT guess under concurrent ambiguity": it runs only after the windowed lookup returned `null`, it fires only when exactly one `active` row exists for the scope, and it adopts that row by its id rather than resolving a contest between two. A row idle past the window therefore remains invisible to `memory.save`, `memory.confirm` and `memory.session_summary` exactly as before, and remains invisible to `memory.session_start`'s first check — where a fresh competitor still wins. Adoption is bounded by the abandonment sweep: once retirement has flipped the row to `abandoned` it is no longer `active`, is not adoptable by any path, and the next unbound `memory.session_start` mints. (Previously: the third clause of the preceding paragraph read "Transport-based resolution SHALL exclude rows whose effective last activity is older than a short staleness window" with the callers unnamed, which was accurate only while that was the single resolution path; leaving it unnamed would make the sole-active carve-out read as a general exemption from the window.)

#### Scenario: A killed client no longer blocks auto-attach

- **GIVEN** one `active` session row whose `last_activity_at` is older than the staleness window, and one freshly-active session row for the same `(token_id, project_id)`
- **WHEN** a write without an explicit session id resolves its session
- **THEN** the fresh row SHALL be selected and the stale row SHALL be ignored

#### Scenario: Two genuinely-concurrent sessions still refuse to guess

- **GIVEN** two `active` session rows for the same `(token_id, project_id)` whose `last_activity_at` are both inside the staleness window
- **WHEN** a write without an explicit session id resolves its session
- **THEN** resolution SHALL return no session rather than choosing by recency

#### Scenario: Stale rows are retired without a restart

- **GIVEN** an `active` session row whose `last_activity_at` predates the abandonment window
- **WHEN** the periodic retirement pass runs while the process continues to serve requests
- **THEN** the row SHALL be marked abandoned without requiring a process restart

#### Scenario: A sole row idle past the window is adopted by memory.session_start

- **GIVEN** no `SessionRouter` binding exists for the calling transport and exactly one `active`, non-deleted row exists for the caller's `(token_id, project_id)`, its `last_activity_at` being older than the staleness window
- **WHEN** the agent calls `memory.session_start`
- **THEN** the response SHALL carry `reused: true` and the `sessionId` of that existing row
- **AND** the `sessions` row count for that `(token_id, project_id)` SHALL be unchanged, which is the control that adoption happened rather than a mint that coincidentally reports the same id
- **AND** the row's activity SHALL have been refreshed, so the next call on the same transport resolves it by the windowed lookup rather than by the fallback

#### Scenario: After the sweep abandons every row the next memory.session_start mints

- **GIVEN** the periodic stale-active retirement pass has flipped the scope's only `active` row to `abandoned`, and no `SessionRouter` binding exists for the calling transport
- **WHEN** the agent calls `memory.session_start`
- **THEN** the call SHALL insert a new `active` row and report `reused: false`
- **AND** this SHALL be the designed outcome rather than a defect: the abandonment window is what makes a weeks-long idle conversation a new session, and no reuse path SHALL reach across a terminal row
