## MODIFIED Requirements

### Requirement: A session belongs to exactly one token and at most one project

Every session row SHALL carry a `token_id` referencing an existing row in `tokens`, and SHALL carry the `project_id` its connection resolved to. Because every connection resolves to exactly one project — the slug's project on `/mcp/<slug>`, and otherwise the default project — **no newly registered session SHALL carry a null `project_id`**.

**Existing rows with a null `project_id` SHALL be repointed to the default project by the migration that retires the global scope.** Leaving them would keep the retired scope alive in a second table after the change claims to have removed it, and the operator surface would keep rendering a scope label for rows whose scope no longer exists. The count of such rows on a real installation is every path-less session ever registered.

The column SHALL remain nullable in this release. Flipping nullability on SQLite requires a full table rebuild, and the same rollback argument that keeps `memory.scope` present applies to it: a previous image booting against the migrated file must still find the schema it expects. Making it `NOT NULL` is deferred to the change that performs the other table rebuilds.

#### Scenario: A token is revoked while one of its sessions is active

- **WHEN** a token is revoked and a session bound to it is still `status = 'active'`
- **THEN** subsequent tool calls reusing that session id SHALL be rejected with `token_revoked` (existing auth behavior) and the session row SHALL be transitioned to `status = 'abandoned'` on the next request

#### Scenario: A session is started without a project but the token is project-scoped

- **WHEN** `memory.session_start` is called on `/mcp` with a token whose scope is `project:<id>` and the connection resolved to the default project
- **THEN** the call SHALL be rejected with code `forbidden` and SHALL NOT insert a session row
- **AND** the refusal SHALL name the pinned project and its `/mcp/<slug>` URL, and SHALL NOT name `project.use`

#### Scenario: A path-less session start binds to the default project

- **GIVEN** a path-less `/mcp` connection with a token authorized to write the default project, whether or not its client advertises the `roots` capability
- **WHEN** `memory.session_start` is called
- **THEN** the session row SHALL carry the default project's `project_id` and SHALL NOT carry a null `project_id`

#### Scenario: Pre-existing scopeless sessions are repointed

- **GIVEN** a populated database holding sessions with `project_id IS NULL`
- **WHEN** the migration retiring the global scope is applied
- **THEN** every such row SHALL carry the default project's `project_id`, the total `sessions` row count SHALL be unchanged, and `SELECT count(*) FROM sessions WHERE project_id IS NULL` SHALL be `0`

### Requirement: `memory.session_start` MAY accept an explicit project slug

The `memory.session_start` tool SHALL accept an optional `project?: string` argument (a slug, not a path). The argument SHALL be an assertion about the connection's resolved project, never a way to choose one: the resolved project comes from the URL path (`/mcp/<slug>`), or is the default project on a path-less connection, and no argument changes it. When `project` names the resolved project's slug, the call SHALL proceed exactly as if the argument were omitted. When it names any other slug — whether or not a project with that slug exists — the call SHALL be rejected with code `scope_locked`, naming the resolved slug, and no session row SHALL be inserted or adopted. On a connection whose URL slug names no project, the `project_not_found` refusal of the shared resolver SHALL take precedence. No argument of this tool SHALL create a project; projects are created from the dashboard.

#### Scenario: `memory.session_start` with a slug matching the default project on `/mcp`

- **GIVEN** a `/mcp` (no path slug) connection whose default project has slug `default`
- **WHEN** the agent calls `memory.session_start({agent: 'claude-code', project: 'default'})`
- **THEN** the call SHALL succeed exactly as `memory.session_start({agent: 'claude-code'})` does, and the session row SHALL carry the default project's `project_id`

#### Scenario: `memory.session_start` with an explicit valid slug on `/mcp`

- **WHEN** the agent calls `memory.session_start({project: 'rembric'})` on a `/mcp` (no path slug) connection, the slug exists, and it is not the default project's slug
- **THEN** the call SHALL be rejected with code `scope_locked` and a message naming the default project's slug
- **AND** no session row SHALL be inserted, and the connection's later calls SHALL still resolve to the default project

#### Scenario: `memory.session_start` with an explicit slug on `/mcp/<slug>` mismatching the path

- **WHEN** the agent calls `memory.session_start({project: 'api'})` on a connection at `/mcp/rembric`
- **THEN** the call SHALL be rejected with code `scope_locked` and a message clarifying that the connection is path-scoped to `'rembric'`

#### Scenario: `memory.session_start` with an unknown slug

- **WHEN** the agent calls `memory.session_start({project: 'unknown-slug'})` on a connection that resolved to an existing project, and no project has slug `unknown-slug`
- **THEN** the call SHALL be rejected with code `scope_locked`; no session row SHALL be inserted and no project row SHALL be created

### Requirement: `findActiveForTransport` MUST NOT guess under concurrent ambiguity

`AgentSessionsService.findActiveForTransport({ tokenId, projectId })` (and the repository method behind it) is the fallback used to auto-attach an MCP write (`memory.save`, `memory.confirm`, `memory.session_summary`) or as `memory.session_start`'s first reuse check when the caller supplied no explicit `sessionId`. It is the only fallback: the server binds no session to a connection or transport. It SHALL query for `status='active'` rows matching `(tokenId, projectId)` and:

1. Return that row when exactly one matches.
2. Return `null` when zero rows match.
3. Return `null` — never an arbitrary pick — when two or more rows match. Two or more concurrently active sessions under the same token+project is genuinely ambiguous; the method SHALL NOT use recency (`started_at`) or any other heuristic to break the tie, since doing so risks attaching to the wrong session, which is a worse outcome than no attachment.

Callers already handle a `null` result: `memory.save`/`memory.confirm` persist with `session_id = NULL`; `memory.session_start`'s reuse logic falls through to minting a fresh session rather than adopting an ambiguous one.

Rules 1–3 are published unchanged for this method itself, and they bind every caller that auto-attaches a write through it — `memory.save`, `memory.confirm`, `memory.session_summary`. (Previously: this requirement was the whole reuse contract for `memory.session_start`, so a `null` from this method meant a mint. That is now the outcome only when no unambiguous `active` candidate exists for the scope at all.)

One caller is carved out, by name: `memory.session_start`. Its reuse precondition is _an unambiguous `active` candidate_, not _an unambiguous `active` candidate that is also inside the staleness window_. When `findActiveForTransport` returns a row, the tool adopts it exactly as it does today. When that lookup returns `null` — including the zero-fresh-rows case, where the only live row for the scope is idle past the staleness window — the tool SHALL consult a SEPARATE lookup, `AgentSessionsService.findSoleActiveForReuse({ tokenId, projectId })`, which SHALL filter the same `(tokenId, projectId)` + `status = 'active'` + `deleted_at IS NULL` set with NO staleness predicate, and SHALL be sole-or-nothing: it returns the row when exactly one matches and `null` when zero or two-or-more match. It SHALL NOT use recency (`started_at`, `last_activity_at`) or any other heuristic to select among two or more rows — rule 3's prohibition applies to both lookups identically, so the carve-out licenses adopting the sole `active` row and never licenses adopting _something_.

No connection binding precedes either reuse lookup: the server keeps no per-connection state, and neither `memory.session_start` nor `memory.session_resume` binds a session to the connection. A client that runs concurrent sessions in one project SHALL therefore name its session explicitly on every write — the Pi extension passes its own `sessionId` on every tool that declares one (see `pi-plugin`, "The Pi extension SHALL declare its session identity on every session-attaching tool call") — and a write that names none is resolved by these lookups alone, which return no session rather than a wrong one when the choice is ambiguous.

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

- **GIVEN** exactly one `active`, non-deleted row exists for the caller's `(token_id, project_id)`, its `last_activity_at` being older than the staleness window
- **WHEN** the agent calls `memory.session_start`
- **THEN** the response SHALL carry `reused: true` and the `sessionId` of that existing row
- **AND** the `sessions` row count for that `(token_id, project_id)` SHALL be unchanged, which is the control that adoption happened rather than a mint that coincidentally reports the same id
- **AND** the row's activity SHALL have been refreshed, so the next call for the same `(token_id, project_id)` resolves it by the windowed lookup rather than by the fallback

#### Scenario: After the sweep abandons every row the next memory.session_start mints

- **GIVEN** the periodic stale-active retirement pass has flipped the scope's only `active` row to `abandoned`
- **WHEN** the agent calls `memory.session_start`
- **THEN** the call SHALL insert a new `active` row and report `reused: false`
- **AND** this SHALL be the designed outcome rather than a defect: the abandonment window is what makes a weeks-long idle conversation a new session, and no reuse path SHALL reach across a terminal row

### Requirement: Memories MAY anchor to a session of origin

The `memory` table SHALL gain a nullable `session_id` column referencing `sessions.id`. The `confirmations` table SHALL gain the same nullable column.

#### Scenario: An agent saves a memory after `memory.session_start`

- **WHEN** exactly one Rembric session is `active` for `(token, project)` inside the staleness window and `memory.save` is called without an explicit `sessionId` argument
- **THEN** the inserted row's `session_id` SHALL be set to that session's id

#### Scenario: An agent saves a memory without calling `memory.session_start`

- **WHEN** `memory.save` is called without a `sessionId` and no Rembric session is resolvable for `(token, project)`
- **THEN** the inserted row's `session_id` SHALL be null and the call SHALL succeed (backwards compatibility)

#### Scenario: A pre-existing memory row predates this change

- **WHEN** the migration that adds `memory.session_id` runs against an existing data file
- **THEN** existing rows SHALL retain `session_id = NULL` and SHALL remain queryable through every existing tool unchanged

### Requirement: Server restart MUST mark in-flight sessions as abandoned

Stale-active retirement SHALL therefore run at startup **and** periodically thereafter (see "Session rows MUST record last activity, and stale-active retirement MUST be periodic"), and BOTH passes SHALL use the same single retirement query so they cannot diverge. That query SHALL key on `COALESCE(last_activity_at, started_at)` — not on `started_at` alone: a genuinely long-running session that is still being written to would otherwise be retired out from under its client at the 24-hour mark, and a row predating the `last_activity_at` column would otherwise never be retired at all. Rows whose effective last activity is older than the configured `SESSION_ABANDON_AFTER_MS` (default `24h`) SHALL be transitioned to `status = 'abandoned'` with `ended_at = now`.

The server keeps no route from an MCP connection to a live session, in process or on disk, so a client that dies while the server is down, or never returns after a restart, leaves its row `active` with nothing that will close it on its behalf.

#### Scenario: Server restarts while a session is active

- **WHEN** the server process exits while a session has `status = 'active'` and the next startup reads an effective last activity older than 24 hours
- **THEN** the session SHALL be flipped to `status = 'abandoned'` and a row in the startup log SHALL record the transition

#### Scenario: Server restarts within the abandon window

- **WHEN** the server restarts and an `active` session's effective last activity is younger than 24h
- **THEN** the row SHALL be left `active`; the next tool call referencing it SHALL be accepted (the agent can `session_end` it explicitly or continue)

#### Scenario: A long-running session is not retired on its start time

- **GIVEN** an `active` session started 3 days ago whose `last_activity_at` is 10 minutes old
- **WHEN** either retirement pass runs
- **THEN** the row SHALL be left `active`

#### Scenario: A row predating the activity column is still retired

- **GIVEN** an `active` session with `last_activity_at IS NULL` and a `started_at` older than the abandon window
- **WHEN** either retirement pass runs
- **THEN** the row SHALL be flipped to `abandoned`

## ADDED Requirements

### Requirement: Session-tool handlers MUST resolve scope from the URL path or the default project only

Every MCP tool handler under `packages/mcp/src/` that needs to resolve the effective project (`memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.save_prompt`, `memory.search_prompts`, `memory.session_end`, `memory.session_summary`, `memory.capture_passive`) SHALL resolve scope by consulting, in this order:

1. `ctx.project` from the request context, populated when the connection is path-scoped (`/mcp/<slug>`).
2. **The default project**, when the connection is path-less (`ctx.requestedSlug === null`). There is no third step and no scopeless outcome: no per-connection pin, no MCP roots and no tool call contributes a project.

A handler that resolves scope using only `ctx.project` and falls through directly to a scope of its own choosing SHALL be considered to be in violation of this requirement. In particular, a handler SHALL NOT construct the default project's scope itself — it SHALL obtain it from the shared resolver, so the resolution rule lives in one place and a change to it cannot leave a handler behind.

#### Scenario: Path-less connection returns the default project's scope

- **GIVEN** a token connected to `/mcp` (path-less), whether or not its client advertises the `roots` capability
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include the default project's scope and only that project's memories

#### Scenario: Path-scoped connection to a missing project does not fall back

- **GIVEN** a token connected to `/mcp/bar` where project `bar` does not exist, and an earlier connection by the same token that wrote to project `foo`
- **WHEN** the agent calls `memory.context`
- **THEN** the call SHALL be refused with `code: 'project_not_found'` rather than resolving to any project, and SHALL NOT fall back to the default project
- **AND** the response SHALL NOT leak `foo`'s memories

#### Scenario: Path-scoped connection to existing project returns that project's scope

- **GIVEN** a token connected to `/mcp/baz` where project `baz` exists
- **AND** auth has resolved `ctx.project` to the `baz` project
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "project:<baz.id>"`

#### Scenario: `memory.search_prompts` honours the shared scope resolution

- **GIVEN** a token connected to `/mcp/foo` where project `foo` exists, and prompts saved in `foo` and in the default project
- **WHEN** the agent calls `memory.search_prompts({ query: "anything" })`
- **THEN** the server SHALL resolve scope to `project:<foo.id>`
- **AND** SHALL NOT return prompts from any other project, including the default project

## REMOVED Requirements

### Requirement: A project switch MUST NOT happen while a session is active

**Reason**: No tool can switch a connection's project any more: `project.use` is removed, and a connection's project is fixed by its URL path or is the default project. The `session_active_must_end` guard has nothing left to guard.

**Migration**: To work in another project, connect at `/mcp/<slug>` (for bridge clients, add a `.rembric` file with `PROJECT_SLUG` or set `REMBRIC_PROJECT_SLUG`). Close the current session with `memory.session_summary` or `memory.session_end` as usual; nothing requires it before reconnecting.

### Requirement: Session-tool handlers MUST honor the documented scope-resolution precedence

**Reason**: The precedence placed a `SessionRouter` step, fed by `project.use` and by roots discovery, between the URL path and the default project. The router and both of its sources are removed, so the scenarios that pinned a router pin, a router fallback and router-based `memory.search_prompts` resolution describe behaviour that no longer exists.

**Migration**: None required. A path-scoped connection resolves to its project and a path-less connection to the default project, as specified by "Session-tool handlers MUST resolve scope from the URL path or the default project only". To work in another project, connect at `/mcp/<slug>`.
