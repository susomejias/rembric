# mcp-api — delta

## ADDED Requirements

### Requirement: A tool's description and its response MUST agree, and neither may promise an unreachable state

An MCP tool description is read by the model on every call and is the only contract most agents ever see. It SHALL NOT teach a state the tool cannot produce, SHALL NOT present as closed an enumeration of the response that omits a field the tool always returns, and SHALL NOT offer a cause for an observable divergence that is not the actual cause. Equivalently: the description, the declared `outputSchema` and the emitted payload SHALL agree, and where they disagree the disagreement is a defect regardless of which of the three is wrong.

Three failure modes are in scope, and an instance SHALL be classified as one of them before it is fixed, because the correct remedy differs:

1. **A field reporting an unreachable state.** Where a tool's declared input schema REJECTS an out-of-range argument, the response SHALL NOT carry a field whose purpose is to report the out-of-range handling that therefore never occurs; likewise a field SHALL NOT be published whose only other value is reachable solely in a state where the tool cannot answer at all. A field that can hold one value forever carries no information and costs a line of the model's attention on every call.
2. **A description that misstates the response.** A closed-form enumeration ("Returns: { … }") SHALL name every field the `outputSchema` marks required. Where a required field answers the question the tool exists to answer, omitting it from the description is the more severe form of this defect, not the milder one.
3. **A description whose stated cause is not the actual cause.** Where a description explains why two surfaces report different numbers, it SHALL name every cause that can produce the divergence. Naming one of two causes is worse than naming none, because a reader who checks the named cause and finds it inapplicable concludes that one of the two numbers is stale.

An instance SHALL be closed in ONE of exactly three ways, and the change closing it SHALL state which:

- **Remove the field or claim** — appropriate when no reachable meaning exists that does not require relaxing the bound the input schema enforces. Relaxing a bound in order to make a clamp-receipt field reachable SHALL NOT be treated as an available option; rejection rather than clamping is the surface-wide rule (see "`memory.search` and `memory.get` MUST expose the annotation bound and its true total").
- **Correct the description** — appropriate when the payload is right and the text is wrong.
- **Correct the CODE** — appropriate when the description states the intended contract and a code path fails to honour it. A description SHALL NOT be weakened to match a defective implementation; where the two disagree, which one moves is a decision the change SHALL record.

Where the remedy is removing a field, the change SHALL take it out of the tool's declared `outputSchema` AND out of the emitted payload together, because the MCP SDK validates `structuredContent` against the schema published at registration: dropping only the key fails output validation, and dropping only the schema entry publishes an undeclared key.

Where the boundary rejects, the tool description SHALL teach the bound rather than promise a receipt. It SHALL name the maximum of every bounded numeric argument it accepts and SHALL state that a larger value is rejected rather than clamped — the same safety condition the annotation-bound requirement states as "Rejection is only safe if the caller is told how to stay inside the bound". `memory.timeline` is the model to match: its handler rejects an over-budget combined window AND names the remedy in the error message, referring the caller to `memory.search`.

Every obligation in this requirement SHALL be discharged in the tool's top-level description text and SHALL NOT be expressed only in a per-argument zod `describe()`, which some clients do not surface to the model. Every obligation SHALL be satisfied within `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"); where content must be reclaimed, the reclaimed clause SHALL be named by the change that removes it.

An in-process bound sitting behind the rejecting boundary MAY be retained as a defensive clamp for a future direct caller that bypasses the input schema. Retaining it SHALL NOT be treated as a violation: a bound with nothing reporting on it makes no claim to the agent. What this requirement forbids is the CLAIM, not the clamp.

#### Scenario: `memory.get`'s two forms carry the same review signal

- **GIVEN** one `active` in-scope memory whose derived `reviewState` is `'needs_review'`
- **WHEN** an MCP client calls `memory.get({ id })` and `memory.get({ ids: [id] })` on the same connection for that same row
- **THEN** both responses SHALL carry `reviewState`, `reviewAfter` and `reviewEscalated` for it, with equal values
- **AND** the `memory.get` description's unconditional promise of that metadata SHALL hold for both forms, since it distinguishes neither
- **AND** the remedy for a divergence here SHALL be to compute the metadata on the deficient path, NOT to qualify the description

#### Scenario: `memory.session_start`'s description names every required output field

- **WHEN** an MCP client reads the `memory.session_start` description from a real `tools/list` response and its declared `outputSchema`
- **THEN** every field the `outputSchema` marks required SHALL be named in the description
- **AND** the description SHALL state what `reused` means, because it is the field that answers whether the call adopted the host's session or started a second one

#### Scenario: `memory.doctor`'s description names both causes of the divergence

- **WHEN** an MCP client reads the `memory.doctor` description from a real `tools/list` response
- **THEN** it SHALL name both causes by which its counters diverge from `memory.stats`': the population, and — for the pending-judgment counter specifically — the adjudicability filter
- **AND** naming only the population SHALL NOT satisfy this scenario, because a reader who confirms both calls resolve to one project would then conclude a number is stale

#### Scenario: `memory.context` and `memory.search_prompts` publish no clamp receipt

- **GIVEN** every bounded numeric argument of both tools is rejected above its maximum by the declared input schema
- **WHEN** an MCP client reads each tool's `outputSchema` from `tools/list` and then calls it
- **THEN** neither `outputSchema`'s `required` list SHALL contain `clamped`, and neither returned `structuredContent` SHALL contain a `clamped` key
- **AND** this SHALL hold for a call with no arguments and for a call passing every bounded argument at its maximum

#### Scenario: `memory.doctor` publishes no field whose false value is unreachable

- **GIVEN** the report can only be produced on a request that already read the database to authenticate
- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the report SHALL NOT carry a `db.open` field, whose `false` value is reachable only in a state where the call cannot be served at all
- **AND** a database fault that does not prevent the call SHALL be reported through `warnings` and `db.integrity`, which do vary

#### Scenario: The over-max argument is rejected and the maximum itself is accepted

- **WHEN** each bounded numeric argument of `memory.context`, `memory.search_prompts` and `memory.timeline` is passed above its maximum, each in its own call
- **THEN** every such call SHALL be rejected as an invalid argument and SHALL NOT return a payload
- **AND** the same argument passed AT its maximum SHALL succeed — without that control a rejection cannot be distinguished from a broken probe

#### Scenario: Each description teaches every bound its tool enforces

- **WHEN** the descriptions of `memory.context`, `memory.search_prompts` and `memory.timeline` are read from a real `tools/list` response
- **THEN** each SHALL name the maximum of every bounded numeric argument it accepts
- **AND** each SHALL state that a value above a maximum is rejected rather than clamped
- **AND** none SHALL state that the response carries a flag reporting a clamp, nor list such a field in the response shape it advertises
- **AND** a CI test SHALL assert these substrings against the live `tools/list` string, so a reintroduction fails the build

#### Scenario: A newly found instance is closed by one of the three remedies

- **GIVEN** a tool is found whose description, `outputSchema` and payload do not agree
- **WHEN** the defect is addressed
- **THEN** the change SHALL classify it as one of the three failure modes and apply the corresponding remedy
- **AND** keeping the disagreement SHALL NOT satisfy this requirement, whether or not the description is partially corrected
- **AND** the closing change SHALL be recorded as a scenario of this requirement rather than as a new requirement, so the rule stays stated once

## MODIFIED Requirements

### Requirement: The `memory.get` tool MUST return the memory and its history

`memory.get` SHALL accept an `id` and SHALL return the memory's content, status, scope, project, tags, `topicKey`, `replaces`, a bounded predecessor projection derived from `replaces`, and the affirming-confirmation count for the current head. The predecessor projection is bounded and content-free — see the `memory` capability, "Supersedes-chain reads MUST be bounded and content-free"; the response SHALL carry `predecessorCount` and `truncated` so a caller can tell that more ancestry exists. The memory row SHALL NOT expose the internal `source` provenance blob (token name, agent, model), which is operator data surfaced on the dashboard and never returned to an agent.

For an `active` memory, the response SHALL additionally include the derived review metadata (see the `memory` capability): `reviewState` (`'fresh'` | `'needs_review'`), `reviewAfter` when non-null, and `reviewEscalated`. For non-`active` memories these fields SHALL be omitted.

`memory.get` SHALL additionally accept an OPTIONAL `ids` array as a back-compatible batch form. Exactly one of `id` or `ids` SHALL be supplied; supplying both, or neither, SHALL be an `invalid_input` error. When `id` is supplied, the response shape SHALL be unchanged from the single-memory form above. When `ids` is supplied, the response SHALL contain an ordered `memories` array — one per id that resolves to an in-scope, token-authorized memory, in the same order the ids were requested, each entry carrying the per-memory shape enumerated below — plus a `notFound` array listing the requested ids that did not resolve. The batch form SHALL be scope-enforced via a scoped service read: an id outside the connection's effective scope SHALL be reported in `notFound` and SHALL NOT leak the memory's content or existence, identically to how the single-`id` form treats an out-of-scope id as not found. The `ids` array SHALL be bounded by a maximum length; a request exceeding it SHALL be an `invalid_input` error.

A batch entry SHALL carry: the memory's own columns (`id`, `scope`, `projectId`, `type`, `title`, `content`, `tags`, `status`, `replaces`, `createdAt`, `topicKey`), `lastSeenAt`, the bounded `relations`/`relationsTotal` projection, the bounded `entities`/`entitiesTotal` projection, and the derived review metadata (`reviewState`, `reviewAfter`, `reviewEscalated`) on exactly the same terms as the single-`id` form — present for an `active` memory, omitted otherwise. The review metadata SHALL be derived in ONE batched lookup for the whole page rather than per row, matching how the search surface already derives it; a batch read SHALL NOT omit it, because `memory.context.needsReview` hands the agent a list of ids and the taught follow-up is a batch read, so an omission there tells the agent that nothing needs review.

The two forms differ deliberately in the following respects, and ONLY these. Each difference SHALL be enumerated here rather than implied by a parity claim, because a claim of identical shape that the payloads do not honour is undetectable by any scenario written against it:

- The single-`id` form dereferences ONE memory and advances its access signal, while the batch form is a pure read and advances nothing, so a bulk pull cannot reshuffle decay eligibility or context recency for every id it names (see the `memory` capability, "A dereferenced memory is treated as accessed").
- The single-`id` form carries the ancestry projection — `head`, `predecessors`, `predecessorCount`, `truncated`, `headTruncated` — and `confirmationCount`; the batch form SHALL NOT. Those are per-target walks, and performing one per id would turn a bulk read into N ancestry queries. A caller needing history for a specific row SHALL use the single-`id` form, and the `memory.get` description SHALL NOT promise ancestry on the batch form.
- `lastSeenAt` is carried by the batch form only. The single-`id` form advances the very signal it would be reporting, so the value it could return is the timestamp its own call just wrote — tautological rather than informative.

#### Scenario: Retrieve a merged memory

- **WHEN** an authenticated client calls `memory.get` with the id of a merged memory M
- **THEN** the response SHALL include M's content, M's predecessors as `{id, title, status, createdAt}` projections, and the confirmation count against M

#### Scenario: memory.get reports review state for an active memory

- **GIVEN** an `active` memory M whose derived `reviewState` is `'fresh'`
- **WHEN** an authenticated client calls `memory.get('M')`
- **THEN** the response SHALL include `reviewState: 'fresh'` and `reviewAfter` (the non-null derived timestamp for M's type)

#### Scenario: memory.get with a single id is unchanged

- **WHEN** an authenticated client calls `memory.get({ id: 'M' })` (no `ids`)
- **THEN** the response SHALL be the single-memory shape (memory, head, bounded predecessors, confirmationCount, relations, and review metadata when active)

#### Scenario: memory.get with ids returns an ordered batch

- **GIVEN** in-scope memories M1, M2, M3 all readable by the calling token
- **WHEN** an authenticated client calls `memory.get({ ids: ['M2', 'M1', 'M3'] })`
- **THEN** the response SHALL include `memories` ordered `[M2, M1, M3]`, each carrying the enumerated batch per-memory shape, and `notFound: []`

#### Scenario: The batch form advances no access signal

- **GIVEN** decay-eligible in-scope memories M1 and M2
- **WHEN** an authenticated client calls `memory.get({ ids: ['M1', 'M2'] })`
- **THEN** neither row's `last_seen_at` SHALL have been advanced, and both SHALL remain decay-eligible

#### Scenario: memory.get batch never leaks a cross-scope id

- **GIVEN** memory X exists in a DIFFERENT project than the connection's effective scope, and in-scope memory M1
- **WHEN** an authenticated client calls `memory.get({ ids: ['M1', 'X'] })`
- **THEN** the response `memories` SHALL contain only M1, and `X` SHALL appear in `notFound`
- **AND** the response SHALL NOT include X's content, title, or any field distinguishing "out of scope" from "does not exist"

#### Scenario: memory.get rejects ambiguous id arguments

- **WHEN** an authenticated client calls `memory.get` with BOTH `id` and `ids` set, or with NEITHER set
- **THEN** the server SHALL return an `invalid_input` error and SHALL NOT return any memory

#### Scenario: The batch form carries the review metadata, verified against the single form

- **GIVEN** one `active` in-scope memory M whose derived `reviewState` is `'needs_review'`
- **WHEN** an authenticated client calls `memory.get({ id: 'M' })` and `memory.get({ ids: ['M'] })` on the same connection, adjacent in time
- **THEN** both responses SHALL carry `reviewState`, `reviewAfter` and `reviewEscalated` for M, with equal values
- **AND** a `superseded` or `archived` id in the same batch SHALL carry none of the three, so the omission remains status-driven rather than form-driven
- **AND** the two calls SHALL be the control for each other: a test asserting only the batch form cannot distinguish a correct batch from a scope in which no row needs review

#### Scenario: The batch form carries `replaces`

- **GIVEN** an in-scope memory M that superseded a predecessor, so `M.replaces` is non-empty
- **WHEN** an authenticated client calls `memory.get({ ids: ['M'] })`
- **THEN** the entry for M SHALL carry `replaces` with the same value the single-`id` form returns for M
- **AND** the entry SHALL NOT carry `head`, `predecessors`, `predecessorCount`, `truncated`, `headTruncated` or `confirmationCount` — `replaces` is a column on the row, the ancestry projection is a walk

#### Scenario: `lastSeenAt` is a deliberate asymmetry, not a drift

- **WHEN** an authenticated client calls `memory.get({ ids: ['M'] })` and `memory.get({ id: 'M' })`
- **THEN** the batch entry SHALL carry `lastSeenAt` and the single-`id` response SHALL NOT
- **AND** the single-`id` call SHALL still advance M's access signal, which is why it does not report it

### Requirement: The MCP server MUST expose three session-lifecycle tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, and `memory.session_summary` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the sole state transition. This is a behaviour change from the prior contract where `memory.session_summary` ended the session as a side effect.

`memory.session_start` SHALL NOT always insert a row. When an `active` session already exists for the caller's `(tokenId, projectId)` on this transport — the ordinary case, because every supported host registers the session over HTTP before the agent runs — the call SHALL adopt that row instead of minting a second one, and SHALL report which of the two happened in a REQUIRED `reused` field: `true` when an existing row was adopted, `false` when a row was inserted. `reused` is the only signal distinguishing "you are now attached to the host's session" from "you just created a parallel session", which is the question a defensive `memory.session_start` call is asking. Its `outputSchema` SHALL mark it required, and the tool's description SHALL name it and state what `true` means (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"): a required field the description omits from a closed-form `Returns: { … }` list is undocumented surface on the one channel the model reads.

`memory.session_summary` SHALL validate `summary` against the single canonical cap exported from `apps/server/src/services/agent-sessions.ts` (`SUMMARY_MAX_CHARS`, currently `10000`). The MCP zod schema SHALL be `summary: z.string().min(1).max(SUMMARY_MAX_CHARS)` so overflow is rejected at the transport boundary with `invalid_input` before the tool body runs. The rejected agent SHALL receive an error whose message contains the decimal string of `SUMMARY_MAX_CHARS` so it can retry with a tighter body on the first attempt.

`memory.session_summary` and `memory.session_end` SHALL NOT reject a call because the resolved row is in a terminal state. `memory.session_summary` SHALL apply its summary/title write subject to the `final` precedence rules regardless of `status`; `memory.session_end` takes no summary/title arguments, so on a terminal row it SHALL be a pure no-op returning the existing `ended_at`. Neither SHALL mutate `status`, `ended_at` or `last_activity_at` on a terminal row — see the `sessions` capability, "Terminal session rows MUST accept late summary and title writes". `session_already_ended` SHALL NOT be a possible error code for either tool. This matters because the plugin's `PreCompact`, `SessionStart:compact` and `Stop` nudges instruct the agent to call `memory.session_summary`, and the stale-active retirement sweep can have flipped the row to `abandoned` (the documented steady state for two of the four clients) before the agent gets there.

`memory.session_end` clears the `SessionRouter` transport binding for `(tokenId, mcpSessionId)` ONLY when the row it resolved is not `abandoned`. Before terminal writes were admitted, `end()` threw on an `abandoned` row and the clear was unreachable, so the binding survived; clearing it now would drop every later `memory.save` on that transport to `session_id = NULL`. That prior behaviour SHALL be preserved: ending an `abandoned` row SHALL leave the binding intact, ending an `active` or `ended` row SHALL clear it.

Session resolution is unchanged and SHALL remain status-aware where it already is: `memory.session_summary` resolves its target from an explicit `sessionId`, else the transport's `SessionRouter` entry, else the unambiguous `active` session for the caller's `(token_id, project_id)`. The third source SHALL continue to consider only `active` rows, so an agent that supplies neither an explicit id nor a router-mapped session SHALL receive `session_not_found` rather than having its write attached to a closed session picked by recency.

#### Scenario: `memory.session_start` opens a new session

- **WHEN** an MCP client calls `memory.session_start` with `{ agent?: string, description?: string }`
- **THEN** the server SHALL insert a `sessions` row with `status = 'active'`, `started_at = now`, the provided `agent` (or `'unknown'`), `token_id` from the request context, `project_id` from the request scope, and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` with `title_final = false`; **AND** the response SHALL be `{ sessionId, scope, projectId, startedAt, title, reused }`

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

- **WHEN** any of the three tools is called with a `sessionId` whose `token_id` does not match the caller's token
- **THEN** the call SHALL be rejected with code `session_not_found` (never `forbidden`, to avoid information disclosure)

#### Scenario: A second `memory.session_start` adopts the first session and says so

- **GIVEN** a connection with no active session for its `(tokenId, projectId)`
- **WHEN** an MCP client calls `memory.session_start` twice in a row on that connection
- **THEN** the first response SHALL carry `reused: false` and the second SHALL carry `reused: true`
- **AND** both responses SHALL carry the SAME `sessionId` — the second call SHALL NOT insert a second `sessions` row
- **AND** the `sessions` row count for that `(tokenId, projectId)` SHALL be 1 after both calls, which is the control that `reused: true` describes adoption rather than a coincidence of ids

#### Scenario: `memory.session_start`'s description names every required output field

- **WHEN** an MCP client retrieves the tool description for `memory.session_start` via `tools/list`
- **THEN** the description's `Returns:` enumeration SHALL name every field its `outputSchema` marks required, including `title` and `reused`
- **AND** the description SHALL state that `reused: true` means the call adopted the host's already-active session rather than starting one
- **AND** a CI test SHALL compare the description against the `outputSchema`'s required list, so a field added to the schema without a description update fails the build

### Requirement: The MCP server MUST expose two observability tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.doctor` and `memory.stats`. Both output contracts SHALL enumerate exactly the fields the tools return: a documented field the tool does not return misleads a client into treating its absence as a fault, and a returned field the contract omits is undocumented surface (the two counters added for queue-depth observability were both in the second category).

The `db` block SHALL NOT carry an `open` flag. Producing the report requires a database read to authenticate the request, so a report that exists is proof the database was open, and the flag's `false` value is reachable only in a state where the tool returns no report at all — the unreachable-state defect (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). Database trouble that does NOT prevent the call SHALL continue to be reported where it varies: `integrity` from the integrity check, and `warnings` for a pragma read that failed. **BREAKING** on the published output contract, accepted because a field with one reachable value cannot be depended upon for anything.

#### Scenario: `memory.doctor` returns an operational report

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the server SHALL return `{ db: { journalMode, integrity, sizeBytes }, embeddings: { model, backlog }, entities: { backlog }, consolidation: { lastRunAt, lastRunOps }, sessions: { active }, review: { needsReview, pendingJudgments }, warnings: string[] }` — the report SHALL NOT contain an `llm` block, and the `embeddings` block SHALL NOT contain `enabled` (embeddings are always on); `model` SHALL identify the compiled-in embedding model
- **AND** `entities.backlog` and `review` SHALL be server-wide, matching `sessions.active`

#### Scenario: `memory.stats` returns counters by scope and status

- **WHEN** an MCP client calls `memory.stats`
- **THEN** the server SHALL return `{ scope, memoriesByStatus, memoriesByType, sessionsByStatus, needsReviewTotal, pendingJudgmentsTotal }`, where `scope` is the resolved scope label, the three `*By*` values are each a `Record<string, number>`, and the two totals are numbers — every one of them computed against the request context

#### Scenario: A read-only token calls `memory.doctor` or `memory.stats`

- **WHEN** the caller's scope is `read:*`, or is `read:project:<id>` and the connection's effective scope resolves to that same project
- **THEN** both tools SHALL succeed (they are read-only by design)
- **WHEN** the caller's scope is `read:project:<id>` and the connection's effective scope resolves to global or to a different project
- **THEN** the call SHALL be rejected with code `forbidden`

#### Scenario: The report carries no `db.open` flag

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the `db` block SHALL contain `journalMode`, `integrity` and `sizeBytes` and SHALL NOT contain `open`
- **AND** the declared `outputSchema` SHALL NOT mark `open` required, nor declare it at all

#### Scenario: A database fault that still permits the call is reported where it varies

- **GIVEN** a database whose pragma reads fail while the connection still authenticates the request
- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the call SHALL succeed, `warnings` SHALL name the failed pragma read, and `integrity` SHALL report `unknown` rather than `ok`
- **AND** no field SHALL claim the database is healthy

### Requirement: The observability tool descriptions MUST disclose which population their counters cover

`memory.doctor` and `memory.stats` return counters under colliding names over two different populations: doctor's are server-wide (all projects plus global), stats' are resolved against the request context. `memory.stats` carries a top-level `scope` field and `memory.doctor` carries none, but a client SHALL NOT be expected to infer one tool's semantics from the ABSENCE of a field in another. The counters therefore differ in value with nothing on the wire to explain it, and two readers of this codebase have already drawn a wrong conclusion from the collision. The tool description is the surface the model reads before deciding to call, so the disclosure belongs there.

`memory.doctor`'s registered description SHALL:

- state that the report is SERVER-WIDE, covering all projects and the global scope;
- state that `memory.stats` carries the scoped equivalents and that the two sets of numbers WILL differ, so a mismatch reads as intent rather than as one of them being stale;
- name EVERY cause of that divergence, not only the population. `review.needsReview` diverges from `memory.stats`' `needsReviewTotal` by population alone, but `review.pendingJudgments` diverges by population AND by filtering: doctor's counter is an unfiltered count of pending rows while the scoped totals count only ADJUDICABLE pairs, both endpoints still `active` (see the `memory` capability, "that field SHALL remain an unfiltered count of pending rows"). Naming only the population is worse than naming no cause, because a reader who verifies that both calls resolve to one project — where the population cannot explain anything — is left concluding that one of the two numbers is stale. The divergence is measurable inside a single project: archiving one endpoint of a pending pair drops the scoped totals and leaves doctor's count unchanged;
- name the blocks the report actually returns, including `entities`, `sessions` and `review`, the three the description omitted before this requirement existed;
- NOT advertise an `llm` block or any other field the output contract forbids (see "The MCP server MUST expose two observability tools", which requires the report to contain no `llm` block). A description that promises a field the tool cannot return misleads a client into treating its absence as a fault — the same hazard that requirement addresses for the output contract, on the surface the model actually reads.

`memory.stats`' registered description SHALL name `needsReviewTotal` and `pendingJudgmentsTotal` among its counters, and SHALL state that `memory.doctor` reports same-named counters server-wide so its numbers will differ. Naming the two totals is load-bearing rather than cosmetic: `memory.doctor`'s disclosure directs the reader to `memory.stats` for the scoped equivalents, and that direction is useless if `memory.stats`' own description never mentions the fields it names.

These disclosures SHALL be expressed in each tool's top-level description text and SHALL NOT be expressed only in a zod `describe()` on the input or output schema, which some clients do not surface to the model — consistent with the identical constraint already placed on `memory.archive` and on the `sessionId` argument.

Both descriptions SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"); if a clause does not fit, prose SHALL be cut from the description rather than the constant raised. Because client truncation is a tail cut, the server-wide disclosure SHALL NOT be the trailing clause of `memory.doctor`'s description.

This requirement constrains description prose only. It SHALL NOT be read as re-scoping any counter: `memory.doctor`'s `sessions.active`, `entities.backlog` and `review` counters remain server-wide as already specified, and satisfying it SHALL NOT add, remove or rename a field on either payload.

#### Scenario: `memory.doctor`'s description discloses the server-wide population and its scoped counterpart

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL convey that the report is server-wide across all projects and the global scope
- **AND** the description SHALL name `memory.stats` as the source of the scoped equivalents and SHALL convey that the two will differ
- **AND** the description SHALL name `entities`, `sessions` and `review` among the blocks returned

#### Scenario: `memory.doctor`'s description does not advertise the removed `llm` block

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL NOT contain the substring `LLM` in any letter case
- **AND** a `memory.doctor` call in the same session SHALL return a payload for which `'llm' in payload` is `false`, so the description and the payload agree

#### Scenario: `memory.stats`' description names its queue-depth totals and the divergence

- **WHEN** an MCP client retrieves the tool description for `memory.stats` via `tools/list`
- **THEN** the description SHALL name `needsReviewTotal` and `pendingJudgmentsTotal`
- **AND** the description SHALL still convey that its counters are scoped to the active project or global
- **AND** the description SHALL convey that `memory.doctor`'s same-named counters are server-wide and will differ

#### Scenario: The disclosures live in the top-level description, not a schema `describe()`

- **WHEN** the registered descriptions and schemas for `memory.doctor` and `memory.stats` are inspected
- **THEN** every disclosure this requirement mandates SHALL be present in the string returned as each tool's `description` by `tools/list`
- **AND** neither tool's presence in `tools/list` SHALL depend on a `describe()` call on `doctorOutput` or `statsOutput` to satisfy this requirement

#### Scenario: Both rewritten descriptions stay inside the truncation cap

- **WHEN** an MCP client issues `tools/list` against the server
- **THEN** the descriptions of `memory.doctor` and `memory.stats` SHALL each be at most `DESCRIPTION_MAX_LENGTH` characters measured as `String.length`
- **AND** `memory.doctor`'s server-wide disclosure SHALL appear before its closing usage guidance, so a tail truncation removes the usage hint rather than the disclosure

#### Scenario: The disclosure does not change any counter's value

- **GIVEN** a scope holding one adjudicable pending pair and three pairs with a retired endpoint
- **WHEN** `memory.doctor` and `memory.stats` are both called from a connection resolving to that scope
- **THEN** `memory.doctor`'s `review.pendingJudgments` SHALL remain the unfiltered server-wide count and `memory.stats`' `pendingJudgmentsTotal` SHALL remain 1, exactly as before this change

#### Scenario: `memory.doctor`'s description names the filter as well as the population

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL convey that `pendingJudgments` is an unfiltered count of pending rows while the scoped totals count only adjudicable pairs
- **AND** it SHALL remain true that the description also conveys the server-wide population, which explains the `sessions`, `entities` and `needsReview` divergences

#### Scenario: The named causes account for a divergence inside one project

- **GIVEN** a single project holding one pending pair, and both tools called from a connection resolving to that project
- **WHEN** one endpoint of the pair is archived and both tools are called again
- **THEN** `memory.doctor`'s `review.pendingJudgments` SHALL still report 1 while `memory.stats`' `pendingJudgmentsTotal` SHALL report 0
- **AND** the `memory.doctor` description SHALL contain a cause that accounts for that difference, since the population cannot: both calls resolved to the same project

### Requirement: Session-lifecycle MCP tools MUST reject soft-deleted sessions

`memory.session_end` and `memory.session_summary` SHALL resolve the target row before performing any state transition. When the resolved row has `deleted_at IS NOT NULL`, the call SHALL be rejected with a structured MCP error containing `code: 'session_deleted'` and a message naming the deleted-at timestamp. No state mutation SHALL be performed. The cross-token check that already protects these calls SHALL continue to run first; only when the cross-token check passes does the `session_deleted` gate apply.

`memory.session_start` is unaffected: it never resolves an existing row by id, and the row it may adopt is found by an active-session lookup that excludes soft-deleted rows, so it can neither target nor revive a deleted session. It does NOT always insert a new row — see "The MCP server MUST expose three session-lifecycle tools", which specifies the adoption path and its `reused` flag — and this requirement SHALL NOT be read as promising that it does.

#### Scenario: memory.session_end targets a soft-deleted session

- **GIVEN** a Rembric session `<S>` whose `deleted_at` is non-null, owned by token `<T>`
- **WHEN** an MCP client authenticated as `<T>` calls `memory.session_end` with `sessionId = <S>`
- **THEN** the response SHALL be an MCP error containing `code: 'session_deleted'` and a message naming the deleted-at timestamp
- **AND** no column on the row SHALL be mutated

#### Scenario: memory.session_summary targets a soft-deleted session

- **GIVEN** a Rembric session `<S>` whose `deleted_at` is non-null, owned by token `<T>`
- **WHEN** an MCP client authenticated as `<T>` calls `memory.session_summary` with `sessionId = <S>` and a non-empty summary
- **THEN** the response SHALL be an MCP error containing `code: 'session_deleted'`
- **AND** the row's `summary` column SHALL remain unchanged

#### Scenario: Cross-token check still runs before the deleted gate

- **GIVEN** a Rembric session `<S>` owned by token `<T1>`, soft-deleted
- **WHEN** an MCP client authenticated as a different token `<T2>` calls `memory.session_end` on `<S>`
- **THEN** the response SHALL be an MCP error with the cross-token mask `session_not_found`, NOT `session_deleted` — the mask never reveals that a session with that id exists under another token, matching "A session-lifecycle tool targets a session owned by a different token" above

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

Both of `memory.context`'s queue channels SHALL be returned with the scoped TOTAL of the queue they page, because a page whose depth is invisible cannot be told from an exhausted queue. `needsReview` has carried `needsReviewTotal` since it was introduced; `pendingJudgments` SHALL carry `pendingJudgmentsTotal` on the same terms.

Both of those pending channels SHALL be restricted to ADJUDICABLE pairs — a pending relation whose source AND target are both `status = 'active'` (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired"). The list and the total SHALL apply that restriction identically, so the total remains the depth of the queue the list pages rather than a depth the list can never reach.

`memory.context`'s four size arguments are bounded by its declared input schema — `sessions` 25, `prompts` 50, `memories` 100, `judgments` 50 — and a value above a maximum SHALL be REJECTED as an invalid argument rather than silently clamped, consistent with every other numeric bound on this surface (see "`memory.search` and `memory.get` MUST expose the annotation bound and its true total"). Because no clamping can occur over the transport, the response SHALL NOT carry a field reporting that an argument was clamped (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). The handler MAY retain an in-process clamp as a defensive bound for a future direct caller that bypasses the input schema; such a clamp is unobservable over the transport and SHALL NOT be reported in the response.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, judgments?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ scope, recentSessions, recentPrompts, recentMemories, relevantMemories, pendingJudgments, pendingJudgmentsTotal, needsReview, needsReviewTotal }` — where `scope` is the resolved scope label, as on `memory.stats` — plus `rankedPass` when the ranked pass executed (see "`memory.context` MUST offer a relevance channel alongside recency"), with each list scoped to the request context (global vs path-scoped project)
- **AND** when a size argument is omitted the default SHALL be `sessions = 3`, `memories = 10`, `prompts = 5`, `judgments = 5` (kept small because the snapshot is read every session start; callers needing more pass explicit args, still bounded by the maxima below)
- **AND** `recentSessions` SHALL contain only sessions that satisfy the `sessionHasContent` predicate (see `sessions` capability), ordered by `started_at DESC`, with empty sessions filtered out BEFORE truncation to `sessions ?? 3`
- **AND** `recentPrompts` SHALL be ordered by `created_at DESC` and filtered to `deleted_at IS NULL`
- **AND** `recentMemories` SHALL be ordered by `COALESCE(last_seen_at, created_at) DESC` — activity recency, falling back to creation for a row never dereferenced, which is most rows given that search does not touch — with `includeArchived = false` (default) filtering out `status = 'archived'` rows
- **AND** `pendingJudgments` SHALL contain at most `judgments ?? 5` adjudicable pending relations in scope — both endpoints `status = 'active'` — oldest first, each entry carrying `{ judgmentId, sourceId, targetId, sourceSnippet, targetSnippet, ageMs }` so the agent can close them with `memory.judge` without further reads; when `judgments` is OMITTED the list SHALL be further filtered to `created_at < (now - JUDGMENT_ORPHAN_AFTER_MS)`, and when `judgments` is PRESENT that age filter SHALL NOT be applied
- **AND** `pendingJudgmentsTotal` SHALL be the count of every adjudicable pending relation in scope — un-aged ones included, and independent of `judgments` — never the returned list's length, which is the page size and therefore exactly the misleading number the field exists to correct. A pending relation excluded from the list because an endpoint is retired SHALL be excluded from the total on the same terms; the age filter is the ONLY divergence permitted between the two
- **AND** `needsReview` SHALL contain at most 3 `active` in-scope memories whose derived `reviewState = 'needs_review'` (see the `memory` capability), ordered recently-refuted first and then oldest `reviewBaseline` first (see the `memory` capability, "A refutation MUST lead the review queue only while it is recent"), each entry carrying `{ id, type, snippet, reviewAfter, ageMs }` (where `snippet` uses the same per-row cap as the other context lists, `ageMs = now - reviewBaseline` the time since last affirmation) so the agent can re-affirm with `memory.confirm`, supersede with `memory.save` + `topic_key`, or — when it contradicts another memory — fall through to the existing `memory.judge` flow. The list is kept small by COUNT (only the 3 oldest) because it is recurring (every `memory.context`) and usually populated

#### Scenario: `pendingJudgmentsTotal` reports the queue, not the page

- **GIVEN** a scope holding more aged pending relations with two `active` endpoints than the default page size
- **WHEN** an MCP client calls `memory.context` with no `judgments` argument
- **THEN** `pendingJudgments` SHALL hold 5 entries and `pendingJudgmentsTotal` SHALL be the full in-scope ADJUDICABLE pending count, strictly greater than 5

#### Scenario: `pendingJudgmentsTotal` counts the un-aged pairs the default list hides

- **GIVEN** one aged pending relation and two pending relations younger than `JUDGMENT_ORPHAN_AFTER_MS`, all in scope
- **WHEN** an MCP client calls `memory.context` with no `judgments` argument
- **THEN** `pendingJudgments` SHALL hold only the aged entry and `pendingJudgmentsTotal` SHALL be 3 — the total is a queue depth, not a description of the list beside it

#### Scenario: `pendingJudgmentsTotal` respects scope

- **GIVEN** a pending relation whose memories belong to project B
- **WHEN** an MCP client scoped to project A (or the global endpoint) calls `memory.context`
- **THEN** `pendingJudgmentsTotal` SHALL NOT count it

#### Scenario: `needsReview` is unary and disjoint from `pendingJudgments`

- **GIVEN** a scope containing one `active` memory past its review shelf life AND one aged pending relation between two other memories
- **WHEN** an MCP client calls `memory.context`
- **THEN** the stale single memory SHALL appear only in `needsReview` (carrying `id`, not `sourceId`/`targetId`) and the aged relation SHALL appear only in `pendingJudgments` — no entry SHALL appear in both lists

#### Scenario: `needsReview` respects scope

- **GIVEN** an `active` memory past its review shelf life that belongs to project B
- **WHEN** an MCP client calls `memory.context` on a connection scoped to project A (or the global endpoint)
- **THEN** that memory SHALL NOT appear in `needsReview`

#### Scenario: `needsReview` excludes non-active and within-shelf-life memories

- **GIVEN** in scope: an `archived` memory past its shelf life, and an `active` memory still within its shelf life
- **WHEN** an MCP client calls `memory.context`
- **THEN** neither SHALL appear in `needsReview`

#### Scenario: `memory.context` default sizes when size args are omitted

- **GIVEN** a scope with more than 10 active memories, more than 5 non-deleted prompts, and more than 3 content-bearing sessions
- **WHEN** an MCP client calls `memory.context` with no size arguments
- **THEN** `recentMemories` SHALL contain at most 10 rows, `recentPrompts` at most 5, and `recentSessions` at most 3
- **AND** the response SHALL contain no clamp-reporting field — the defaults are inside every maximum, and no admissible argument value can produce clamping

#### Scenario: `memory.context.recentSessions` backfills past empty sessions

- **GIVEN** the active scope contains, in `started_at` order from newest to oldest, three empty sessions and one useful session
- **WHEN** an MCP client calls `memory.context({sessions: 1})`
- **THEN** the response's `recentSessions` array SHALL have length 1 and SHALL contain only the useful session — the three newer empty sessions SHALL NOT consume the slot

#### Scenario: `memory.context.recentSessions` excludes soft-deleted sessions

- **GIVEN** a session that has content AND is soft-deleted (`deleted_at IS NOT NULL`)
- **WHEN** an MCP client calls `memory.context`
- **THEN** the row SHALL NOT appear in `recentSessions` — the soft-delete filter and the content filter both apply

#### Scenario: `memory.context` arguments exceed clamps

The title predates the behaviour: nothing is clamped, and the scenario pins the rejection that happens instead.

- **WHEN** the caller passes `sessions: 26`, `prompts: 51`, `memories: 101`, or `judgments: 51`, each in its own call
- **THEN** each call SHALL be rejected as an invalid argument and SHALL NOT return a context payload
- **AND** the same argument AT its maximum — `sessions: 25`, `prompts: 50`, `memories: 100`, `judgments: 50` — SHALL succeed, which is the control that distinguishes a real rejection from a broken probe
- **AND** all four arguments SHALL be bounded on identical terms; `judgments` SHALL NOT introduce a different layering from its three siblings
- **AND** a `judgments` value at or below 50 that exceeds the number of pending relations in scope SHALL return every one that exists — asking for more than the queue holds is not an error
- **AND** no response SHALL carry a field reporting that any argument was clamped

#### Scenario: `memory.context` excludes soft-deleted prompts

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** an MCP client calls `memory.context`
- **THEN** `recentPrompts` SHALL include `P1` and SHALL NOT include `P2`

#### Scenario: `memory.context` exposes only aged pendings by default, never fresh ones

- **GIVEN** a pending relation younger than `JUDGMENT_ORPHAN_AFTER_MS` and another older than it, both in scope
- **WHEN** an MCP client calls `memory.context` with no `judgments` argument
- **THEN** `pendingJudgments` SHALL include only the aged one — fresh pendings belong to the session that created them, and the default channel is a queue-depth warning rather than an inventory

#### Scenario: An explicit `judgments` size lifts the age filter

- **GIVEN** the same pair of pending relations, one aged and one fresh
- **WHEN** an MCP client calls `memory.context` with `{ judgments: 10 }`
- **THEN** `pendingJudgments` SHALL include BOTH, oldest first — asking for a size is the caller asking for inventory, and inventory that hides most of itself is not inventory
- **AND** the un-aged entry SHALL carry the same `{ judgmentId, sourceId, targetId, sourceTitle, targetTitle, sourceSnippet, targetSnippet, ageMs }` shape as an aged one, so it can be judged straight from the response
- **AND** no separate `includeUnaged` argument SHALL exist: a size present or absent is the only knob, so the fourth combination (unaged without a bound) is unreachable by construction

#### Scenario: An un-aged pending pair is reachable at all

- **GIVEN** a pending relation created moments ago, whose originating `memory.save` response is no longer available to the caller
- **WHEN** an MCP client calls `memory.context` with a `judgments` size
- **THEN** the pair's `judgmentId` SHALL be returned, so `memory.judge` can close it — without this the pair is unreachable from every MCP surface until `JUDGMENT_ORPHAN_AFTER_MS` elapses, since `memory.judge` accepts only a `judgmentId` and `memory.compare` requires both memory ids up front and so cannot discover a pair

#### Scenario: `memory.context.pendingJudgments` respects scope

- **GIVEN** an aged pending relation whose memories belong to project B
- **WHEN** an MCP client scoped to project A calls `memory.context`
- **THEN** `pendingJudgments` SHALL NOT include it, with or without a `judgments` size

#### Scenario: A `topic_key` revision does not evict the live pending from the page

- **GIVEN** memory A saved with `topic_key = 't'` carrying five aged pending relations, then memory B saved with the same `topic_key` (so A becomes `superseded` and B is `active`), carrying one aged pending relation that is newer than all five
- **WHEN** an MCP client calls `memory.context` with no `judgments` argument
- **THEN** `pendingJudgments` SHALL hold exactly the one pair whose source is B, and `pendingJudgmentsTotal` SHALL be 1 — A's five pairs SHALL neither appear on the page nor raise the total, even though they are the five oldest rows and the page holds five entries

#### Scenario: A retired target is withheld on the same terms as a retired source

- **GIVEN** an aged pending relation whose source is `active` and whose target has been archived
- **WHEN** an MCP client calls `memory.context`
- **THEN** the pair SHALL NOT appear in `pendingJudgments` and SHALL NOT be counted in `pendingJudgmentsTotal`

#### Scenario: An explicit `judgments` size does not readmit retired pairs

- **GIVEN** one adjudicable pending relation and three pending relations with a retired endpoint, all in scope, all created moments ago
- **WHEN** an MCP client calls `memory.context` with `{ judgments: 50 }`
- **THEN** `pendingJudgments` SHALL hold exactly the adjudicable pair and `pendingJudgmentsTotal` SHALL be 1 — a size argument lifts the AGE filter only, so an inventory request cannot surface a pair the default channel withholds for a different reason

#### Scenario: `memory.context`'s description advertises the total and the size

- **WHEN** an MCP client retrieves the tool description for `memory.context` via `tools/list`
- **THEN** the description SHALL name `pendingJudgmentsTotal` and the `judgments` argument, and SHALL state that passing a size lifts the age filter — a caller cannot guess that a size argument changes which rows qualify
- **AND** the description SHALL name the maximum of EACH of the four size arguments — `sessions` 25, `prompts` 50, `memories` 100, `judgments` 50 — and SHALL state that a value above a maximum is rejected rather than clamped. Declaring a maximum only as an input-schema `maximum` keyword SHALL NOT satisfy this clause, since some clients do not surface per-property schema descriptions to the model, leaving the tool rejecting a bound it never taught
- **AND** the description SHALL NOT state that the response carries a flag reporting a clamp
- **AND** the description SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling"); if the clause does not fit, prose SHALL be cut from the description rather than the constant raised

#### Scenario: `memory.timeline` returns chronological neighbors within a session

- **WHEN** an MCP client calls `memory.timeline` with `{ memoryId, before?: 5, after?: 5 }` and the target memory has a non-null `session_id`
- **THEN** the server SHALL return up to `before` memories with `created_at < target.created_at` and `session_id = target.session_id`, plus up to `after` memories with `created_at > target.created_at` and `session_id = target.session_id`, ordered chronologically

#### Scenario: `memory.timeline` falls back when the target has no session

- **WHEN** the target memory has `session_id = NULL`
- **THEN** the server SHALL return neighbors selected by `created_at` within ±2 hours of the target's `created_at`, scoped to the same `(scope, project_id)`, and the response SHALL include `fallback: 'time_window'`

#### Scenario: `memory.timeline`'s description names its arguments and its bound

- **WHEN** an MCP client retrieves the tool description for `memory.timeline` via `tools/list`
- **THEN** the description SHALL name the `before` and `after` arguments and their defaults, SHALL state that their SUM may not exceed the combined maximum, and SHALL state that a larger window is rejected rather than clamped
- **AND** it SHALL name the remedy the handler's own error message already names — a wider window is served by `memory.search` — so the description and the error agree
- **AND** a tool whose handler rejects a bound its description never mentions SHALL be treated as a defect (see "A tool's description and its response MUST agree, and neither may promise an unreachable state")

#### Scenario: `memory.timeline` combined window exceeds 50

- **WHEN** `before + after > 50`
- **THEN** the call SHALL be rejected with code `invalid_input` and a message referring the caller to `memory.search`

#### Scenario: `memory.capture_passive` extracts numbered learnings

- **WHEN** an MCP client calls `memory.capture_passive` with `{ text: string, sessionId?: string }` and `text` contains a section starting with `^## Key Learnings:\s*$`
- **THEN** the server SHALL extract each subsequent numbered (`1.`, `2.`) or bulleted (`-`, `*`) item, save each as a separate memory with `type = 'reference'` (there is no `discovery` type) and the active scope, and SHALL return `{ saved: number, ids: string[] }` plus the aggregated `candidates[]` when the saves detected any

#### Scenario: `memory.capture_passive` finds no learnings block

- **WHEN** the input text has no matching `## Key Learnings:` heading
- **THEN** the server SHALL return `{ saved: 0, ids: [] }` with an explicit `reason` naming the expected heading form (see "`memory.capture_passive` MUST NOT report success when it extracted nothing") and SHALL NOT error

### Requirement: The MCP server MUST expose `memory.search_prompts`

The `/mcp` and `/mcp/<slug>` endpoints SHALL register a new MCP tool `memory.search_prompts` that returns curated prompts matching a query and/or structured filters, scope-resolved through the existing `scopeFromContext` helper.

Input schema:

- `query?: string` — free-text query; when provided, the server SHALL sanitize it (the same sanitizer used by `memory.search`'s hybrid retrieval — see the `memory` capability) and use the `prompts_fts` virtual table via `MATCH` against `content + tags`. A query that sanitizes to nothing (e.g. pure punctuation) SHALL be treated as no query (recency fallback) rather than raising an error.
- `sessionId?: string` — restrict to prompts whose `session_id = <sessionId>`.
- `agent?: string` — restrict to prompts whose `agent = <agent>`.
- `includeDeleted?: boolean` — default `false`; when `true`, soft-deleted prompts SHALL be included.
- `limit?: number` — default `25`, bounded to `[1, 100]` by the declared input schema. A value outside that range SHALL be REJECTED as an invalid argument rather than clamped.
- `offset?: number` — default `0`.

Response shape:

```json
{
  "scope": "project:<id>" | "global",
  "prompts": [
    {
      "id": "<ulid>",
      "content": "<full content>",
      "title": "<title or null>",
      "tags": ["<tag>", ...] | null,
      "sessionId": "<id or null>",
      "projectId": "<id or null>",
      "agent": "<agent or null>",
      "replaces": ["<predecessorId>", ...] | null,
      "deletedAt": "<iso timestamp or null>",
      "createdAt": "<iso timestamp>"
    }
  ],
  "total": <count>
}
```

The tool SHALL resolve effective project via the existing `scopeFromContext` precedence (path-scoped `ctx.project` → `SessionRouter` pin → global). It SHALL NOT leak prompts from any other scope.

Because the input schema's bound exactly brackets the service's own range, no clamping can occur over the transport, and the response SHALL NOT carry a field reporting that `limit` was clamped (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). The service MAY retain an in-process clamp over the same range as a defensive bound for a direct caller; it is unobservable over the transport and SHALL NOT be reported in the response. The tool's description SHALL name `limit`'s default and its maximum and SHALL state that a larger value is rejected rather than clamped — a rejection the caller was not told how to avoid is not a safe bound.

#### Scenario: `memory.search_prompts` returns FTS5 matches scoped to the active project

- **GIVEN** a token connected to `/mcp/foo` and a project `foo` with prompts containing "deploy via Docker" and "refactor auth"
- **WHEN** the agent calls `memory.search_prompts({ query: "deploy" })`
- **THEN** the response SHALL include exactly the prompt whose content matches "deploy"
- **AND** the response `scope` SHALL be `project:<foo.id>`

#### Scenario: `memory.search_prompts` honours session and agent filters

- **GIVEN** prompts P1 (`session_id=S1, agent=claude-code`), P2 (`session_id=S1, agent=codex`), P3 (`session_id=S2, agent=claude-code`)
- **WHEN** the agent calls `memory.search_prompts({ sessionId: "<S1>", agent: "claude-code" })`
- **THEN** the response SHALL include only `P1`

#### Scenario: `memory.search_prompts` excludes soft-deleted prompts by default

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** the agent calls `memory.search_prompts({})` (no `includeDeleted` flag)
- **THEN** the response SHALL include only `P1`

#### Scenario: `memory.search_prompts` includes soft-deleted prompts when explicitly requested

- **GIVEN** prompts P1 and P2 in scope where `P2.deleted_at IS NOT NULL`
- **WHEN** the agent calls `memory.search_prompts({ includeDeleted: true })`
- **THEN** the response SHALL include both `P1` and `P2`

#### Scenario: `memory.search_prompts` clamps limit and reports it

The title predates the behaviour: `limit` is NOT clamped and nothing is reported, and the scenario pins the rejection that happens instead.

- **WHEN** the caller passes `limit: 500`
- **THEN** the call SHALL be rejected as an invalid argument and SHALL NOT return a prompt page
- **AND** `limit: 0` SHALL be rejected on the same terms — the bound is two-sided
- **AND** `limit: 100` SHALL succeed, which is the control that makes the rejection a finding rather than a broken probe, and proves the bound the description teaches is usable
- **AND** no response SHALL carry a field reporting that `limit` was clamped

#### Scenario: `memory.search_prompts`' description teaches its bound

- **WHEN** an MCP client retrieves the tool description for `memory.search_prompts` via `tools/list`
- **THEN** the description SHALL state `limit`'s default and its maximum, and that a larger value is rejected rather than clamped
- **AND** the response shape the description advertises SHALL NOT list a clamp-reporting field
- **AND** the description SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling")

#### Scenario: `memory.search_prompts` from a path-scoped connection rejects cross-scope leakage

- **GIVEN** a token connected to `/mcp/foo` AND a prompt belonging to project `bar`
- **WHEN** the agent calls `memory.search_prompts({ query: "anything matching bar" })`
- **THEN** the `bar` prompt SHALL NOT appear in the response

#### Scenario: `memory.search_prompts` does not raise an FTS5 syntax error on ordinary punctuation

- **GIVEN** a prompt in scope with content `"what's the deploy plan?"`
- **WHEN** the agent calls `memory.search_prompts({ query: "what's the deploy plan?" })`
- **THEN** the call SHALL succeed and SHALL NOT raise an FTS5 syntax error
- **AND** the response SHALL include the matching prompt

#### Scenario: A query that sanitizes to nothing falls back to recency

- **WHEN** the agent calls `memory.search_prompts({ query: "??? !!!" })`
- **THEN** the call SHALL succeed and return the most recent in-scope prompts, as if no query had been given
