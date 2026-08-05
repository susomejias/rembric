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

### Requirement: Every MCP tool input schema MUST refuse an unknown property rather than ignore it

Every registered tool SHALL validate its arguments against a **strict** object schema: a property the tool does not declare SHALL be refused, naming both the tool and the offending property, and the call SHALL NOT reach the handler.

The reason is retirement, not tidiness. MCP has no version negotiation (see the release-sequencing decision that splits this change across two releases), so a client pinned to an older plugin keeps sending the arguments it was built against, and the server cannot detect that it is old. Under a schema that silently drops unknown properties, a retired argument keeps parsing forever and quietly means something different from what the caller intends — `include_global: true` on a connection that can no longer widen anything reads as consent to a result set the caller did not ask for. A refusal that names the property tells the operator to upgrade; a silent drop tells them nothing. It is also the only way the published manifest becomes true: `tools/list` already advertises `additionalProperties: false` for every tool, so a server that strips instead of refusing publishes a constraint it does not enforce.

Strictness SHALL apply uniformly to the whole tool surface and SHALL NOT carry a per-tool exception list — an exempt tool is where the next retired argument goes on meaning something. It SHALL be applied at the single seam where tool input shapes are registered, so a tool added later inherits it rather than opting in, and SHALL reach nested object properties as well as top-level ones.

A refusal for an unknown property is an **argument**-validation failure, not a scope-resolution refusal: it is reported as the transport's own invalid-parameters error and is not required to carry a `DomainError` code. This does not weaken "Scope-sensitive tools MUST share the single async scope resolver", whose subject is the refusal a resolver produces.

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
- **WHEN** the client calls `memory.save`, `memory.search`, `memory.get`, `memory.context`, `project.use` and `memory.session_start` with every argument each of them declares
- **THEN** every call SHALL succeed
- **AND** this scenario is the non-vacuity control for the two above: without it a server that refused everything would satisfy them

#### Scenario: A wrong-typed declared argument fails as it did before

- **WHEN** the client calls a tool with a declared property carrying the wrong type
- **THEN** the call SHALL be refused exactly as it was before strictness, so the pre-existing failure mode is unchanged and the new refusal is attributable to the unknown property alone

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
- **THEN** the call SHALL be rejected by the input schema as an unrecognized argument, and no refusal SHALL name the scope the argument used to request
- **AND** the scenario title predates this change: the argument it names has been removed, so no call can ask for a scope and be refused one. `scope_locked` survives only as a refusal of a project **switch** (see "the surviving `scope_locked` refusals lock a switch, not a scope"); it SHALL NOT be reintroduced as a refusal of a scope

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
- **AND** the scenario title predates this change: a path-less connection is no longer "global", and `project_required` is retired from the MCP surface entirely rather than surviving on a narrower path — the two paths that leave a connection unusable emit their own codes, `project_not_found` for an unresolvable slug and `project_archived` for an archived project, and neither message SHALL name a scope

### Requirement: MCP error messages MUST NOT instruct the agent to perform an action it cannot perform

An error message on the MCP surface is read by an agent that will act on it, so a message naming an unreachable remedy costs a wasted turn and, worse, teaches the agent a false model of its own connection. Every structured error message SHALL name only remedies reachable by the party it addresses, and SHALL NOT contradict the `instructions` block delivered on the same connection.

One consequence is normative:

- The `forbidden` message returned when a token pinned to exactly one project is denied an action on a connection whose resolved scope is a DIFFERENT project — including the default project on a path-less connection — SHALL name the way out: activating the pinned project with `project.use({slug})`, or reconnecting at `/mcp/<slug>`. Naming only the token scope and the denied target reads as a misconfigured token and hides a one-call fix. This requirement changes no authorization outcome: the denial itself is correct and unchanged. The remedy's condition SHALL be expressed in terms of the resolved scope differing from the token's pin, NOT in terms of the resolved scope being global — a global-scope condition becomes permanently false when a path-less connection resolves to a project, which would silently stop the remedy being emitted and regress this requirement to a bare identifier with no next step.

The previously-normative consequence about `scope_locked` as a **scope** refusal is retired with the argument that produced it. `memory.save` accepts no `scope` argument, so no call can request a scope the connection forbids, and no message can promise a user-wide destination. A change SHALL NOT reintroduce a message naming a scope or user-wide memory, nor one instructing the operator to add a path-less `/mcp` entry for user-wide memory.

The `scope_locked` code itself is NOT retired: it survives as the refusal for a **switch** a path-scoped connection cannot perform — `project.use({slug})` or `memory.session_start({project})` naming a project the URL contradicts. That refusal names the bound slug and no scope, so it is outside what the paragraph above forbids, and it is the only refusal for "this connection is fixed by its URL, you cannot change it from a tool". Its message SHALL keep that shape.

#### Scenario: `scope_locked` does not promise a second connection

- **GIVEN** a path-scoped connection at `/mcp/foo`
- **WHEN** every refusal the connection can produce is enumerated
- **THEN** no message SHALL name a scope, SHALL instruct opening or connecting to a second MCP connection, or SHALL mention user-wide memory
- **AND** each enumerated message SHALL be pinned verbatim, not screened against a list of prohibited words — a paraphrase of a prohibited instruction carries none of its words, so only the verbatim pin makes a change to a refusal message visible
- **AND** the scenario title predates this change: `scope_locked` is retired as a scope refusal, and this scenario pins that it does not come back as one

#### Scenario: the surviving `scope_locked` refusals lock a switch, not a scope

- **GIVEN** a path-scoped connection at `/mcp/foo`
- **WHEN** the client calls `project.use({slug: 'bar'})` or `memory.session_start({project: 'bar'})`
- **THEN** each call SHALL be refused with `code: 'scope_locked'`
- **AND** each message SHALL name the bound slug `foo`, and SHALL name no scope, promise no second connection and mention no user-wide memory

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

### Requirement: The MCP server MUST expose a `memory.archive` tool

The server SHALL register an MCP tool `memory.archive` that retires a single memory by flipping its `status` from `active` to `archived`. The tool SHALL accept `{ id: string }` (validated by zod; non-empty) and SHALL NOT accept a `scope` argument. It SHALL resolve the effective scope exactly like the other single-memory tools (`memory.get`/`memory.confirm`, via `resolveEffectiveScope`) and delegate to `MemoryService.archive(id, scope)`, so archiving is confined to the connection's one effective scope: a `/mcp/<slug>` connection archives in that project's scope; a `/mcp` connection archives in the project the router pinned (via `project.use`), or in the default project when nothing else resolved.

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

### Requirement: The MCP server MUST expose three research tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.context`, `memory.timeline`, and `memory.capture_passive` with the following contracts. Note that `memory.save_prompt` (write side) and `memory.search_prompts` (read side) are registered in their own dedicated requirements; this requirement scopes the research/context tools only.

Both of `memory.context`'s queue channels SHALL be returned with the scoped TOTAL of the queue they page, because a page whose depth is invisible cannot be told from an exhausted queue. `needsReview` has carried `needsReviewTotal` since it was introduced; `pendingJudgments` SHALL carry `pendingJudgmentsTotal` on the same terms.

Both of those pending channels SHALL be restricted to ADJUDICABLE pairs — a pending relation whose source AND target are both `status = 'active'` (see the `memory` capability, "A pending judgment MUST be withheld from the agent queue once either endpoint is retired"). The list and the total SHALL apply that restriction identically, so the total remains the depth of the queue the list pages rather than a depth the list can never reach.

`memory.context`'s four size arguments are bounded by its declared input schema — `sessions` 25, `prompts` 50, `memories` 100, `judgments` 50 — and a value above a maximum SHALL be REJECTED as an invalid argument rather than silently clamped, consistent with every other numeric bound on this surface (see "`memory.search` and `memory.get` MUST expose the annotation bound and its true total"). Because no clamping can occur over the transport, the response SHALL NOT carry a field reporting that an argument was clamped (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"). The handler MAY retain an in-process clamp as a defensive bound for a future direct caller that bypasses the input schema; such a clamp is unobservable over the transport and SHALL NOT be reported in the response.

#### Scenario: `memory.context` returns a bootstrap snapshot

- **WHEN** an MCP client calls `memory.context` with `{ sessions?: number, prompts?: number, memories?: number, judgments?: number, includeArchived?: boolean }`
- **THEN** the server SHALL return `{ scope, recentSessions, recentPrompts, recentMemories, relevantMemories, pendingJudgments, pendingJudgmentsTotal, needsReview, needsReviewTotal }` — where `scope` is the resolved scope label, as on `memory.stats` — plus `rankedPass` when the ranked pass executed (see "`memory.context` MUST offer a relevance channel alongside recency"), with each list scoped to the request context (the connection's one project)
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
- **WHEN** an MCP client scoped to project A calls `memory.context`
- **THEN** `pendingJudgmentsTotal` SHALL NOT count it

#### Scenario: `needsReview` is unary and disjoint from `pendingJudgments`

- **GIVEN** a scope containing one `active` memory past its review shelf life AND one aged pending relation between two other memories
- **WHEN** an MCP client calls `memory.context`
- **THEN** the stale single memory SHALL appear only in `needsReview` (carrying `id`, not `sourceId`/`targetId`) and the aged relation SHALL appear only in `pendingJudgments` — no entry SHALL appear in both lists

#### Scenario: `needsReview` respects scope

- **GIVEN** an `active` memory past its review shelf life that belongs to project B
- **WHEN** an MCP client calls `memory.context` on a connection scoped to project A
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
- **WHEN** the caller's scope is `read:project:<id>` and the connection's effective scope resolves to a different project
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

`memory.doctor` and `memory.stats` return counters under colliding names over two different populations: doctor's are server-wide (every project), stats' are resolved against the request context. `memory.stats` carries a top-level `scope` field and `memory.doctor` carries none, but a client SHALL NOT be expected to infer one tool's semantics from the ABSENCE of a field in another. The counters therefore differ in value with nothing on the wire to explain it, and two readers of this codebase have already drawn a wrong conclusion from the collision. The tool description is the surface the model reads before deciding to call, so the disclosure belongs there.

`memory.doctor`'s registered description SHALL:

- state that the report is SERVER-WIDE, covering every project;
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
- **THEN** the description SHALL convey that the report is server-wide across every project
- **AND** the description SHALL name `memory.stats` as the source of the scoped equivalents and SHALL convey that the two will differ
- **AND** the description SHALL name `entities`, `sessions` and `review` among the blocks returned

#### Scenario: `memory.doctor`'s description does not advertise the removed `llm` block

- **WHEN** an MCP client retrieves the tool description for `memory.doctor` via `tools/list`
- **THEN** the description SHALL NOT contain the substring `LLM` in any letter case
- **AND** a `memory.doctor` call in the same session SHALL return a payload for which `'llm' in payload` is `false`, so the description and the payload agree

#### Scenario: `memory.stats`' description names its queue-depth totals and the divergence

- **WHEN** an MCP client retrieves the tool description for `memory.stats` via `tools/list`
- **THEN** the description SHALL name `needsReviewTotal` and `pendingJudgmentsTotal`
- **AND** the description SHALL still convey that its counters are scoped to the active project
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

### Requirement: The MCP server MUST expose three project-management tools under the `project.*` namespace

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `project.use`, `project.list`, and `project.current` with the following contracts. Tool names live under the top-level `project.*` namespace (not `memory.project_*`) to distinguish project management from memory CRUD.

`project.list`'s per-project count SHALL be named `activeMemoryCount` and SHALL count only memories whose `status` is `active`, in that project's scope. The name carries the filter because the count's previous name, `memoryCount`, stated neither dimension and was measured disagreeing with the corpus the same connection could read: after `memory.archive` on a project's only memory, `project.list` reported `1` while `memory.search` in that same scope returned `0`. The name is additionally reused elsewhere in the server for a different aggregate (memories saved in one session), so a bare `memoryCount` on this payload is ambiguous in two ways at once. Renaming rather than silently re-filtering is required: a changed value under an unchanged key gives a consumer no signal to re-read the contract.

`activeMemoryCount` SHALL be computed by a repository read that takes the scope as a required parameter (see the `data-access` requirement "`project.list`'s per-project memory count MUST be a scoped repository read"). The scope SHALL be derived from the project row being reported, and the token-authorization filter over project rows SHALL be applied BEFORE any count is taken, so the handler can only count a scope the token was already authorized to read. This ordering is the entire basis on which a handler may name its own scope, and it SHALL NOT be relaxed into a post-filter.

`project.list` SHALL NOT resolve an effective scope from the request context in order to produce the count, and SHALL continue to succeed on a connection whose URL slug resolves to no project (see "the connection is not bricked by the refusal").

`project.list` SHALL NOT report a second, unfiltered per-project total. The per-status breakdown scoped to the request context is `memory.stats`' `memoriesByStatus`, and a second total on this payload would answer the same question on a path that deliberately does not resolve the caller's scope.

`project.list`'s registered top-level description SHALL state that the count is of active memories. This SHALL be in the description string returned by `tools/list`, not only in a schema `describe()`, which some clients do not surface to the model.

#### Scenario: `project.use` activates an existing slug

- **WHEN** an MCP client calls `project.use({slug: 'rembric'})` and no project is currently active for the session
- **AND** a project row exists with `slug = 'rembric'`
- **THEN** the server SHALL activate that project for the session and SHALL return `{ slug: 'rembric', projectId, created: false, switched: false, source: 'tool-explicit' }`

#### Scenario: `project.use` with the same slug as currently active is idempotent

- **WHEN** `project.use({slug})` is called where `slug` matches the project already active for the session
- **THEN** the server SHALL return `{ slug, projectId, created: false, switched: false }` and SHALL NOT mutate any state

#### Scenario: `project.use` against a different active project requires `confirmSwitch`

- **WHEN** `project.use({slug: 'api'})` is called where the session is already active in project `'rembric'` and `confirmSwitch` is omitted or `false`
- **THEN** the call SHALL be rejected with code `project_switch_requires_confirm` and a payload `{ currentSlug: 'rembric', targetSlug: 'api' }`

#### Scenario: `project.use` against a different active project with active session

- **WHEN** `project.use({slug: 'api', confirmSwitch: true})` is called where the session is active in project `'rembric'` AND a Rembric session is currently `status = 'active'` for this MCP transport session
- **THEN** the call SHALL be rejected with code `session_active_must_end` and a payload `{ activeSessionId }`, instructing the agent to call `memory.session_summary` (or `memory.session_end`) first

#### Scenario: `project.use` against an unknown slug without `autocreate`

- **WHEN** `project.use({slug: 'does-not-exist'})` is called and no project with that slug exists
- **THEN** the call SHALL be rejected with code `project_not_found` and a payload `{ suggestedSlugs: string[] }` of up to 3 deterministic Levenshtein-≤3 suggestions

#### Scenario: `project.use` with `autocreate` creates a valid slug

- **WHEN** `project.use({slug: 'new-thing', autocreate: true})` is called where no project has that slug and no other project is active for the session
- **AND** the slug matches the strict regex
- **THEN** the server SHALL insert a new `projects` row and activate it, returning `{ slug, projectId, created: true, switched: false }`

#### Scenario: `project.use` with `autocreate` and an invalid slug

- **WHEN** `project.use({slug: 'Bad_Slug', autocreate: true})` is called
- **THEN** the call SHALL be rejected with code `invalid_slug` and SHALL NOT insert a row

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
- **THEN** the server SHALL return `{ slug: string | null, projectId: string | null, source: 'url-path' | 'roots' | 'tool-explicit' | 'default' | 'none', suggestedSlugs: string[] }` where `source: 'default'` reports the default-project fallback — a resolution that happened, so it SHALL NOT be reported as `'none'` — and `suggestedSlugs` is populated by the most recent `roots/list` derivation that did NOT auto-activate (existing-but-already-active, or non-existing)

### Requirement: Tools that attach a write to a session MUST accept an explicit `sessionId` override, reinforced in their descriptions

`memory.save`, `memory.session_summary`, `memory.session_end`, `memory.save_prompt`, and `memory.capture_passive` SHALL accept an optional `sessionId: string` argument. When provided, it SHALL take precedence over the transport's own session resolution (the `SessionRouter` entry, then the ambiguous-active-session fallback) — mirroring the explicit-first precedence `memory.session_summary`/`memory.session_end` already apply via `resolveSessionId`. Each tool's description SHALL mention `sessionId` explicitly (not only via the input schema's per-argument `describe()`, since some MCP clients do not surface per-property schema descriptions to the model) with guidance to pass it only if genuinely known and never invent one.

This closes a blind spot: `memory.session_summary`'s and `memory.session_end`'s zod schemas already declared `sessionId` as optional, but their tool descriptions never mentioned it — a model reading only the description had no reason to believe passing it was possible. `memory.save` and `memory.save_prompt` did not accept the argument at all prior to this requirement.

An explicit `sessionId` on the write-_attaching_ tools (`memory.save`, `memory.save_prompt`, `memory.capture_passive`) SHALL be validated before it is honored. The server SHALL resolve the named session row and require that it (a) is owned by the caller's token (`token_id` matches the request context), (b) belongs to the caller's effective project (`project_id` equals the connection's resolved project id), and (c) is not soft-deleted (`deleted_at IS NULL`). When (a) or (b) fails, the call SHALL be rejected with code `session_not_found` — the same masking code the session-lifecycle tools use, so a caller cannot probe which session ids exist under other tokens or projects. When (a) and (b) pass but (c) fails, the call SHALL be rejected with code `session_deleted`. On rejection no row SHALL be written. Validation applies only when `sessionId` is explicitly supplied; the transport/active-session fallback paths already resolve to a session owned by the caller within the effective scope. An `ended` (but not soft-deleted) session remains a valid attachment target. `memory.session_summary`/`memory.session_end` retain their existing service-layer cross-token + soft-delete checks. This closes a security blind spot: prior to this requirement an explicit `sessionId` was honored verbatim, letting a caller forge an attachment to another token's or another project's session.

#### Scenario: memory.save accepts and prioritizes an explicit sessionId

- **GIVEN** two sessions are concurrently active for the same `(tokenId, projectId)` (the ambiguous-fallback case where auto-resolution returns null)
- **WHEN** the agent calls `memory.save({..., sessionId: '<S>'})` with an explicit, valid session id
- **THEN** the saved memory's `session_id` SHALL be `'<S>'`, NOT null — the explicit value bypasses the ambiguous fallback entirely

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

### Requirement: The MCP server MUST expose `memory.save_prompt` with optional metadata and refine semantics

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.save_prompt` for persisting curated user prompts. Input schema:

- `content: string` (required, non-empty after trim).
- `title: string` (required, ≤100 chars).
- `tags?: string[]` (optional; each element is a non-empty string).
- `replaces?: string` (optional; ULID of a predecessor prompt in the same scope).
- `sessionId?: string` (optional; when provided, takes precedence over the session-attach helper's own resolution — see the `sessionId` reinforcement requirement below).

Standard behaviour: the server SHALL insert a new row into `prompts` with `content`, `title`, `tags`, the resolved `session_id` (the caller's explicit `sessionId` when provided, else the existing session-attach helper), the active scope's `project_id`, and `agent` copied from the token name. The row SHALL be created with `deleted_at = NULL`, `replaces = NULL`.

Refine behaviour: when `replaces` is provided, the server SHALL run an atomic SQLite transaction that:

1. Loads the predecessor row by id.
2. Rejects with `prompt_not_found` if no row exists.
3. Rejects with `prompt_scope_mismatch` if the predecessor's `project_id` does not match the active scope's `project_id`.
4. Rejects with `prompt_already_deleted` if the predecessor's `deleted_at IS NOT NULL`.
5. Sets the predecessor's `deleted_at = now()`.
6. Inserts the new prompt row with `replaces = [<predecessorId>]`.
7. Returns `{ ok: true, id: <newId>, createdAt: <ts>, replaces: [<predecessorId>] }`.

On `replaces=null`/unset, the response SHALL be `{ ok: true, id: <newId>, createdAt: <ts> }`.

#### Scenario: `memory.save_prompt` persists optional title and tags

- **WHEN** the agent calls `memory.save_prompt({ content: "ship the auth refactor by Friday", title: "auth refactor deadline", tags: ["deadline", "auth"] })`
- **THEN** the persisted row SHALL have `title = "auth refactor deadline"` and `tags = '["deadline","auth"]'` (JSON encoded)
- **AND** the row SHALL be indexed in `prompts_fts` with both `content` and the flattened `tags` string

#### Scenario: `memory.save_prompt` rejects title over 100 chars

- **WHEN** the agent submits `title: "A".repeat(101)`
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: `memory.save_prompt` refine soft-deletes the predecessor atomically

- **GIVEN** an active prompt `P1` in project `foo`
- **WHEN** the agent calls `memory.save_prompt({ content: "...refined...", replaces: "<P1.id>" })` from a `/mcp/foo` connection
- **THEN** in a single transaction: `P1.deleted_at` SHALL be set to the current timestamp; a new row `P2` SHALL be inserted with `P2.replaces = ["<P1.id>"]`
- **AND** the response SHALL include `{ ok: true, id: "<P2.id>", replaces: ["<P1.id>"] }`

#### Scenario: `memory.save_prompt` rejects refine when the predecessor is not in the active scope

- **GIVEN** a prompt `P1` belonging to project `foo`
- **WHEN** the agent (on a `/mcp/bar` connection) calls `memory.save_prompt({ content: "...", replaces: "<P1.id>" })`
- **THEN** the call SHALL be rejected with code `prompt_scope_mismatch`
- **AND** `P1` SHALL remain active

#### Scenario: `memory.save_prompt` rejects refine when the predecessor is already deleted

- **GIVEN** a prompt `P1` with `deleted_at IS NOT NULL`
- **WHEN** the agent calls `memory.save_prompt({ content: "...", replaces: "<P1.id>" })`
- **THEN** the call SHALL be rejected with code `prompt_already_deleted`
- **AND** no new row SHALL be inserted

#### Scenario: `memory.save_prompt` rejects refine when the predecessor does not exist

- **WHEN** the agent calls `memory.save_prompt({ content: "...", replaces: "01HVALIDLOOKINGBUTUNKNOWN" })`
- **THEN** the call SHALL be rejected with code `prompt_not_found`

#### Scenario: `memory.save_prompt` plain save (no tags, no replaces)

- **WHEN** the agent calls `memory.save_prompt({ content: "save me", title: "remember to save" })` with no tags and no replaces
- **THEN** the call SHALL succeed and the row SHALL have `tags = NULL`, `replaces = NULL`
- **AND** the response SHALL be `{ ok: true, id: <ulid>, createdAt: <ts> }`

#### Scenario: `memory.save_prompt` rejects calls missing `title`

- **WHEN** the agent calls `memory.save_prompt({ content: "save me" })` without a `title`
- **THEN** the call SHALL be rejected with code `invalid_input` (zod validation failure: title is required)

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

The tool SHALL resolve effective project via the existing `scopeFromContext` precedence (path-scoped `ctx.project` → `SessionRouter` pin → the default project). It SHALL NOT leak prompts from any other scope.

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

### Requirement: Every MCP tool call MUST be authorized against the token's scope

Every registered MCP tool except `memory.about` SHALL be classified as `read` or `write` and SHALL, before touching any data, resolve the connection's effective scope through the single async resolver (path slug → roots discovery → `SessionRouter`) and check `isAuthorized(tokenScope, action, resolvedScope)`. A failed check SHALL be rejected with code `forbidden`. Tools that accept a `scope` input (`memory.save`, `memory.search`) SHALL authorize the requested scope after their existing input-driven resolution. The path-scoping error contract (`scope_locked`, `project_required`, `project_not_found`, `project_suggestion_pending`) SHALL be preserved unchanged and SHALL be evaluated before the authorization check where it applies today.

Write classification: `memory.save`, `memory.save_prompt`, `memory.capture_passive`, `memory.confirm`, `memory.judge`, `memory.compare`, `memory.session_start`, `memory.session_summary`, `memory.session_end`. `memory.compare` is a write because it always persists a `memory_relations` row (`status='judged'`) and, for `relation='supersedes'`, flips the target memory's `status` to `superseded` and appends to the source's `replaces[]` — a lifecycle mutation, not a read. Read classification: `memory.search`, `memory.get`, `memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.search_prompts`, `memory.suggest_topic_key`, `memory.session_get`, `project.use` (against the requested project), `project.current`. `project.list` SHALL filter its result to the projects the token is authorized to read: `*` and `read:*` tokens see all projects; `project:<id>` and `read:project:<id>` tokens see only that project.

`project.use({autocreate: true})` on a slug that does not yet exist is a WRITE (it mints a new project row), even though `project.use` is otherwise read-classified: the server SHALL check `isAuthorized(tokenScope, 'write', {scope: 'project', projectId: null})` before creating the row. `autocreate: true` against an ALREADY-existing slug is unaffected (no row is created, so the normal read check against the resolved project applies).

#### Scenario: Read-restricted token attempts a formerly-ungated write

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, or `memory.judge`
- **THEN** the call SHALL be rejected with code `forbidden` and no row SHALL be written

#### Scenario: Read-restricted token attempts memory.compare

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.compare` with any two in-scope memories
- **THEN** the call SHALL be rejected with code `forbidden`, no `memory_relations` row SHALL be written, and no target memory's `status` SHALL change

#### Scenario: A read-only token cannot autocreate a project

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token calls `project.use({slug: 'brand-new-slug', autocreate: true})` for a slug that does not yet exist
- **THEN** the call SHALL be rejected with code `forbidden` and no project row SHALL be created

#### Scenario: A full-access token can still autocreate a project

- **GIVEN** a token with scope `*`
- **WHEN** the token calls `project.use({slug: 'brand-new-slug', autocreate: true})` for a slug that does not yet exist
- **THEN** the project SHALL be created and the call SHALL succeed

#### Scenario: Project-restricted token reads another project's context

- **GIVEN** a token with scope `read:project:A` or `project:A`
- **WHEN** the token opens `/mcp/B` (or resolves project B via `project.use`/roots discovery) and calls `memory.context`, `memory.timeline`, `memory.stats`, `memory.search_prompts`, or `memory.session_get`
- **THEN** the call SHALL be rejected with code `forbidden` and no project-B data SHALL be returned

#### Scenario: Project-restricted token on an unscoped connection resolving global scope

The title predates this change: the scope a path-less connection resolves is the default project.

- **GIVEN** a token with scope `read:project:A` connected to `/mcp` with no active project
- **WHEN** the token calls a read tool whose effective scope resolves to the default project
- **THEN** the call SHALL be rejected with code `forbidden`; after `project.use A` (authorized) the same call SHALL succeed against project A

#### Scenario: `project.list` is filtered by token scope

- **GIVEN** projects A and B exist and a token with scope `project:A`
- **WHEN** the token calls `project.list`
- **THEN** the response SHALL contain project A only

#### Scenario: Full-access tokens are unaffected

- **GIVEN** a token with scope `*`
- **WHEN** it invokes any tool on any `/mcp*` connection
- **THEN** authorization SHALL never reject the call (path-scoping errors still apply)

### Requirement: `memory.judge` and `memory.compare` MUST validate their targets against the connection's effective scope

`memory.judge` SHALL resolve the pending judgment (and `memory.compare` its two memories) through a scope-parameterized service read using the connection's effective scope. A judgment or memory outside that scope SHALL be rejected with code `not_found` (never `forbidden`), so cross-scope existence does not leak, matching the cross-scope-read invariant of `memory.get`.

#### Scenario: Judging a pending relation that belongs to another project

- **GIVEN** a pending judgment created in project B
- **WHEN** a connection whose effective scope is project A (any token) calls `memory.judge` with that `judgmentId`
- **THEN** the call SHALL be rejected with code `not_found` and the relation SHALL remain pending

#### Scenario: Comparing memories from another scope

- **WHEN** a connection whose effective scope is project A calls `memory.compare` naming a memory stored in project B
- **THEN** the call SHALL be rejected with code `not_found`

#### Scenario: A bogus judgmentId is indistinguishable from an out-of-scope one

- **WHEN** `judgmentId` matches no row anywhere (never existed), single form
- **THEN** the call SHALL be rejected with code `not_found` — the same code an out-of-scope-but-existing `judgmentId` produces, so a caller cannot use the response to infer whether the id exists in another scope. This supersedes the literal `memory_not_found` code the (now-internal-only) unscoped `RelationsService.judge` raises; `memory.judge` always calls the scope-parameterized `judgeInScope`, whose "not found" and "found but out of scope" paths are the same query and therefore the same code.
- **AND** in the batch form, each item's `code` field follows the same rule: an unknown-or-out-of-scope `judgmentId` reports `code: 'not_found'`, not `memory_not_found`

### Requirement: `memory.search` MUST accept an `entity` filter, and no new tool SHALL be added

Exact-address retrieval SHALL be reachable as an `entity` argument on `memory.search` rather than as a new tool. The MCP tool surface is already at the practical ceiling for reliable tool selection — 23 tools with four clusters the model cannot easily distinguish — so a capability expressible as an argument SHALL be an argument.

When `entity` is supplied, the response SHALL be the scoped set of memories linked to that entity, chronologically ordered, and the response SHALL indicate that the entity path was taken rather than the ranked text-query path, so the agent does not read the absence of relevance scores as a defect.

Completeness is bounded, and the bound SHALL be the same generous over-fetch ceiling the ranked branches use rather than the ranked default page size: an omitted `limit` on the entity path means "every linked memory in scope" up to that ceiling, NOT the small default that is calibrated for a ranked page. Returning eight rows out of twelve under a description promising completeness is a correctness problem, because the agent has no signal that anything was withheld. An explicit `limit` SHALL still bound the page.

`entity` SHALL compose with every other selection filter `memory.search` accepts — `status`, `type`, `tag` and `topic_key` — applying the same predicates with the same meaning as on the ranked path. A filter that is documented as combinable but silently dropped is worse than an unsupported one: an agent that narrows to `type: 'user'` and receives unfiltered rows reads project notes as user preferences. An OMITTED `status`, however, SHALL mean "any but archived" here rather than the ranked branches' `active` default — the same reason an omitted `limit` means the generous bound: this path is specified as complete within scope, and inheriting the ranked default would withhold the `superseded` history exactly as the ranked default page withheld the twelfth row. An explicit `status` SHALL filter exactly, `superseded` and `archived` included. Combining `entity` with a text `query` SHALL narrow within the entity's memories rather than fusing two result sets.

An empty entity result SHALL say whether the index has caught up. The tool's own guidance is "empty means it is not there, so retry with `query`" — which is wrong for as long as the extraction drain is still running, and after a recipe change that is the state of the whole corpus. When an `entity` lookup returns nothing AND the scope still holds memories awaiting their first scan, the response SHALL carry a draining flag, and the argument's description SHALL name it so the agent retries the same lookup rather than degrading to text. A non-empty result and a miss over a fully-scanned scope SHALL NOT carry it, so its presence always means something.

#### Scenario: Retrieving everything known about a file

- **WHEN** `memory.search` is called with an `entity` naming a file path present in scope
- **THEN** every in-scope memory linked to that path SHALL be returned in chronological order

#### Scenario: An omitted limit returns the whole linked set, not a ranked page

- **GIVEN** twelve in-scope memories linked to one entity
- **WHEN** `memory.search` is called with that `entity` and no `limit`
- **THEN** all twelve SHALL be returned

#### Scenario: An omitted status returns the entity's non-archived history

- **GIVEN** three in-scope memories linked to one entity, one `active`, one `superseded` and one `archived`
- **WHEN** `memory.search` is called with that `entity` and no `status`
- **THEN** the `active` and the `superseded` row SHALL be returned and the `archived` row SHALL NOT
- **AND** each of `status: 'active'`, `'superseded'` and `'archived'` SHALL return exactly its own row

#### Scenario: The response distinguishes the entity path

- **WHEN** `memory.search` returns results for an `entity` lookup
- **THEN** the response SHALL indicate that exact-address retrieval was used

#### Scenario: An unknown entity returns empty rather than falling back to text search

- **WHEN** `memory.search` is called with an `entity` that exists nowhere in scope
- **THEN** the response SHALL be empty and SHALL NOT silently degrade into a text query over that string
- **AND** when the scope is fully scanned the response SHALL NOT carry the draining flag

#### Scenario: An empty lookup during a drain is marked as such

- **GIVEN** an in-scope memory referencing an identifier, saved but not yet scanned for entities
- **WHEN** `memory.search` is called with that `entity`
- **THEN** the response SHALL be empty AND SHALL carry the draining flag
- **AND** after the drain completes, the same call SHALL return the memory and SHALL NOT carry the flag

#### Scenario: Entity plus text query narrows rather than fuses

- **WHEN** `memory.search` is called with both an `entity` and a text `query`
- **THEN** the result SHALL be the entity's memories ranked by the text query, not a fusion of two independent result sets

#### Scenario: Entity combines with type and status

- **GIVEN** one entity linked to a `user` memory, a `project` memory and an `archived` memory
- **WHEN** `memory.search` is called with that `entity` and `type: 'user'`
- **THEN** only the `user` memory SHALL be returned
- **WHEN** the same call passes `status: 'archived'` instead
- **THEN** only the archived memory SHALL be returned

#### Scenario: Entity combines with include_global

The title predates this change: the argument it names is retired, and what the scenario now pins is that the entity branch admits no row outside the connection's project.

- **GIVEN** two memories in the connection's project linked to the same path, and another project's memory linked to it too
- **WHEN** `memory.search` is called with that `entity`
- **THEN** both in-scope memories SHALL be returned, the other project's memory SHALL NOT, and no argument SHALL widen the branch past the resolved project

## REMOVED Requirements

### Requirement: Path-less MCP writes MUST refuse silent fallback to global when project suggestions are pending

**Reason**: Its precondition can no longer hold. All four gate call sites reduce to "no project is active", and the gate returns null as soon as a project is pinned; with a path-less `/mcp` connection always resolving to the default project, no path reaches a firing return. Retaining a published error code, message and `suggestedSlugs[]` payload for a state the server cannot produce is the unreachable-state defect that "A tool's description and its response MUST agree, and neither may promise an unreachable state" forbids; per that requirement's three-remedy rule the remedy applied is **remove the field or claim**.

Two of this requirement's own statements were also measured FALSE before removal, and are corrected rather than carried: `memory.save` never silently fell back to global, because its `scope` argument defaulted to `'project'` and a path-less connection with no active project returned `project_required` loudly. The gate WAS load-bearing for `memory.session_start`, `memory.save_prompt` and `memory.capture_passive`, which without it wrote global-scope rows silently.

**Migration**: The `project_suggestion_pending` error code is retired from the MCP surface, along with the four call sites, the gate helper and its message constructor. Writes on a path-less connection with unminted roots suggestions now succeed against the default project. What is lost is misfiling protection, not leak protection: the destination is a closed project, `project.current` names it, and the corpus is append-only with `topic_key` supersede, so a misfiled memory is re-saved under the right project rather than edited or lost. Roots discovery still activates an EXISTING project when one matches; `project.use({slug, autocreate: true})` remains the way to mint a new one.

### Requirement: `include_global` MUST be ignored unless the connection is authorized for global reads

**Reason**: The argument this requirement gates is deleted. It is the fix for GHSA-cc4j-ch4r-9pf5 on the MCP side, and it has no referent once no argument can widen a project-scoped result. Retaining it would publish an authorization rule for an input property the schema rejects.

The scope-agnostic principle it rests on is NOT retired: it survives, generalised, in the `auth` capability's "A read whose result set is widened past the effective scope MUST re-authorize against the wider scope" — a token SHALL NOT receive rows from a scope it is not authorized to read, whatever argument requested them. That sentence outlives the argument that occasioned it, and any future widening argument is bound by it from the moment it is proposed.

**Migration**: `include_global` is removed from `memory.search`'s input schema, from the service and repository option bags it threaded through, from the widening branch of the shared scope predicate, and from the entity-lookup widening the `memory-entities` capability defined as mirroring it. The `includeGlobal` construction invariant added to close issue #304 is deleted with it: it exists solely to keep one boolean constructible in one file, and there is no longer a boolean to construct. A client that passes the argument receives a schema rejection rather than a silent no-op, which is the loud failure this repo prefers over changed semantics under an unchanged key.
