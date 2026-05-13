## ADDED Requirements

### Requirement: The MCP endpoint MUST use Streamable HTTP transport

The server SHALL expose the Model Context Protocol over the Streamable HTTP transport at `/mcp`, using `@modelcontextprotocol/sdk`. The legacy SSE transport SHALL NOT be exposed.

#### Scenario: Client initiates a session
- **WHEN** an MCP client opens a session against `/mcp` using the Streamable HTTP transport
- **THEN** the server SHALL respond with a valid initialize result advertising the registered tools

### Requirement: Every MCP request MUST be authenticated

The server SHALL reject any request to `/mcp` that does not include a valid bearer token in the `Authorization` header. Tokens SHALL be matched against the `tokens` table by hash; revoked or expired tokens SHALL be rejected.

#### Scenario: Missing token
- **WHEN** a request arrives at `/mcp` without an `Authorization` header
- **THEN** the response SHALL be `401 Unauthorized` and no MCP handshake SHALL be performed

#### Scenario: Revoked token
- **GIVEN** a token whose `revoked_at` is set
- **WHEN** a request arrives at `/mcp` with that token
- **THEN** the response SHALL be `401 Unauthorized`

#### Scenario: Expired token
- **GIVEN** a token whose `expires_at` is in the past
- **WHEN** a request arrives at `/mcp` with that token
- **THEN** the response SHALL be `401 Unauthorized`

### Requirement: Tool inputs MUST be validated by zod

Every MCP tool SHALL declare its input schema with zod, and the SDK shall reject calls with invalid arguments before the tool handler runs. Tool handlers SHALL NOT need to re-validate primitive fields.

#### Scenario: Invalid input
- **WHEN** an MCP client calls `memory.save` with `content` set to an integer
- **THEN** the tool SHALL respond with an MCP error indicating the schema violation and SHALL NOT touch the database

### Requirement: The `memory.save` tool MUST persist a new active memory

`memory.save` SHALL accept `scope`, `type`, `content`, optional `tags`, and SHALL insert a new memory with `status = 'active'`, the current timestamp, and `source` populated from the call context (token name, project header, client info).

#### Scenario: Save a project-scoped memory
- **WHEN** an authenticated client calls `memory.save` with `scope = 'project'`, `type = 'user'`, `content = 'prefers tabs'`, headers including `X-Memoria-Project: app`
- **THEN** a new memory row SHALL exist with the given fields, `scope = 'project'`, `project_id` resolving to the `app` project, and `source.token_name` matching the caller's token

### Requirement: The `memory.search` tool MUST return active memories matching the query

`memory.search` SHALL accept `query`, optional `type`, `tags`, `status` (default `active`), `limit` (default 20), and SHALL return memories ordered by FTS5 relevance then `last_seen_at` desc. Results SHALL respect the caller's scope as defined by `X-Memoria-Project`.

#### Scenario: Search by keyword in a project
- **GIVEN** the project `app` has active memories matching the query "tabs"
- **WHEN** an authenticated client calls `memory.search` with `query = 'tabs'` and `X-Memoria-Project: app`
- **THEN** the response SHALL include only memories from project `app` (plus globals if `include_global = true`) matching the FTS5 search

### Requirement: The `memory.get` tool MUST return the memory and its history

`memory.get` SHALL accept an `id` and SHALL return the memory's content, status, scope, project, tags, source, and the full chain of predecessors derived from `replaces`, plus the confirmation count for the current head.

#### Scenario: Retrieve a merged memory
- **WHEN** an authenticated client calls `memory.get` with the id of a merged memory M
- **THEN** the response SHALL include M's content, M's predecessor ids, their content snapshots, and the confirmation count against M

### Requirement: The `memory.confirm` tool MUST follow the supersedes chain

`memory.confirm` SHALL accept an `id` and SHALL insert a `confirmations` row for the current head of the supersedes chain reachable from `id`. The tool SHALL NOT mutate any `memory` row.

#### Scenario: Confirming an outdated id
- **GIVEN** memory A is superseded by M
- **WHEN** an authenticated client calls `memory.confirm('A')`
- **THEN** a row SHALL be inserted into `confirmations` with `memory_id = 'M'` and no `memory` row SHALL be updated

### Requirement: Errors MUST follow MCP conventions

The server SHALL return MCP-conformant errors for invalid operations, including helpful messages but never leaking secrets or internal stack traces.

#### Scenario: Unknown tool
- **WHEN** a client invokes a tool name not registered by the server
- **THEN** the response SHALL be an MCP error of the appropriate code with a human-readable message identifying the missing tool

#### Scenario: Internal error
- **WHEN** a tool handler throws an unexpected exception
- **THEN** the response SHALL be an MCP error with a generic message and an error id; the full stack SHALL be logged server-side but NOT returned to the client
