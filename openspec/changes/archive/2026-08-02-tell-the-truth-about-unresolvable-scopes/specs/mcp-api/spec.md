## MODIFIED Requirements

### Requirement: Path-scoped connections MUST enforce strict project isolation

When the MCP connection is path-scoped (`/mcp/<slug>` or via `X-Rembric-Project` header) the server SHALL enforce a hard isolation contract on every tool call. The connection's project is the only scope visible:

- `memory.save` with `scope='global'` SHALL be rejected with structured code `scope_locked`.
- `memory.save` with `scope='project'` SHALL be persisted with `project_id` equal to the path-bound project regardless of any other argument the agent supplies.
- `memory.search` SHALL return only memories whose `scope = 'project'` and `project_id` equals the bound project; global memories SHALL NOT be returned. The `includeGlobal` argument SHALL be ignored on path-scoped connections.
- `memory.get` and `memory.confirm` SHALL respond with structured code `not_found` when the requested memory is global or belongs to a different project, regardless of whether the memory exists, to avoid leaking existence across scopes.

A path slug that does not resolve to an existing project SHALL NOT establish any scope. Such a connection has no bound project, so the four clauses above have nothing to bind to; instead **every** tool that resolves scope SHALL be refused with structured code `project_not_found`, reads and writes alike, and SHALL NOT fall back to the global scope. The refusal SHALL be the connection's uniform answer regardless of tool classification: an unresolvable slug SHALL never widen a read to user-wide memory, and SHALL never admit a write into the global scope.

The `not_found` clause above governs a connection whose slug DOES resolve, where the comparison is between the bound project and the requested memory. On an unresolvable slug there is no bound project to compare against, so `project_not_found` — which names the unusable connection — takes precedence over `not_found`, and the two do not conflict.

#### Scenario: save with scope='global' on a path-scoped connection

- **GIVEN** a client connected at `/mcp/foo` with a valid token
- **WHEN** the client calls `memory.save` with `scope='global'`
- **THEN** the response SHALL be an MCP error containing `code: 'scope_locked'` and a message naming the bound project

#### Scenario: search on a path-scoped connection does not leak globals

- **GIVEN** a path-scoped connection at `/mcp/foo` and at least one memory with `scope='global'`
- **WHEN** the client calls `memory.search` with or without `includeGlobal=true`
- **THEN** the response SHALL NOT contain any memory whose `scope='global'`

#### Scenario: get across project boundaries

- **GIVEN** a path-scoped connection at `/mcp/foo` and a memory M with `scope='project'`, `project_id='bar'`
- **WHEN** the client calls `memory.get('M')`
- **THEN** the response SHALL be an MCP error with `code: 'not_found'`, identical to the response for a non-existent id

#### Scenario: search on an unresolvable slug refuses instead of reading global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and at least one memory with `scope='global'`
- **WHEN** the client calls `memory.search`
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'`
- **AND** the response SHALL contain no memory whose `scope='global'`

#### Scenario: get on a global id from an unresolvable slug refuses

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and a memory M with `scope='global'`
- **WHEN** the client calls `memory.get({id: M})`
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'` and SHALL NOT return M's `content`

#### Scenario: writes on an unresolvable slug do not land in global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.capture_passive` with text containing a well-formed Key Learnings section, or calls `memory.save_prompt`
- **THEN** each call SHALL be refused with `code: 'project_not_found'`
- **AND** no row SHALL be inserted into `memory` or `prompts`

#### Scenario: a session is not opened in the global scope from an unresolvable slug

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.session_start`
- **THEN** the call SHALL be refused with `code: 'project_not_found'`
- **AND** no `agent_sessions` row SHALL be inserted, in the global scope or any other

#### Scenario: the refusal names candidate slugs

- **GIVEN** a project with slug `rembric` exists and a connection at `/mcp/rembic`
- **WHEN** the client calls any tool that resolves scope
- **THEN** the error payload SHALL include `suggestedSlugs` containing `rembric`

#### Scenario: the connection is not bricked by the refusal

- **GIVEN** a connection at `/mcp/no-such-project` and a token authorized to create a project
- **WHEN** the client calls `project.current`, `project.list`, `memory.about`, or `project.use({slug: 'no-such-project', autocreate: true})`
- **THEN** each call SHALL succeed
- **AND** after the `project.use` call, subsequent scope-resolving tools SHALL operate in that project's scope rather than being refused

### Requirement: The MCP endpoint MUST support path-based project scoping

The server SHALL accept MCP requests at `/mcp` (global) and at `/mcp/<project-slug>` (project-scoped). When the path includes a non-empty slug after `/mcp/`, the server SHALL resolve that slug to a project via `projects.findBySlug(slug)` and SHALL use the resulting project as the request's project scope. Resolution SHALL NOT create a project: auto-create on read is forbidden by the `projects` capability, and creating a project row at the authentication layer would let any token holding `*` mint arbitrary projects by requesting arbitrary URLs, before any write authorization has been checked.

When `findBySlug` returns nothing, the `initialize` handshake SHALL still succeed and the connection SHALL be treated as path-scoped to a project that does not exist — refused per the strict-isolation requirement, never resolved to the global scope.

The `X-Rembric-Project` header SHALL NOT be consulted in scope resolution (see the `projects` capability); the path slug is the only connection-level mechanism.

#### Scenario: Connecting at a project-scoped path

- **WHEN** an MCP client connects to `/mcp/my-app` with a valid token and a project with slug `my-app` exists
- **THEN** the server SHALL resolve `my-app` to that existing project row, SHALL NOT insert a row, and every tool call in that session SHALL be scoped to it

#### Scenario: Path slug names no project

- **WHEN** an MCP client connects to `/mcp/my-app` with a valid token and no project has slug `my-app`
- **THEN** `initialize` SHALL succeed, no project row SHALL be inserted, and every subsequent tool call that resolves scope SHALL be refused with `code: 'project_not_found'`

#### Scenario: Path slug and conflicting header

- **GIVEN** a client connecting to `/mcp/foo` while also sending `X-Rembric-Project: bar`
- **WHEN** the server processes the request
- **THEN** the project SHALL resolve to `foo` (the path wins); the header SHALL be ignored

#### Scenario: Global connection

- **WHEN** an MCP client connects to `/mcp` without a slug
- **THEN** the request SHALL be accepted without a project scope; tools that require a project (e.g. `memory.save` with `scope='project'`) SHALL respond with a structured error code `project_required` whose message instructs the caller to reconnect at `/mcp/<slug>`, to call `project.use({slug})`, or to save as `scope='global'` instead

### Requirement: Scope-sensitive tools MUST share the single async scope resolver

All scope-sensitive tools SHALL resolve the effective project through the same async resolver that `memory.save` uses (awaiting roots discovery on unscoped connections). The sync resolver that skipped discovery SHALL be removed. Write tools on unscoped connections SHALL honor the `project_suggestion_pending` gate exactly as `memory.save` does.

The shared resolver SHALL refuse with `project_not_found` rather than returning a scope when the path slug names no project, so no tool routed through it can inherit a fallback by omission — including a tool added after this requirement lands.

A tool that resolves its own project rather than delegating to the resolver SHALL apply the same refusal. Two do, both because they must classify the request before a scope exists to assert against: `memory.save`, which distinguishes `scope='global'` (`scope_locked`) from `scope='project'`, and `memory.session_start`, which binds the session row to a project. Every such site SHALL build its message and `suggestedSlugs[]` from one shared constructor, so the refusals cannot drift in wording or payload. That obligation SHALL be verified by enumeration over the registered tool list (below), never by counting resolver call sites — a tool absent from that list of call sites is exactly how this defect reached three separate write paths.

Every tool routed through the resolver SHALL surface that refusal as a structured `mcpError` (`isError: true` with a JSON body carrying `code` and `message`), never as an exception escaping into the transport, because an escaped exception yields an error result with no machine-readable `code`. A tool SHALL therefore resolve scope inside the same error-translating boundary it already uses for authorization failures. Where a tool previously validated its arguments before resolving scope, scope resolution SHALL come first: an unusable connection is reported ahead of a malformed argument, because the call cannot succeed under any arguments.

Coverage SHALL be asserted by enumeration rather than by inspection: a test SHALL drive the registered tool list, invoke every scope-sensitive tool on a connection whose path slug names no project, and assert the structured refusal. Tools exempt from scope resolution SHALL be enumerated explicitly in that test, so a newly registered tool fails it until it is classified.

#### Scenario: `memory.context` at session start on an unscoped connection

- **GIVEN** an unscoped `/mcp` connection whose project is resolvable via MCP roots discovery
- **WHEN** the agent's first tool call is `memory.context` (before any other call has populated the router)
- **THEN** the server SHALL await roots discovery and return the PROJECT's context, not global context

#### Scenario: `memory.capture_passive` while a project suggestion is pending

- **GIVEN** an unscoped `/mcp` connection with a pending project suggestion
- **WHEN** the agent calls `memory.capture_passive` or `memory.save_prompt`
- **THEN** the call SHALL be rejected with code `project_suggestion_pending`, identically to `memory.save`

#### Scenario: Every registered scope-sensitive tool refuses an unresolvable slug

- **GIVEN** a connection whose path slug names no project and a token whose scope is `*`
- **WHEN** the enumerating test invokes every tool in the registered tool list with minimally valid arguments
- **THEN** every tool not on the explicit exemption list SHALL return a result carrying `isError: true` and a JSON body whose `code` is `project_not_found`

#### Scenario: A newly registered tool cannot inherit the fallback

- **GIVEN** a change that registers a new scope-sensitive MCP tool
- **WHEN** the test suite runs without that tool being classified
- **THEN** the enumerating test SHALL fail rather than the tool silently resolving to the global scope

#### Scenario: Scope resolution precedes argument validation

- **GIVEN** a connection whose path slug names no project
- **WHEN** the client calls `memory.get` with neither `id` nor `ids` (a malformed request)
- **THEN** the response SHALL carry `code: 'project_not_found'` rather than `code: 'invalid_input'`

### Requirement: `include_global` MUST be ignored unless the connection is authorized for global reads

`memory.search` accepts `include_global` to admit `global` rows into a project-scoped result. The argument SHALL take effect only where both the connection and the token permit it, and SHALL be silently ignored otherwise — never rejected, so a client that passes it habitually degrades to project-only results instead of failing.

Two independent conditions gate it:

1. **Connection.** On a path-scoped connection the argument SHALL be ignored regardless of token scope, per the existing strict-isolation requirement. That requirement's verb is "ignored", and this requirement does not weaken it: on a path-scoped connection a `*` token receives that project's rows only.
2. **Token.** On a connection that reached `project` scope through `project.use` rather than a path slug, the argument SHALL take effect only when the token authorizes a global read.

The gate SHALL apply uniformly to every branch the argument reaches — the ranked lexical branch, the dense branch, and the `entity` branch — so a single call cannot be widened through one path while narrowed through another. `memory.get` gains no widening from this requirement.

This requirement governs the widening argument only, and therefore cannot constrain a connection whose _base_ scope is already global. On a path-scoped connection the base scope can no longer be global: a slug that names no project is refused with `project_not_found` rather than resolved, per the strict-isolation requirement. The isolation guarantees above therefore hold for every path-scoped connection, resolvable or not.

#### Scenario: Path-scoped connection with a full-access token

- **GIVEN** a path-scoped connection at `/mcp/foo` whose slug resolves to an existing project, with a token whose scope is `*`, and at least one memory with `scope = 'global'`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** the response SHALL contain no memory whose `scope = 'global'`

#### Scenario: Path-scoped connection whose slug names no project

- **GIVEN** a connection at `/mcp/no-such-project`, a token whose scope is `*`, and at least one memory with `scope = 'global'`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** the call SHALL be refused with `code: 'project_not_found'` and the response SHALL contain no memory

#### Scenario: `project.use` scope with an authorized token

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `*`, which has called `project.use({slug: 'foo'})`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** global memories SHALL be returned alongside project `foo`'s own, and no other project's memories SHALL be returned

#### Scenario: `project.use` scope with a project-restricted token

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, which has called `project.use({slug: 'foo'})`
- **WHEN** the client calls `memory.search` with `include_global = true`
- **THEN** the call SHALL succeed and the response SHALL contain no memory whose `scope = 'global'`

#### Scenario: The entity branch is gated identically

- **GIVEN** a global memory and a project memory both linked to the same entity value, on a path-scoped connection
- **WHEN** the client calls `memory.search` with that `entity` and `include_global = true`
- **THEN** only the in-scope project memory SHALL be returned

## ADDED Requirements

### Requirement: MCP error messages MUST NOT instruct the agent to perform an action it cannot perform

An error message on the MCP surface is read by an agent that will act on it, so a message naming an unreachable remedy costs a wasted turn and, worse, teaches the agent a false model of its own connection. Every structured error message SHALL name only remedies reachable by the party it addresses, and SHALL NOT contradict the `instructions` block delivered on the same connection.

Two consequences are normative:

- The `scope_locked` message returned for `memory.save({scope: 'global'})` on a path-scoped connection SHALL NOT instruct the agent to open a second MCP connection. An agent cannot: each client has one MCP entry and the bridge derives its URL path from the project's `.rembric` file, so only the operator can add another. The message SHALL name the bound project (as already required), SHALL state that user-wide memory is not reachable on this connection, in agreement with the path-scoped `instructions` note, and SHALL name a remedy the agent or the operator can actually apply.
- The `forbidden` message returned when a token pinned to exactly one project is denied a global-scope action on a path-less connection SHALL name the way out — activating that project with `project.use({slug})`, or reconnecting at `/mcp/<slug>`. Naming only the token scope and the denied target reads as a misconfigured token and hides a one-call fix. This requirement changes no authorization outcome: the denial itself is correct and unchanged.

#### Scenario: `scope_locked` does not promise a second connection

- **GIVEN** a path-scoped connection at `/mcp/foo`
- **WHEN** the client calls `memory.save` with `scope='global'`
- **THEN** the error message SHALL contain the bound project's slug
- **AND** the message SHALL NOT instruct opening or connecting to a second MCP connection
- **AND** the message SHALL state that user-wide memory is not reachable on this connection

#### Scenario: `scope_locked` agrees with the connection's own instructions

- **WHEN** the path-scoped `instructions` variant and the `scope_locked` message are compared for the same connection
- **THEN** neither SHALL assert that user-wide memory is reachable from this connection

#### Scenario: A project-pinned token on a path-less connection is told the remedy

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>` and no active project
- **WHEN** the client calls `memory.context` or `memory.search`
- **THEN** the call SHALL be refused with `code: 'forbidden'` (unchanged)
- **AND** the message SHALL name `project.use` and SHALL name the slug `foo`

#### Scenario: A full-access token's denial message is unaffected

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `read:*`
- **WHEN** the client calls a write-classified tool
- **THEN** the refusal SHALL carry `code: 'forbidden'` and the message SHALL NOT suggest `project.use`, since no project pin exists to activate
