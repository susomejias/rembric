## MODIFIED Requirements

### Requirement: Sessions MUST converge on a non-null summary when the agent cooperates OR the transcript is reachable

Every closed session in the dashboard SHALL display a non-null `summary` whenever ANY of the following held during its lifetime:

- The agent called `memory.session_summary({summary, title?})` at any point.
- The session compacted (Claude Code only) and the model produced a compact summary the post-compact instruction injection could refer to.
- The session reached `SessionEnd` (Claude Code) or successive `Stop` invocations (Codex) with a readable `transcript_path` containing at least one assistant turn.
- The session ran under Hermes Agent (`on_session_end(messages)` with non-empty messages).
- The session ran under opencode and **either** the agent called `memory.session_summary({summary, title?})` voluntarily, **or** opencode's `server.instance.disposed` event fired with a non-empty per-session transcript accumulator. The opencode plugin POSTs `/api/<slug>/sessions/<id>/summary` with `final:false` for every known top-level session at dispose time, populated from the in-memory `sessionMessages` Map fed by `chat.message` and `message.updated` handlers during the session. `status` stays `'active'` until `abandonStale` flips it (the plugin never POSTs `/end`).

A session SHALL be considered to have "converged on a summary" if its `sessions.summary` column is non-null. Coverage in the contrary case (transcript file missing, hook scripts never fired, agent ignored every instruction, Hermes messages list empty, opencode hard-crashed before `server.instance.disposed` could fire) is OUT of scope — these are degenerate states the dashboard surfaces as "no summary captured" without crashing.

Plugin-side fallback writers (bash transcript dump, Hermes `_format_transcript`, opencode dispose-time flush) truncate their transcript by Unicode **code points**, while the server measures string length in **UTF-16 code units**. The HTTP length guard SHALL account for this skew so a body within a plugin's code-point cap is NEVER rejected by it (the `http-api` capability holds the authoritative endpoint contract). On the HTTP path the server SHALL **truncate, never reject by length**: any `summary` whose length exceeds `SUMMARY_MAX_CHARS` SHALL be replaced with `summary.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + '…[truncated]'`, and any over-length `title` SHALL be hard-cut to `TITLE_MAX_LENGTH`, before calling the service. Convergence is therefore on a row whose stored `summary` is bounded by `SUMMARY_MAX_CHARS` regardless of what the fallback writer sent — INCLUDING transcripts rich in emoji or other non-BMP characters, which previously could trip an over-strict wire cap (a `summary` at the plugin's code-point cap measuring >cap UTF-16 units) and leave the session with NO summary at all. Historical specs used literal numbers (`19500`, then `2000`, then `20000`) for derived or previous caps; this spec references the server cap (`SUMMARY_MAX_CHARS`) abstractly so it does not drift when the cap changes.

The bash fallback's transcript formatter (`_rembric_format_transcript_claude_code_jq`/`_codex_cli_jq`) streams output line-by-line as it parses; if the transcript's final line is torn (a `Stop` hook racing an in-progress append, or a crash mid-write), the parser SHALL still contribute every well-formed line that preceded the torn one to the summary — a torn trailing line SHALL degrade the summary by at most that one line, NEVER discard the entire transcript.

#### Scenario: Claude Code short session with cooperating agent

- **GIVEN** a Claude Code session of N user prompts (N ≥ 1, no compact)
- **AND** the agent called `memory.session_summary({summary, title})` at any point before stop with `summary.length <= SUMMARY_MAX_CHARS`
- **WHEN** the user closes the session and `SessionEnd` fires
- **THEN** `sessions.summary` SHALL be the model-authored content (preserved because `final:true` blocks the bash overwrite)
- **AND** `sessions.title` SHALL be the model-authored title
- **AND** `sessions.status` SHALL be `'ended'`

#### Scenario: Claude Code short session with non-cooperating agent

- **GIVEN** a Claude Code session of N user prompts (N ≥ 1, no compact)
- **AND** the agent never called `memory.session_summary`
- **WHEN** the user closes the session and `SessionEnd` fires with a non-empty `transcript_path` JSONL
- **THEN** `sessions.summary` SHALL be the bash fallback's formatted transcript (oldest-first, role: content) truncated server-side to at most `SUMMARY_MAX_CHARS` chars, with the suffix `…[truncated]` when truncation fired
- **AND** `sessions.title` SHALL be derived from the first non-empty assistant message in the transcript, truncated to 100 chars
- **AND** `sessions.status` SHALL be `'ended'`

#### Scenario: Codex short session captures summary via per-turn Stop

- **GIVEN** a Codex session of N turns (N ≥ 1, no compact)
- **AND** every `Stop` hook fired and posted `/summary` with the running transcript
- **WHEN** the user closes the Codex CLI
- **THEN** `sessions.summary` SHALL contain the most recent transcript (from the final `Stop` of the session), truncated server-side to at most `SUMMARY_MAX_CHARS` when the wire body exceeded the cap
- **AND** `sessions.title` SHALL be derived from the first non-empty assistant message
- **AND** `sessions.status` SHALL be `'active'` until `abandonStale` flips it to `'abandoned'` (Codex has no SessionEnd signal — this is the expected steady state)

#### Scenario: Hermes short session

- **GIVEN** a Hermes session of N turns (N ≥ 1, no compress)
- **WHEN** the user exits and `on_session_end(messages)` fires
- **THEN** the provider SHALL POST `/end {summary: _format_transcript(messages), title, final:false}` whose `summary` is bounded client-side by `_SUMMARY_MAX_CHARS` (a wire upper bound, not the effective cap)
- **AND** the server SHALL truncate any body exceeding `SUMMARY_MAX_CHARS` before storing
- **AND** `sessions.summary` SHALL be non-null and of length ≤ `SUMMARY_MAX_CHARS`
- **AND** `sessions.status` SHALL be `'ended'`

#### Scenario: Hermes emoji-rich transcript still converges (no UTF-16 wire-cap rejection)

- **GIVEN** a Hermes session whose per-turn `sync_turn` transcript contains emoji or other non-BMP characters and whose code-point length is at or near the plugin's client-side truncation cap
- **WHEN** the plugin POSTs `/sessions/<id>/summary` and the body's UTF-16 `.length` exceeds the plugin's code-point cap
- **THEN** the server SHALL accept and truncate the body (200 OK), NOT reject it with `400 invalid_input`
- **AND** `sessions.summary` SHALL be non-null (the session converges) — this is the behaviour change vs. the prior over-strict wire cap that left such sessions empty

#### Scenario: opencode short session with cooperating agent

- **GIVEN** an opencode session of N user prompts (N ≥ 1, no compact)
- **AND** the agent called `memory.session_summary({summary, title})` via MCP at any point (sets `summary_final=true` server-side)
- **WHEN** the user closes opencode (firing `server.instance.disposed`)
- **THEN** the plugin's dispose handler POSTs `/sessions/<id>/summary` with the accumulated transcript and `final:false`
- **AND** the server applies the precedence rule and DOES NOT overwrite the existing summary (because `summary_final=true`)
- **AND** `sessions.summary` SHALL remain the model-authored content
- **AND** `sessions.title` SHALL remain the model-authored title
- **AND** `sessions.status` SHALL stay `'active'` until `abandonStale` flips it, unless the agent itself called `memory.session_end` — the opencode plugin never POSTs `/end`, and `memory.session_summary` does not transition the session (`POST /sessions/<id>/end` and `memory.session_end` are the sole transitions, per the `sessions` capability)

#### Scenario: opencode short session with non-cooperating agent

- **GIVEN** an opencode session of N user prompts (N ≥ 1, no compact)
- **AND** the agent never called `memory.session_summary`
- **WHEN** the user closes opencode (firing `server.instance.disposed`)
- **THEN** the plugin's dispose handler POSTs `/sessions/<id>/summary` for every known session with body `{summary: <role-prefixed transcript bounded by the plugin's client-side wire upper bound>, title?: <first user text truncated to 100 chars>, final: false}`
- **AND** the server SHALL truncate `summary` to `SUMMARY_MAX_CHARS` chars with the suffix `…[truncated]` when the wire body exceeded the cap
- **AND** `sessions.summary` SHALL be the accumulated (possibly server-truncated) transcript (NOT `NULL` — this is the key behaviour change vs the pre-0.8.0 plugin)
- **AND** `sessions.title` SHALL be the derived title when the accumulator had at least one user entry; OMITTED from the body otherwise (server leaves the placeholder `basename(cwd) · HH:MM UTC` in place)
- **AND** `sessions.status` SHALL be `'active'` until `abandonStale` flips it to `'abandoned'`
- **AND** the dashboard surfaces the session row with the (possibly truncated) transcript visible immediately after close

#### Scenario: opencode hard-crash before dispose fires

- **GIVEN** opencode is killed via SIGKILL (or OS-level crash) before `server.instance.disposed` can fire
- **WHEN** the operator opens the dashboard
- **THEN** the session row's `summary` SHALL be `NULL` (no fallback exists for this scenario — same risk Claude/Codex hooks carry)
- **AND** `sessions.status` SHALL be `'active'` until `abandonStale` flips it
- **AND** the dashboard surfaces the session as "no summary captured" without crashing

#### Scenario: opencode session survives compaction with cooperating agent

- **GIVEN** an opencode session approaching the context window limit
- **WHEN** `experimental.session.compacting` fires
- **THEN** the plugin appends the recall-context block AND the "FIRST ACTION REQUIRED: call memory.session_summary" reminder to `output.context`
- **AND** the next agent (post-compaction) reads that reminder and calls `memory.session_summary({summary: <compacted summary content>, title})` with `summary.length <= SUMMARY_MAX_CHARS`
- **AND** the resulting row in `sessions` has the compacted summary as `summary` and a non-null `title`

#### Scenario: Claude Code session ends with a torn trailing transcript line

- **GIVEN** a Claude Code session whose transcript JSONL's final line was torn mid-write (a `Stop` hook race or a crash), while every earlier line is well-formed JSON containing at least one assistant turn
- **AND** the agent never called `memory.session_summary`
- **WHEN** the user closes the session and `SessionEnd` fires with that transcript's path
- **THEN** `sessions.summary` SHALL contain every well-formed line before the torn one (oldest-first, role: content)
- **AND** `sessions.summary` SHALL NOT be `NULL` or empty — the torn line degrades the summary by at most itself, it does not discard the lines that parsed successfully before it

### Requirement: Per-client lifecycle mapping MUST be honoured

The cross-client write contract maps lifecycle events to HTTP endpoints as follows. Implementations SHALL conform; divergences from this mapping SHALL be considered specification violations.

| Client      | Lifecycle event                                   | HTTP call                                                                     | `final` |
| ----------- | ------------------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| Claude Code | `SessionStart` (`startup\|resume\|clear`)         | `POST /sessions {id, cwd, agent}` (placeholder title)                         | n/a     |
| Claude Code | `SessionStart` (`compact`)                        | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) + stdout instruction | n/a     |
| Claude Code | `UserPromptSubmit`                                | none (stdout nudges only)                                                     | n/a     |
| Claude Code | `Stop` (every turn)                               | `POST /summary {summary, title}` — `final` OMITTED                            | absent  |
| Claude Code | `PreCompact`                                      | `POST /summary {summary, title, final:false}`, or `{}` when no transcript     | false   |
| Claude Code | `PostCompact`                                     | `POST /summary {summary, final:false}`, or `{}` when no compaction summary    | false   |
| Claude Code | `SessionEnd`                                      | `POST /end {summary, title, final:false}`, or `{}` when no transcript         | false   |
| Codex CLI   | `SessionStart` (`startup\|resume\|clear`)         | `POST /sessions {id, cwd, agent}`                                             | n/a     |
| Codex CLI   | `SessionStart` (`compact`)                        | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) + stdout instruction | n/a     |
| Codex CLI   | `UserPromptSubmit`                                | none (stdout nudges only)                                                     | n/a     |
| Codex CLI   | `Stop` (every turn)                               | `POST /summary {summary, title, final:false}` + stdout `'{}'`                 | false   |
| Codex CLI   | `PreCompact`                                      | `POST /summary {summary, title, final:false}`, or `{}` when no transcript     | false   |
| Codex CLI   | `PostCompact`                                     | `POST /summary {summary, final:false}`, or `{}` when no compaction summary    | false   |
| Hermes      | `initialize`                                      | `POST /sessions {id, cwd, agent}`                                             | n/a     |
| Hermes      | `on_pre_compress(messages)`                       | `POST /summary {summary, final:false}`                                        | false   |
| Hermes      | `on_session_switch(new_id, parent_id)`            | `POST /end old + POST /sessions new`                                          | n/a     |
| Hermes      | `on_session_end(messages)`                        | `POST /end {summary, title, final:false}`                                     | false   |
| opencode    | `session.created` (not a sub-agent)               | `POST /sessions {id, cwd, agent}`                                             | n/a     |
| opencode    | `chat.message`                                    | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) + debounced `/summary` | false   |
| opencode    | `session.idle`                                    | debounced `POST /summary {summary, title?, final:false}`                       | false   |
| opencode    | `session.compacted`                               | `POST /summary {summary, title?, final:false}`                                | false   |
| opencode    | `experimental.session.compacting`                 | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) + injected context   | n/a     |
| opencode    | `session.deleted`                                 | none (drops the in-memory accumulator only)                                   | n/a     |
| opencode    | `server.instance.disposed`                        | fire-and-forget `POST /summary {summary, title?, final:false}` per known session — never `/end` | false   |
| Pi          | `session_start`                                   | none (creates the protocol client and discovers tools over MCP)               | n/a     |
| Pi          | `before_agent_start`                              | `POST /sessions {id, cwd, agent}` (idempotent ensure) + injected nudges       | n/a     |
| Pi          | `message_end`                                     | none (feeds the in-memory accumulator only)                                   | n/a     |
| Pi          | `agent_settled`                                   | debounced `POST /summary {summary, title?, final:false}`                       | false   |
| Pi          | `session_shutdown` (`quit\|new\|resume\|fork`, not a self-resume) | `POST /end {summary, title, final:false}`, or `{}` when the accumulator is empty | false   |
| Pi          | `session_shutdown` (`reload`, a self-resume, or an unrecognised reason) | `POST /summary {summary, title?, final:false}` — never `/end`     | false   |
| Any (model) | `memory.session_summary({summary, title?})` (MCP) | internal write (no HTTP) with `final:true`                                    | true    |

Four rows are load-bearing and easy to get wrong:

- **Claude Code `Stop` omits `final` entirely** — it is never sent as `true` and never sent as `false`. Codex's `Stop` sends `final:false` explicitly, because Codex has no `SessionEnd` and its row must stay `active` for the next turn. `apps/plugin/scripts/stop-sync.sh` selects between the two from its agent-name argument.
- **`SessionStart (compact)` does make an HTTP call on both clients.** `post-compact.sh` re-POSTs `/sessions` as an idempotent ensure before emitting its stdout block, covering the case where the stale sweep abandoned the row between the pre-compact moment and the resume. Its stdout block is additionally injected into the resumed model's context.
- **Pi's two `session_shutdown` rows are selected by the event's `reason`, and the split is the whole point.** `reason: "reload"` is the same session continuing, and the status FSM has no path back to `active`, so ending there costs `session_id = NULL` on every later write for the rest of the process. A `resume` that names the session file already open is the same hazard under a different reason. The gate and its self-resume guard are specified in the `pi-plugin` capability; this table records which endpoint each branch reaches. Pi is the only client that chooses its shutdown endpoint at runtime.
- **opencode's dispose row is fire-and-forget and never `/end`, by decision rather than omission.** The host kills the subprocess before async handlers settle, so an awaited call there would frequently not land and no requirement could promise `ended`. An opencode row therefore stays `active` until `abandonStale` flips it — the same steady state as Codex.

Codex CLI has no `SessionEnd` event, so a Codex session row stays `active` until the `abandonStale` job flips it to `abandoned`. opencode reaches the same steady state for the reason above. Of the five clients, three POST `/end`: Claude Code, Hermes and Pi.

#### Scenario: Every client has a row and no client has an undocumented lifecycle write

- **WHEN** the table above is compared against the shipped clients at HEAD
- **THEN** each of the five clients SHALL have at least one row
- **AND** every lifecycle handler in each client that issues an HTTP request SHALL correspond to a row naming that endpoint
- **AND** a handler that issues no request SHALL either be absent from the table or carry `none` in the HTTP-call column

#### Scenario: Claude Code hooks.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** `Stop` SHALL declare exactly two entries
- **AND** the six event types SHALL carry nine handler entries in total
- **AND** the FIRST `Stop` handler (the raw sync) SHALL declare `"async": true` and the SECOND (the end-of-turn reminder) SHALL NOT declare `async` — an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback to the turn
- **AND** the `hooks` object SHALL NOT contain a `PostToolUse` entry

#### Scenario: Codex hooks.codex.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these five event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** `Stop` SHALL declare exactly two entries
- **AND** the five event types SHALL carry eight handler entries in total
- **AND** the `hooks` object SHALL NOT contain a `SessionEnd` entry (Codex does not support the event)
- **AND** the `Stop` script SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout — plain text is invalid per docs)

#### Scenario: `pre-compact.sh` exists and is wired on both clients

- **WHEN** the repository is inspected at HEAD
- **THEN** `apps/plugin/scripts/pre-compact.sh` SHALL exist and be executable
- **AND** `hooks.json`'s `PreCompact` entry SHALL invoke it with the agent argument `claude-code`
- **AND** `hooks.codex.json`'s `PreCompact` entry SHALL invoke it with the agent argument `codex-cli`

#### Scenario: Claude Code `Stop` never marks the session curated

- **GIVEN** a Claude Code session whose `summary_final` is `false`
- **WHEN** the `Stop` hook fires and POSTs `/summary`
- **THEN** the request body SHALL NOT contain a `final` key
- **AND** the row's `summary_final` and `title_final` SHALL remain `false`

#### Scenario: Hermes plugin.yaml declares the lifecycle methods

- **WHEN** `apps/plugin/.hermes-plugin/plugin.yaml` is loaded
- **THEN** the `hooks` array SHALL contain `on_pre_compress`, `on_session_end`, and `on_session_switch`

### Requirement: Sessions under the Pi client MUST converge on a non-null summary

Every closed session created by the Pi client SHALL end with a non-null `sessions.summary` whenever **either** of the following held during its lifetime:

- The agent called `memory.session_summary({summary, title?})` at any point, or
- the harness's session-shutdown handler ran with a non-empty per-session transcript accumulator.

The second condition SHALL hold for **every** shutdown reason, and it is not the same request in both cases. On a reason that closes the session the awaited POST is `/end` carrying `{summary, title, final:false}`; on `reload`, on a self-resume, and on an unrecognised reason it is `/summary` with the same body. Convergence is therefore independent of the reason gate: whichever branch the gate selects, the accumulated transcript is written by one awaited request. The reason gate decides `status`, never `summary` — its contract lives in the `pi-plugin` capability.

An empty accumulator does NOT converge and is not expected to: on a closing reason the client POSTs `/end` with an empty body, so the row reaches `'ended'` with `summary` still `NULL`. That is a session with nothing in it, and the dashboard surfaces it as "no summary captured" exactly as for the other degenerate cases.

The second condition is a stronger guarantee than the equivalent opencode condition, and the difference is measured rather than assumed. The harness awaits its shutdown handler with no timeout (measured against 0.84.1: a 300 ms awaited fetch completes, a 10 s one completes, and an MCP `tools/call` issued from inside the handler completes; SIGTERM and SIGHUP both reach it; the discriminating control — SIGKILL — runs nothing). So this client's final flush is an **awaited** POST and its landing is a guarantee, not a race, whereas the opencode dispose-time flush is explicitly best-effort because that host kills the subprocess before async handlers finish.

A per-turn debounced flush SHALL also run, as for the other in-process clients, so the server's summary is current at all times and any loss is bounded to one turn.

**One documented exception:** an interrupt does not reach the shutdown handler in either mode. In print mode SIGINT is not registered as a signal (`dist/modes/print-mode.js:32`, `const signals = ["SIGTERM"]`, with SIGHUP wired separately). In the interactive TUI the interrupt byte is a keypress and is measured not to exit: under a pty with keys at t=4 s and stdin held open to t=14 s, Ctrl-C left the handler firing at 13.6 s (the stdin EOF, byte-identical to the no-keys control) while Ctrl-D fired it at 3.6 s. So a Ctrl-C loses the final flush in both modes, Ctrl-D does not, and the per-turn flush bounds the loss to one turn. Convergence after a Ctrl-C is therefore out of scope in exactly the way a hard crash already is.

#### Scenario: Cooperating agent

- **GIVEN** a Pi session in which the agent called `memory.session_summary({summary, title})`
- **WHEN** the session ends
- **THEN** `sessions.summary` SHALL be the model-authored content
- **AND** it SHALL NOT be overwritten by the shutdown flush (which POSTs with `final:false`)

#### Scenario: Non-cooperating agent, normal shutdown

- **GIVEN** a Pi session with at least one user turn and no `memory.session_summary` call
- **WHEN** the harness shuts the session down through its normal exit path or SIGTERM
- **THEN** the awaited POST carrying the accumulated transcript SHALL complete before the process exits — `/end` because that reason closes the session
- **AND** `sessions.summary` SHALL be non-null
- **AND** `sessions.status` SHALL be `'ended'`

#### Scenario: A reload converges without ending the session

- **GIVEN** a Pi session with at least one user turn and no `memory.session_summary` call
- **WHEN** `session_shutdown` fires with `reason: "reload"`
- **THEN** the awaited POST SHALL be `/summary`, not `/end`
- **AND** `sessions.summary` SHALL be non-null
- **AND** `sessions.status` SHALL still be `'active'`

#### Scenario: SIGKILL loses the final flush (the discriminating control)

- **GIVEN** a Pi session with accumulated transcript entries
- **WHEN** the process is SIGKILLed
- **THEN** no shutdown handler SHALL run
- **AND** convergence SHALL rest on the last per-turn flush, so the stored summary SHALL lag by at most one turn

### Requirement: The shared client core MUST be the single implementation of the cross-client protocol logic

The nudge constants and texts, the `<private>` redaction helper, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers, and the session-end call SHALL exist in exactly one JS/TS implementation, at `apps/plugin/bin/rembric-plugin-core.mjs`. Every JS/TS client SHALL import them from there and SHALL declare no local copy.

This is what makes the byte-identical-nudge and identical-redaction-semantics requirements structural rather than a matter of discipline: with one implementation there is no second copy to keep in step, and a client added later inherits both contracts by construction.

A member of that list SHALL live in the core even when exactly one client calls it. The session-end call is the case in point: only Pi invokes it, because opencode's host kills the subprocess before an awaited call can land. Placing it in the client that happens to use it would put a second `fetch` against a `/sessions/…` path in a client file, which is a second implementation of the session HTTP client whatever it is named, and it would leave the next client that needs the verb to write a third.

An invariant test in `apps/server/src/test/invariants.test.ts` SHALL fail the build when a second JS/TS definition of any of these appears. The test SHALL (a) assert a **non-zero count** of scanned files, so an empty file list cannot satisfy the negative assertions vacuously, and (b) derive its scanned file list from a repository-wide search rather than a hard-coded list, so a client added later is scanned on the day it is added. The failure message SHALL name the offending `<file>:<line>`.

The core SHALL require `agent` as a mandatory parameter of session registration, with no default. `sessions.agent` is written once per session and memory is append-only, so a defaulted value misattributes sessions permanently with no repair verb.

#### Scenario: A second redaction implementation fails the build

- **GIVEN** a change introduces a local `function stripPrivateTags` in any JS/TS client file
- **WHEN** `pnpm vitest run apps/server/src/test/invariants.test.ts` runs
- **THEN** the test SHALL fail with a message naming the offending file and line

#### Scenario: The invariant cannot pass vacuously

- **GIVEN** the invariant's derived file list is empty (for example because the search pattern stopped matching)
- **WHEN** the test runs
- **THEN** it SHALL fail on the non-zero-count assertion
- **AND** it SHALL NOT report success on the strength of the negative assertions alone

#### Scenario: Bash and Python keep their own implementations

- **WHEN** the invariant runs against the repository at HEAD
- **THEN** the bash implementations (`apps/plugin/scripts/_transcript.sh`, `apps/plugin/scripts/_api.sh`) and the Python implementation (`apps/plugin/.hermes-plugin/__init__.py`) SHALL NOT be flagged
- **AND** the shared cross-language fixtures SHALL remain the mechanism keeping them in agreement
