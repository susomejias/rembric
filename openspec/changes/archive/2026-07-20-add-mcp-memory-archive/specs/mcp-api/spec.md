## ADDED Requirements

### Requirement: The MCP server MUST expose a `memory.archive` tool

The server SHALL register an MCP tool `memory.archive` that retires a single memory by flipping its `status` from `active` to `archived`. The tool SHALL accept `{ id: string }` (validated by zod; non-empty) and SHALL NOT accept a `scope` argument. It SHALL resolve the effective scope exactly like the other single-memory tools (`memory.get`/`memory.confirm`, via `resolveEffectiveScope`) and delegate to `MemoryService.archive(id, scope)`, so archiving is confined to the connection's one effective scope: a `/mcp/<slug>` connection archives in that project's scope; a `/mcp` connection archives in the routed project (via `project.use`) or global scope.

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

### Requirement: The `memory.archive` description MUST steer against autonomous retirement

Because `memory.archive` gives the model an unlinked retirement verb, its tool description is load-bearing and SHALL constrain when the model uses it. The description SHALL instruct the model to call `memory.archive` ONLY when the user has explicitly asked to retire, remove, or forget a specific memory (including the archive-back half of a user-requested cross-project move: `memory.save` into the destination followed by `memory.archive` of the original). The description SHALL instruct the model to PREFER a `topic_key` upsert or a `memory.judge` supersede whenever a replacement memory exists, because those keep a successor link, and SHALL state that archive is the no-successor path. The description SHALL forbid archiving as autonomous housekeeping during normal recall or save, and SHALL note that archiving is reversible from the operator dashboard. These constraints SHALL NOT be expressed only in the per-argument zod `describe()` (which some clients do not surface to the model) but in the tool's top-level description text.

#### Scenario: The description carries the explicit-request guard

- **WHEN** an MCP client retrieves the tool description for `memory.archive` via `tools/list`
- **THEN** the description SHALL convey that the tool is called ONLY at the user's explicit request to retire/remove/forget a memory
- **AND** the description SHALL convey that a `topic_key`/`memory.judge` supersede is preferred when a replacement exists (archive being the no-successor path)
- **AND** the description SHALL convey that the model MUST NOT archive as autonomous cleanup during recall or save
- **AND** the description SHALL convey that the action is reversible from the operator dashboard
