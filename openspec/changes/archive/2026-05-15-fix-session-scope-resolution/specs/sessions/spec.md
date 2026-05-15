# sessions — scope resolution for session tools

This delta amends the `sessions` capability to make explicit the invariant that session-tool handlers MUST consult the `SessionRouter` when resolving the effective project for path-less MCP connections. The behavior is already implied by the general MCP scope-resolution precedence documented in `CLAUDE.md`; this change closes the gap where `sessions-tools.ts::scopeFromContext` silently violates it.

## ADDED Requirements

### Requirement: Session-tool handlers MUST honor the documented scope-resolution precedence

Every MCP tool handler under `src/mcp/sessions-tools.ts` that needs to resolve the effective project (`memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.save_prompt`, `memory.session_end`, `memory.session_summary`, `memory.capture_passive`) SHALL resolve scope by consulting, in this order:

1. `ctx.project` from the request context, populated when the connection is path-scoped (`/mcp/<slug>`).
2. The `SessionRouter` entry for `(tokenId, mcpSessionId)`, populated by a prior `project.use` call or by roots-based discovery, when the connection is path-less (`ctx.requestedSlug === null`).
3. Global scope, when neither source resolves a project.

A handler that resolves scope using only `ctx.project` and falls through directly to global scope SHALL be considered to be in violation of this requirement.

#### Scenario: Path-less connection with router pin returns project scope

- **GIVEN** a token connected to `/mcp` (path-less)
- **AND** an agent has called `project.use({slug: 'foo', create: true})` successfully
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "project:<foo.id>"` and the project's recent memories

#### Scenario: Path-less connection with no router entry returns global scope

- **GIVEN** a token connected to `/mcp` (path-less)
- **AND** no `project.use` call has been made on this MCP session
- **AND** no roots-based discovery has populated the router
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "global"` and only global-scope memories

#### Scenario: Path-scoped connection ignores router fallback

- **GIVEN** a token connected to `/mcp/bar` where project `bar` does not exist
- **AND** the router has a leftover entry pointing to project `foo` from a previous session reusing the same `(tokenId, mcpSessionId)` keys
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "global"` (the path-scoped intent overrides the stale router entry)
- **AND** the response SHALL NOT leak `foo`'s memories

#### Scenario: Path-scoped connection to existing project returns that project's scope

- **GIVEN** a token connected to `/mcp/baz` where project `baz` exists
- **AND** auth has resolved `ctx.project` to the `baz` project
- **WHEN** the agent calls `memory.context`
- **THEN** the response SHALL include `scope: "project:<baz.id>"` regardless of any router state
