## ADDED Requirements

### Requirement: `POST /api/<slug>/memory/recall` MUST return ranked memory context for per-turn prefetch

The endpoint SHALL accept a JSON body `{ query: string, limit?: number }`. The `query` field is REQUIRED and SHALL be a non-empty string. The `limit` field, when present, SHALL be clamped to `[1, 5]` (this endpoint feeds a per-turn context-injection budget, not exploratory search); when omitted it SHALL default to 5. The endpoint SHALL resolve scope via the same `authenticate({pathSlug})` helper used by the other `/api/<slug>/*` routes, so the same 401/403/404 error contract (`missing_token`, `token_invalid`, `project_not_found`, `forbidden`, `project_archived`) applies unchanged.

The endpoint SHALL delegate to the same `MemoryService.search()` path used by the MCP `memory.search` tool (project scope resolved from the path slug, `include_global` NOT set — this endpoint always searches the path-scoped project only), so ranking (including any hybrid-search boost) is identical to the MCP-facing search. On success the server SHALL respond `200 OK` with body `{ ok: true, memories: [{ id: string, title: string, snippet: string }], formatted: string }`, where `memories` mirrors the ranked `memory.search` results (title + a content snippet capped the same way other context snippets are capped) and `formatted` is a ready-to-inject string of the shape `<memory-context>\n<one line per memory: "- {title}: {snippet}">\n</memory-context>`, or the empty string when `memories` is empty.

This endpoint SHALL NOT be exposed to any client other than the Hermes provider in this revision; it carries no client-identifying restriction at the HTTP layer (any valid token scoped to the slug may call it), but no other client's plugin code calls it yet.

#### Scenario: A successful recall returns ranked memories and a formatted block

- **GIVEN** a project with several `active` memories, at least one matching the query lexically or semantically
- **WHEN** a client POSTs `{ "query": "how do we handle auth tokens" }` to `/api/<slug>/memory/recall` with a valid token scoped to that slug
- **THEN** the response SHALL be `200 OK` with `ok: true`, a `memories` array ordered by the same ranking `memory.search` would produce for that query, and a non-empty `formatted` string when `memories` is non-empty

#### Scenario: No matching memories yields an empty formatted block

- **GIVEN** a project with no memories matching the query
- **WHEN** a client POSTs a query to `/api/<slug>/memory/recall`
- **THEN** the response SHALL be `200 OK` with `memories: []` and `formatted: ""`

#### Scenario: limit is clamped

- **WHEN** a client POSTs `{ "query": "...", "limit": 50 }`
- **THEN** the server SHALL clamp the effective limit to 5 rather than reject the request

#### Scenario: Missing query is rejected

- **WHEN** a client POSTs a body without a `query` field, or with an empty string
- **THEN** the server SHALL respond with a `400`-class validation error and SHALL NOT execute a search

#### Scenario: Auth and scope errors match the existing `/api/<slug>/*` contract

- **WHEN** a client POSTs to `/api/<slug>/memory/recall` without a valid bearer token, or with a token scoped to a different project, or against an unknown or archived slug
- **THEN** the response SHALL match the corresponding scenario already specified for `POST /api/<slug>/sessions` (401 `missing_token`/`token_invalid`, 403 `forbidden`, 404 `project_not_found`, 403 `project_archived`)
