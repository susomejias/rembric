## ADDED Requirements

### Requirement: Session auto-attachment MUST prefer a bridge-instance-scoped signal over the ambiguous transport fallback

`memory.save`, `memory.confirm`, and `memory.session_summary` each auto-attach a target session id when the caller omits an explicit `sessionId`. The resolution precedence SHALL be:

1. An explicit `sessionId` argument, when supplied.
2. The `SessionRouter` entry for `(tokenId, mcpSessionId)` — set by an explicit `memory.session_start` call on this MCP transport.
3. The most recent `active` session whose `bridge_instance_id` column matches the value of the request's `X-Rembric-Bridge-Instance` header, scoped to the caller's `tokenId`, when that header is present and resolves to a match.
4. The most recently-started `active` session for `(tokenId, projectId)` (the pre-existing ambiguous fallback, unchanged), when none of the above apply.

Step 3 SHALL only ever narrow the result to a session belonging to the caller's own token — it SHALL NOT be used to look up or expose any session belonging to a different token. A header value that resolves to no active session (unknown instance id, or a session that has since ended) SHALL be treated identically to a missing header: the resolution SHALL continue to step 4, and the call SHALL NOT fail solely because the header failed to resolve.

#### Scenario: Bridge-instance header disambiguates two concurrent sessions under one token

- **GIVEN** two `active` sessions exist for the same `tokenId` and `projectId` — session A with `bridge_instance_id = "bi-1"`, session B (started later) with `bridge_instance_id = "bi-2"`
- **WHEN** an MCP request carrying header `X-Rembric-Bridge-Instance: bi-1` calls `memory.session_summary({summary: "..."})` without an explicit `sessionId`
- **THEN** the summary SHALL be written to session A, not session B, even though session B started more recently

#### Scenario: Missing or unresolvable header falls back to the existing precedence unchanged

- **WHEN** an MCP request calls `memory.save({...})` without an explicit `sessionId`, without an active `SessionRouter` entry, and either without an `X-Rembric-Bridge-Instance` header or with one that matches no active session for the caller's token
- **THEN** the server SHALL resolve the session via the pre-existing `(tokenId, projectId)` most-recently-started fallback, and the call SHALL succeed exactly as it did before this requirement existed

#### Scenario: The header cannot cross a token boundary

- **GIVEN** an active session with `bridge_instance_id = "bi-shared"` belongs to token T1
- **WHEN** a request authenticated as a different token T2 carries header `X-Rembric-Bridge-Instance: bi-shared`
- **THEN** the lookup SHALL find no match for T2 (the query is scoped to T2's own `tokenId`), and resolution SHALL continue to the next precedence step

## MODIFIED Requirements

### Requirement: The MCP server MUST expose three session-lifecycle tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, and `memory.session_summary` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the sole state transition. This is a behaviour change from the prior contract where `memory.session_summary` ended the session as a side effect.

`memory.session_summary` SHALL validate `summary` against the single canonical cap exported from `apps/server/src/services/agent-sessions.ts` (`SUMMARY_MAX_CHARS`, currently `10000`). The MCP zod schema SHALL be `summary: z.string().min(1).max(SUMMARY_MAX_CHARS)` so overflow is rejected at the transport boundary with `invalid_input` before the tool body runs. The rejected agent SHALL receive an error whose message contains the decimal string of `SUMMARY_MAX_CHARS` so it can retry with a tighter body on the first attempt.

#### Scenario: `memory.session_start` opens a new session

- **WHEN** an MCP client calls `memory.session_start` with `{ agent?: string, description?: string }`
- **THEN** the server SHALL insert a `sessions` row with `status = 'active'`, `started_at = now`, the provided `agent` (or `'unknown'`), `token_id` from the request context, `project_id` from the request scope, and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` with `title_final = false`; **AND** the response SHALL be `{ sessionId, scope, startedAt, title }`

#### Scenario: `memory.session_end` ends a session without summary

- **WHEN** an MCP client calls `memory.session_end` with `{ sessionId: string }` for an active session
- **THEN** the server SHALL set `status = 'ended'` and `ended_at = now` on that row, leave `summary` and `title` unchanged, and SHALL return `{ ok: true, endedAt }`

#### Scenario: `memory.session_end` is idempotent on already-ended sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is already `'ended'`
- **THEN** the server SHALL return `{ ok: true, endedAt }` with the existing `ended_at` and SHALL NOT mutate the row

#### Scenario: `memory.session_summary` writes summary and title without ending the session

- **WHEN** an MCP client calls `memory.session_summary` with `{ sessionId?: string, summary: string, title?: string }` and `summary.length <= SUMMARY_MAX_CHARS`
- **THEN** the server SHALL resolve `sessionId`, when omitted, via the precedence chain in "Session auto-attachment MUST prefer a bridge-instance-scoped signal over the ambiguous transport fallback", write `summary` with `summary_final = true`, write `title` (when provided, after validating length ≤100) with `title_final = true`, leave `status`/`ended_at` unchanged, and return `{ ok: true, sessionId, summary, title, summaryFinal: true, titleFinal: <true|false> }`

#### Scenario: `memory.session_summary` may be called multiple times; the latest call wins

- **GIVEN** a session whose `summary_final = true` from a prior `memory.session_summary({summary: "A"})` call
- **WHEN** the agent calls `memory.session_summary({summary: "B"})` again
- **THEN** `summary` SHALL be replaced with "B" (last-final-wins among final writes)

#### Scenario: `memory.session_summary` rejects empty summary

- **WHEN** the agent submits `summary: ""` or whitespace-only
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: `memory.session_summary` rejects title over 100 chars

- **WHEN** the agent submits `title: "A".repeat(101)`
- **THEN** the call SHALL be rejected with code `invalid_input`

#### Scenario: `memory.session_summary` rejects summary over `SUMMARY_MAX_CHARS`

- **WHEN** the agent submits `summary: "A".repeat(SUMMARY_MAX_CHARS + 1)` (one char over the cap)
- **THEN** the call SHALL be rejected at the zod boundary with code `invalid_input`
- **AND** the error message SHALL contain the decimal string of `SUMMARY_MAX_CHARS` so the agent can deduce the cap and retry with a tighter body on the first attempt
- **AND** the session row SHALL NOT be mutated (no partial write, `summary_final` unchanged)

#### Scenario: `memory.session_summary` accepts summary of exactly `SUMMARY_MAX_CHARS`

- **WHEN** the agent submits `summary: "A".repeat(SUMMARY_MAX_CHARS)`
- **THEN** the call SHALL succeed and the row SHALL have `summary` of length `SUMMARY_MAX_CHARS` with `summary_final = true`

#### Scenario: A session-lifecycle tool targets a session owned by a different token

- **WHEN** any of the three tools is called with a `sessionId` whose `token_id` does not match the caller's token
- **THEN** the call SHALL be rejected with code `session_not_found` (never `forbidden`, to avoid information disclosure)
