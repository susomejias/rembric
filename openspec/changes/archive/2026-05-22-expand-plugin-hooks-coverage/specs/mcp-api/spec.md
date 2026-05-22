## MODIFIED Requirements

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 800 characters or fewer.

The instructions SHALL include:

1. The session-close protocol sentence directing the agent to call `memory.session_summary({title, summary})` before declaring work "done". The sentence SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic) and the summary structure (Goal · Discoveries · Accomplished · Next Steps · Files).
2. **The post-compact recovery clause (new)** — a short instruction directing the agent that after any compaction event, when the compacted summary lacks specific detail (exact file paths, prior decisions, concrete error messages), it MUST call `memory.context` (or `memory.search` for keyword lookup) BEFORE responding to the user's pending prompt. The phrasing SHALL stay concise (≤60 chars of new content) so the total stays under the 800-char cap.

#### Scenario: An MCP client connects on `/mcp/<slug>`

- **WHEN** the `initialize` handshake completes against `/mcp/my-project`
- **THEN** the `InitializeResult.instructions` SHALL contain references to `memory.save`, `memory.search`, `memory.session_summary`, AND `memory.context` (the new post-compact recovery clause) plus a note indicating the connection is project-scoped to `'my-project'` and that `scope='global'` will be rejected
- **AND** the instructions SHALL contain the substring `memory.session_summary` and the substring `title` and a reference to "before" (referring to before declaring done)
- **AND** the instructions SHALL contain the substring `memory.context` (the new post-compact recovery clause)

#### Scenario: An MCP client connects on `/mcp` without a project

- **WHEN** the `initialize` handshake completes against `/mcp`
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol triggers (including the session-close protocol sentence AND the memory.context post-compact recovery clause) and a note indicating the connection is global-scope and that project memories require opening `/mcp/<slug>` or sending `X-Rembric-Project`

#### Scenario: Instructions length is checked at build time

- **WHEN** the test suite runs against both `/mcp` and `/mcp/<slug>` variants of `buildInstructions(ctx)`
- **THEN** both outputs SHALL be 800 characters or fewer (unchanged cap — the new clause MUST fit within the existing budget)

#### Scenario: A client that does not consume `instructions` connects

- **WHEN** an MCP client ignores the `instructions` field
- **THEN** every tool SHALL still function normally (the field is informational only)

#### Scenario: instructions.test.ts asserts the new memory.context clause is present

- **WHEN** `apps/server/src/mcp/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substring `memory.context`
- **AND** both outputs SHALL be ≤800 chars
- **AND** existing assertions for `memory.session_summary`, `memory.save`, `memory.search`, scope notes, etc. SHALL continue to pass
