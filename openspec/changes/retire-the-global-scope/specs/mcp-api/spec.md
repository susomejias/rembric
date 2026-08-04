## ADDED Requirements

### Requirement: A path-less `/mcp` connection MUST resolve to the default project

A connection at `/mcp` with no path slug SHALL resolve its effective scope to the **default project** — the single `projects` row marked as the system default (see the `projects` capability). There SHALL be no state in which a connection is authenticated but has no project scope, and no tool SHALL be reachable in such a state.

Every site that previously fell back to the global scope on a path-less connection SHALL target the default project instead, and the set of such sites SHALL be exhaustive rather than sampled: the shared scope resolver, `memory.session_start`'s project binding, `project.current`'s authorization target, and the pinned-token remedy builder. A site missed here does not fail — it silently authorizes against, or reports, a scope that no longer exists.

`project.use` SHALL still switch the connection to another project the token is authorized to read, and the default project SHALL be an ordinary target of that switch. Switching the single closed scope is not widening it: no read admits two projects' rows, and a token authorized for two projects could already move between them.

**Authorization is unchanged and still gates the default project.** A token pinned to one project, connecting path-lessly, SHALL be refused with `code: 'forbidden'` naming the default project — a project it was never granted. The denial is the same denial it receives today against the global scope; only the named target changes, and it changes to one an operator can open. The refusal SHALL carry the pinned-project remedy (see "MCP error messages MUST NOT instruct the agent to perform an action it cannot perform").

#### Scenario: A path-less save with no arguments succeeds

- **GIVEN** a path-less `/mcp` connection, a token authorized to write the default project, and no `.rembric` file, no roots capability and no prior `project.use`
- **WHEN** the client calls `memory.save` with only `type`, `title` and `content`
- **THEN** the call SHALL succeed and the new row SHALL carry the default project's `project_id`
- **AND** the call SHALL NOT be refused with `project_required` or `project_suggestion_pending`

#### Scenario: `project.current` names the default project on a path-less connection

- **GIVEN** a path-less `/mcp` connection with a token authorized to read the default project and no prior `project.use`
- **WHEN** the client calls `project.current`
- **THEN** the response SHALL name the default project's slug and id, and `source` SHALL report that resolution came from the default rather than from a URL path, roots discovery or an explicit tool call

#### Scenario: A project-pinned token is refused, and told the way out

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, where `foo` is not the default project
- **WHEN** the client calls `memory.search` or `project.current`
- **THEN** the call SHALL be refused with `code: 'forbidden'`
- **AND** the message SHALL name `project.use` and SHALL name the slug `foo`

#### Scenario: Switching to another project does not merge two projects

- **GIVEN** a path-less `/mcp` connection resolved to the default project, a token authorized for both it and project `beta`, and memories in each
- **WHEN** the client calls `project.use({slug: 'beta'})` and then `memory.search`, `memory.search` with an `entity`, `memory.context`, `memory.stats`, `memory.get` by id, `memory.get` by ids, and `memory.timeline`
- **THEN** every response SHALL contain only `beta`'s rows and counters, and none SHALL contain a row or counter from the default project

#### Scenario: The default project is listable and usable like any other

- **GIVEN** a token authorized to read the default project
- **WHEN** the client calls `project.list`
- **THEN** the default project SHALL appear as an ordinary entry with its slug, display name, archived flag and `activeMemoryCount`
- **AND** `project.use` with its slug SHALL activate it under the same rules as any other project

### Requirement: No MCP tool surface MAY name a scope the server does not have

`global` is not a scope. No registered tool's description, no input property name, and no per-property `describe()` SHALL name `global`, `include_global`, or `user-wide` memory, and no error message SHALL offer a remedy that reaches one. This is an instance of "A tool's description and its response MUST agree, and neither may promise an unreachable state", and the remedy applied throughout is **remove the field or claim**.

The obligation SHALL be enforced by a test that reads the **live `tools/list` response** rather than the description constants, over **all** registered tools rather than the ones a change happened to edit. A prose sweep that a human performs once is exactly how twenty false statements accumulated; a test over the manifest makes the class non-recurrable.

The test SHALL fail on a reintroduction rather than merely reporting it, and SHALL assert over a non-empty tool set — a manifest read that returned nothing would satisfy every negative assertion vacuously.

#### Scenario: No tool description names a retired scope

- **WHEN** every registered tool's description is read from a real `tools/list` response
- **THEN** none SHALL contain `global`, `include_global` or `user-wide`
- **AND** the number of tools examined SHALL be asserted to be non-zero, so an empty manifest cannot pass

#### Scenario: No input property names a retired scope

- **WHEN** every registered tool's `inputSchema` is read from a real `tools/list` response
- **THEN** no property name SHALL be `scope` or `include_global`, and no property `description` SHALL contain `global` or `user-wide`

#### Scenario: No error message offers a retired remedy

- **WHEN** the refusals a path-less and a path-scoped connection can produce are enumerated
- **THEN** none SHALL instruct the caller to set a scope, to save user-wide, or to add a path-less `/mcp` entry for user-wide memory

## MODIFIED Requirements

### Requirement: Path-scoped connections MUST enforce strict project isolation

When the MCP connection is path-scoped (`/mcp/<slug>`) the server SHALL enforce a hard isolation contract on every tool call. The connection's project is the only scope visible:

- `memory.save` SHALL be persisted with `project_id` equal to the path-bound project regardless of any other argument the agent supplies. There is no argument by which an agent can name a different destination: `memory.save` accepts no `scope` argument, so the destination is determined entirely by the connection the operator configured.
- `memory.search` SHALL return only memories whose `project_id` equals the bound project. No argument SHALL widen the result set past it; `include_global` is removed from the tool's input schema.
- `memory.get` and `memory.confirm` SHALL respond with structured code `not_found` when the requested memory belongs to a different project, regardless of whether the memory exists, to avoid leaking existence across scopes.

Because there is now exactly one kind of scope, the isolation this requirement describes is no longer a property of path-scoped connections specifically — it holds on every connection. What remains specific to a path-scoped connection is that its project is fixed by the URL and cannot be changed by `project.use` for the life of the connection.

A path slug that does not resolve to an existing project SHALL NOT establish any scope. Such a connection has no bound project, so the clauses above have nothing to bind to; instead **every** tool that resolves scope SHALL be refused with structured code `project_not_found`, reads and writes alike, and SHALL NOT fall back to any other project — in particular not to the default project, whose role is to serve path-LESS connections. An operator who typed a slug asked to be confined to it, and answering a typo with someone else's project is worse than refusing.

The `not_found` clause above governs a connection whose slug DOES resolve, where the comparison is between the bound project and the requested memory. On an unresolvable slug there is no bound project to compare against, so `project_not_found` — which names the unusable connection — takes precedence over `not_found`, and the two do not conflict.

#### Scenario: save with scope='global' on a path-scoped connection

- **GIVEN** a path-scoped connection at `/mcp/foo` with a valid token
- **WHEN** the client calls `memory.save` with an argument named `scope`
- **THEN** the call SHALL be rejected by the input schema as an unrecognized argument, and no `scope_locked` code SHALL be emitted by any path
- **AND** the scenario title predates this change: the argument it names has been removed, and the retired `scope_locked` code is not reintroduced under any condition

#### Scenario: search on a path-scoped connection does not leak globals

- **GIVEN** a path-scoped connection at `/mcp/foo` and memories in another project
- **WHEN** the client calls `memory.search`, with or without any additional argument
- **THEN** the response SHALL contain only project `foo`'s memories, and no argument SHALL admit another project's rows
- **AND** the scenario title predates this change: there are no global memories left to leak, and `include_global` is no longer an accepted argument

#### Scenario: get across project boundaries

- **GIVEN** a path-scoped connection at `/mcp/foo` and a memory M whose `project_id` is another project
- **WHEN** the client calls `memory.get('M')`
- **THEN** the response SHALL be an MCP error with `code: 'not_found'`, identical to the response for a non-existent id

#### Scenario: search on an unresolvable slug refuses instead of reading global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and memories in the default project
- **WHEN** the client calls `memory.search`
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'`
- **AND** the response SHALL contain no memory, in particular none from the default project

#### Scenario: get on a global id from an unresolvable slug refuses

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and a memory M in the default project
- **WHEN** the client calls `memory.get({id: M})`
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'` and SHALL NOT return M's `content`

#### Scenario: writes on an unresolvable slug do not land in global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.capture_passive` with text containing a well-formed Key Learnings section, or calls `memory.save_prompt`
- **THEN** each call SHALL be refused with `code: 'project_not_found'`
- **AND** no row SHALL be inserted into `memory` or `prompts`, in the default project or any other

#### Scenario: a session is not opened in the global scope from an unresolvable slug

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.session_start`
- **THEN** the call SHALL be refused with `code: 'project_not_found'`
- **AND** no `agent_sessions` row SHALL be inserted, in the default project or any other

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

The server SHALL accept MCP requests at `/mcp` (which resolves to the default project) and at `/mcp/<project-slug>` (bound to the named project). When the path includes a non-empty slug after `/mcp/`, the server SHALL resolve that slug to a project via `projects.findBySlug(slug)` and SHALL use the resulting project as the request's project scope. Resolution SHALL NOT create a project: auto-create on read is forbidden by the `projects` capability, and creating a project row at the authentication layer would let any token holding `*` mint arbitrary projects by requesting arbitrary URLs, before any write authorization has been checked.

When `findBySlug` returns nothing, the `initialize` handshake SHALL still succeed and the connection SHALL be treated as path-scoped to a project that does not exist — refused per the strict-isolation requirement, never resolved to another project and in particular never to the default project.

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
- **THEN** the request SHALL be accepted with the default project as its scope, and every tool that resolves scope SHALL operate in it
- **AND** no tool SHALL respond with `project_required` on such a connection, because a project is always active
- **AND** the scenario title predates this change: a path-less connection is no longer "global", and `project_required` survives only for the unresolvable-slug and archived-project paths, where its message SHALL name no scope

### Requirement: MCP error messages MUST NOT instruct the agent to perform an action it cannot perform

An error message on the MCP surface is read by an agent that will act on it, so a message naming an unreachable remedy costs a wasted turn and, worse, teaches the agent a false model of its own connection. Every structured error message SHALL name only remedies reachable by the party it addresses, and SHALL NOT contradict the `instructions` block delivered on the same connection.

One consequence is normative:

- The `forbidden` message returned when a token pinned to exactly one project is denied an action on a connection whose resolved scope is a DIFFERENT project — including the default project on a path-less connection — SHALL name the way out: activating the pinned project with `project.use({slug})`, or reconnecting at `/mcp/<slug>`. Naming only the token scope and the denied target reads as a misconfigured token and hides a one-call fix. This requirement changes no authorization outcome: the denial itself is correct and unchanged. The remedy's condition SHALL be expressed in terms of the resolved scope differing from the token's pin, NOT in terms of the resolved scope being global — a global-scope condition becomes permanently false when a path-less connection resolves to a project, which would silently stop the remedy being emitted and regress this requirement to a bare identifier with no next step.

The previously-normative consequence about `scope_locked` is retired with the argument that produced it. `memory.save` accepts no `scope` argument, so no call can request a scope the connection forbids, and no message can promise a user-wide destination. A change SHALL NOT reintroduce a message naming user-wide memory or instructing the operator to add a path-less `/mcp` entry for it.

#### Scenario: `scope_locked` does not promise a second connection

- **GIVEN** a path-scoped connection at `/mcp/foo`
- **WHEN** every refusal the connection can produce is enumerated
- **THEN** no message SHALL contain `scope_locked`, SHALL instruct opening or connecting to a second MCP connection, or SHALL mention user-wide memory
- **AND** the scenario title predates this change: the code it names is retired, and this scenario now pins that it stays retired

#### Scenario: `scope_locked` agrees with the connection's own instructions

- **WHEN** the path-scoped `instructions` variant and every refusal the same connection can produce are compared
- **THEN** neither SHALL assert that user-wide memory is reachable, and neither SHALL name a scope

#### Scenario: A project-pinned token on a path-less connection is told the remedy

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, where `foo` is not the default project
- **WHEN** the client calls `memory.context` or `memory.search`
- **THEN** the call SHALL be refused with `code: 'forbidden'` (unchanged)
- **AND** the message SHALL name `project.use` and SHALL name the slug `foo`

#### Scenario: A full-access token's denial message is unaffected

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `read:*`
- **WHEN** the client calls a write-classified tool
- **THEN** the refusal SHALL carry `code: 'forbidden'` and the message SHALL NOT suggest `project.use`, since no project pin exists to activate

### Requirement: Scope-sensitive tools MUST share the single async scope resolver

All scope-sensitive tools SHALL resolve the effective project through the same async resolver that `memory.save` uses (awaiting roots discovery on unscoped connections). The sync resolver that skipped discovery SHALL be removed. On a path-less connection the resolver SHALL return the default project when neither the URL path, roots discovery nor a prior `project.use` named one; it SHALL NOT return a scopeless result, so no tool can observe an unresolved scope.

The shared resolver SHALL refuse with `project_not_found` rather than returning a scope when the path slug names no project, so no tool routed through it can inherit a fallback by omission — including a tool added after this requirement lands.

A tool that resolves its own project rather than delegating to the resolver SHALL apply the same refusal. One does — `memory.session_start`, which binds the session row to a project — and it SHALL build its message and `suggestedSlugs[]` from the same shared constructor, so the refusals cannot drift in wording or payload. `memory.save` no longer classifies the request before resolving, because it no longer accepts a `scope` argument to classify; it delegates to the resolver like every other tool. That obligation SHALL be verified by enumeration over the registered tool list (below), never by counting resolver call sites — a tool absent from that list of call sites is exactly how this defect reached three separate write paths.

Every tool routed through the resolver SHALL surface that refusal as a structured `mcpError` (`isError: true` with a JSON body carrying `code` and `message`), never as an exception escaping into the transport, because an escaped exception yields an error result with no machine-readable `code`. A tool SHALL therefore resolve scope inside the same error-translating boundary it already uses for authorization failures. Where a tool previously validated its arguments before resolving scope, scope resolution SHALL come first: an unusable connection is reported ahead of a malformed argument, because the call cannot succeed under any arguments.

Coverage SHALL be asserted by enumeration rather than by inspection: a test SHALL drive the registered tool list, invoke every scope-sensitive tool on a connection whose path slug names no project, and assert the structured refusal. Tools exempt from scope resolution SHALL be enumerated explicitly in that test, so a newly registered tool fails it until it is classified.

#### Scenario: `memory.context` at session start on an unscoped connection

- **GIVEN** an unscoped `/mcp` connection whose project is resolvable via MCP roots discovery
- **WHEN** the agent's first tool call is `memory.context` (before any other call has populated the router)
- **THEN** the server SHALL await roots discovery and return the discovered PROJECT's context, not the default project's

#### Scenario: `memory.capture_passive` while a project suggestion is pending

- **GIVEN** an unscoped `/mcp` connection whose roots discovery surfaced a slug that names no project
- **WHEN** the agent calls `memory.capture_passive` or `memory.save_prompt`
- **THEN** the call SHALL succeed against the default project rather than being rejected, and no `project_suggestion_pending` code SHALL be emitted by any path
- **AND** the scenario title predates this change: the gate it names is retired, because with a default project always active its precondition ("no project is active") can never hold

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

### Requirement: `memory.timeline` session neighbors MUST be filtered by the connection's effective scope

`memory.timeline`'s session-neighbor query (used when the target memory has a non-null `session_id`) SHALL filter neighbors by the connection's effective `project_id` in addition to `session_id`, so a neighbor lying outside the effective scope is never returned. Filtering by `session_id` alone is insufficient because a single session can hold memories in more than one project (a path-less connection can call `project.use` mid-session and save into a second project) and because `session_id` carries no foreign key — so without a scope predicate `memory.timeline` could return another project's memory `content`, violating the cross-scope-read invariant that a target memory's own scope gate is meant to uphold. The time-window fallback neighbor query already applies this filter; the session-neighbor query SHALL match it.

#### Scenario: A same-session memory in another scope is not returned

- **GIVEN** a target memory `<M>` in project A with `session_id = <S>`, and another memory `<G>` in project B that also carries `session_id = <S>`
- **WHEN** a connection whose effective scope is project A calls `memory.timeline` with `{ memoryId: '<M>' }`
- **THEN** the returned `before`/`after` neighbors SHALL NOT include `<G>` or its `content`

#### Scenario: In-scope session neighbors are still returned

- **GIVEN** a target memory `<M>` in project A with `session_id = <S>`, and other project-A memories sharing `session_id = <S>`
- **WHEN** a connection whose effective scope is project A calls `memory.timeline` with `{ memoryId: '<M>', before: 5, after: 5 }`
- **THEN** the in-scope same-session neighbors SHALL be returned, ordered chronologically, exactly as before this change

### Requirement: OAuth and static tokens MUST share the path-scoping contract

A connection authenticated by an OAuth access token SHALL be subject to the identical `/mcp` vs `/mcp/<slug>` path-scoping contract as a static-token connection: a path-scoped OAuth connection SHALL be bound to its slug's project, and a path-less OAuth connection SHALL resolve to the default project exactly as a path-less static-token connection does. The authentication mechanism SHALL NOT change scope resolution.

#### Scenario: Path-scoped OAuth connection enforces isolation

- **GIVEN** a connection at `/mcp/foo` authenticated with an OAuth access token
- **WHEN** the client calls `memory.save`
- **THEN** the row SHALL be persisted with `foo`'s `project_id`, and no argument SHALL admit any other destination — identical to the static-token case

#### Scenario: Reserved OAuth paths do not shadow MCP slugs

- **GIVEN** OAuth is enabled
- **WHEN** the server routes requests for `/authorize`, `/token`, `/register`, and `/.well-known/oauth-*`
- **THEN** those SHALL resolve to the OAuth handlers and SHALL NOT be interpreted as `/mcp` project slugs, and `/mcp/<slug>` routing SHALL remain unchanged

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1000 characters or fewer in both variants. This cap is a self-imposed token budget rather than the binding limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, but at least one consuming client DOES impose a ceiling — Claude Code truncates `instructions` at 2048 characters with the same `LB` constant it applies to tool descriptions, appending `… [truncated]`. The 1000-character cap is therefore chosen for token cost, at less than half the known client ceiling, and it binds first. Any future change RAISING this cap SHALL keep it below the verified client ceiling (see "Tool descriptions MUST stay below the client truncation ceiling").

Neither variant SHALL name `global`, `include_global` or user-wide memory (see "No MCP tool surface MAY name a scope the server does not have"). The path-scoped variant SHALL state which project the connection is bound to; the path-less variant SHALL state that a project is always active, name the default project as the scope in effect when nothing else resolved, and name `project.use` as the way to switch.

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline plus the `content`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Mechanical detail (error codes, scope semantics) MAY be deferred to the tool's own `description`.
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
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows (the proactive save flow, the on-demand recall flow, the session-close flow with the `10000`-char cap, AND the `memory.about` update-guidance pointer) and a note stating that a project is always active — naming the default project as the scope in effect, roots-based auto-detection where the client supports it, and `project.use` as the way to switch. It SHALL NOT name the retired `X-Rembric-Project` header, which is asserted absent from both variants by `apps/server/src/mcp/instructions.test.ts`, and SHALL NOT name `global`, `include_global` or user-wide memory.

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

- **WHEN** `apps/server/src/mcp/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substrings `memory.save`, `memory.context`, `memory.session_summary`, AND `memory.about`
- **AND** both outputs SHALL be ≤1000 chars
- **AND** existing assertions for `memory.search`, the scope note, the `10000` cap, and the proactive (non-"done"-bound) session-summary phrasing SHALL pass, with the scope-note assertion updated to the project-only wording

#### Scenario: The instructions cap stays below the client ceiling

- **WHEN** a change raises `INSTRUCTIONS_MAX_LENGTH` above 1000
- **THEN** the new cap SHALL remain below the verified client truncation ceiling for `instructions` (2048 characters in Claude Code 2.1.220)
- **AND** the change SHALL record the ceiling it re-verified, so the cap is never raised past a limit nobody checked

## REMOVED Requirements

### Requirement: Path-less MCP writes MUST refuse silent fallback to global when project suggestions are pending

**Reason**: Its precondition can no longer hold. All four gate call sites reduce to "no project is active", and the gate returns null as soon as a project is pinned; with a path-less `/mcp` connection always resolving to the default project, no path reaches a firing return. Retaining a published error code, message and `suggestedSlugs[]` payload for a state the server cannot produce is the unreachable-state defect that "A tool's description and its response MUST agree, and neither may promise an unreachable state" forbids; per that requirement's three-remedy rule the remedy applied is **remove the field or claim**.

Two of this requirement's own statements were also measured FALSE before removal, and are corrected rather than carried: `memory.save` never silently fell back to global, because its `scope` argument defaulted to `'project'` and a path-less connection with no active project returned `project_required` loudly. The gate WAS load-bearing for `memory.session_start`, `memory.save_prompt` and `memory.capture_passive`, which without it wrote global-scope rows silently.

**Migration**: The `project_suggestion_pending` error code is retired from the MCP surface, along with the four call sites, the gate helper and its message constructor. Writes on a path-less connection with unminted roots suggestions now succeed against the default project. What is lost is misfiling protection, not leak protection: the destination is a closed project, `project.current` names it, and the corpus is append-only with `topic_key` supersede, so a misfiled memory is re-saved under the right project rather than edited or lost. Roots discovery still activates an EXISTING project when one matches; `project.use({slug, autocreate: true})` remains the way to mint a new one.

### Requirement: `include_global` MUST be ignored unless the connection is authorized for global reads

**Reason**: The argument this requirement gates is deleted. It is the fix for GHSA-cc4j-ch4r-9pf5 on the MCP side, and it has no referent once no argument can widen a project-scoped result. Retaining it would publish an authorization rule for an input property the schema rejects.

The scope-agnostic principle it rests on is NOT retired: it survives, generalised, in the `auth` capability's "A read whose result set is widened past the effective scope MUST re-authorize against the wider scope" — a token SHALL NOT receive rows from a scope it is not authorized to read, whatever argument requested them. That sentence outlives the argument that occasioned it, and any future widening argument is bound by it from the moment it is proposed.

**Migration**: `include_global` is removed from `memory.search`'s input schema, from the service and repository option bags it threaded through, from the widening branch of the shared scope predicate, and from the entity-lookup widening the `memory-entities` capability defined as mirroring it. The `includeGlobal` construction invariant added to close issue #304 is deleted with it: it exists solely to keep one boolean constructible in one file, and there is no longer a boolean to construct. A client that passes the argument receives a schema rejection rather than a silent no-op, which is the loud failure this repo prefers over changed semantics under an unchanged key.
