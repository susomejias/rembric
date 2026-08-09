## MODIFIED Requirements

### Requirement: Session.created handler with sub-agent filtering

The `event` dispatcher's `"session.created"` branch SHALL extract `event.properties.info.id`, `event.properties.info.parentID`, and `event.properties.info.title`. It SHALL treat a session as a sub-agent (and skip top-level registration) iff `parentID` is truthy OR `title.endsWith(" subagent)")`. Sub-agent session IDs SHALL be stored in a closure-scoped `Set<string>` named `subAgentSessions` so subsequent `tool.execute.after` events for the same id can also skip work.

Non-sub-agent sessions SHALL be registered exactly once per plugin lifetime via an `ensureSession(id)` helper — supplied by the shared core, not reimplemented here (`plugin-session-protocol`) — that:

- Returns immediately if `id` is empty.
- Returns immediately if `id` is in `subAgentSessions`.
- Returns immediately if `id` is already in `knownSessions` (a second closure-scoped `Set<string>`).
- Adds `id` to `knownSessions`.
- POSTs `${REMBRIC_SERVER_URL}/api/<slug>/sessions` with body `{"id": <id>, "agent": "opencode", "cwd": <ctx.directory>}` if a slug resolved successfully. The body SHALL OMIT `cwd` entirely (NOT send `null`) when `ctx.directory` is unavailable, matching the bug fix recorded in memory `01KRY3ZAF86NRK5Y8K3N0JJ9M6`.
- POSTs `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<id>/resume` with body `{}` immediately afterwards, on this branch only.

The resume SHALL be issued on the newly-known branch and SHALL NOT be issued on any of the three early returns, so exactly one resume is sent per session id per plugin lifetime however many handlers call `ensureSession` for it. The plugin file SHALL NOT contain the resume path as a literal, for the same reason it contains no other `/sessions/…` fetch: the shared core is the single implementation of the session HTTP client.

The rule is unconditional. opencode emits `session.created` exactly once in the life of a session id — the host's `create` is idempotent and returns before the `publish` — and reopening a persisted session keeps its id and emits nothing, so there is no host signal here that could distinguish a reopened conversation from a new one even if the plugin wanted one. The unconditional resume is what makes a reopened opencode session re-attach: its row will normally be `abandoned`, since the plugin never POSTs `/end` and the sweep retires the row while the operator is away.

The handler SHALL emit one stderr diagnostic line per `session.created` event of the form `[rembric] session.created id=<id> parentID=<parentID|""> title=<title|""> subagent=<true|false>`. This is mandatory: it makes sub-agent heuristic drift visible in opencode's debug logs (design.md risk register).

#### Scenario: Top-level session is registered exactly once

- **WHEN** `session.created` fires with `info.id="abc"`, `info.parentID=""`, `info.title="Working on widget"`
- **THEN** `ensureSession("abc")` runs and POSTs to `/api/<slug>/sessions` exactly once
- **AND** a second `session.created` with the same id is a no-op (no second POST)

#### Scenario: The resume follows the ensure exactly once per id

- **WHEN** `ensureSession("abc")` runs for the first time in this plugin lifetime
- **THEN** it SHALL POST `/api/<slug>/sessions` and then `/api/<slug>/sessions/abc/resume`, in that order
- **AND** a `chat.message` or `experimental.session.compacting` event for the same id afterwards SHALL POST neither
- **AND** the control SHALL pass in the same run: `ensureSession("def")` for an id not yet known DOES POST both

#### Scenario: A reopened opencode session re-attaches its memories

- **GIVEN** session `abc` was registered in a previous opencode process, and its row is now `abandoned` because the plugin never posts `/end` and the sweep retired it
- **WHEN** the operator reopens that conversation, opencode emits `chat.message` for the same id, and `ensureSession("abc")` runs for the first time in the new process
- **THEN** the ensure SHALL return the row still `abandoned`, and the resume that follows SHALL return it to `status='active'` with `ended_at IS NULL`
- **AND** a subsequent `memory.save` on that conversation's MCP transport SHALL persist a non-null `session_id`
- **AND** the control SHALL pass in the same run: without the resume the row stays `abandoned` and the same save persists `session_id = NULL`

#### Scenario: A sub-agent session is neither ensured nor resumed

- **WHEN** `session.created` fires with `info.parentID="parent-1"`
- **THEN** neither `/api/<slug>/sessions` nor `/api/<slug>/sessions/<id>/resume` SHALL be POSTed
- **AND** the id SHALL be in `subAgentSessions`

#### Scenario: Sub-agent session is filtered

- **WHEN** `session.created` fires with `info.id="abc"`, `info.parentID="parent-1"`, `info.title="Implement step (codex subagent)"`
- **THEN** `subAgentSessions` contains `"abc"`
- **AND** NO POST to `/api/<slug>/sessions` occurs
- **AND** the stderr diagnostic includes `subagent=true`

#### Scenario: Sub-agent detection by title suffix without parentID

- **WHEN** `session.created` fires with `info.id="def"`, `info.parentID=""`, `info.title="Verify rebuild (subagent)"`
- **THEN** the title-suffix heuristic matches (` subagent)` literal)
- **AND** `def` is added to `subAgentSessions`
- **AND** no top-level POST occurs

#### Scenario: cwd is omitted from body when ctx.directory is empty

- **GIVEN** `ctx.directory` is the empty string at plugin construction time
- **WHEN** `ensureSession("xyz")` POSTs to `/api/<slug>/sessions`
- **THEN** the JSON body is `{"id": "xyz", "agent": "opencode"}` with NO `cwd` key
- **AND** the body MUST NOT contain `"cwd": null`
