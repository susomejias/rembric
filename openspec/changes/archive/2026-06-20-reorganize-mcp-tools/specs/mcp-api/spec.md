## ADDED Requirements

### Requirement: MCP tool handlers MUST be organized one domain per module

The MCP tool-handler layer at `apps/server/src/mcp/` SHALL place each tool domain in its own `<domain>-tools.ts` module that exports exactly one `build<Domain>Handlers` factory and its `<Domain>ToolDeps` interface. There SHALL be no generically-named `tools.ts` handler module. Cross-cutting helpers shared by more than one handler module (the `DomainError`→MCP error mapper, the session-router key resolver, scope resolution, and serialization helpers) SHALL be defined exactly once in a shared module and imported, never copied. `server.ts` SHALL remain a thin registration manifest that wires the per-domain factories without containing handler logic.

#### Scenario: Invariant test rejects a generic or duplicated handler module

- **WHEN** the invariants suite (`apps/server/src/test/invariants.test.ts`) scans `apps/server/src/mcp/` for handler modules
- **THEN** the suite SHALL fail if a file named `tools.ts` exists, if any `*-tools.ts` module does not export exactly one `build*Handlers` factory, or if `errToMcp` / `routerKey` are defined in more than one module

#### Scenario: Tool surface is unchanged by the reorganization

- **WHEN** the MCP server registers its tools after the reorganization
- **THEN** the exact same set of tool names, input schemas, output schemas, and annotations SHALL be advertised as before, and every existing `mcp-api` tool-contract requirement SHALL continue to hold
