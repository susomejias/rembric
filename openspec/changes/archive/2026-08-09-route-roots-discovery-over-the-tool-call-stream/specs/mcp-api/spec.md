## MODIFIED Requirements

### Requirement: Scope-sensitive tools MUST share the single async scope resolver

All scope-sensitive tools SHALL resolve the effective project through the same async resolver that `memory.save` uses (awaiting roots discovery on unscoped connections). The sync resolver that skipped discovery SHALL be removed. On a path-less connection the resolver SHALL return the default project when neither the URL path, roots discovery nor a prior `project.use` named one; it SHALL NOT return a scopeless result, so no tool can observe an unresolved scope.

The shared resolver SHALL refuse with `project_not_found` rather than returning a scope when the path slug names no project, so no tool routed through it can inherit a fallback by omission — including a tool added after this requirement lands.

A tool that resolves its own project rather than delegating to the resolver SHALL apply the same refusal. One does — `memory.session_start`, which binds the session row to a project — and it SHALL build its message and `suggestedSlugs[]` from the same shared constructor, so the refusals cannot drift in wording or payload. `memory.save` no longer classifies the request before resolving, because it no longer accepts a `scope` argument to classify; it delegates to the resolver like every other tool. That obligation SHALL be verified by enumeration over the registered tool list (below), never by counting resolver call sites — a tool absent from that list of call sites is exactly how this defect reached three separate write paths.

Every tool routed through the resolver SHALL surface that refusal as a structured `mcpError` (`isError: true` with a JSON body carrying `code` and `message`), never as an exception escaping into the transport, because an escaped exception yields an error result with no machine-readable `code`. A tool SHALL therefore resolve scope inside the same error-translating boundary it already uses for authorization failures. Where a tool previously validated its arguments before resolving scope, scope resolution SHALL come first: an unusable connection is reported ahead of a malformed argument, because the call cannot succeed under any arguments.

Coverage SHALL be asserted by enumeration rather than by inspection: a test SHALL drive the registered tool list, invoke every scope-sensitive tool on a connection whose path slug names no project, and assert the structured refusal. Tools exempt from scope resolution SHALL be enumerated explicitly in that test, so a newly registered tool fails it until it is classified.

**The discovery the resolver awaits SHALL be reachable from the tool call that triggered it.** The resolver runs discovery from inside a tool handler, so the identity of that in-flight tool call is available at that point and SHALL be usable by the discovery path without being threaded through every resolver call site. A mechanism that requires each call site to pass it SHALL NOT be used, because a tool added later that omits the argument would silently revert to resolving the default project — the same "absent from the list of call sites" failure mode this requirement already records. The identity SHALL be captured once, at the single registration funnel through which every tool is registered, so a newly registered tool inherits it without action. Where no such identity is available, the resolver SHALL fall back to today's behaviour rather than failing the call.

**The scenario below SHALL be guarded by a test that does not retry.** The test asserting that the first tool call on an unscoped, roots-discoverable connection returns the discovered project SHALL run with retries disabled, and SHALL be exercised in a process that has already served MCP traffic on the same host — not only in a freshly started process. Both conditions are load-bearing and neither is a style preference: measured, this scenario failed on the very first attempt in every warm arm and on none in a cold one, so a test that runs only cold cannot observe the failure, and a retried test asserts only that one of several attempts passed. A cold arm SHALL be retained alongside the warm one as the control, because with only a warm arm a harness that never reaches the discovery path is indistinguishable from a correct one.

**A test that asserts only the resolved scope SHALL NOT be relied on as the guard for the routing behaviour**, because it passes whenever the underlying race is won and therefore passes both before and after a routing fix. The guard SHALL assert the routing property directly: discovery completes while the client's optional standalone server→client stream is absent.

#### Scenario: `memory.context` at session start on an unscoped connection

- **GIVEN** an unscoped `/mcp` connection whose project is resolvable via MCP roots discovery
- **WHEN** the agent's first tool call is `memory.context` (before any other call has populated the router)
- **THEN** the server SHALL await roots discovery and return the discovered PROJECT's context, not the default project's

#### Scenario: The discovered scope holds on the first call in a warm process

- **GIVEN** a server process that has already served MCP traffic for at least three prior client connections
- **AND** a fresh unscoped `/mcp` connection whose client advertises `capabilities.roots` and whose first root's basename names an existing project
- **WHEN** the agent's first tool call is `memory.context`, with test retries disabled
- **THEN** the returned scope SHALL be the discovered project's on the first attempt
- **AND** the same assertion SHALL hold for the equivalent connection in a process that has served no prior traffic

#### Scenario: A connection that lost the discovery request is not stuck in the default project

- **GIVEN** an unscoped `/mcp` connection whose first `roots/list` produced no answer of any kind
- **WHEN** the agent issues a second `memory.context` call on that same connection
- **THEN** the second call SHALL resolve to the discovered project rather than to the default project
- **AND** `project.current` on that connection SHALL NOT report an empty `suggestedSlugs` while a discoverable root exists

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

#### Scenario: A newly registered tool inherits the tool-call identity without action

- **GIVEN** a change that registers a new scope-sensitive MCP tool through the shared registration funnel
- **WHEN** that tool is the first call on an unscoped, roots-discoverable connection
- **THEN** discovery SHALL be reachable from it with no per-tool wiring, and the tool SHALL resolve to the discovered project

#### Scenario: Scope resolution precedes argument validation

- **GIVEN** a connection whose path slug names no project
- **WHEN** the client calls `memory.get` with neither `id` nor `ids` (a malformed request)
- **THEN** the response SHALL carry `code: 'project_not_found'` rather than `code: 'invalid_input'`
