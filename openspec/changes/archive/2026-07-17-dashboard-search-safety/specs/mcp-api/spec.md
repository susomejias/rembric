## MODIFIED Requirements

### Requirement: The MCP server MUST expose `memory.search_prompts`

The `/mcp` and `/mcp/<slug>` endpoints SHALL register a new MCP tool `memory.search_prompts` that returns curated prompts matching a query and/or structured filters, scope-resolved through the existing `scopeFromContext` helper.

Input schema:

- `query?: string` — free-text query; when provided, the server SHALL sanitize it (the same sanitizer used by `memory.search`'s hybrid retrieval — see the `memory` capability) and use the `prompts_fts` virtual table via `MATCH` against `content + tags`. A query that sanitizes to nothing (e.g. pure punctuation) SHALL be treated as no query (recency fallback) rather than raising an error.
- `sessionId?: string` — restrict to prompts whose `session_id = <sessionId>`.
- `agent?: string` — restrict to prompts whose `agent = <agent>`.
- `includeDeleted?: boolean` — default `false`; when `true`, soft-deleted prompts SHALL be included.
- `limit?: number` — default `25`, clamped to `[1, 100]`.
- `offset?: number` — default `0`.

Response shape:

```json
{
  "scope": "project:<id>" | "global",
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
  "total": <count>,
  "clamped": true | false
}
```

The tool SHALL resolve effective project via the existing `scopeFromContext` precedence (path-scoped `ctx.project` → `SessionRouter` pin → global). It SHALL NOT leak prompts from any other scope.

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

- **WHEN** the caller passes `limit: 500`
- **THEN** the server SHALL silently clamp `limit` to `100`
- **AND** the response SHALL include `clamped: true`

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
