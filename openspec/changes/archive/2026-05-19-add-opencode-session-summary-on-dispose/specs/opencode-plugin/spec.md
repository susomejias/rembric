## MODIFIED Requirements

### Requirement: Event handler set

The plugin module's returned object SHALL declare exactly the following event handler properties, no more and no fewer:

1. `event: async ({ event }) => ...` — a dispatcher that switches on `event.type` for `"session.created"`, `"session.deleted"`, and `"server.instance.disposed"`. Any other `event.type` values SHALL be silently ignored.
2. `"chat.message": async (input, output) => ...` — appends a `{role:'user', text}` entry to the per-session transcript accumulator (`sessionMessages` Map). The handler SHALL NOT POST any HTTP request.
3. `"message.updated": async (input, output) => ...` — appends or replaces a `{role:'assistant', text}` entry keyed by `output.message.id` in `sessionMessages`. The handler SHALL NOT POST any HTTP request, and SHALL be a no-op for messages whose role is not `'assistant'`.
4. `"session.idle": async (input) => ...` — schedules a debounced summary flush for `input.sessionID`. PRIMARY mechanism for delivering transcript-to-server during the session. See `Session.idle handler (periodic flush)`.
5. `"experimental.session.compacting": async (input, output) => ...` — post-compaction reminder injection.

The plugin SHALL NOT register `"tool.execute.after"`. The corresponding `/api/<slug>/observations/passive` endpoint does not exist on Rembric's HTTP API; the handler has no work to do.

The plugin SHALL NOT register `experimental.chat.system.transform` (no system-prompt injection). The plugin SHALL NOT register `tool.execute.before` (no tool guards). The plugin SHALL NOT register `permission.asked` or `permission.replied`.

If Plan B of the cwd spike applies (see "cwd spike" requirement), the plugin SHALL additionally register `"shell.env": async (input, output) => { output.env.REMBRIC_PROJECT_DIR = ctx.directory }`. The hook SHALL be omitted otherwise.

The `chat.message` and `message.updated` handlers MUST treat the `sessionMessages` Map as their only side effect. An invariant test (`src/test/invariants.test.ts`) SHALL fail the build if either handler invokes `rembricPost`, `fetch`, or any other HTTP work.

#### Scenario: Handler set is exactly the documented set

- **WHEN** the resolved value of `RembricPlugin(ctx)` is inspected
- **THEN** its own enumerable keys are exactly `["event", "chat.message", "message.updated", "session.idle", "experimental.session.compacting"]` plus `"shell.env"` if Plan B is active
- **AND** no other keys exist

### Requirement: Session.deleted handler clears in-memory state only

The `event` dispatcher's `"session.deleted"` branch SHALL remove the session id from `knownSessions`, `subAgentSessions`, and `sessionMessages` (the per-session transcript accumulator). It SHALL NOT POST any HTTP request. opencode's `session.deleted` fires only on explicit UI delete — it is not a "user quit" signal and SHALL NOT trigger server-side session closure.

Server-side session closure SHALL rely on:

- The agent voluntarily calling `memory.session_summary` (cooperating path; sets `summary_final=true`, locking the row against transcript-based overwrites).
- The dispose-flush at `server.instance.disposed` time, which POSTs the accumulated transcript via `/sessions/<id>/summary` with `final:false` (see "Server.instance.disposed flush handler"). Sets `summary` but leaves `status='active'` until `abandonStale` flips it.
- The server's `abandonStale` periodic task flipping `status='active'` rows to `'abandoned'` after the configured inactivity threshold.

#### Scenario: session.deleted is a local-state cleanup

- **GIVEN** session id `"abc"` is in `knownSessions` and `sessionMessages` contains an entry for `"abc"`
- **WHEN** `session.deleted` fires with `info.id="abc"`
- **THEN** `knownSessions` no longer contains `"abc"`
- **AND** `sessionMessages.has("abc")` is `false`
- **AND** no HTTP request is made
- **AND** the server's `sessions` table is NOT modified by this event

## ADDED Requirements

### Requirement: Session.idle handler (periodic flush)

The `"session.idle"` handler is the PRIMARY mechanism that delivers the transcript to the server during the session lifetime. It fires once per agent turn (after the assistant response completes and before the next user prompt). The handler SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Schedule a debounced flush for `input.sessionID` with a 500ms quiet period. If a prior debounce-timer is pending for the same session id, cancel it and schedule afresh. Implementation note: use `setTimeout` / `clearTimeout` plus a `Map<string, ReturnType<typeof setTimeout>>` to track per-session pending timers.
3. The debounced flush callback SHALL call `flushSessionSummary(sessionId)` (the shared helper used by `server.instance.disposed`), which POSTs `/api/<slug>/sessions/<id>/summary` with body `{summary, title?, final:false}`.

Rationale: opencode's `server.instance.disposed` is fire-and-forget at the runtime level (verified by spike — see design.md::Decision 4 resolved). Async POSTs from that handler don't land. The per-turn flush keeps the server's summary current at all times so that even if `server.instance.disposed` fails to deliver, the row is at-most-one-turn behind reality.

The debounce SHALL NOT exceed 2 seconds (don't accumulate too much state in-flight) and SHALL NOT be below 200ms (don't POST on every keystroke during streaming).

#### Scenario: session.idle fires periodic flush per turn

- **GIVEN** a session "s1" with three user prompts each followed by an assistant response, accumulator contains user+assistant turns
- **WHEN** `session.idle` fires after the third assistant turn
- **THEN** within 500ms a POST to `/api/<slug>/sessions/s1/summary` is issued
- **AND** the body's `summary` contains all six turns

#### Scenario: Rapid-fire session.idle events debounce

- **GIVEN** session.idle fires three times within 100ms for the same session id
- **WHEN** the debounce timer expires
- **THEN** exactly ONE POST is issued (the prior timers were cancelled)

### Requirement: Server.instance.disposed flush handler (best-effort)

The `event` dispatcher's `"server.instance.disposed"` branch SHALL iterate the closure-scoped `knownSessions` Set and, for each session id, issue a fire-and-forget `fetch(...)` request to `/api/<slug>/sessions/<id>/summary` with body `{summary, title?, final:false}`. The handler MUST NOT `await` the fetch — opencode does not await async handlers at dispose time (verified by spike, design.md::Decision 4 resolved). Awaiting would block opencode's exit AND would still get the subprocess killed before completion. The fire-and-forget call gives the kernel a chance to flush the TCP packet before the subprocess is killed; success is opportunistic.

The body shape is identical to the `session.idle` flush:

- `summary` is the joined transcript: each entry rendered as `<role>: <text>`, separated by `\n\n`, oldest first, truncated from the head if the result exceeds 19500 characters.
- `title` is derived from the first `{role:'user'}` entry's text, truncated to 100 characters. If no user entry exists yet, `title` is OMITTED.
- `final` is always `false`.

The handler SHALL skip sessions whose id is in `subAgentSessions`. The handler SHALL emit ONE stderr diagnostic line per session id of the form `[rembric] dispose-flush sessionId=<id> (fire-and-forget)` to make the attempt visible in opencode's debug logs. Errors are silent — the fetch returns a promise we ignore.

The handler is documented as expected-to-often-fail. The user-facing impact is at-most-one-turn data loss in the worst case (the gap between the last `session.idle` flush and the close). The PRIMARY guarantee for non-cooperating-agent summary convergence comes from `session.idle`; `server.instance.disposed` is the cherry-on-top.

The plugin SHALL declare a `// dispose-spike-result: fire-and-forget` comment in the first 10 lines of `plugin.ts`, recording the spike outcome (locked because the spike result is empirically determined and unlikely to change without a major opencode version bump).

#### Scenario: Disposed event POSTs summary for every known session

- **GIVEN** `knownSessions` contains `["s1", "s2"]` and `sessionMessages` has both with non-empty entries
- **WHEN** the `event` dispatcher receives `event.type === "server.instance.disposed"`
- **THEN** the handler POSTs to `/api/<slug>/sessions/s1/summary` AND `/api/<slug>/sessions/s2/summary`
- **AND** each body has `final: false`
- **AND** each body's `summary` is the role-prefixed transcript truncated to ≤ 19500 chars
- **AND** the bodies omit `title` for sessions whose accumulator has no user entry, OR include `title` as the first-user-text truncated to 100 chars when present

#### Scenario: Disposed event is best-effort

- **GIVEN** the Rembric server is unreachable (5xx, ECONNREFUSED, timeout)
- **WHEN** the dispose handler runs
- **THEN** one stderr diagnostic per failed session is written
- **AND** the handler returns normally without throwing
- **AND** opencode's shutdown is not blocked

#### Scenario: Sub-agent sessions are skipped at dispose time

- **GIVEN** `subAgentSessions` contains `"sub-1"` AND `knownSessions` does NOT contain `"sub-1"` (the v1 filter prevents sub-agents from being added)
- **WHEN** the dispose handler runs
- **THEN** no POST is issued for `"sub-1"`

#### Scenario: Existing model summary (final:true) is preserved

- **GIVEN** session `"s1"` already has `summary_final=true` (the agent previously called `memory.session_summary({final:true})`)
- **WHEN** the dispose handler POSTs `/summary` with `final:false`
- **THEN** the server applies the precedence rule and does NOT overwrite the existing summary
- **AND** the dispose-flush is effectively a no-op for that session

### Requirement: Chat.message handler accumulates user transcript

The `"chat.message"` handler SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Extract text from `output.parts` filtering `part.type === "text"`, joining with newlines, and trimming. If empty, fall back to `output.message.summary.title + "\n" + output.message.summary.body` if available.
3. If the resulting text is empty, return without mutating state.
4. Otherwise append `{role: 'user', text: <stripped+truncated>}` to `sessionMessages.get(input.sessionID)` (creating the array if it does not exist).
5. The handler SHALL pass the text through a `stripPrivateTags` helper that replaces `<private>...</private>` blocks (case-insensitive, multiline) with `[REDACTED]`. The handler SHALL truncate each entry to 2000 characters with a `"..."` suffix if longer.
6. The accumulator MUST cap each session's array at 200 entries. If the array reaches the cap, the oldest entry is shifted out (FIFO) before the new entry is appended. This protects against unbounded memory growth in long sessions.

The handler SHALL NOT POST any HTTP request. The accumulated data flows out only via the `server.instance.disposed` flush.

#### Scenario: User text accumulates

- **WHEN** `chat.message` fires three times with sessionID `"s1"` and user text `"hello"`, `"fix the bug"`, `"thanks"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'user', text:'hello'}, {role:'user', text:'fix the bug'}, {role:'user', text:'thanks'}]`
- **AND** no HTTP request is made

#### Scenario: Private tags are redacted before accumulation

- **WHEN** `chat.message` fires with user text `"Connect to <private>postgresql://u:p@host/db</private> and run a count"`
- **THEN** the appended entry's `text` is `"Connect to [REDACTED] and run a count"`

#### Scenario: Sub-agent prompts are skipped

- **GIVEN** `subAgentSessions` contains `"sub-1"`
- **WHEN** `chat.message` fires with `input.sessionID = "sub-1"`
- **THEN** `sessionMessages` does NOT gain an entry for `"sub-1"`

#### Scenario: Accumulator caps at 200 entries

- **GIVEN** `sessionMessages.get("s1").length === 200`
- **WHEN** a 201st `chat.message` fires for `"s1"`
- **THEN** the oldest entry is removed (the array length stays at 200)
- **AND** the newest entry is at the tail

### Requirement: Message.updated handler accumulates assistant transcript

The `"message.updated"` handler SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Return immediately if `output.message.role !== 'assistant'`. The handler is a no-op for user messages (which are captured by `chat.message`) and any other roles.
3. Extract text from `output.message.parts` filtering text parts. Apply the same `stripPrivateTags` and truncate-to-2000 transforms as `chat.message`.
4. If the resulting text is empty, return.
5. Search `sessionMessages.get(input.sessionID)` for an existing entry whose `id` field equals `output.message.id`. If found, REPLACE its `text` (preserving the entry's position in the array). If not found, APPEND `{role:'assistant', text, id:<output.message.id>}` to the array.

The handler MUST be idempotent under streaming token updates: opencode may fire `message.updated` many times per assistant turn (token-by-token streaming). The id-keyed replacement ensures only one final-state entry per assistant message in the accumulator.

The 200-entry cap from `chat.message` applies here too — when appending a new assistant entry causes the array to exceed 200, the oldest entry is FIFO-evicted.

#### Scenario: Assistant text is appended on first sight, replaced on subsequent updates

- **GIVEN** `sessionMessages.get("s1")` is `[]`
- **WHEN** `message.updated` fires with `output.message.id="m1"`, `role="assistant"`, accumulating parts that resolve to text `"Hello,"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello,', id:'m1'}]`
- **WHEN** `message.updated` fires again with the SAME `output.message.id="m1"` and longer text `"Hello, working on it."`
- **THEN** the entry's text is replaced; the array length stays at 1; the entry's position is unchanged
- **WHEN** `message.updated` fires with a different `output.message.id="m2"`, text `"Done."`
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello, working on it.', id:'m1'}, {role:'assistant', text:'Done.', id:'m2'}]`

#### Scenario: Non-assistant roles are ignored

- **WHEN** `message.updated` fires with `output.message.role="user"` or `"system"` or `"tool"`
- **THEN** the handler returns without mutating `sessionMessages`

### Requirement: Dispose spike result MUST be recorded

The plugin's source file (`plugin/.opencode-plugin/plugin.ts`) MUST declare the comment line `// dispose-spike-result: fire-and-forget` within the first 10 lines, recording the outcome of the pre-implementation runtime spike. Outcome: opencode kills the subprocess before async handlers complete; awaited fetches do not land (full evidence in design.md::Decision 4 resolved). An invariant test (`src/test/invariants.test.ts`) MUST fail the build if the line is absent. The plugin SHALL NOT contain any other `// dispose-spike-result:` line.

#### Scenario: Spike-result comment is recorded

- **WHEN** `plugin/.opencode-plugin/plugin.ts` is read at HEAD
- **THEN** the first 10 lines contain `// dispose-spike-result: fire-and-forget`
- **AND** the `server.instance.disposed` handler does NOT `await` the fetch call

### Requirement: Install script auto-configures opencode.json

`plugin/.opencode-plugin/install.sh` SHALL, in addition to copying the plugin/bridge/dotenv files, manage the `~/.config/opencode/opencode.json` file with conservative semantics so the user does not need to copy-paste an MCP block manually.

Behaviour:

1. If `~/.config/opencode/opencode.json` does NOT exist: the script SHALL create it with a single `mcp.rembric` block. The block SHALL use `{env:VAR}` substitution syntax for credentials (verified to work in opencode 1.15.x — opencode interpolates these from the parent shell at MCP subprocess spawn time). The user only needs to `export REMBRIC_SERVER_URL=...` and `export REMBRIC_API_TOKEN=...` in their shell rc.
2. If `~/.config/opencode/opencode.json` EXISTS and parses as JSON AND has NO `mcp.rembric` key: the script SHALL warn the user and print the snippet to paste manually (do NOT auto-merge — JSONC support and other-MCP-server coexistence make `jq` merging risky).
3. If `~/.config/opencode/opencode.json` EXISTS and ALREADY has an `mcp.rembric` key: the script SHALL leave it untouched and print a one-line status confirming detection.

The written block SHALL be exactly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["node", "<absolute installed bridge path>"],
      "environment": {
        "REMBRIC_SERVER_URL": "{env:REMBRIC_SERVER_URL}",
        "REMBRIC_API_TOKEN": "{env:REMBRIC_API_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

The script's success banner SHALL instruct the user to `export REMBRIC_SERVER_URL=...` and `export REMBRIC_API_TOKEN=...` in their shell rc and restart opencode. The token SHALL be shown as obtained from `/dashboard/tokens` (plaintext shown once).

The plain-text MCP snippet is no longer printed for the auto-write path. It is still printed for case (2) (existing file without rembric block) so the user has the block to merge manually.

#### Scenario: Fresh install writes opencode.json with env-substitution

- **GIVEN** no `~/.config/opencode/opencode.json` exists
- **WHEN** `install.sh` runs
- **THEN** `~/.config/opencode/opencode.json` is created with exactly the documented block
- **AND** the `environment` block uses `"{env:REMBRIC_SERVER_URL}"` and `"{env:REMBRIC_API_TOKEN}"` literally
- **AND** the success banner instructs the user to `export REMBRIC_SERVER_URL` and `export REMBRIC_API_TOKEN`

#### Scenario: Existing opencode.json without rembric block — print snippet

- **GIVEN** `~/.config/opencode/opencode.json` exists with `{"mcp":{"other-server":{...}}}` but no `mcp.rembric`
- **WHEN** `install.sh` runs
- **THEN** `~/.config/opencode/opencode.json` is left UNCHANGED
- **AND** the script prints the MCP block for the user to merge manually
- **AND** the script exits 0 with a warning

#### Scenario: Existing opencode.json with rembric block — leave alone

- **GIVEN** `~/.config/opencode/opencode.json` already contains an `mcp.rembric` block
- **WHEN** `install.sh` runs
- **THEN** `~/.config/opencode/opencode.json` is left UNCHANGED
- **AND** the script prints a one-line confirmation (e.g., `[rembric] mcp.rembric already configured in opencode.json — skipped`)
