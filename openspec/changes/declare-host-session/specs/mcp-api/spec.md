Note: `memory.session_start`'s adoption of a declared session is ADDED below rather than MODIFIED into "The MCP server MUST expose four session-lifecycle tools that keep no per-connection binding", which `report-session-ambiguity` and `expose-session-write-verdict` already modify; the ADDED requirement layers in front of that requirement's published order (the text as amended by `report-session-ambiguity`, which archives first).

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

`memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` SHALL accept an optional `sessionId: string` argument. When provided, it SHALL take precedence over the server's own session resolution — mirroring the explicit-first precedence `memory.session_summary`/`memory.session_end` already apply via `resolveSessionId`. The resolution order SHALL be exactly three steps: (1) an honoured host-declared session (see "An honoured host-declared session MUST take precedence over the model's `sessionId`"), in which case the `sessionId` argument SHALL be ignored without being validated; (2) otherwise the explicit, ownership-checked `sessionId`; (3) otherwise `findActiveForTransport(tokenId, projectId)`, which returns a session only when the choice is unambiguous and returns none otherwise (see the `sessions` requirement "`findActiveForTransport` MUST NOT guess under concurrent ambiguity"). The host's declaration outranks the argument because the client's lifecycle code knows the live session, while the model's copy of the id is lost to compaction and goes stale on `/clear`. No session SHALL be bound to the connection or transport, and no step SHALL consult per-connection state: the server keeps none. Each tool's description SHALL mention `sessionId` explicitly (not only via the input schema's per-argument `describe()`, since some MCP clients do not surface per-property schema descriptions to the model) with guidance to pass it only if genuinely known and never invent one.

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
