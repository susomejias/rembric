## ADDED Requirements

### Requirement: An honoured host-declared session MUST take precedence over the model's `sessionId`

A request MAY carry a host-declared session id, read by the MCP route from `X-Rembric-Session` into `RequestContext.declaredSessionId` (see the `http-api` capability, "The MCP route MUST read `X-Rembric-Session` into the request context and never refuse on it"). The declaration is attribution metadata, never authority. The server SHALL **honour** it only when all of these hold, checked when the tool resolves its session:

1. a `sessions` row with that id exists;
2. its `token_id` equals the request token's id;
3. its `project_id` equals the connection's resolved project id;
4. its `status` is `active`;
5. its `deleted_at` is `NULL`.

Otherwise the declaration SHALL be ignored exactly as if absent, and the call SHALL NOT be refused because of it: a stale declaration (the host's previous session after `/clear`, or a session the sweep abandoned) degrades to the resolution the call would have without it. Requiring `active` is what keeps a stale declaration from attaching new writes to a closed session, and conditions 2 and 3 confine any declaration to the caller's own sessions in its own project.

For `memory.save`, `memory.confirm`, `memory.merge`, `memory.save_prompt`, `memory.capture_passive`, `memory.session_summary`, `memory.session_end`, and the focus seed of `memory.context`, the session SHALL resolve in this order:

1. An honoured declared session. The tool's `sessionId` argument SHALL then be ignored entirely, without an ownership check.
2. Otherwise the explicit `sessionId` argument, validated exactly as it is without a declaration.
3. Otherwise `findActiveForTransport` (the sole `active` row inside the staleness window). `memory.session_summary` and `memory.session_end` SHALL classify the unresolved case through `AgentSessionsService.resolveForTransport` and refuse with `session_ambiguous` or `session_not_found`, unchanged. `memory.context`'s focus seed has no `sessionId` argument and uses steps 1 and 3.

`memory.session_start` SHALL adopt an honoured declared session before step (1) of the order published in "The MCP server MUST expose four session-lifecycle tools that keep no per-connection binding", reporting `reused: true`, that row's `sessionId` and that row's stored `agent`, and SHALL insert no row. Every other clause of that requirement is unchanged: the `project` assertion and authorization run first, and without an honoured declaration the published order applies as written.

`memory.session_resume` SHALL ignore the declaration. Its explicit `sessionId` is required and wins, because naming the session is the tool's whole purpose.

The declaration is not a connection binding. It is read from each request and never stored, so the server stays stateless. One helper in `packages/mcp/src/_shared.ts` SHALL decide whether a declaration is honoured, and every resolution path listed above SHALL call it rather than re-implement the check.

#### Scenario: memory.save attaches to the declared session over a different explicit sessionId

- **GIVEN** two `active` sessions `<H>` and `<M>` owned by the caller's token in the connection's project, and the request declares `<H>`
- **WHEN** the agent calls `memory.save({..., sessionId: '<M>'})`
- **THEN** the saved memory's `session_id` SHALL be `'<H>'`

#### Scenario: A declaration resolves the session where the sole-active lookup has no answer

- **GIVEN** two `active` sessions `<H>` and `<O>` for the caller's `(token_id, project_id)`
- **WHEN** the agent calls `memory.save` without `sessionId`, first without a declaration and then declaring `<H>`
- **THEN** the first saved row SHALL carry `session_id = NULL` and the second SHALL carry `session_id = '<H>'`

#### Scenario: memory.session_summary writes the declared session

- **GIVEN** two `active` sessions `<H>` and `<M>` for the caller's `(token_id, project_id)`, and the request declares `<H>`
- **WHEN** the agent calls `memory.session_summary({ sessionId: '<M>', summary })`, or the same call without `sessionId`
- **THEN** the response SHALL carry `sessionId = '<H>'`, the summary SHALL be written to `<H>`, and `<M>`'s summary SHALL be unchanged
- **AND** the call without `sessionId` SHALL NOT be refused with `session_ambiguous`

#### Scenario: memory.session_end ends the declared session

- **GIVEN** two `active` sessions `<H>` and `<M>`, and the request declares `<H>`
- **WHEN** the agent calls `memory.session_end({ sessionId: '<M>' })`
- **THEN** `<H>` SHALL become `ended` and `<M>` SHALL stay `active`

#### Scenario: An unhonoured declaration is ignored as if absent

- **GIVEN** the declared id names a row owned by another token, a row in another project, an `ended` row, an `abandoned` row, a soft-deleted row, or no row at all
- **WHEN** the agent calls `memory.save` without `sessionId` while exactly one other `active` session `<S>` exists for its `(token_id, project_id)`
- **THEN** the saved row SHALL carry `session_id = '<S>'`
- **AND** `memory.session_summary({ sessionId: '<E>', summary })`, naming the caller's own `active` session `<E>`, SHALL write to `<E>`, and `memory.session_start` with no `active` row SHALL mint a new row with `reused: false`, which is the behaviour without the header
- **AND** none of these calls SHALL be refused because of the declaration

#### Scenario: memory.session_start adopts the declared session

- **GIVEN** two `active` sessions `<H>` (`agent = 'claude-code'`) and `<O>` for the caller's `(token_id, project_id)`, and the request declares `<H>`
- **WHEN** the client calls `memory.session_start({ agent: 'pi' })`
- **THEN** the response SHALL carry `sessionId = '<H>'`, `reused: true` and `agent: 'claude-code'`
- **AND** the `sessions` row count SHALL be unchanged; without the declaration the same call mints, as published

#### Scenario: memory.session_resume ignores the declaration

- **GIVEN** an `active` session `<H>` declared on the request and an `ended` session `<E>` owned by the caller
- **WHEN** the client calls `memory.session_resume({ sessionId: '<E>' })`
- **THEN** the response SHALL carry `sessionId = '<E>'` and `previousStatus: 'ended'`, and `<E>` SHALL become `active`

#### Scenario: memory.context seeds its focus from the declared session

- **GIVEN** two `active` sessions for the caller's `(token_id, project_id)`, the declared one `<H>` titled with a term only one memory contains
- **WHEN** the agent calls `memory.context({})` without a declaration and then declaring `<H>`
- **THEN** that memory SHALL be absent from `relevantMemories` on the first call and present on the second

## MODIFIED Requirements

### Requirement: Tools that attach a write to a session MUST accept an explicit `sessionId` override, reinforced in their descriptions

`memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` SHALL accept an optional `sessionId: string` argument. When provided, it SHALL take precedence over the server's transport lookup (step (3) below), and yield only to an honoured host-declared session. The resolution order SHALL be exactly three steps: (1) an honoured host-declared session (see "An honoured host-declared session MUST take precedence over the model's `sessionId`"), in which case the `sessionId` argument SHALL be ignored without being validated; (2) otherwise the explicit, ownership-checked `sessionId`; (3) otherwise `findActiveForTransport(tokenId, projectId)`, which returns a session only when the choice is unambiguous and returns none otherwise (see the `sessions` requirement "`findActiveForTransport` MUST NOT guess under concurrent ambiguity"). The host's declaration outranks the argument because the client's lifecycle code knows the live session, while the model's copy of the id is lost to compaction and goes stale on `/clear`. No session SHALL be bound to the connection or transport, and no step SHALL consult per-connection state: the server keeps none. Each tool's description SHALL mention `sessionId` explicitly (not only via the input schema's per-argument `describe()`, since some MCP clients do not surface per-property schema descriptions to the model) with guidance to pass it only if genuinely known and never invent one.

This closes a blind spot: `memory.session_summary`'s and `memory.session_end`'s zod schemas already declared `sessionId` as optional, but their tool descriptions never mentioned it — a model reading only the description had no reason to believe passing it was possible. `memory.save` and `memory.save_prompt` did not accept the argument at all prior to this requirement.

An explicit `sessionId` on the write-_attaching_ tools (`memory.save`, `memory.save_prompt`, `memory.capture_passive`) SHALL be validated before it is honored. The server SHALL resolve the named session row and require that it (a) is owned by the caller's token (`token_id` matches the request context), (b) belongs to the caller's effective project (`project_id` equals the connection's resolved project id), and (c) is not soft-deleted (`deleted_at IS NULL`). When (a) or (b) fails, the call SHALL be rejected with code `session_not_found` — the same masking code the session-lifecycle tools use, so a caller cannot probe which session ids exist under other tokens or projects. When (a) and (b) pass but (c) fails, the call SHALL be rejected with code `session_deleted`. On rejection no row SHALL be written. Validation applies only when `sessionId` is explicitly supplied and no honoured host-declared session precedes it; the active-session fallback already resolves to a session owned by the caller within the effective scope, and an honoured declaration is by definition the caller's own `active` row in the effective project. An `ended` (but not soft-deleted) session remains a valid attachment target. `memory.session_summary`/`memory.session_end` retain their existing service-layer cross-token + soft-delete checks. This closes a security blind spot: prior to this requirement an explicit `sessionId` was honored verbatim, letting a caller forge an attachment to another token's or another project's session.

#### Scenario: memory.save accepts and prioritizes an explicit sessionId

- **GIVEN** two sessions are concurrently active for the same `(tokenId, projectId)` (the ambiguous-fallback case where auto-resolution returns null)
- **WHEN** the agent calls `memory.save({..., sessionId: '<S>'})` with an explicit, valid session id
- **THEN** the saved memory's `session_id` SHALL be `'<S>'`, NOT null — the explicit value bypasses the ambiguous fallback entirely

#### Scenario: A write without sessionId attaches to the sole active session or to none

- **GIVEN** exactly one `active` session `<S>` for the caller's `(tokenId, projectId)`, with its last activity inside the staleness window
- **WHEN** the agent calls `memory.save` without `sessionId`
- **THEN** the saved memory's `session_id` SHALL be `'<S>'`
- **AND** when a second session is concurrently `active` for the same `(tokenId, projectId)`, the same call SHALL persist `session_id = null` rather than either session, whichever session an earlier call on the same connection named or resumed

#### Scenario: memory.save_prompt accepts and prioritizes an explicit sessionId

- **WHEN** the agent calls `memory.save_prompt({content, title, sessionId: '<S>'})`
- **THEN** the persisted prompt row's `session_id` SHALL be `'<S>'`

#### Scenario: Tool descriptions mention sessionId explicitly

- **WHEN** the `memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` tool descriptions are inspected
- **THEN** each SHALL contain the substring `sessionId` with guidance not to invent one when unknown

#### Scenario: An explicit sessionId owned by a different token is rejected

- **GIVEN** a session `<S>` owned by token `<T1>`
- **WHEN** a caller authenticated as a different token `<T2>` calls `memory.save`, `memory.save_prompt`, or `memory.capture_passive` with `sessionId = '<S>'`
- **THEN** the call SHALL be rejected with code `session_not_found` and no row SHALL be written

#### Scenario: An explicit sessionId from another project is rejected

- **GIVEN** the caller's token owns a session `<S>` whose `project_id` is project B
- **WHEN** the caller, on a connection whose effective scope is project A, calls a write-attaching tool with `sessionId = '<S>'`
- **THEN** the call SHALL be rejected with code `session_not_found` and no row SHALL be written

#### Scenario: An explicit sessionId naming a soft-deleted session is rejected

- **GIVEN** the caller's token owns a session `<S>` in the effective project whose `deleted_at` is non-null
- **WHEN** the caller calls a write-attaching tool with `sessionId = '<S>'`
- **THEN** the call SHALL be rejected with code `session_deleted` and no row SHALL be written

#### Scenario: An honoured host declaration outranks an explicit sessionId

- **GIVEN** two `active` sessions `<H>` and `<M>` owned by the caller's token in the effective project, and the request declares `<H>` in `X-Rembric-Session`
- **WHEN** the agent calls `memory.save({..., sessionId: '<M>'})`
- **THEN** the saved memory's `session_id` SHALL be `'<H>'`
- **AND** the same call with `sessionId` naming no row SHALL also succeed and attach to `'<H>'`, because the argument is ignored without being validated

#### Scenario: An unhonoured declaration leaves the explicit sessionId validated as before

- **GIVEN** the request declares a session id that names no row, and `<S>` is owned by a different token
- **WHEN** the caller calls `memory.save` with `sessionId = '<S>'`
- **THEN** the call SHALL be rejected with code `session_not_found` and no row SHALL be written

### Requirement: The MCP server MUST expose four session-lifecycle tools that keep no per-connection binding

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, `memory.session_summary` and `memory.session_resume` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the state transition out of `active`, and `memory.session_resume` is the sole transition back into it.

`memory.session_start` SHALL NOT always insert a row. When an `active` session already exists for the caller's `(tokenId, projectId)` — the ordinary case, because every supported host registers the session over HTTP before the agent runs — the call SHALL adopt that row instead of minting a second one, and SHALL report which of the two happened in a REQUIRED `reused` field: `true` when an existing row was adopted, `false` when a row was inserted. `reused` is the only signal distinguishing "you are now attached to the host's session" from "you just created a parallel session", which is the question a defensive `memory.session_start` call is asking. Its `outputSchema` SHALL mark it required, and the tool's description SHALL name it and state what `true` means (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"): a required field the description omits from a closed-form `Returns: { … }` list is undocumented surface on the one channel the model reads.

The response SHALL additionally carry a REQUIRED `agent` field reporting the attribution the resolved row actually carries: on `reused: false` the value just written, and on `reused: true` the adopted row's own value, which MAY differ from the `agent` argument the call passed. It SHALL be read from the resolved row rather than from the argument, so the field reports what is stored and not what was requested. The adopt path SHALL NOT write the passed `agent` onto the adopted row: `sessions.agent` is immutable (see the `sessions` capability, "The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session") and no verb re-attributes a session, so a differing argument is discarded permanently and every memory and summary version anchored to that row inherits the row's attribution instead. Reporting it is therefore the entire remedy available: `reused: true` alone tells the caller it is attached to a session it did not open but not whose, and without `agent` the discard is not merely unnoticed but unobservable. Refusing the call on a mismatch SHALL NOT be adopted as the remedy — a host-registered row whose `agent` string the hook chose, adopted by a model that names itself differently, is the ordinary case the reuse exists to serve — and neither SHALL `agent` be added to the reuse key, which would restore the duplicate-session bug the reuse prevents. `agent` SHALL be non-nullable and always present, since the column is `NOT NULL` and the insert path substitutes `'unknown'`; a nullable declaration would publish a state the tool cannot produce. Its `outputSchema` SHALL mark it required and the description's closed-form `Returns: { … }` list SHALL name it, per "A tool's description and its response MUST agree, and neither may promise an unreachable state".

`memory.session_start` SHALL resolve the session it reports in this order, and the order is normative: (0) an honoured host-declared session (see "An honoured host-declared session MUST take precedence over the model's `sessionId`"); (1) the windowed sole-active lookup (`findActiveForTransport`); (2) the sole-active reuse lookup that applies no staleness window (`findSoleActiveForReuse`); (3) a mint. Steps (1) and (2) are specified in the `sessions` capability, "`findActiveForTransport` MUST NOT guess under concurrent ambiguity". No step SHALL consult a binding between the connection and a session: the server keeps no per-connection state, and neither `memory.session_start` nor `memory.session_resume` binds a session to the connection.

The three adoption paths report the same way: `reused: true` carrying the adopted row's `sessionId` and that row's stored `agent`, and none of them SHALL insert a row. Only step (3) reports `reused: false`. Minting under two-or-more live rows is preserved as published behaviour, and with no connection binding to answer a repeated call, each repeated call under that condition mints again; the description clause below is what limits repeated calls.

`memory.session_start`'s optional `project` argument SHALL be an assertion, not an activation. When it names the project the connection resolved — from the URL path, or the default project on a path-less connection — the call SHALL proceed exactly as if the argument were omitted. When it names any other slug, the call SHALL be refused with `scope_locked`, naming the resolved slug, and SHALL insert, adopt and modify no row. It SHALL NOT activate, switch or create a project.

The tool's description SHALL additionally tell the model not to repeat the call on a connection that already has a session — once a session is active on this connection, do not call `memory.session_start` again, because writes attach automatically. The description is the only surface that can reduce the volume of defensive calls that create these rows in the first place; the resolution order above bounds the damage per call, and this clause is what reduces the number of calls.

`memory.session_summary` SHALL validate `summary` against the single canonical cap exported from `packages/core/src/services/agent-sessions.ts` (`SUMMARY_MAX_CHARS`, currently `10000`). The MCP zod schema SHALL be `summary: z.string().min(1).max(SUMMARY_MAX_CHARS)` so overflow is rejected at the transport boundary with `invalid_input` before the tool body runs. The rejected agent SHALL receive an error whose message contains the decimal string of `SUMMARY_MAX_CHARS` so it can retry with a tighter body on the first attempt.

`memory.session_summary` and `memory.session_end` SHALL NOT reject a call because the resolved row is in a terminal state. `memory.session_summary` SHALL apply its summary/title write subject to the `final` precedence rules regardless of `status`; `memory.session_end` takes no summary/title arguments, so on a terminal row it SHALL be a pure no-op returning the existing `ended_at`. Neither SHALL mutate `status`, `ended_at` or `last_activity_at` on a terminal row — see the `sessions` capability, "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`". `session_already_ended` SHALL NOT be a possible error code for either tool. This matters because the plugin's `PreCompact`, `SessionStart:compact` and `Stop` nudges instruct the agent to call `memory.session_summary`, and the stale-active retirement sweep can have flipped the row to `abandoned` (the documented steady state for two of the clients) before the agent gets there.

`memory.session_summary`'s response SHALL carry a REQUIRED `applied: boolean` field. `applied` is `true` when the summary/title write landed on the row (whether the row was `active` or terminal without a prior curated summary). `applied` is `false` when the terminal first-curated-stands precedence rule blocked the write: the row is terminal (`ended` or `abandoned`), `summary_final` was already `true`, and the incoming curated summary was discarded. When `applied` is `false`, the response SHALL additionally carry `discardReason: 'terminal_final'` — the only discard reason today — to name the specific rule that blocked the write. When `applied` is `true`, `discardReason` SHALL be omitted from the response. The `outputSchema` SHALL declare `applied` as required (`z.boolean()`) and `discardReason` as optional (`z.string().optional()`). This field is the entire remedy available on the MCP surface: the row cannot be repaired, the first-curated-stands rule cannot be changed (there is no `replaces` chain for sessions, so losing a curated handoff is unrecoverable), and returning an error would violate the "SHALL NOT reject a call because the resolved row is in a terminal state" clause above.

`memory.session_end`'s response SHALL carry a REQUIRED `applied: boolean` field. `applied` is `true` when the call transitioned an `active` row to `ended`. `applied` is `false` when the row was already terminal (`ended` or `abandoned`) and the call was a no-op. The `outputSchema` SHALL declare `applied` as required (`z.boolean()`). This makes the two session-lifecycle write tools consistent: both report whether the call achieved a state change.

`memory.session_resume` SHALL accept `{ sessionId: string }` with `sessionId` REQUIRED, and SHALL call `AgentSessionsService.resume` (specified in the `sessions` capability) with the request's token id. Its response SHALL be `{ ok: true, sessionId, status: 'active', startedAt, resumedAt, previousStatus, previousEndedAt, title }`, where `previousStatus` is the row's `status` immediately before the call and `previousEndedAt` is the `ended_at` the call discarded (`null` when the row was already `active`). Those two fields are the ONLY report of a value the server does not retain, so the tool's `outputSchema` SHALL mark them required and the description SHALL name them. `resumedAt` SHALL be the row's effective last activity after the call — the instant of the resume on the transition path, and the row's PRIOR activity on the already-`active` no-op path, since that path writes nothing by design. `resumedAt` SHALL NOT be read as "the instant this call ran": `previousStatus` is what distinguishes a transition from a no-op, and the tool description SHALL say so.

`sessionId` SHALL have no fallback resolution on `memory.session_resume`. Unlike the other three tools it SHALL NOT consult the sole-active-session lookup. That fallback is structurally unavailable — the active-session lookup filters `status = 'active'`, which the resume target by definition is not — so any fallback would have to select a terminal row by recency, precisely the heuristic the `sessions` capability's "`findActiveForTransport` MUST NOT guess under concurrent ambiguity" refuses. A call omitting `sessionId` SHALL be rejected at the zod boundary with `invalid_input`, never resolved to a guess.

`memory.session_resume` SHALL NOT bind the resumed session to the connection, on the transition path or on the already-`active` no-op path, and SHALL NOT set a project: resume names a session, and the project is whatever the connection already resolved. A later write reaches the resumed session through an honoured host-declared session naming it, through an explicit `sessionId` when no declared session is honoured, or through the sole-active-session lookup when the resumed session is the only `active` one for the caller's `(token, project)`. `memory.session_end` has no binding to clear.

Session resolution for the other three tools SHALL remain status-aware where it already is: `memory.session_summary` resolves its target from an honoured host-declared session, else an explicit `sessionId`, else the unambiguous `active` session for the caller's `(token_id, project_id)`. The last source, the transport lookup, SHALL continue to consider only `active` rows, so an agent that supplies no explicit id SHALL receive a refusal rather than having its write attached to a closed session picked by recency.

When `memory.session_summary` or `memory.session_end` is called without `sessionId` and no session resolves, the refusal SHALL say why, because the remedy differs and a wrong remedy misfiles the write permanently. The tool SHALL classify through `AgentSessionsService.resolveForTransport` (see the `sessions` capability, "Transport resolution MUST distinguish absence from ambiguity") and SHALL refuse with:

- `session_ambiguous` when two or more `active`, non-deleted rows exist for the caller's `(token_id, project_id)`, with or without the staleness window, and no single row is inside the window. Its message SHALL be exactly `more than one session is active for this token and project; pass your sessionId explicitly. memory.session_start cannot resolve this: it would open another session`. It SHALL NOT name, count or otherwise reveal the candidate rows, and SHALL NOT write, insert or touch any row.
- `session_not_found` with its existing message `no active session on this MCP transport and no sessionId was provided` in every other unresolved case, including a sole `active` row idle past the window (which `memory.session_start` adopts) and no `active` row at all.

`session_not_found` SHALL NOT be returned for the ambiguity case. The defect this closes: the server instructions route `session_not_found` to `memory.session_start`, which under ambiguity mints a row with `agent: 'unknown'`, and the retried summary then lands on that row, permanently, since sessions are append-only and `agent` is immutable. The `memory.session_end` description SHALL name `session_ambiguous` and say that the remedy is the caller's own `sessionId`, never `memory.session_start`. The `memory.session_summary` description is exempt because it has no room under `DESCRIPTION_MAX_LENGTH`; for that tool the refusal message carries the remedy.

#### Scenario: `memory.session_start` opens a new session

- **WHEN** an MCP client calls `memory.session_start` with `{ agent?: string, description?: string }`
- **THEN** the server SHALL insert a `sessions` row with `status = 'active'`, `started_at = now`, the provided `agent` (or `'unknown'`), `token_id` from the request context, `project_id` from the request scope, and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` with `title_final = false`; **AND** the response SHALL be `{ sessionId, scope, projectId, startedAt, title, reused, agent }`, whose `agent` SHALL equal the value just written to the row

#### Scenario: `memory.session_end` ends a session without summary

- **WHEN** an MCP client calls `memory.session_end` with `{ sessionId: string }` for an active session
- **THEN** the server SHALL set `status = 'ended'` and `ended_at = now` on that row, leave `summary` and `title` unchanged, and SHALL return `{ ok: true, sessionId, endedAt, applied: true }`

#### Scenario: `memory.session_end` is idempotent on already-ended sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is already `'ended'`
- **THEN** the server SHALL return `{ ok: true, sessionId, endedAt, applied: false }` with the existing `ended_at` and SHALL NOT mutate the row

#### Scenario: `memory.session_end` is idempotent on abandoned sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is `'abandoned'` with `ended_at = E`
- **THEN** the server SHALL return `{ ok: true, sessionId, endedAt: E, applied: false }`, SHALL leave `status = 'abandoned'` and `ended_at = E` untouched, and SHALL NOT return `session_already_ended`

#### Scenario: `memory.session_summary` writes summary and title without ending the session

- **WHEN** an MCP client calls `memory.session_summary` with `{ sessionId?: string, summary: string, title?: string }` and `summary.length <= SUMMARY_MAX_CHARS`
- **THEN** the server SHALL resolve `sessionId`, when omitted, to the unambiguous `active` session for the caller's `(token_id, project_id)`, write `summary` with `summary_final = true`, write `title` (when provided, after validating length ≤100) with `title_final = true`, leave `status`/`ended_at` unchanged, and return `{ ok: true, sessionId, summary, title, summaryFinal: true, titleFinal: <true|false>, applied: true }`

#### Scenario: `memory.session_summary` succeeds on a session the sweep already abandoned

- **GIVEN** the agent's session was flipped to `status = 'abandoned'` with `ended_at = E` and `last_activity_at = L` by stale-active retirement while the conversation was still open, and the agent knows its `sessionId` (the plugin's nudge injects it)
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary, title })`
- **THEN** the call SHALL succeed and return `{ ok: true, sessionId, summary, title, summaryFinal: true, applied: true }`
- **AND** the row SHALL retain `status = 'abandoned'`, `ended_at = E` and `last_activity_at = L`
- **AND** the call SHALL NOT return `session_already_ended`

#### Scenario: `memory.session_summary` succeeds on an ended session

- **GIVEN** a row whose `status = 'ended'` with `ended_at = E` and `summary_final = false` (no curated summary written yet)
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary })`
- **THEN** the call SHALL succeed with `summaryFinal: true` and `applied: true`, and `status`/`ended_at` SHALL be unchanged

#### Scenario: `memory.session_summary` with no resolvable session still reports `session_not_found`

- **GIVEN** the agent passes no explicit `sessionId`, and the only candidate row for its `(token_id, project_id)` is `abandoned`
- **WHEN** the agent calls `memory.session_summary({ summary })`
- **THEN** the call SHALL be rejected with code `session_not_found` (NOT `session_already_ended`, and NOT silently attached to the abandoned row)

#### Scenario: `memory.session_summary` may be called multiple times; the latest call wins

- **GIVEN** an `active` session whose `summary_final = true` from a prior `memory.session_summary({summary: "A"})` call
- **WHEN** the agent calls `memory.session_summary({summary: "B"})` again
- **THEN** `summary` SHALL be replaced with "B" (last-final-wins among final writes on active rows) and `applied` SHALL be `true`

#### Scenario: `memory.session_summary` discards a second curated write on a terminal row

- **GIVEN** a terminal session (`status = 'ended'` or `'abandoned'`) whose `summary_final = true` from a prior curated write with summary "A"
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary: "B" })`
- **THEN** the response SHALL carry `ok: true`, `summary: "A"` (the stored value, unchanged), `summaryFinal: true`, `applied: false`, and `discardReason: 'terminal_final'`
- **AND** the session row SHALL be unchanged in every column

#### Scenario: `memory.session_summary` discards a second curated title on a terminal row

- **GIVEN** a terminal session whose `title_final = true` from a prior curated write with title "First"
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary: "new summary", title: "Second" })`
- **THEN** the response SHALL carry `title: "First"` (the stored value, unchanged), `titleFinal: true`, `applied: false`, and `discardReason: 'terminal_final'`
- **AND** the session row SHALL be unchanged in every column

#### Scenario: `memory.session_summary` discards summary but applies title on a terminal row

- **GIVEN** a terminal session whose `summary_final = true` and `title_final = false`
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary: "B", title: "New Title" })`
- **THEN** the response SHALL carry `summary: "A"` (unchanged), `summaryFinal: true`, `title: "New Title"` (applied), `titleFinal: true`, `applied: false`, and `discardReason: 'terminal_final'`
- **AND** the summary column SHALL be unchanged but the title column SHALL reflect the new value

#### Scenario: `memory.session_summary` rejects empty summary

- **WHEN** the agent submits `summary: ""` or whitespace-only
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: `memory.session_summary` rejects title over 100 chars

- **WHEN** the agent submits `title: "A".repeat(101)`
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: `memory.session_summary` rejects summary over `SUMMARY_MAX_CHARS`

- **WHEN** the agent submits `summary: "A".repeat(SUMMARY_MAX_CHARS + 1)` (one char over the cap)
- **THEN** the call SHALL be rejected at the zod boundary with code `invalid_input`
- **AND** the error message SHALL contain the decimal string of `SUMMARY_MAX_CHARS` so the agent can deduce the cap and retry with a tighter body on the first attempt
- **AND** the session row SHALL NOT be mutated (no partial write, `summary_final` unchanged)

#### Scenario: `memory.session_summary` accepts summary of exactly `SUMMARY_MAX_CHARS`

- **WHEN** the agent submits `summary: "A".repeat(SUMMARY_MAX_CHARS)`
- **THEN** the call SHALL succeed and the row SHALL have `summary` of length `SUMMARY_MAX_CHARS` with `summary_final = true` and `applied: true`

#### Scenario: A session-lifecycle tool targets a session owned by a different token

- **WHEN** any of the four tools is called with a `sessionId` whose `token_id` does not match the caller's token
- **THEN** the call SHALL be rejected with code `session_not_found` (never `forbidden`, to avoid information disclosure)

#### Scenario: A second `memory.session_start` adopts the first session and says so

- **GIVEN** a connection with no active session for its `(tokenId, projectId)`
- **WHEN** an MCP client calls `memory.session_start` twice in a row on that connection
- **THEN** the first response SHALL carry `reused: false` and the second SHALL carry `reused: true`
- **AND** both responses SHALL carry the SAME `sessionId` — the second call SHALL NOT insert a second `sessions` row
- **AND** the `sessions` row count for that `(tokenId, projectId)` SHALL be 1 after both calls, which is the control that `reused: true` describes adoption rather than a coincidence of ids

#### Scenario: `memory.session_start` reports the adopted session's `agent` rather than the argument

- **GIVEN** exactly one `active` session for the caller's `(tokenId, projectId)`, created with `agent = 'claude-code'`
- **WHEN** an MCP client calls `memory.session_start` with `{ agent: 'pi' }` on that connection
- **THEN** the response SHALL carry `reused: true` AND `agent: 'claude-code'` — the adopted row's stored value, NOT the argument
- **AND** the row's `agent` column SHALL still be `'claude-code'` and the `sessions` row count for that `(tokenId, projectId)` SHALL still be 1, so the report is of an adoption and not of a second row
- **AND** the control, from the same connection state without the pre-existing session: `memory.session_start({ agent: 'pi' })` SHALL return `reused: false` with `agent: 'pi'`. Without it a passing adopt assertion cannot be told apart from a test that never adopted anything, and an implementation reading `agent` from the argument would satisfy the adopt assertion whenever the two values happen to agree

#### Scenario: `memory.session_start` adopts the sole active row when no fresh row exists

- **GIVEN** exactly one `active`, non-deleted row `<S>` for the caller's `(tokenId, projectId)`, idle past the staleness window
- **WHEN** the client calls `memory.session_start`
- **THEN** the response SHALL carry `reused: true` and `sessionId = <S>`
- **AND** the row count SHALL be unchanged

#### Scenario: `memory.session_start` asserts the connection's project

- **GIVEN** a connection whose resolved project is `foo`, either at `/mcp/foo` or path-less with `foo` as the default project
- **WHEN** the client calls `memory.session_start({ project: 'bar' })`
- **THEN** the call SHALL be refused with `code: 'scope_locked'` and a message naming `foo`
- **AND** no `sessions` row SHALL be inserted or modified, and every later call on the connection SHALL still resolve to `foo`
- **AND** the control, on the same connection: `memory.session_start({ project: 'foo' })` SHALL succeed exactly as `memory.session_start({})` does

#### Scenario: `memory.session_start`'s description names every required output field

- **WHEN** an MCP client retrieves the tool description for `memory.session_start` via `tools/list`
- **THEN** the description's `Returns:` enumeration SHALL name every field its `outputSchema` marks required, including `title`, `reused` and `agent`
- **AND** the description SHALL state that `reused: true` means the call adopted the host's already-active session rather than starting one
- **AND** the description SHALL state that `agent` reports the attribution the resolved session carries and MAY differ from the `agent` argument the call passed, so the field is not read as an echo of that argument
- **AND** a CI test SHALL compare the description against the `outputSchema`'s required list, so a field added to the schema without a description update fails the build

#### Scenario: The `memory.session_start` description tells the model not to call again on an active connection

- **WHEN** an MCP client retrieves the tool description for `memory.session_start` via `tools/list`
- **THEN** the description SHALL state that once a session is active on this connection the model SHALL NOT call `memory.session_start` again, and that writes attach automatically
- **AND** it SHALL keep stating that in normal operation the model does not need to call the tool at all, so the two clauses read as one instruction rather than a contradiction
- **AND** its `String.length` measured from a real `tools/list` response SHALL be at or below `DESCRIPTION_MAX_LENGTH = 1900`
- **AND** the change SHALL record the measured length and the remaining headroom: the description measured **818 of 1900 characters, 1082 of headroom**, immediately before this clause was added, so the clause fits without reclaiming any mandated prose
- **AND** the cap SHALL NOT be raised to accommodate it; if it ever ceases to fit, the clause is reworded shorter instead

#### Scenario: `memory.session_resume` returns an ended session to active

- **GIVEN** session `<S>` owned by the calling token, `status='ended'` with `ended_at = E`, in the connection's project
- **WHEN** an MCP client calls `memory.session_resume` with `{ sessionId: <S> }`
- **THEN** the response SHALL be `{ ok: true, sessionId: <S>, status: 'active', startedAt, resumedAt, previousStatus: 'ended', previousEndedAt: E, title }`
- **AND** the row SHALL have `status='active'` and `ended_at IS NULL`

#### Scenario: `memory.session_resume` returns an abandoned session to active identically

- **GIVEN** session `<S>` owned by the calling token, `status='abandoned'` with `ended_at = E`
- **WHEN** an MCP client calls `memory.session_resume` with `{ sessionId: <S> }`
- **THEN** the response SHALL carry `previousStatus: 'abandoned'`, `previousEndedAt: E` and `status: 'active'`
- **AND** the row SHALL be indistinguishable in every column from the same row resumed out of `ended`

#### Scenario: `memory.session_resume` binds nothing to the connection

- **GIVEN** sessions `<S>` and `<T>` owned by the calling token in the connection's project, `<S>` `ended` and `<T>` `active`
- **WHEN** the client calls `memory.session_resume` with `{ sessionId: <S> }`, it succeeds, and the client then calls `memory.save` with no explicit `sessionId`
- **THEN** the saved row SHALL carry `session_id = NULL`, because two sessions are now `active` and the sole-active-session lookup refuses to choose
- **AND** the same `memory.save` with `sessionId: <S>` SHALL persist `session_id = <S>`, which is the control that the resumed session is reachable by its explicit identifier

#### Scenario: `memory.session_resume` refuses a call with no `sessionId`

- **WHEN** an MCP client calls `memory.session_resume` with `{}`
- **THEN** the call SHALL be rejected at the zod boundary with code `invalid_input`
- **AND** no session SHALL be resolved by recency, and no row SHALL be mutated

#### Scenario: `memory.session_resume` refuses an unknown property

- **WHEN** an MCP client calls `memory.session_resume` with `{ sessionId: <S>, epoch: 3 }`
- **THEN** the call SHALL be rejected with `invalid_input` rather than having the unknown property silently stripped, because every tool's input schema is registered strict

#### Scenario: `memory.session_resume` targets a session in another project

- **GIVEN** session `<S>` owned by the calling token but belonging to a project other than the one this connection resolved
- **WHEN** the client calls `memory.session_resume` with `{ sessionId: <S> }`
- **THEN** the call SHALL be rejected with `session_not_found` and the row SHALL NOT be mutated

#### Scenario: `memory.session_resume` on an already-active session succeeds without mutating it

- **GIVEN** session `<S>` with `status='active'` and `last_activity_at = L`
- **WHEN** the client calls `memory.session_resume` with `{ sessionId: <S> }`
- **THEN** the call SHALL succeed with `previousStatus: 'active'` and `previousEndedAt: null`
- **AND** the row SHALL NOT be mutated, so `last_activity_at` SHALL still be `L`

#### Scenario: `memory.session_start` adopts a resumed session rather than minting a second row

- **GIVEN** session `<S>` was resumed and is the only `active` row for the caller's `(token_id, project_id)`
- **WHEN** the agent calls `memory.session_start`
- **THEN** the response SHALL carry `sessionId = <S>` and `reused: true`
- **AND** the `sessions` row count for that `(token_id, project_id)` SHALL be unchanged, which is the control that adoption happened rather than a coincidence of ids

#### Scenario: `memory.session_resume`'s description names every required output field

- **WHEN** an MCP client retrieves the tool description for `memory.session_resume` via `tools/list`
- **THEN** the description's `Returns:` enumeration SHALL name every field its `outputSchema` marks required, including `previousStatus` and `previousEndedAt`
- **AND** the description SHALL state that `previousEndedAt` is not retained on the row after the call
- **AND** the CI test that compares each description against its `outputSchema`'s required list SHALL cover this tool

#### Scenario: `memory.session_summary` without `sessionId` under two active sessions is refused as `session_ambiguous`

- **GIVEN** two `active`, non-deleted rows exist for the caller's `(token_id, project_id)`, both inside the staleness window
- **WHEN** the agent calls `memory.session_summary({ summary, title })` with no `sessionId`
- **THEN** the call SHALL be refused with code `session_ambiguous` and the exact message above
- **AND** no `sessions` row SHALL be inserted or modified, which is the control that the refusal happened before any write

#### Scenario: Two active rows idle past the window are still `session_ambiguous`

- **GIVEN** two `active`, non-deleted rows for the caller's `(token_id, project_id)`, both idle past the staleness window
- **WHEN** the agent calls `memory.session_summary` or `memory.session_end` with no `sessionId`
- **THEN** the call SHALL be refused with `session_ambiguous`, because `memory.session_start` would mint here too

#### Scenario: A sole idle row and no row keep `session_not_found`

- **GIVEN** either no `active` row, or exactly one `active` row idle past the staleness window, for the caller's `(token_id, project_id)`
- **WHEN** the agent calls `memory.session_summary` or `memory.session_end` with no `sessionId`
- **THEN** the call SHALL be refused with `session_not_found` and its existing message

#### Scenario: `memory.session_end` without `sessionId` under ambiguity ends nothing

- **GIVEN** two `active` rows for the caller's `(token_id, project_id)`
- **WHEN** the agent calls `memory.session_end({})`
- **THEN** the call SHALL be refused with `session_ambiguous` and both rows SHALL remain `active`

#### Scenario: `memory.session_start` adopts an honoured host-declared session before any other lookup

- **GIVEN** two `active` rows for the caller's `(token_id, project_id)` and a request whose `X-Rembric-Session` names one of them
- **WHEN** the agent calls `memory.session_start`
- **THEN** the response SHALL carry `reused: true`, that row's `sessionId` and that row's stored `agent`
- **AND** no `sessions` row SHALL be inserted
