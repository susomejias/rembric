## MODIFIED Requirements

### Requirement: Chat.message handler accumulates user transcript

The `"chat.message"` handler SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Call `await ensureSession(input.sessionID)` — idempotent (a no-op if the session is already known) — so a session opencode resumes into without re-emitting `session.created` (e.g. after a client restart) still gets registered before any accumulation or flush happens for it.
3. Extract text from `output.parts` filtering `part.type === "text"`, joining with newlines, and trimming. If empty, fall back to `output.message.summary.title + "\n" + output.message.summary.body` if available.
4. If the resulting text is empty, return without mutating state.
5. Otherwise append `{role: 'user', text: <stripped+truncated>}` to `sessionMessages.get(input.sessionID)` (creating the array if it does not exist).
6. The handler SHALL pass the text through a `stripPrivateTags` helper that replaces `<private>...</private>` blocks (case-insensitive, multiline) with `[REDACTED]`. The handler SHALL truncate each entry to 2000 characters with a `"..."` suffix if longer.
7. The accumulator MUST cap each session's array at 200 entries. If the array reaches the cap, the oldest entry is shifted out (FIFO) before the new entry is appended. This protects against unbounded memory growth in long sessions.
8. After the above, for a non-subagent session, the handler SHALL call `flushSessionSummary(input.sessionID)` **without awaiting it** (`void flushSessionSummary(...)`) — a fire-and-forget POST of the accumulated transcript to `/sessions/:id/summary`, on every call, with no throttle and no counter. The handler itself SHALL NOT await, block on, or otherwise delay its own return on this call.

The handler SHALL await `ensureSession` (step 2) but SHALL NOT `await` any HTTP request beyond that as part of its own control flow — the fire-and-forget flush in step 8 is the sole additional POST this handler triggers, and it must never delay the handler's return. `ensureSession` itself resolves quickly (it either no-ops on an already-known session or fires a single registration POST that the handler does wait on, matching the existing behavior of `session.created` and `experimental.session.compacting`, which already await it). (Previously this handler made no HTTP request at all and relied solely on the `server.instance.disposed` flush; that periodic accumulation-only behavior is superseded by step 8 without removing the dispose-time flush, which remains a last-chance mechanism for whatever accumulated since the last `chat.message`.)

#### Scenario: User text accumulates

- **WHEN** `chat.message` fires three times with sessionID `"s1"` and user text `"hello"`, `"fix the bug"`, `"thanks"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'user', text:'hello'}, {role:'user', text:'fix the bug'}, {role:'user', text:'thanks'}]`
- **AND** each call additionally triggers an un-awaited `flushSessionSummary("s1")`

#### Scenario: Private tags are redacted before accumulation

- **WHEN** `chat.message` fires with user text `"Connect to <private>postgresql://u:p@host/db</private> and run a count"`
- **THEN** the appended entry's `text` is `"Connect to [REDACTED] and run a count"`

#### Scenario: Sub-agent prompts are skipped

- **GIVEN** `subAgentSessions` contains `"sub-1"`
- **WHEN** `chat.message` fires with `input.sessionID = "sub-1"`
- **THEN** `sessionMessages` does NOT gain an entry for `"sub-1"`
- **AND** `flushSessionSummary` SHALL NOT be called for `"sub-1"`
- **AND** `ensureSession` SHALL NOT be called for `"sub-1"`

#### Scenario: Accumulator caps at 200 entries

- **GIVEN** `sessionMessages.get("s1").length === 200`
- **WHEN** a 201st `chat.message` fires for `"s1"`
- **THEN** the oldest entry is removed (the array length stays at 200)
- **AND** the newest entry is at the tail

#### Scenario: The per-turn flush never blocks the handler's return

- **WHEN** `chat.message` fires and `flushSessionSummary`'s underlying `fetch` is slow or hangs
- **THEN** the handler SHALL still return promptly (its own promise resolves without waiting on the fetch), because the call is `void`-invoked, not awaited
- **AND** the written `summary`/`title` SHALL have `final` omitted, so the server never marks the session curated from this path

#### Scenario: The per-turn flush does not replace the dispose-time last-chance flush

- **GIVEN** a session with accumulated messages since its last `chat.message`-triggered flush
- **WHEN** the opencode process is killed and `server.instance.disposed` fires
- **THEN** the existing best-effort dispose flush SHALL still attempt to send whatever accumulated since the last per-turn flush, unchanged from its current behavior

#### Scenario: A resumed session with no prior session.created is registered before its first flush

- **GIVEN** `knownSessions` does NOT contain `"resumed-1"` (opencode did not re-emit `session.created` for it after a restart) and `subAgentSessions` does NOT contain it either
- **WHEN** `chat.message` fires for `input.sessionID = "resumed-1"` with non-empty user text
- **THEN** `ensureSession("resumed-1")` SHALL run BEFORE the text is appended to `sessionMessages`, registering the session via `POST /sessions`
- **AND** the subsequent `void flushSessionSummary("resumed-1")` call SHALL find the session in `knownSessions` and actually POST the summary, instead of silently no-opping
