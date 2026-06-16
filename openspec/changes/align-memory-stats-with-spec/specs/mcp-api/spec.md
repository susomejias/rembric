## MODIFIED Requirements

### Requirement: The MCP server MUST expose two observability tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `memory.doctor` and `memory.stats`.

#### Scenario: `memory.doctor` returns an operational report

- **WHEN** an MCP client calls `memory.doctor`
- **THEN** the server SHALL return `{ db: { open, journalMode, integrity, sizeBytes }, embeddings: { model, backlog }, consolidation: { lastRunAt, lastRunOps }, sessions: { active }, warnings: string[] }` — the report SHALL NOT contain an `llm` block, and the `embeddings` block SHALL NOT contain `enabled` (embeddings are always on); `model` SHALL identify the compiled-in embedding model

#### Scenario: `memory.stats` returns counters by scope and status

- **WHEN** an MCP client calls `memory.stats`
- **THEN** the server SHALL return `{ scope, memoriesByStatus, memoriesByType, memoriesByScope, sessionsByStatus, totalProjects, totalTokens }` scoped to the request context, where:
  - `scope` is a string (`global` or `project:<id>`) identifying the resolved scope,
  - `memoriesByStatus`, `memoriesByType`, `memoriesByScope`, and `sessionsByStatus` are each a `Record<string, number>` of counts,
  - `totalProjects` and `totalTokens` are each a `number`
- **AND** the response SHALL conform to the tool's declared `outputSchema`

#### Scenario: A read-only token calls `memory.doctor` or `memory.stats`

- **WHEN** the caller's scope is `read:*` or `read:project:<id>`
- **THEN** both tools SHALL succeed (they are read-only by design)
