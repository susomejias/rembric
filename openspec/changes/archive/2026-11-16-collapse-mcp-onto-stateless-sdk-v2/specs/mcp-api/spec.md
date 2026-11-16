## MODIFIED Requirements

### Requirement: The MCP endpoint MUST use Streamable HTTP transport

The server SHALL expose the Model Context Protocol over the Streamable HTTP transport at `/mcp` and `/mcp/<slug>` through one `createMcpHandler` from `@modelcontextprotocol/server`, in its default stateless posture. That single handler SHALL serve both the 2025 protocol family and the `2026-07-28` revision from the same tool-server factory: each request SHALL be answered by a server built for that request, and no per-connection state SHALL be kept between requests. A `2026-07-28` request SHALL be served, not refused with `-32022`. `@modelcontextprotocol/sdk` SHALL NOT serve any MCP request. The legacy SSE transport SHALL NOT be exposed.

The server SHALL NOT mint an `Mcp-Session-Id` header, and SHALL NOT require one on any request. `GET` and `DELETE` on the MCP endpoint SHALL be answered with HTTP `405`: there is no standalone server→client stream to open and no protocol session to tear down.

#### Scenario: Client initiates a session

- **WHEN** an MCP client sends `initialize` with a 2025 `protocolVersion` to `/mcp` using the Streamable HTTP transport
- **THEN** the server SHALL respond with a valid initialize result advertising the registered tools
- **AND** the response SHALL NOT carry an `Mcp-Session-Id` header
- **AND** a subsequent `tools/call` from the same client, sent without an `Mcp-Session-Id` header, SHALL be served

#### Scenario: A 2026-07-28 client discovers the server

- **WHEN** an MCP client sends `server/discover` with protocol version `2026-07-28` to `/mcp`
- **THEN** the server SHALL answer with a successful JSON-RPC result, not an HTTP 500 and not a `-32022` error
- **AND** a `tools/list` sent by that client SHALL list the same tools a 2025 client receives

#### Scenario: GET and DELETE are not served

- **WHEN** an authenticated client sends `GET` or `DELETE` to `/mcp` or `/mcp/<slug>`
- **THEN** the server SHALL answer with HTTP `405`
- **AND** no event stream SHALL be opened and no server state SHALL be created or removed

### Requirement: Path-scoped connections MUST enforce strict project isolation

When the MCP connection is path-scoped (`/mcp/<slug>`) the server SHALL enforce a hard isolation contract on every tool call. The connection's project is the only scope the server chooses on the caller's behalf:

- `memory.save` SHALL be persisted with `project_id` equal to the path-bound project regardless of any other argument the agent supplies. There is no argument by which an agent can name a different destination: `memory.save` accepts no `scope` argument, so the destination is determined entirely by the connection the operator configured.
- `memory.search` SHALL return only memories whose `project_id` equals the bound project, **unless the caller explicitly passes the cross-project argument specified in "`memory.search` MUST accept an opt-in cross-project read and report which projects it read", in which case it SHALL return only memories from projects the token is authorized to read.** No other argument SHALL widen the result set past the bound project, and `include_global` remains absent from the tool's input schema. **Widening is a property of the caller's request and the token's reach, not of the connection: a path-scoped connection may widen exactly as a path-less one may, because the path fixes which project is the caller's home, not which projects the token may read.**
- `memory.get` and `memory.confirm` SHALL respond with structured code `not_found` when the requested memory belongs to a different project, regardless of whether the memory exists, to avoid leaking existence across scopes. **Neither accepts a widening argument**, so this clause is unchanged by the cross-project search.

Because there is exactly one kind of scope, the isolation this requirement describes is no longer a property of path-scoped connections specifically — it holds on every connection. What remains specific to a path-scoped connection is that its home project is fixed by the URL. No tool can change a connection's home project, on a path-scoped connection or a path-less one.

A path slug that does not resolve to an existing project SHALL NOT establish any scope. Such a connection has no bound project, so the clauses above have nothing to bind to; instead **every** tool that resolves scope SHALL be refused with structured code `project_not_found`, reads and writes alike, and SHALL NOT fall back to any other project — in particular not to the default project, whose role is to serve path-LESS connections, and **in particular not by widening**: with no resolved home project there is nothing to widen from, and the cross-project argument SHALL NOT make such a connection usable. An operator who typed a slug asked to be confined to it, and answering a typo with someone else's project is worse than refusing.

The `not_found` clause above governs a connection whose slug DOES resolve, where the comparison is between the bound project and the requested memory. On an unresolvable slug there is no bound project to compare against, so `project_not_found` — which names the unusable connection — takes precedence over `not_found`, and the two do not conflict.

#### Scenario: save with scope='global' on a path-scoped connection

- **GIVEN** a path-scoped connection at `/mcp/foo` with a valid token
- **WHEN** the client calls `memory.save` with an argument named `scope`
- **THEN** the call SHALL be rejected by the input schema as an unrecognized argument, and no refusal SHALL name the scope the argument used to request
- **AND** the scenario title predates this change: the argument it names has been removed, so no call can ask for a scope and be refused one. `scope_locked` survives only as a refusal of a project **switch** (see "the surviving `scope_locked` refusals lock a switch, not a scope"); it SHALL NOT be reintroduced as a refusal of a scope

#### Scenario: search on a path-scoped connection does not leak globals

The title predates this change: there are no global memories left to leak, and the only cross-project read is one the caller asked for and the token was authorized for — everything else stays closed, which is what this scenario now pins.

- **GIVEN** a path-scoped connection at `/mcp/foo` and memories in another project
- **WHEN** the client calls `memory.search` with any argument other than the cross-project one
- **THEN** the response SHALL contain only project `foo`'s memories, and no such argument SHALL admit another project's rows
- **AND** `include_global` SHALL still be refused as an unrecognized argument

#### Scenario: a path-scoped connection may widen deliberately

- **GIVEN** a path-scoped connection at `/mcp/foo`, a token authorized to read `foo` and `bar`, and memories in each
- **WHEN** the client calls `memory.search` with the cross-project argument
- **THEN** the response MAY contain `bar`'s memories and SHALL name both projects as searched
- **AND** `memory.save` on the same connection SHALL still write to `foo`, so widening a read has not widened a write

#### Scenario: get across project boundaries

- **GIVEN** a path-scoped connection at `/mcp/foo` and a memory M whose `project_id` is another project
- **WHEN** the client calls `memory.get('M')`
- **THEN** the response SHALL be an MCP error with `code: 'not_found'`, identical to the response for a non-existent id
- **AND** this SHALL hold whether or not a prior `memory.search` on the same connection widened and returned M, because `memory.get` accepts no widening argument

#### Scenario: search on an unresolvable slug refuses instead of reading global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and memories in the default project
- **WHEN** the client calls `memory.search`, with or without the cross-project argument
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'`
- **AND** the response SHALL contain no memory, in particular none from the default project and none from any other project the token may read
- **AND** the scenario title predates this change: there is no global memory to read, and the refusal it pins is unchanged

#### Scenario: get on a global id from an unresolvable slug refuses

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and a memory M in the default project
- **WHEN** the client calls `memory.get({id: M})`
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'` and SHALL NOT return M's `content`
- **AND** the scenario title predates this change: M is a memory in the default project, not a global one, which is what its body already says

#### Scenario: writes on an unresolvable slug do not land in global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.capture_passive` with text containing a well-formed Key Learnings section, or calls `memory.save_prompt`
- **THEN** each call SHALL be refused with `code: 'project_not_found'`
- **AND** no row SHALL be inserted into `memory` or `prompts`, in the default project or any other
- **AND** the scenario title predates this change: there is no global memory to land in, and the refusal it pins is unchanged

#### Scenario: a session is not opened in the global scope from an unresolvable slug

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.session_start`
- **THEN** the call SHALL be refused with `code: 'project_not_found'`
- **AND** no `agent_sessions` row SHALL be inserted, in the default project or any other
- **AND** the scenario title predates this change: there is no global scope to open a session in, and the refusal it pins is unchanged

#### Scenario: the refusal names candidate slugs

- **GIVEN** a project with slug `rembric` exists and a connection at `/mcp/rembic`
- **WHEN** the client calls any tool that resolves scope
- **THEN** the error payload SHALL include `suggestedSlugs` containing `rembric`

#### Scenario: the connection is not bricked by the refusal

- **GIVEN** a connection at `/mcp/no-such-project` and a token authorized to read the existing projects
- **WHEN** the client calls `project.current`, `project.list` or `memory.about`
- **THEN** each call SHALL succeed
- **AND** the `project_not_found` refusal that every scope-resolving tool returns on that connection SHALL name the dashboard as the place to create the project, and SHALL NOT name a tool call as a way to create or activate it

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1000 characters or fewer in both variants. This cap is a self-imposed token budget rather than the binding limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, but at least one consuming client DOES impose a ceiling — Claude Code truncates `instructions` at 2048 characters with the same `LB` constant it applies to tool descriptions, appending `… [truncated]`. The 1000-character cap is therefore chosen for token cost, at less than half the known client ceiling, and it binds first. Any future change RAISING this cap SHALL keep it below the verified client ceiling (see "Tool descriptions MUST stay below the client truncation ceiling").

Neither variant SHALL name `global`, `include_global` or user-wide memory (see "No MCP tool surface MAY name a scope the server does not have"). The path-scoped variant SHALL state which project the connection is bound to; the path-less variant SHALL state that a project is always active, name the default project as the scope in effect, and name a `/mcp/<slug>` URL as the way to reach another project. Neither variant SHALL name `project.use` or roots-based auto-detection, because neither exists.

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline, `content`, and `tags`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the optional `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Tag guidance SHALL teach normally 1–5 useful reusable lowercase kebab-case labels such as `dashboard`, `sqlite`, and `bug-fix`; selecting tags SHALL NOT require another tool call. The existing explicit-batch-tool requirements continue to govern operational judgment calls. Mechanical detail (error codes, scope semantics, the hard 1–64 tag bound) MAY be deferred to the tool's own `description` and schema.
2. **A recall flow** — directing the agent that when starting or resuming work, after a `/compact` event, or when asked "what did we do", it SHALL call `memory.context` (or `memory.search` for keyword lookup) BEFORE acting, but ONLY when it lacks the prior detail it needs. The phrasing SHALL keep recall on-demand — it MUST NOT direct an unconditional `memory.context` load at session start.
3. **A session-close flow** — directing the agent to call `memory.session_summary({title, summary})`. The trigger SHALL be bound to ending a turn in which real work happened — phrased so the agent saves before ending any working turn, and SHALL NOT be evadable by avoiding the literal word "done". The flow SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic), the summary structure (the canonical section list defined in `sessions`, carried from its single source rather than restated), AND the summary length cap (currently ≤10000 chars, derived from `SUMMARY_MAX_CHARS`). The cap MUST be present inline so the agent budgets for it on the first attempt; this is verified by the same length test that enforces the 1000-character ceiling.
4. **The update-guidance pointer** — a short clause naming `memory.about` as the tool to call when the operator asks how to update or upgrade Rembric (server or plugins).
5. **The `sessionId` reinforcement clause** — a terse directive telling the agent to pass its current session id explicitly when it knows one, and to never guess/invent one, so writes attach correctly instead of falling through the ambiguous-session fallback (see the `sessionId` reinforcement requirement below).

#### Scenario: An MCP client connects on `/mcp/<slug>`

- **WHEN** the `initialize` handshake completes against `/mcp/my-project`
- **THEN** the `InitializeResult.instructions` SHALL contain references to `memory.save`, `memory.search`, `memory.session_summary`, AND `memory.context` plus a note indicating the connection is bound to project `'my-project'`
- **AND** the note SHALL NOT contain `global`, `include_global` or `user-wide`
- **AND** the instructions SHALL contain the substring `memory.session_summary` and the substring `title` and a reference to "before" (referring to before ending a working turn)
- **AND** the instructions SHALL contain the substring `10000` (the summary length cap)
- **AND** the instructions SHALL contain the substring `memory.context` (the recall flow)
- **AND** the instructions SHALL contain the substring `memory.about` (the update-guidance pointer)

#### Scenario: The session-summary trigger is bound to ending a working turn

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the instructions SHALL phrase the `memory.session_summary` trigger as firing before ending any turn in which real work happened
- **AND** the instructions SHALL NOT bind the trigger solely to the literal phrase `before saying "done"`

#### Scenario: Recall guidance is on-demand, not unconditional-at-start

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the `memory.context` recall flow SHALL be conditioned on the agent lacking prior detail (e.g. starting/resuming work, after `/compact`, or "what did we do")
- **AND** the instructions SHALL NOT direct an unconditional `memory.context` load on every session start

#### Scenario: An MCP client connects on `/mcp` without a project

- **WHEN** the `initialize` handshake completes against `/mcp`
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows (the proactive save flow, the on-demand recall flow, the session-close flow with the `10000`-char cap, AND the `memory.about` update-guidance pointer) and a note stating that a project is always active — naming the default project as the scope in effect and a `/mcp/<slug>` URL as the way to reach another project. It SHALL NOT name `project.use` or roots-based auto-detection. It SHALL NOT name the retired `X-Rembric-Project` header, which is asserted absent from both variants by `packages/mcp/src/instructions.test.ts`, and SHALL NOT name `global`, `include_global` or user-wide memory.

#### Scenario: Instructions length is checked at build time

- **WHEN** the test suite runs against both `/mcp` and `/mcp/<slug>` variants of `buildInstructions(ctx)`
- **THEN** both outputs SHALL be 1000 characters or fewer (the raised cap — the 10000-char summary cap mention, the recall flow, AND the memory.about pointer MUST all fit within the 1000-char budget)
- **AND** both outputs SHALL contain the substring `10000`
- **AND** both outputs SHALL contain the substring `memory.context`
- **AND** both outputs SHALL contain the substring `memory.about`

#### Scenario: A client that does not consume `instructions` connects

- **WHEN** an MCP client ignores the `instructions` field
- **THEN** every tool SHALL still function normally (the field is informational only)
- **AND** `memory.about` SHALL remain discoverable through the MCP tool manifest regardless of whether the client consumed the `instructions` pointer

#### Scenario: instructions.test.ts asserts the protocol flows are present

- **WHEN** `packages/mcp/src/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substrings `memory.save`, `memory.context`, `memory.session_summary`, AND `memory.about`
- **AND** both outputs SHALL be ≤1000 chars
- **AND** existing assertions for `memory.search`, the scope note, the `10000` cap, and the proactive (non-"done"-bound) session-summary phrasing SHALL pass, with the scope-note assertion updated to the project-only wording

#### Scenario: The instructions cap stays below the client ceiling

- **WHEN** a change raises `INSTRUCTIONS_MAX_LENGTH` above 1000
- **THEN** the new cap SHALL remain below the verified client truncation ceiling for `instructions` (2048 characters in Claude Code 2.1.220)
- **AND** the change SHALL record the ceiling it re-verified, so the cap is never raised past a limit nobody checked

#### Scenario: SAVE guidance teaches required useful tags

- **WHEN** either instructions variant is built
- **THEN** its SAVE clause SHALL include required `tags` and normally 1–5 useful reusable lowercase kebab-case labels, with examples `dashboard`, `sqlite`, and `bug-fix`
- **AND** `topic_key` SHALL remain optional and no extra tag-selection call SHALL be introduced

### Requirement: Tools that attach a write to a session MUST accept an explicit `sessionId` override, reinforced in their descriptions

`memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` SHALL accept an optional `sessionId: string` argument. When provided, it SHALL take precedence over the server's own session resolution — mirroring the explicit-first precedence `memory.session_summary`/`memory.session_end` already apply via `resolveSessionId`. The resolution order SHALL be exactly two steps: (1) the explicit, ownership-checked `sessionId`; (2) otherwise `findActiveForTransport(tokenId, projectId)`, which returns a session only when the choice is unambiguous and returns none otherwise (see the `sessions` requirement "`findActiveForTransport` MUST NOT guess under concurrent ambiguity"). No session SHALL be bound to the connection or transport, and no step SHALL consult per-connection state: the server keeps none. Each tool's description SHALL mention `sessionId` explicitly (not only via the input schema's per-argument `describe()`, since some MCP clients do not surface per-property schema descriptions to the model) with guidance to pass it only if genuinely known and never invent one.

This closes a blind spot: `memory.session_summary`'s and `memory.session_end`'s zod schemas already declared `sessionId` as optional, but their tool descriptions never mentioned it — a model reading only the description had no reason to believe passing it was possible. `memory.save` and `memory.save_prompt` did not accept the argument at all prior to this requirement.

An explicit `sessionId` on the write-_attaching_ tools (`memory.save`, `memory.save_prompt`, `memory.capture_passive`) SHALL be validated before it is honored. The server SHALL resolve the named session row and require that it (a) is owned by the caller's token (`token_id` matches the request context), (b) belongs to the caller's effective project (`project_id` equals the connection's resolved project id), and (c) is not soft-deleted (`deleted_at IS NULL`). When (a) or (b) fails, the call SHALL be rejected with code `session_not_found` — the same masking code the session-lifecycle tools use, so a caller cannot probe which session ids exist under other tokens or projects. When (a) and (b) pass but (c) fails, the call SHALL be rejected with code `session_deleted`. On rejection no row SHALL be written. Validation applies only when `sessionId` is explicitly supplied; the active-session fallback already resolves to a session owned by the caller within the effective scope. An `ended` (but not soft-deleted) session remains a valid attachment target. `memory.session_summary`/`memory.session_end` retain their existing service-layer cross-token + soft-delete checks. This closes a security blind spot: prior to this requirement an explicit `sessionId` was honored verbatim, letting a caller forge an attachment to another token's or another project's session.

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

### Requirement: Session-lifecycle MCP tools MUST reject soft-deleted sessions

`memory.session_end`, `memory.session_summary` and `memory.session_resume` SHALL resolve the target row before performing any state transition. When the resolved row has `deleted_at IS NOT NULL`, the call SHALL be rejected with a structured MCP error containing `code: 'session_deleted'` and a message naming the deleted-at timestamp. No state mutation SHALL be performed. The cross-token check that already protects these calls SHALL continue to run first; only when the cross-token check passes does the `session_deleted` gate apply.

`memory.session_resume` is the tool for which this rule matters most, because it is the only one that can change `status` in the reviving direction: a soft-deleted row SHALL NOT be resumable, so an operator's Delete is not undone by an agent. Its gate SHALL be evaluated in the service against the row read in the same synchronous tick as the write, not only at the tool boundary, for the reason stated in the `sessions` capability under "Sessions MAY be soft-deleted while preserving the audit trail". Resume SHALL NOT clear `deleted_at`; undelete remains an operator-only action.

`memory.session_start` is unaffected: it never resolves an existing row by id, and the row it may adopt is found by an active-session lookup that excludes soft-deleted rows, so it can neither target nor revive a deleted session. It does NOT always insert a new row — see "The MCP server MUST expose four session-lifecycle tools that keep no per-connection binding", which specifies the adoption path and its `reused` flag — and this requirement SHALL NOT be read as promising that it does.

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

#### Scenario: memory.session_resume targets a soft-deleted session

- **GIVEN** a Rembric session `<S>` whose `deleted_at` is non-null and whose `status` is `'ended'`, owned by token `<T>`
- **WHEN** an MCP client authenticated as `<T>` calls `memory.session_resume` with `sessionId = <S>`
- **THEN** the response SHALL be an MCP error containing `code: 'session_deleted'` and a message naming the deleted-at timestamp
- **AND** `status`, `ended_at`, `last_activity_at` and `deleted_at` SHALL all be unchanged

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
  "scope": "project:<id>",
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

The tool SHALL resolve effective project via the shared scope resolver (path-scoped `ctx.project` → the default project on a path-less connection). It SHALL NOT leak prompts from any other scope.

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

### Requirement: Every MCP tool MUST advertise behavioral annotations

Every tool registered on the MCP server SHALL declare an `annotations` object consistent with Rembric's append-only and closed-store invariants. The annotation set SHALL satisfy:

- Read-only tools (`memory.search`, `memory.get`, `memory.context`, `memory.session_get`, `memory.timeline`, `memory.search_prompts`, `memory.doctor`, `memory.about`, `memory.stats`, `memory.suggest_topic_key`, `project.list`, `project.current`) SHALL carry `readOnlyHint: true`.
- Mutating tools SHALL carry `readOnlyHint: false`.
- Because no tool performs an irreversible destructive update (supersede is a reversible, journaled `status` flip; rows are never deleted), **every** tool SHALL carry `destructiveHint: false`.
- Because Rembric is a closed local store, **every** tool SHALL carry `openWorldHint: false`.
- Tools whose repeated invocation is side-effect-free or last-call-wins (`memory.compare`, `memory.session_end`, `memory.session_summary`, `memory.suggest_topic_key`, and all read-only tools) SHALL carry `idempotentHint: true`.

Annotations are advisory metadata only: they SHALL NOT change tool inputs, outputs, or the `text` result contract.

#### Scenario: Read-only tools report readOnlyHint

- **WHEN** a client calls `tools/list`
- **THEN** each of `memory.search`, `memory.get`, `memory.context`, `memory.session_get`, `memory.timeline`, `memory.search_prompts`, `memory.doctor`, `memory.about`, `memory.stats`, `memory.suggest_topic_key`, `project.list`, and `project.current` SHALL report `annotations.readOnlyHint === true`

#### Scenario: No tool is advertised as destructive

- **WHEN** a client calls `tools/list`
- **THEN** every registered tool SHALL report `annotations.destructiveHint === false`

#### Scenario: No tool is advertised as open-world

- **WHEN** a client calls `tools/list`
- **THEN** every registered tool SHALL report `annotations.openWorldHint === false`

#### Scenario: Mutating tools are not marked read-only

- **WHEN** a client calls `tools/list`
- **THEN** `memory.save`, `memory.confirm`, `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, `memory.session_summary`, `memory.session_end`, `memory.judge`, and `memory.compare` SHALL report `annotations.readOnlyHint === false`

#### Scenario: Annotations do not alter the result contract

- **WHEN** any annotated tool is invoked successfully
- **THEN** the result SHALL still be returned as a `text` content block (no `structuredContent` is required), unchanged from the pre-annotation behavior

### Requirement: MCP error messages MUST NOT instruct the agent to perform an action it cannot perform

An error message on the MCP surface is read by an agent that will act on it, so a message naming an unreachable remedy costs a wasted turn and, worse, teaches the agent a false model of its own connection. Every structured error message SHALL name only remedies reachable by the party it addresses, and SHALL NOT contradict the `instructions` block delivered on the same connection.

One consequence is normative:

- The `forbidden` message returned when a token pinned to exactly one project is denied an action on a connection whose resolved scope is a DIFFERENT project — including the default project on a path-less connection — SHALL name the way out: reconnecting at `/mcp/<slug>` for the pinned project. It SHALL NOT name `project.use` or any other tool call, because no tool can change a connection's project. Naming only the token scope and the denied target reads as a misconfigured token and hides a one-line configuration fix. This requirement changes no authorization outcome: the denial itself is correct and unchanged. The remedy's condition SHALL be expressed in terms of the resolved scope differing from the token's pin, NOT in terms of the resolved scope being global — a global-scope condition becomes permanently false when a path-less connection resolves to a project, which would silently stop the remedy being emitted and regress this requirement to a bare identifier with no next step.

The previously-normative consequence about `scope_locked` as a **scope** refusal is retired with the argument that produced it. `memory.save` accepts no `scope` argument, so no call can request a scope the connection forbids, and no message can promise a user-wide destination. A change SHALL NOT reintroduce a message naming a scope or user-wide memory, nor one instructing the operator to add a path-less `/mcp` entry for user-wide memory.

The `scope_locked` code itself is NOT retired: it survives as the refusal for a **switch** no connection can perform — `memory.session_start({project})` naming a project other than the one the connection resolved, whether that project came from the URL path or is the default project on a path-less connection. That refusal names the resolved slug and no scope, so it is outside what the paragraph above forbids, and it is the only refusal for "this connection is fixed by its URL, you cannot change it from a tool". Its message SHALL keep that shape.

#### Scenario: `scope_locked` does not promise a second connection

- **GIVEN** a path-scoped connection at `/mcp/foo`
- **WHEN** every refusal the connection can produce is enumerated
- **THEN** no message SHALL name a scope, SHALL instruct opening or connecting to a second MCP connection, or SHALL mention user-wide memory
- **AND** each enumerated message SHALL be pinned verbatim, not screened against a list of prohibited words — a paraphrase of a prohibited instruction carries none of its words, so only the verbatim pin makes a change to a refusal message visible
- **AND** the scenario title predates this change: `scope_locked` is retired as a scope refusal, and this scenario pins that it does not come back as one

#### Scenario: the surviving `scope_locked` refusals lock a switch, not a scope

- **GIVEN** a path-scoped connection at `/mcp/foo`
- **WHEN** the client calls `memory.session_start({project: 'bar'})`
- **THEN** the call SHALL be refused with `code: 'scope_locked'`
- **AND** the message SHALL name the bound slug `foo`, and SHALL name no scope, promise no second connection and mention no user-wide memory

#### Scenario: `scope_locked` agrees with the connection's own instructions

- **WHEN** the path-scoped `instructions` variant and every refusal the same connection can produce are compared
- **THEN** neither SHALL assert that user-wide memory is reachable, and neither SHALL name a scope

#### Scenario: A project-pinned token on a path-less connection is told the remedy

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, where `foo` is not the default project
- **WHEN** the client calls `memory.context` or `memory.search`
- **THEN** the call SHALL be refused with `code: 'forbidden'` (unchanged)
- **AND** the message SHALL name the slug `foo` and the `/mcp/foo` URL, and SHALL NOT name `project.use`

#### Scenario: A full-access token's denial message is unaffected

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `read:*`
- **WHEN** the client calls a write-classified tool
- **THEN** the refusal SHALL carry `code: 'forbidden'` and the message SHALL NOT carry the pinned-project remedy, since the token has no project pin

### Requirement: A path-less `/mcp` connection MUST resolve to the default project

A connection at `/mcp` with no path slug SHALL resolve its effective scope to the **default project** — the single `projects` row marked as the system default (see the `projects` capability). There SHALL be no state in which a connection is authenticated but has no project scope, and no tool SHALL be reachable in such a state.

Every site that previously fell back to the global scope on a path-less connection SHALL target the default project instead, and the set of such sites SHALL be exhaustive rather than sampled: the shared scope resolver, `memory.session_start`'s project binding, `project.current`'s authorization target, and the pinned-token remedy builder. A site missed here does not fail — it silently authorizes against, or reports, a scope that no longer exists.

No tool SHALL switch a path-less connection to another project, and MCP roots SHALL NOT be consulted to choose one: the server keeps no per-connection state that could hold a switch. A path-less connection reaches another project only by being reconfigured to `/mcp/<slug>`. Reconfiguring the connection's home scope is not the same operation as widening one read: a home scope decides where writes land and what every tool sees by default, while a widening affects exactly one `memory.search` call and no write. Both are bounded by the same authorization, so neither reaches a project the token may not read.

**Authorization is unchanged and still gates the default project.** A token pinned to one project, connecting path-lessly, SHALL be refused with `code: 'forbidden'` naming the default project — a project it was never granted. The denial is the same denial it receives today against the global scope; only the named target changes, and it changes to one an operator can open. The refusal SHALL carry the pinned-project remedy (see "MCP error messages MUST NOT instruct the agent to perform an action it cannot perform").

#### Scenario: A path-less save with no arguments succeeds

- **GIVEN** a path-less `/mcp` connection, a token authorized to write the default project, and no `.rembric` file, whether or not the client advertises the roots capability
- **WHEN** the client calls `memory.save` with only `type`, `title` and `content`
- **THEN** the call SHALL succeed and the new row SHALL carry the default project's `project_id`
- **AND** the call SHALL NOT be refused with `project_required` or `project_suggestion_pending`

#### Scenario: `project.current` names the default project on a path-less connection

- **GIVEN** a path-less `/mcp` connection with a token authorized to read the default project
- **WHEN** the client calls `project.current`
- **THEN** the response SHALL name the default project's slug and id, and `source` SHALL report that resolution came from the default rather than from a URL path

#### Scenario: A project-pinned token is refused, and told the way out

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, where `foo` is not the default project
- **WHEN** the client calls `memory.search` or `project.current`
- **THEN** the call SHALL be refused with `code: 'forbidden'`
- **AND** the message SHALL name the slug `foo` and the `/mcp/foo` URL, and SHALL NOT name `project.use`

#### Scenario: Switching to another project does not merge two projects

- **GIVEN** a token authorized for both the default project and project `beta`, and memories in each
- **WHEN** the client switches by reconfiguring its connection from `/mcp` to `/mcp/beta`, the only way left to switch, and calls `memory.search`, `memory.search` with an `entity`, `memory.context`, `memory.stats`, `memory.get` by id, `memory.get` by ids, and `memory.timeline`, none of them passing the cross-project argument
- **THEN** every response SHALL contain only `beta`'s rows and counters, and none SHALL contain a row or counter from the default project

#### Scenario: A widened search does not change where a subsequent write lands

- **GIVEN** a path-less connection resolved to the default project and a token authorized for it and `beta`
- **WHEN** the client calls `memory.search` with the cross-project argument and then `memory.save`
- **THEN** the saved row SHALL carry the default project's `project_id`, so a widened read leaves the connection's home scope untouched

#### Scenario: The default project is listable and usable like any other

- **GIVEN** a token authorized to read the default project
- **WHEN** the client calls `project.list`
- **THEN** the default project SHALL appear as an ordinary entry with its slug, display name, archived flag and `activeMemoryCount`
- **AND** a connection at `/mcp/<its slug>` SHALL resolve to it under the same rules as any other project

### Requirement: Every MCP tool input schema MUST refuse an unknown property rather than ignore it

Every registered tool SHALL validate its arguments against a **strict** object schema: a property the tool does not declare SHALL be refused, naming both the tool and the offending property, and the call SHALL NOT reach the handler.

The reason is retirement, not tidiness. MCP has no version negotiation (see the release-sequencing decision that splits this change across two releases), so a client pinned to an older plugin keeps sending the arguments it was built against, and the server cannot detect that it is old. Under a schema that silently drops unknown properties, a retired argument keeps parsing forever and quietly means something different from what the caller intends — `include_global: true` on a connection that can no longer widen anything reads as consent to a result set the caller did not ask for. A refusal that names the property tells the operator to upgrade; a silent drop tells them nothing. It is also the only way the published manifest becomes true: `tools/list` already advertises `additionalProperties: false` for every tool, so a server that strips instead of refusing publishes a constraint it does not enforce.

Strictness SHALL apply uniformly to the whole tool surface and SHALL NOT carry a per-tool exception list — an exempt tool is where the next retired argument goes on meaning something. It SHALL be applied at the single seam where tool input shapes are registered, so a tool added later inherits it rather than opting in, and SHALL reach nested object properties as well as top-level ones.

A refusal for an unknown property is an **argument**-validation failure, not a scope-resolution refusal: it is reported as the transport's own invalid-parameters error and is not required to carry a `DomainError` code. This does not weaken "Scope-sensitive tools MUST share the single scope resolver over the URL path and the default project", whose subject is the refusal a resolver produces.

#### Scenario: A retired argument is refused, not dropped

- **GIVEN** any connection with a valid token
- **WHEN** the client calls `memory.search` with `include_global`, or `memory.save` with `scope`
- **THEN** the call SHALL be refused with the transport's invalid-parameters error, the message SHALL name the tool and the offending property, and no memory SHALL be written or returned

#### Scenario: An unknown property is refused on every registered tool

- **WHEN** every tool in a real `tools/list` response is called with a property no tool declares
- **THEN** every call SHALL be refused and each message SHALL name that property
- **AND** the number of tools examined SHALL be asserted to be non-zero, so an empty manifest cannot pass

#### Scenario: A legitimate call still succeeds

- **GIVEN** a connection resolved to a project the token may read and write
- **WHEN** the client calls `memory.save`, `memory.search`, `memory.get`, `memory.context`, `project.list` and `memory.session_start` with every argument each of them declares
- **THEN** every call SHALL succeed
- **AND** this scenario is the non-vacuity control for the two above: without it a server that refused everything would satisfy them

#### Scenario: A wrong-typed declared argument fails as it did before

- **WHEN** the client calls a tool with a declared property carrying the wrong type
- **THEN** the call SHALL be refused exactly as it was before strictness, so the pre-existing failure mode is unchanged and the new refusal is attributable to the unknown property alone

### Requirement: The MCP server MUST expose a `memory.archive` tool

The server SHALL register an MCP tool `memory.archive` that retires a single memory by flipping its `status` from `active` to `archived`. The tool SHALL accept `{ id: string }` (validated by zod; non-empty) and SHALL NOT accept a `scope` argument. It SHALL resolve the effective scope exactly like the other single-memory tools (`memory.get`/`memory.confirm`, via `resolveEffectiveScope`) and delegate to `MemoryService.archive(id, scope)`, so archiving is confined to the connection's one effective scope: a `/mcp/<slug>` connection archives in that project's scope; a `/mcp` connection archives in the default project.

A cross-scope or unknown `id` SHALL return the same `not_found`-class error as `memory.get`/`memory.confirm` — there is no cross-scope or cross-project archive path. Archiving a non-`active` memory SHALL return a `conflict`-class error. The tool SHALL NOT delete rows, drop vectors, or expose any purge capability; physical deletion remains operator/admin-only.

#### Scenario: Archiving an active memory in scope succeeds

- **GIVEN** a `/mcp/<slug>` connection scoped to project `P` and an `active` memory `M` in project `P`
- **WHEN** an MCP client calls `memory.archive` with `{ id: 'M' }`
- **THEN** the server SHALL flip `M.status` to `archived` in project `P`
- **AND** the response SHALL confirm the archive (e.g. the archived id and its new status)

#### Scenario: Archiving a memory outside the connection's scope is not found

- **GIVEN** a `/mcp/<slug>` connection scoped to project `P` and an `active` memory `X` in a different project `Q`
- **WHEN** an MCP client calls `memory.archive` with `{ id: 'X' }`
- **THEN** the server SHALL return a `not_found`-class error and SHALL NOT change `X.status`

#### Scenario: Archiving a non-active memory conflicts

- **WHEN** an MCP client calls `memory.archive` for a memory whose `status` is `superseded` or `archived`
- **THEN** the server SHALL return a `conflict`-class error and SHALL NOT change the memory's status

### Requirement: `memory.timeline` session neighbors MUST be filtered by the connection's effective scope

`memory.timeline`'s session-neighbor query (used when the target memory has a non-null `session_id`) SHALL filter neighbors by the connection's effective `project_id` in addition to `session_id`, so a neighbor lying outside the effective scope is never returned. Filtering by `session_id` alone is insufficient because a single session can hold memories in more than one project (rows written before project switching was removed, when a path-less connection could switch project mid-session and save into a second project) and because `session_id` carries no foreign key — so without a scope predicate `memory.timeline` could return another project's memory `content`, violating the cross-scope-read invariant that a target memory's own scope gate is meant to uphold. The time-window fallback neighbor query already applies this filter; the session-neighbor query SHALL match it.

#### Scenario: A same-session memory in another scope is not returned

- **GIVEN** a target memory `<M>` in project A with `session_id = <S>`, and another memory `<G>` in project B that also carries `session_id = <S>`
- **WHEN** a connection whose effective scope is project A calls `memory.timeline` with `{ memoryId: '<M>' }`
- **THEN** the returned `before`/`after` neighbors SHALL NOT include `<G>` or its `content`

#### Scenario: In-scope session neighbors are still returned

- **GIVEN** a target memory `<M>` in project A with `session_id = <S>`, and other project-A memories sharing `session_id = <S>`
- **WHEN** a connection whose effective scope is project A calls `memory.timeline` with `{ memoryId: '<M>', before: 5, after: 5 }`
- **THEN** the in-scope same-session neighbors SHALL be returned, ordered chronologically, exactly as before this change

## ADDED Requirements

### Requirement: The MCP server MUST expose two project-management tools under the `project.*` namespace

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `project.list` and `project.current` with the following contracts. Tool names live under the top-level `project.*` namespace (not `memory.project_*`) to distinguish project management from memory CRUD.

No tool SHALL activate, switch or create a project. A connection's project is fixed by its URL path, or is the default project on a path-less connection; projects are created from the dashboard. `project.use` SHALL NOT be registered and SHALL NOT appear in `tools/list`.

`project.list`'s per-project count SHALL be named `activeMemoryCount` and SHALL count only memories whose `status` is `active`, in that project's scope. The name carries the filter because the count's previous name, `memoryCount`, stated neither dimension and was measured disagreeing with the corpus the same connection could read: after `memory.archive` on a project's only memory, `project.list` reported `1` while `memory.search` in that same scope returned `0`. The name is additionally reused elsewhere in the server for a different aggregate (memories saved in one session), so a bare `memoryCount` on this payload is ambiguous in two ways at once. Renaming rather than silently re-filtering is required: a changed value under an unchanged key gives a consumer no signal to re-read the contract.

`activeMemoryCount` SHALL be computed by a repository read that takes the scope as a required parameter (see the `data-access` requirement "`project.list`'s per-project memory count MUST be a scoped repository read"). The scope SHALL be derived from the project row being reported, and the token-authorization filter over project rows SHALL be applied BEFORE any count is taken, so the handler can only count a scope the token was already authorized to read. This ordering is the entire basis on which a handler may name its own scope, and it SHALL NOT be relaxed into a post-filter.

`project.list` SHALL NOT resolve an effective scope from the request context in order to produce the count, and SHALL continue to succeed on a connection whose URL slug resolves to no project (see "the connection is not bricked by the refusal").

`project.list` SHALL NOT report a second, unfiltered per-project total. The per-status breakdown scoped to the request context is `memory.stats`' `memoriesByStatus`, and a second total on this payload would answer the same question on a path that deliberately does not resolve the caller's scope.

`project.list`'s registered top-level description SHALL state that the count is of active memories. This SHALL be in the description string returned by `tools/list`, not only in a schema `describe()`, which some clients do not surface to the model.

#### Scenario: No project-switching or project-creating tool is offered

- **WHEN** an MCP client calls `tools/list` on `/mcp` or on `/mcp/<slug>`
- **THEN** the response SHALL contain `project.list` and `project.current`
- **AND** the response SHALL NOT contain `project.use`, nor any other tool that activates, switches or creates a project

#### Scenario: `project.list` returns available slugs

- **WHEN** an MCP client calls `project.list({includeArchived?: false})`
- **THEN** the server SHALL return `{ projects: Array<{ slug, displayName, archived, activeMemoryCount }> }` ordered by slug ascending, filtering archived rows by default
- **AND** the payload SHALL NOT contain a `memoryCount` key on any project entry

#### Scenario: `activeMemoryCount` drops when a memory is archived

- **GIVEN** projects `p` and `q`, where `p` holds exactly one memory with `status = 'active'` and `q` holds two
- **WHEN** an MCP client calls `project.list`, then calls `memory.archive` on `p`'s only memory, then calls `project.list` again
- **THEN** the first response SHALL report `activeMemoryCount` of 1 for `p`
- **AND** the second response SHALL report `activeMemoryCount` of 0 for `p`
- **AND** `q`'s `activeMemoryCount` SHALL be 2 in both responses

#### Scenario: `activeMemoryCount` agrees with what the same connection can retrieve

- **GIVEN** a project holding one `active` memory and one `archived` memory
- **WHEN** an MCP client on a connection resolving to that project calls `project.list` and `memory.stats`
- **THEN** `activeMemoryCount` for that project SHALL equal `memory.stats`' `memoriesByStatus.active` for the same scope
- **AND** `activeMemoryCount` SHALL be strictly less than the project's total row count, so the filter is observable rather than vacuous

#### Scenario: `activeMemoryCount` excludes memories outside the reported project

- **GIVEN** projects `p` and `q` each holding `active` memories, plus at least one `active` memory in the default project
- **WHEN** a token authorized for both projects calls `project.list`
- **THEN** each entry's `activeMemoryCount` SHALL count only that entry's own project scope
- **AND** no entry's `activeMemoryCount` SHALL include any other project's memories

#### Scenario: A project-scoped token sees only its own project and its own count

- **GIVEN** projects `p` and `q` both holding `active` memories, and a token with scope `project:<p.id>`
- **WHEN** the token calls `project.list`
- **THEN** the response SHALL contain `p` only, with `p`'s own `activeMemoryCount`
- **AND** no count for `q` SHALL be computed or returned

#### Scenario: `project.list` still succeeds on a connection whose slug resolves to no project

- **GIVEN** a connection at `/mcp/no-such-project` and a token authorized to read the existing projects
- **WHEN** the client calls `project.list`
- **THEN** the call SHALL succeed and SHALL report `activeMemoryCount` for every project the token may read
- **AND** the call SHALL NOT be rejected with `project_not_found`

#### Scenario: `project.list`'s description states that the count is of active memories

- **WHEN** an MCP client retrieves the tool description for `project.list` via `tools/list`
- **THEN** the description SHALL convey that the per-project count covers active memories
- **AND** the description SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling")

#### Scenario: `project.current` reports resolution provenance

- **WHEN** an MCP client calls `project.current`
- **THEN** the server SHALL return `{ slug: string | null, projectId: string | null, source: 'url-path' | 'default' | 'none' }` where `source: 'default'` reports the default-project fallback — a resolution that happened, so it SHALL NOT be reported as `'none'`
- **AND** the response SHALL NOT carry a `suggestedSlugs` field

### Requirement: Every MCP tool call MUST be authorized against the token's scope for the resolved project

Every registered MCP tool except `memory.about` SHALL be classified as `read` or `write` and SHALL, before touching any data, resolve the connection's effective scope through the single async resolver (path slug → the default project) and check `isAuthorized(tokenScope, action, resolvedScope)`. A failed check SHALL be rejected with code `forbidden`. **A tool that accepts an input widening the result set past the resolved scope — `memory.search`'s cross-project argument is the only one — SHALL additionally authorize each project the widening would admit, after the resolved-scope check, and SHALL drop the projects that fail rather than reject the call** (see the `auth` capability). The path-scoping error contract (`scope_locked`, `project_not_found`) SHALL be preserved unchanged and SHALL be evaluated before the authorization check where it applies today.

Write classification: `memory.save`, `memory.save_prompt`, `memory.capture_passive`, `memory.confirm`, `memory.judge`, `memory.compare`, `memory.session_start`, `memory.session_summary`, `memory.session_end`. `memory.compare` is a write because it always persists a `memory_relations` row (`status='judged'`) and, for `relation='supersedes'`, flips the target memory's `status` to `superseded` and appends to the source's `replaces[]` — a lifecycle mutation, not a read. Read classification: `memory.search`, `memory.get`, `memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.search_prompts`, `memory.suggest_topic_key`, `memory.session_get`, `project.current`. `project.list` SHALL filter its result to the projects the token is authorized to read, using the same per-project predicate: `*` and `read:*` tokens see all projects; `project:<id>` and `read:project:<id>` tokens see only that project; a set-scoped token sees exactly its members. **That predicate and the one that builds the widened search set SHALL be the same expression, so `project.list` and a widened `memory.search` can never disagree about a token's reach.**

No MCP tool creates a project, so no tool call needs the project-creation authorization the retired `project.use({autocreate: true})` path carried; projects are created from the dashboard.

#### Scenario: Read-restricted token attempts a formerly-ungated write

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, or `memory.judge`
- **THEN** the call SHALL be rejected with code `forbidden` and no row SHALL be written

#### Scenario: Read-restricted token attempts memory.compare

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.compare` with any two in-scope memories
- **THEN** the call SHALL be rejected with code `forbidden`, no `memory_relations` row SHALL be written, and no target memory's `status` SHALL change

#### Scenario: Project-restricted token reads another project's context

- **GIVEN** a token with scope `read:project:A` or `project:A`
- **WHEN** the token opens `/mcp/B` and calls `memory.context`, `memory.timeline`, `memory.stats`, `memory.search_prompts`, or `memory.session_get`
- **THEN** the call SHALL be rejected with code `forbidden` and no project-B data SHALL be returned

#### Scenario: Project-restricted token on an unscoped connection resolving global scope

The title predates this change: the scope a path-less connection resolves is the default project.

- **GIVEN** a token with scope `read:project:A` connected to `/mcp` with no active project
- **WHEN** the token calls a read tool whose effective scope resolves to the default project
- **THEN** the call SHALL be rejected with code `forbidden`; the same call on a connection at `/mcp/A` SHALL succeed against project A
- **AND** passing the cross-project argument SHALL NOT make the refused call succeed, because the widening is authorized after the resolved-scope check, not instead of it

#### Scenario: `project.list` is filtered by token scope

- **GIVEN** projects A and B exist and a token with scope `project:A`
- **WHEN** the token calls `project.list`
- **THEN** the response SHALL contain project A only

#### Scenario: `project.list` and a widened search agree

- **GIVEN** any token and any set of projects
- **WHEN** the token calls `project.list` and then `memory.search` with the cross-project argument
- **THEN** the slugs in `searchedProjects` SHALL be a subset of the non-archived slugs `project.list` returned, and SHALL equal them when none is archived

#### Scenario: Full-access tokens are unaffected

- **GIVEN** a token with scope `*`
- **WHEN** it invokes any tool on any `/mcp*` connection
- **THEN** authorization SHALL never reject the call (path-scoping errors still apply)

### Requirement: Scope-sensitive tools MUST share the single scope resolver over the URL path and the default project

All scope-sensitive tools SHALL resolve the effective project through the same async resolver that `memory.save` uses. The resolver SHALL have exactly two sources: the URL path slug, and — on a path-less connection — the default project. It SHALL NOT consult MCP roots, a per-connection project pin, or any other per-connection state, and it SHALL NOT issue any server→client request. It SHALL NOT return a scopeless result, so no tool can observe an unresolved scope.

The shared resolver SHALL refuse with `project_not_found` rather than returning a scope when the path slug names no project, so no tool routed through it can inherit a fallback by omission — including a tool added after this requirement lands.

A tool that resolves its own project rather than delegating to the resolver SHALL apply the same refusal. One does — `memory.session_start`, which binds the session row to a project — and it SHALL build its message and `suggestedSlugs[]` from the same shared constructor, so the refusals cannot drift in wording or payload. `memory.save` no longer classifies the request before resolving, because it no longer accepts a `scope` argument to classify; it delegates to the resolver like every other tool. That obligation SHALL be verified by enumeration over the registered tool list (below), never by counting resolver call sites — a tool absent from that list of call sites is exactly how this defect reached three separate write paths.

Every tool routed through the resolver SHALL surface that refusal as a structured `mcpError` (`isError: true` with a JSON body carrying `code` and `message`), never as an exception escaping into the transport, because an escaped exception yields an error result with no machine-readable `code`. A tool SHALL therefore resolve scope inside the same error-translating boundary it already uses for authorization failures. Where a tool previously validated its arguments before resolving scope, scope resolution SHALL come first: an unusable connection is reported ahead of a malformed argument, because the call cannot succeed under any arguments.

Coverage SHALL be asserted by enumeration rather than by inspection: a test SHALL drive the registered tool list, invoke every scope-sensitive tool on a connection whose path slug names no project, and assert the structured refusal. Tools exempt from scope resolution SHALL be enumerated explicitly in that test, so a newly registered tool fails it until it is classified.

#### Scenario: A path-less connection resolves to the default project whatever the client advertises

- **GIVEN** an unscoped `/mcp` connection whose client advertises `capabilities.roots` and whose first root's basename names an existing project other than the default project
- **WHEN** the agent's first tool call is `memory.context`
- **THEN** the server SHALL return the default project's context
- **AND** the server SHALL NOT send a `roots/list` request, and a `notifications/roots/list_changed` from the client SHALL change no later call's resolved scope

#### Scenario: Every registered scope-sensitive tool refuses an unresolvable slug

- **GIVEN** a connection whose path slug names no project and a token whose scope is `*`
- **WHEN** the enumerating test invokes every tool in the registered tool list with minimally valid arguments
- **THEN** every tool not on the explicit exemption list SHALL return a result carrying `isError: true` and a JSON body whose `code` is `project_not_found`

#### Scenario: A newly registered tool cannot inherit the fallback

- **GIVEN** a change that registers a new scope-sensitive MCP tool
- **WHEN** the test suite runs without that tool being classified
- **THEN** the enumerating test SHALL fail rather than the tool silently resolving to the default project

#### Scenario: Scope resolution precedes argument validation

- **GIVEN** a connection whose path slug names no project
- **WHEN** the client calls `memory.get` with neither `id` nor `ids` (a malformed request)
- **THEN** the response SHALL carry `code: 'project_not_found'` rather than `code: 'invalid_input'`

### Requirement: The MCP server MUST expose four session-lifecycle tools that keep no per-connection binding

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, `memory.session_summary` and `memory.session_resume` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the state transition out of `active`, and `memory.session_resume` is the sole transition back into it.

`memory.session_start` SHALL NOT always insert a row. When an `active` session already exists for the caller's `(tokenId, projectId)` — the ordinary case, because every supported host registers the session over HTTP before the agent runs — the call SHALL adopt that row instead of minting a second one, and SHALL report which of the two happened in a REQUIRED `reused` field: `true` when an existing row was adopted, `false` when a row was inserted. `reused` is the only signal distinguishing "you are now attached to the host's session" from "you just created a parallel session", which is the question a defensive `memory.session_start` call is asking. Its `outputSchema` SHALL mark it required, and the tool's description SHALL name it and state what `true` means (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"): a required field the description omits from a closed-form `Returns: { … }` list is undocumented surface on the one channel the model reads.

The response SHALL additionally carry a REQUIRED `agent` field reporting the attribution the resolved row actually carries: on `reused: false` the value just written, and on `reused: true` the adopted row's own value, which MAY differ from the `agent` argument the call passed. It SHALL be read from the resolved row rather than from the argument, so the field reports what is stored and not what was requested. The adopt path SHALL NOT write the passed `agent` onto the adopted row: `sessions.agent` is immutable (see the `sessions` capability, "The system SHALL never physically delete a session row and SHALL never mutate the `agent`, `token_id`, `started_at`, or `project_id` of an existing session") and no verb re-attributes a session, so a differing argument is discarded permanently and every memory and summary version anchored to that row inherits the row's attribution instead. Reporting it is therefore the entire remedy available: `reused: true` alone tells the caller it is attached to a session it did not open but not whose, and without `agent` the discard is not merely unnoticed but unobservable. Refusing the call on a mismatch SHALL NOT be adopted as the remedy — a host-registered row whose `agent` string the hook chose, adopted by a model that names itself differently, is the ordinary case the reuse exists to serve — and neither SHALL `agent` be added to the reuse key, which would restore the duplicate-session bug the reuse prevents. `agent` SHALL be non-nullable and always present, since the column is `NOT NULL` and the insert path substitutes `'unknown'`; a nullable declaration would publish a state the tool cannot produce. Its `outputSchema` SHALL mark it required and the description's closed-form `Returns: { … }` list SHALL name it, per "A tool's description and its response MUST agree, and neither may promise an unreachable state".

`memory.session_start` SHALL resolve the session it reports in this order, and the order is normative: (1) the windowed sole-active lookup (`findActiveForTransport`); (2) the sole-active reuse lookup that applies no staleness window (`findSoleActiveForReuse`); (3) a mint. Steps (1) and (2) are specified in the `sessions` capability, "`findActiveForTransport` MUST NOT guess under concurrent ambiguity". No step SHALL consult a binding between the connection and a session: the server keeps no per-connection state, and neither `memory.session_start` nor `memory.session_resume` binds a session to the connection.

Both adoption paths report the same way: `reused: true` carrying the adopted row's `sessionId` and that row's stored `agent`, and neither SHALL insert a row. Only step (3) reports `reused: false`. Minting under two-or-more live rows is preserved as published behaviour, and with no connection binding to answer a repeated call, each repeated call under that condition mints again; the description clause below is what limits repeated calls.

`memory.session_start`'s optional `project` argument SHALL be an assertion, not an activation. When it names the project the connection resolved — from the URL path, or the default project on a path-less connection — the call SHALL proceed exactly as if the argument were omitted. When it names any other slug, the call SHALL be refused with `scope_locked`, naming the resolved slug, and SHALL insert, adopt and modify no row. It SHALL NOT activate, switch or create a project.

The tool's description SHALL additionally tell the model not to repeat the call on a connection that already has a session — once a session is active on this connection, do not call `memory.session_start` again, because writes attach automatically. The description is the only surface that can reduce the volume of defensive calls that create these rows in the first place; the resolution order above bounds the damage per call, and this clause is what reduces the number of calls.

`memory.session_summary` SHALL validate `summary` against the single canonical cap exported from `packages/core/src/services/agent-sessions.ts` (`SUMMARY_MAX_CHARS`, currently `10000`). The MCP zod schema SHALL be `summary: z.string().min(1).max(SUMMARY_MAX_CHARS)` so overflow is rejected at the transport boundary with `invalid_input` before the tool body runs. The rejected agent SHALL receive an error whose message contains the decimal string of `SUMMARY_MAX_CHARS` so it can retry with a tighter body on the first attempt.

`memory.session_summary` and `memory.session_end` SHALL NOT reject a call because the resolved row is in a terminal state. `memory.session_summary` SHALL apply its summary/title write subject to the `final` precedence rules regardless of `status`; `memory.session_end` takes no summary/title arguments, so on a terminal row it SHALL be a pure no-op returning the existing `ended_at`. Neither SHALL mutate `status`, `ended_at` or `last_activity_at` on a terminal row — see the `sessions` capability, "Terminal session rows MUST accept late summary and title writes, and MUST NOT change status except through `resume`". `session_already_ended` SHALL NOT be a possible error code for either tool. This matters because the plugin's `PreCompact`, `SessionStart:compact` and `Stop` nudges instruct the agent to call `memory.session_summary`, and the stale-active retirement sweep can have flipped the row to `abandoned` (the documented steady state for two of the clients) before the agent gets there.

`memory.session_summary`'s response SHALL carry a REQUIRED `applied: boolean` field. `applied` is `true` when the summary/title write landed on the row (whether the row was `active` or terminal without a prior curated summary). `applied` is `false` when the terminal first-curated-stands precedence rule blocked the write: the row is terminal (`ended` or `abandoned`), `summary_final` was already `true`, and the incoming curated summary was discarded. When `applied` is `false`, the response SHALL additionally carry `discardReason: 'terminal_final'` — the only discard reason today — to name the specific rule that blocked the write. When `applied` is `true`, `discardReason` SHALL be omitted from the response. The `outputSchema` SHALL declare `applied` as required (`z.boolean()`) and `discardReason` as optional (`z.string().optional()`). This field is the entire remedy available on the MCP surface: the row cannot be repaired, the first-curated-stands rule cannot be changed (there is no `replaces` chain for sessions, so losing a curated handoff is unrecoverable), and returning an error would violate the "SHALL NOT reject a call because the resolved row is in a terminal state" clause above.

`memory.session_end`'s response SHALL carry a REQUIRED `applied: boolean` field. `applied` is `true` when the call transitioned an `active` row to `ended`. `applied` is `false` when the row was already terminal (`ended` or `abandoned`) and the call was a no-op. The `outputSchema` SHALL declare `applied` as required (`z.boolean()`). This makes the two session-lifecycle write tools consistent: both report whether the call achieved a state change.

`memory.session_resume` SHALL accept `{ sessionId: string }` with `sessionId` REQUIRED, and SHALL call `AgentSessionsService.resume` (specified in the `sessions` capability) with the request's token id. Its response SHALL be `{ ok: true, sessionId, status: 'active', startedAt, resumedAt, previousStatus, previousEndedAt, title }`, where `previousStatus` is the row's `status` immediately before the call and `previousEndedAt` is the `ended_at` the call discarded (`null` when the row was already `active`). Those two fields are the ONLY report of a value the server does not retain, so the tool's `outputSchema` SHALL mark them required and the description SHALL name them. `resumedAt` SHALL be the row's effective last activity after the call — the instant of the resume on the transition path, and the row's PRIOR activity on the already-`active` no-op path, since that path writes nothing by design. `resumedAt` SHALL NOT be read as "the instant this call ran": `previousStatus` is what distinguishes a transition from a no-op, and the tool description SHALL say so.

`sessionId` SHALL have no fallback resolution on `memory.session_resume`. Unlike the other three tools it SHALL NOT consult the sole-active-session lookup. That fallback is structurally unavailable — the active-session lookup filters `status = 'active'`, which the resume target by definition is not — so any fallback would have to select a terminal row by recency, precisely the heuristic the `sessions` capability's "`findActiveForTransport` MUST NOT guess under concurrent ambiguity" refuses. A call omitting `sessionId` SHALL be rejected at the zod boundary with `invalid_input`, never resolved to a guess.

`memory.session_resume` SHALL NOT bind the resumed session to the connection, on the transition path or on the already-`active` no-op path, and SHALL NOT set a project: resume names a session, and the project is whatever the connection already resolved. A later write reaches the resumed session through an explicit `sessionId`, or through the sole-active-session lookup when the resumed session is the only `active` one for the caller's `(token, project)`. `memory.session_end` has no binding to clear.

Session resolution is unchanged for the other three tools and SHALL remain status-aware where it already is: `memory.session_summary` resolves its target from an explicit `sessionId`, else the unambiguous `active` session for the caller's `(token_id, project_id)`. The second source SHALL continue to consider only `active` rows, so an agent that supplies no explicit id SHALL receive `session_not_found` rather than having its write attached to a closed session picked by recency.

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

## REMOVED Requirements

### Requirement: The MCP server MUST expose three project-management tools under the `project.*` namespace

**Reason**: `project.use` is removed, together with its `autocreate` and `confirmSwitch` paths, so no tool activates, switches or creates a project. A switch only existed as a pin on per-connection state the server no longer keeps, and agent-side project creation is withdrawn. The `project.list` and `project.current` contracts continue under "The MCP server MUST expose two project-management tools under the `project.*` namespace".

**Migration**: Connect at `/mcp/<slug>` to work in a project; bridge clients do so with a `.rembric` file containing `PROJECT_SLUG` or with `REMBRIC_PROJECT_SLUG`. Create projects from the dashboard. A call to `project.use` is refused because no tool by that name is registered.

### Requirement: Every MCP tool call MUST be authorized against the token's scope

**Reason**: The requirement classified `project.use` as a read, classified `project.use({autocreate: true})` on an unknown slug as a project-creating write, and pinned that a full-access token could still create a project that way. `project.use` and agent-side project creation are removed, so neither classification can hold.

**Migration**: None required for authorization. Every remaining classification, the per-project predicate shared by `project.list` and a widened `memory.search`, and the `forbidden` refusal continue under "Every MCP tool call MUST be authorized against the token's scope for the resolved project". Projects are created from the dashboard.

### Requirement: Scope-sensitive tools MUST share the single async scope resolver

**Reason**: The resolver no longer awaits MCP roots discovery and no longer reads a `project.use` pin. The scenarios that pinned discovery on the first call in a warm process, recovery after a lost `roots/list`, the pending-suggestion path and the tool-call identity captured for discovery describe behaviour that no longer exists.

**Migration**: None required. The shared resolver, its `project_not_found` refusal, the enumerating coverage test and scope resolution ahead of argument validation continue under "Scope-sensitive tools MUST share the single scope resolver over the URL path and the default project". A path-less connection resolves to the default project; connect at `/mcp/<slug>` for any other.

### Requirement: The MCP server MUST expose four session-lifecycle tools

**Reason**: The tools no longer read or write a per-connection session binding: `SessionRouter` is removed together with the `Mcp-Session-Id` it was keyed on. `memory.session_start` no longer leads with a bound session, `memory.session_resume` no longer pins one and `memory.session_end` has none to clear, so the scenarios that pinned those bindings describe behaviour that no longer exists.

**Migration**: A client that needs a write attached to a specific session passes its id as `sessionId`; without it, a write attaches to the sole active session for the token and project, or to none when that is ambiguous. Every other contract of the four tools continues under "The MCP server MUST expose four session-lifecycle tools that keep no per-connection binding".
