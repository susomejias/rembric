## MODIFIED Requirements

### Requirement: The MCP server MUST expose four session-lifecycle tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, `memory.session_summary` and `memory.session_resume` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the state transition out of `active`, and `memory.session_resume` is the sole transition back into it.

`memory.session_start` SHALL NOT always insert a row. When an `active` session already exists for the caller's `(tokenId, projectId)` on this transport — the ordinary case, because every supported host registers the session over HTTP before the agent runs — the call SHALL adopt that row instead of minting a second one, and SHALL report which of the two happened in a REQUIRED `reused` field: `true` when an existing row was adopted, `false` when a row was inserted. `reused` is the only signal distinguishing "you are now attached to the host's session" from "you just created a parallel session", which is the question a defensive `memory.session_start` call is asking. Its `outputSchema` SHALL mark it required, and the tool's description SHALL name it and state what `true` means (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"): a required field the description omits from a closed-form `Returns: { … }` list is undocumented surface on the one channel the model reads.

The response SHALL additionally carry a REQUIRED `agent` field reporting the attribution the resolved row actually carries: on `reused: false` the value just written, and on `reused: true` the adopted row's own value, which MAY differ from the `agent` argument the call passed. It SHALL be read from the resolved row rather than from the argument, so the field reports what is stored and not what was requested. The adopt path SHALL NOT write the passed `agent` onto the adopted row: `sessions.agent` is immutable (see the `sessions` capability, "The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session") and no verb re-attributes a session, so a differing argument is discarded permanently and every memory and summary version anchored to that row inherits the row's attribution instead. Reporting it is therefore the entire remedy available: `reused: true` alone tells the caller it is attached to a session it did not open but not whose, and without `agent` the discard is not merely unnoticed but unobservable. Refusing the call on a mismatch SHALL NOT be adopted as the remedy — a host-registered row whose `agent` string the hook chose, adopted by a model that names itself differently, is the ordinary case the reuse exists to serve — and neither SHALL `agent` be added to the reuse key, which would restore the duplicate-session bug the reuse prevents. `agent` SHALL be non-nullable and always present, since the column is `NOT NULL` and the insert path substitutes `'unknown'`; a nullable declaration would publish a state the tool cannot produce. Its `outputSchema` SHALL mark it required and the description's closed-form `Returns: { … }` list SHALL name it, per "A tool's description and its response MUST agree, and neither may promise an unreachable state".

`memory.session_summary` SHALL validate `summary` against the single canonical cap exported from `apps/server/src/services/agent-sessions.ts` (`SUMMARY_MAX_CHARS`, currently `10000`). The MCP zod schema SHALL be `summary: z.string().min(1).max(SUMMARY_MAX_CHARS)` so overflow is rejected at the transport boundary with `invalid_input` before the tool body runs. The rejected agent SHALL receive an error whose message contains the decimal string of `SUMMARY_MAX_CHARS` so it can retry with a tighter body on the first attempt.

`memory.session_summary` and `memory.session_end` SHALL NOT reject a call because the resolved row is in a terminal state. `memory.session_summary` SHALL apply its summary/title write subject to the `final` precedence rules regardless of `status`; `memory.session_end` takes no summary/title arguments, so on a terminal row it SHALL be a pure no-op returning the existing `ended_at`. Neither SHALL mutate `status`, `ended_at` or `last_activity_at` on a terminal row — see the `sessions` capability, "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`". `session_already_ended` SHALL NOT be a possible error code for either tool. This matters because the plugin's `PreCompact`, `SessionStart:compact` and `Stop` nudges instruct the agent to call `memory.session_summary`, and the stale-active retirement sweep can have flipped the row to `abandoned` (the documented steady state for two of the clients) before the agent gets there.

`memory.session_resume` SHALL accept `{ sessionId: string }` with `sessionId` REQUIRED, and SHALL call `AgentSessionsService.resume` (specified in the `sessions` capability) with the request's token id. Its response SHALL be `{ ok: true, sessionId, status: 'active', startedAt, resumedAt, previousStatus, previousEndedAt, title }`, where `previousStatus` is the row's `status` immediately before the call and `previousEndedAt` is the `ended_at` the call discarded (`null` when the row was already `active`). Those two fields are the ONLY report of a value the server does not retain, so the tool's `outputSchema` SHALL mark them required and the description SHALL name them. `resumedAt` SHALL be the row's effective last activity after the call — the instant of the resume on the transition path, and the row's PRIOR activity on the already-`active` no-op path, since that path writes nothing by design. `resumedAt` SHALL NOT be read as "the instant this call ran": `previousStatus` is what distinguishes a transition from a no-op, and the tool description SHALL say so.

`sessionId` SHALL have no fallback resolution on `memory.session_resume`. Unlike the other three tools it SHALL NOT consult the `SessionRouter` entry, and SHALL NOT consult the sole-active-session lookup. Both fallbacks are structurally unavailable — `memory.session_end` cleared the router binding on its way out, and the active-session lookup filters `status = 'active'`, which the resume target by definition is not — so any fallback would have to select a terminal row by recency, precisely the heuristic the `sessions` capability's "`findActiveForTransport` MUST NOT guess under concurrent ambiguity" refuses. A call omitting `sessionId` SHALL be rejected at the zod boundary with `invalid_input`, never resolved to a guess.

`memory.session_end` clears the `SessionRouter` transport binding for `(tokenId, mcpSessionId)` ONLY when the row it resolved is not `abandoned`. Before terminal writes were admitted, `end()` threw on an `abandoned` row and the clear was unreachable, so the binding survived; clearing it now would drop every later `memory.save` on that transport to `session_id = NULL`. That prior behaviour SHALL be preserved: ending an `abandoned` row SHALL leave the binding intact, ending an `active` or `ended` row SHALL clear it.

`memory.session_resume` SHALL set that binding, and this is load-bearing rather than incidental. On success it SHALL call the same `SessionRouter.setActiveSession(tokenId, mcpSessionId, sessionId)` that `memory.session_start` calls, so the resuming transport resolves its session by an explicit pin rather than by the ambiguous-resolution fallback. Without the pin a resumed row is only reachable through the sole-active-session lookup, which returns nothing whenever a second session is concurrently live under the same `(token, project)`. It SHALL set the binding on the already-`active` no-op path too, since re-pinning is the useful half of a defensive call. It SHALL NOT set `setActiveProject`: resume names a session, not a project, and the project is whatever the connection already resolved.

Session resolution is unchanged for the other three tools and SHALL remain status-aware where it already is: `memory.session_summary` resolves its target from an explicit `sessionId`, else the transport's `SessionRouter` entry, else the unambiguous `active` session for the caller's `(token_id, project_id)`. The third source SHALL continue to consider only `active` rows, so an agent that supplies neither an explicit id nor a router-mapped session SHALL receive `session_not_found` rather than having its write attached to a closed session picked by recency.

#### Scenario: `memory.session_start` opens a new session

- **WHEN** an MCP client calls `memory.session_start` with `{ agent?: string, description?: string }`
- **THEN** the server SHALL insert a `sessions` row with `status = 'active'`, `started_at = now`, the provided `agent` (or `'unknown'`), `token_id` from the request context, `project_id` from the request scope, and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` with `title_final = false`; **AND** the response SHALL be `{ sessionId, scope, projectId, startedAt, title, reused, agent }`, whose `agent` SHALL equal the value just written to the row

#### Scenario: `memory.session_end` ends a session without summary

- **WHEN** an MCP client calls `memory.session_end` with `{ sessionId: string }` for an active session
- **THEN** the server SHALL set `status = 'ended'` and `ended_at = now` on that row, leave `summary` and `title` unchanged, and SHALL return `{ ok: true, endedAt }`

#### Scenario: `memory.session_end` is idempotent on already-ended sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is already `'ended'`
- **THEN** the server SHALL return `{ ok: true, endedAt }` with the existing `ended_at` and SHALL NOT mutate the row

#### Scenario: `memory.session_end` is idempotent on abandoned sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is `'abandoned'` with `ended_at = E`
- **THEN** the server SHALL return `{ ok: true, endedAt: E }`, SHALL leave `status = 'abandoned'` and `ended_at = E` untouched, and SHALL NOT return `session_already_ended`
- **AND** the `SessionRouter` binding for the calling transport SHALL remain pointing at that session, so a subsequent `memory.save` on the same transport still auto-attaches its `session_id`

#### Scenario: `memory.session_end` on an active session clears the transport binding

- **WHEN** an MCP client calls `memory.session_end` on an `active` row and the call transitions it to `ended`
- **THEN** the `SessionRouter` entry for `(tokenId, mcpSessionId)` SHALL be cleared, as before this requirement's revision

#### Scenario: `memory.session_summary` writes summary and title without ending the session

- **WHEN** an MCP client calls `memory.session_summary` with `{ sessionId?: string, summary: string, title?: string }` and `summary.length <= SUMMARY_MAX_CHARS`
- **THEN** the server SHALL resolve `sessionId` from the active MCP transport mapping when omitted, write `summary` with `summary_final = true`, write `title` (when provided, after validating length ≤100) with `title_final = true`, leave `status`/`ended_at` unchanged, and return `{ ok: true, sessionId, summary, title, summaryFinal: true, titleFinal: <true|false> }`

#### Scenario: `memory.session_summary` succeeds on a session the sweep already abandoned

- **GIVEN** the agent's session was flipped to `status = 'abandoned'` with `ended_at = E` and `last_activity_at = L` by stale-active retirement while the conversation was still open, and the agent knows its `sessionId` (the plugin's nudge injects it)
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary, title })`
- **THEN** the call SHALL succeed and return `{ ok: true, sessionId, summary, title, summaryFinal: true, … }`
- **AND** the row SHALL retain `status = 'abandoned'`, `ended_at = E` and `last_activity_at = L`
- **AND** the call SHALL NOT return `session_already_ended`

#### Scenario: `memory.session_summary` succeeds on an ended session

- **GIVEN** a row whose `status = 'ended'` with `ended_at = E`
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary })`
- **THEN** the call SHALL succeed with `summaryFinal: true`, and `status`/`ended_at` SHALL be unchanged

#### Scenario: `memory.session_summary` with no resolvable session still reports `session_not_found`

- **GIVEN** the agent passes no explicit `sessionId`, the transport has no `SessionRouter` entry, and the only candidate row for its `(token_id, project_id)` is `abandoned`
- **WHEN** the agent calls `memory.session_summary({ summary })`
- **THEN** the call SHALL be rejected with code `session_not_found` (NOT `session_already_ended`, and NOT silently attached to the abandoned row)

#### Scenario: `memory.session_summary` may be called multiple times; the latest call wins

- **GIVEN** a session whose `summary_final = true` from a prior `memory.session_summary({summary: "A"})` call
- **WHEN** the agent calls `memory.session_summary({summary: "B"})` again
- **THEN** `summary` SHALL be replaced with "B" (last-final-wins among final writes)

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
- **THEN** the call SHALL succeed and the row SHALL have `summary` of length `SUMMARY_MAX_CHARS` with `summary_final = true`

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

#### Scenario: `memory.session_start`'s description names every required output field

- **WHEN** an MCP client retrieves the tool description for `memory.session_start` via `tools/list`
- **THEN** the description's `Returns:` enumeration SHALL name every field its `outputSchema` marks required, including `title`, `reused` and `agent`
- **AND** the description SHALL state that `reused: true` means the call adopted the host's already-active session rather than starting one
- **AND** the description SHALL state that `agent` reports the attribution the resolved session carries and MAY differ from the `agent` argument the call passed, so the field is not read as an echo of that argument
- **AND** a CI test SHALL compare the description against the `outputSchema`'s required list, so a field added to the schema without a description update fails the build

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

#### Scenario: `memory.session_resume` pins the transport binding

- **GIVEN** an MCP transport whose `SessionRouter` entry carries no session (the state `memory.session_end` leaves behind)
- **WHEN** the client calls `memory.session_resume` with `{ sessionId: <S> }` and it succeeds
- **THEN** the `SessionRouter` entry for `(tokenId, mcpSessionId)` SHALL point at `<S>`
- **AND** a subsequent `memory.save` on that transport, with no explicit `sessionId`, SHALL persist `session_id = <S>`
- **AND** that SHALL hold even when a second `active` session exists for the same `(token_id, project_id)`, which is the case the sole-active-session fallback refuses to resolve

#### Scenario: `memory.session_resume` refuses a call with no `sessionId`

- **WHEN** an MCP client calls `memory.session_resume` with `{}`
- **THEN** the call SHALL be rejected at the zod boundary with code `invalid_input`
- **AND** no session SHALL be resolved from the `SessionRouter` entry or by recency, and no row SHALL be mutated

#### Scenario: `memory.session_resume` refuses an unknown property

- **WHEN** an MCP client calls `memory.session_resume` with `{ sessionId: <S>, epoch: 3 }`
- **THEN** the call SHALL be rejected with `invalid_input` rather than having the unknown property silently stripped, because every tool's input schema is registered strict

#### Scenario: `memory.session_resume` targets a session in another project

- **GIVEN** session `<S>` owned by the calling token but belonging to a project other than the one this connection resolved
- **WHEN** the client calls `memory.session_resume` with `{ sessionId: <S> }`
- **THEN** the call SHALL be rejected with `session_not_found` and the row SHALL NOT be mutated

#### Scenario: `memory.session_resume` on an already-active session succeeds and re-pins

- **GIVEN** session `<S>` with `status='active'` and `last_activity_at = L`
- **WHEN** the client calls `memory.session_resume` with `{ sessionId: <S> }`
- **THEN** the call SHALL succeed with `previousStatus: 'active'` and `previousEndedAt: null`
- **AND** the row SHALL NOT be mutated, so `last_activity_at` SHALL still be `L`
- **AND** the `SessionRouter` entry SHALL nonetheless point at `<S>`

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
