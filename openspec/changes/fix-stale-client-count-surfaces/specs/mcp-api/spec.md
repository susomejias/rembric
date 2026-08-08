## MODIFIED Requirements

### Requirement: The MCP server MUST expose three session-lifecycle tools

The `/mcp` and `/mcp/<slug>` endpoints SHALL register the tools `memory.session_start`, `memory.session_end`, and `memory.session_summary` with the following contracts. The tools are split by responsibility: `memory.session_start` opens a session, `memory.session_summary` writes summary/title without transitioning, `memory.session_end` is the sole state transition. This is a behaviour change from the prior contract where `memory.session_summary` ended the session as a side effect.

`memory.session_start` SHALL NOT always insert a row. When an `active` session already exists for the caller's `(tokenId, projectId)` on this transport — the ordinary case, because every supported host registers the session over HTTP before the agent runs — the call SHALL adopt that row instead of minting a second one, and SHALL report which of the two happened in a REQUIRED `reused` field: `true` when an existing row was adopted, `false` when a row was inserted. `reused` is the only signal distinguishing "you are now attached to the host's session" from "you just created a parallel session", which is the question a defensive `memory.session_start` call is asking. Its `outputSchema` SHALL mark it required, and the tool's description SHALL name it and state what `true` means (see "A tool's description and its response MUST agree, and neither may promise an unreachable state"): a required field the description omits from a closed-form `Returns: { … }` list is undocumented surface on the one channel the model reads.

`memory.session_summary` SHALL validate `summary` against the single canonical cap exported from `apps/server/src/services/agent-sessions.ts` (`SUMMARY_MAX_CHARS`, currently `10000`). The MCP zod schema SHALL be `summary: z.string().min(1).max(SUMMARY_MAX_CHARS)` so overflow is rejected at the transport boundary with `invalid_input` before the tool body runs. The rejected agent SHALL receive an error whose message contains the decimal string of `SUMMARY_MAX_CHARS` so it can retry with a tighter body on the first attempt.

`memory.session_summary` and `memory.session_end` SHALL NOT reject a call because the resolved row is in a terminal state. `memory.session_summary` SHALL apply its summary/title write subject to the `final` precedence rules regardless of `status`; `memory.session_end` takes no summary/title arguments, so on a terminal row it SHALL be a pure no-op returning the existing `ended_at`. Neither SHALL mutate `status`, `ended_at` or `last_activity_at` on a terminal row — see the `sessions` capability, "Terminal session rows MUST accept late summary and title writes". `session_already_ended` SHALL NOT be a possible error code for either tool. This matters because the plugin's `PreCompact`, `SessionStart:compact` and `Stop` nudges instruct the agent to call `memory.session_summary`, and the stale-active retirement sweep can have flipped the row to `abandoned` (the documented steady state for two of the clients) before the agent gets there.

`memory.session_end` clears the `SessionRouter` transport binding for `(tokenId, mcpSessionId)` ONLY when the row it resolved is not `abandoned`. Before terminal writes were admitted, `end()` threw on an `abandoned` row and the clear was unreachable, so the binding survived; clearing it now would drop every later `memory.save` on that transport to `session_id = NULL`. That prior behaviour SHALL be preserved: ending an `abandoned` row SHALL leave the binding intact, ending an `active` or `ended` row SHALL clear it.

Session resolution is unchanged and SHALL remain status-aware where it already is: `memory.session_summary` resolves its target from an explicit `sessionId`, else the transport's `SessionRouter` entry, else the unambiguous `active` session for the caller's `(token_id, project_id)`. The third source SHALL continue to consider only `active` rows, so an agent that supplies neither an explicit id nor a router-mapped session SHALL receive `session_not_found` rather than having its write attached to a closed session picked by recency.

#### Scenario: `memory.session_start` opens a new session

- **WHEN** an MCP client calls `memory.session_start` with `{ agent?: string, description?: string }`
- **THEN** the server SHALL insert a `sessions` row with `status = 'active'`, `started_at = now`, the provided `agent` (or `'unknown'`), `token_id` from the request context, `project_id` from the request scope, and a placeholder `title` of the form `basename(cwd) · HH:MM UTC` with `title_final = false`; **AND** the response SHALL be `{ sessionId, scope, projectId, startedAt, title, reused }`

#### Scenario: `memory.session_end` ends a session without summary

- **WHEN** an MCP client calls `memory.session_end` with `{ sessionId: string }` for an active session
- **THEN** the server SHALL set `status = 'ended'` and `ended_at = now` on that row, leave `summary` and `title` unchanged, and SHALL return `{ ok: true, endedAt }`

#### Scenario: `memory.session_end` is idempotent on already-ended sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is already `'ended'`
- **THEN** the server SHALL return `{ ok: true, endedAt }` with the existing `ended_at` and SHALL NOT mutate the row

#### Scenario: `memory.session_end` is idempotent on abandoned sessions

- **WHEN** an MCP client calls `memory.session_end` on a row whose `status` is `'abandoned'` with `ended_at = E`
- **THEN** the server SHALL return `{ ok: true, endedAt: E }`, SHALL leave `status = 'abandoned'` and `ended_at = E` untouched, and SHALL NOT return `session_already_ended`
- **AND** the `SessionRouter` binding for the calling transport SHALL remain pointing at that session, so a subsequent `memory.save` on the same transport still auto-attaches its `session_id`

#### Scenario: `memory.session_end` on an active session clears the transport binding

- **WHEN** an MCP client calls `memory.session_end` on an `active` row and the call transitions it to `ended`
- **THEN** the `SessionRouter` entry for `(tokenId, mcpSessionId)` SHALL be cleared, as before this requirement's revision

#### Scenario: `memory.session_summary` writes summary and title without ending the session

- **WHEN** an MCP client calls `memory.session_summary` with `{ sessionId?: string, summary: string, title?: string }` and `summary.length <= SUMMARY_MAX_CHARS`
- **THEN** the server SHALL resolve `sessionId` from the active MCP transport mapping when omitted, write `summary` with `summary_final = true`, write `title` (when provided, after validating length ≤100) with `title_final = true`, leave `status`/`ended_at` unchanged, and return `{ ok: true, sessionId, summary, title, summaryFinal: true, titleFinal: <true|false> }`

#### Scenario: `memory.session_summary` succeeds on a session the sweep already abandoned

- **GIVEN** the agent's session was flipped to `status = 'abandoned'` with `ended_at = E` and `last_activity_at = L` by stale-active retirement while the conversation was still open, and the agent knows its `sessionId` (the plugin's nudge injects it)
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary, title })`
- **THEN** the call SHALL succeed and return `{ ok: true, sessionId, summary, title, summaryFinal: true, … }`
- **AND** the row SHALL retain `status = 'abandoned'`, `ended_at = E` and `last_activity_at = L`
- **AND** the call SHALL NOT return `session_already_ended`

#### Scenario: `memory.session_summary` succeeds on an ended session

- **GIVEN** a row whose `status = 'ended'` with `ended_at = E`
- **WHEN** the agent calls `memory.session_summary({ sessionId, summary })`
- **THEN** the call SHALL succeed with `summaryFinal: true`, and `status`/`ended_at` SHALL be unchanged

#### Scenario: `memory.session_summary` with no resolvable session still reports `session_not_found`

- **GIVEN** the agent passes no explicit `sessionId`, the transport has no `SessionRouter` entry, and the only candidate row for its `(token_id, project_id)` is `abandoned`
- **WHEN** the agent calls `memory.session_summary({ summary })`
- **THEN** the call SHALL be rejected with code `session_not_found` (NOT `session_already_ended`, and NOT silently attached to the abandoned row)

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

#### Scenario: A second `memory.session_start` adopts the first session and says so

- **GIVEN** a connection with no active session for its `(tokenId, projectId)`
- **WHEN** an MCP client calls `memory.session_start` twice in a row on that connection
- **THEN** the first response SHALL carry `reused: false` and the second SHALL carry `reused: true`
- **AND** both responses SHALL carry the SAME `sessionId` — the second call SHALL NOT insert a second `sessions` row
- **AND** the `sessions` row count for that `(tokenId, projectId)` SHALL be 1 after both calls, which is the control that `reused: true` describes adoption rather than a coincidence of ids

#### Scenario: `memory.session_start`'s description names every required output field

- **WHEN** an MCP client retrieves the tool description for `memory.session_start` via `tools/list`
- **THEN** the description's `Returns:` enumeration SHALL name every field its `outputSchema` marks required, including `title` and `reused`
- **AND** the description SHALL state that `reused: true` means the call adopted the host's already-active session rather than starting one
- **AND** a CI test SHALL compare the description against the `outputSchema`'s required list, so a field added to the schema without a description update fails the build

### Requirement: The MCP server MUST expose a read-only `memory.about` update-guidance tool

The server SHALL register a `memory.about` tool that returns Rembric update guidance as structured data. The tool SHALL take no input parameters, SHALL be read-only (no database access, no persistence, no mutation of any kind), and SHALL be idempotent. Its registered description SHALL contain the keywords `update` and `upgrade` and reference plugins so an agent selects it when the operator asks how to update or upgrade Rembric.

The tool acts as the cross-client equivalent of a Claude-Code skill: it is the portable surface — reachable from every supported client — that hands the operator the commands to run. It SHALL be **guidance-only**: it returns command strings for the operator to run and SHALL NOT execute `curl`, `sh`, `docker`, or any shell command itself.

The response SHALL be split into two axes that are never conflated:

- `server`: an object containing the running server version (the value of `REMBRIC_VERSION`), a human-readable note that this is the server (which runs wherever the tool executes, e.g. the operator's VPS), and the server update path on that host (`docker compose pull && docker compose up -d`). This axis SHALL NOT claim anything about client plugin state.
- `plugins`: an object containing the canonical TUI-installer commands — a **read-only status command** (`… --status --json`) that reports the server and each plugin's installed-vs-available version with a per-agent `action` (`none`/`update`/`ahead`/`unknown`), the interactive entrypoint (`curl -fsSL <install-url> | sh`), the update-all variant (`… --action=update`), and a subset example (`… --action=update --agent=<a,b>`) — together with an explicit note that plugins are installed per client machine, that this server cannot see them, that the operator runs the command on each machine where Rembric is used, and that the `update_all` command is safe to run directly (it updates only agents with an update available and skips the rest without erroring) — the status-first-then-selective-update advice applies to the `subset` command, where the operator names specific agents.

The status command SHALL be the installer's existing read-only `--status --json` mode; the tool SHALL NOT compute installed-vs-available state itself (that detection is client-side and owned by the installer). The status command SHALL NOT include `--action=update` or any mutating flag.

The `plugins` command strings SHALL be derived from the canonical installer entrypoint and flags defined by the `tui-installer` capability; the tool SHALL NOT fork or hand-edit the installer's flag set. The `server` update command SHALL NOT duplicate the dashboard-driven one-click flow owned by the `self-update` capability; `memory.about` only surfaces the manual host command and the running version.

#### Scenario: A client calls memory.about

- **WHEN** an authenticated MCP client calls `memory.about` with no arguments
- **THEN** the tool SHALL return a result containing a `server` object whose version equals the running `REMBRIC_VERSION` and a `plugins` object containing the installer command(s)
- **AND** the result SHALL NOT trigger any database read or write

#### Scenario: The two axes are labeled and never conflated

- **WHEN** the tool result is inspected
- **THEN** the `plugins` axis SHALL include a note stating that plugins live on each client machine and that the server cannot see them
- **AND** the `server` version SHALL NOT be presented as an indicator of whether any client plugin is up to date

#### Scenario: The tool is guidance-only and never executes

- **WHEN** `memory.about` is invoked
- **THEN** the server SHALL NOT spawn a process, run `curl`/`sh`/`docker`, or perform any side effect; it SHALL only return command strings for the operator to run

#### Scenario: The plugins commands match the canonical installer entrypoint

- **WHEN** the tool's `plugins` command strings are compared against the canonical installer entrypoint defined by the `tui-installer` capability
- **THEN** the interactive and `--action=update` invocations SHALL reference that same entrypoint and flag set (no forked URL or flags)

#### Scenario: The tool offers a read-only status command to check before updating

- **WHEN** the `plugins` axis is inspected
- **THEN** it SHALL include a `status` command using the installer's `--status --json` mode that references the canonical entrypoint
- **AND** that command SHALL NOT contain `--action=update` or any other mutating flag
- **AND** the `plugins.note` SHALL state that `update_all` is safe to run directly without checking `status` first
- **AND** the `plugins.note` SHALL direct the operator to check `status` first specifically when using the `subset` command to update named agents
