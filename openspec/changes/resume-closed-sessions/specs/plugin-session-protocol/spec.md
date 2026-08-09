## MODIFIED Requirements

### Requirement: Sessions MUST converge on a non-null summary when the agent cooperates OR the transcript is reachable

Every closed session in the dashboard SHALL display a non-null `summary` whenever ANY of the following held during its lifetime:

- The agent called `memory.session_summary({summary, title?})` at any point.
- The session compacted (Claude Code only) and the model produced a compact summary the post-compact instruction injection could refer to.
- The session reached `SessionEnd` (Claude Code **or Codex CLI** — both hosts fire the event; Codex's runs for the main thread only and never for subagents) or successive `Stop` invocations (Codex) with a readable `transcript_path` containing at least one assistant turn.
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
- **AND** `sessions.status` SHALL be `'ended'` once Codex's `SessionEnd` hook fires, which it does when Codex closes normally, when an open conversation is archived or deleted, or after 30 minutes idle with no connected client
- **AND** when `SessionEnd` does NOT fire — a subagent thread, a SIGKILL, or a handler that overran its 1–3 second budget — `sessions.status` SHALL remain `'active'` until `abandonStale` flips it to `'abandoned'`, which is the remaining steady state rather than the only one

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
- **AND** `sessions.status` SHALL stay `'active'` until `abandonStale` flips it, unless the agent itself called `memory.session_end` — the opencode plugin never POSTs `/end`, and `memory.session_summary` does not transition the session (`POST /sessions/<id>/end` and `memory.session_end` are the sole transitions out of `active`, per the `sessions` capability)

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

| Client      | Lifecycle event                                                         | HTTP call                                                                                       | `final` |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| Claude Code | `SessionStart` (`startup\|resume\|clear\|fork`)                         | `POST /sessions {id, cwd, agent}` (placeholder title) **then `POST /sessions/<id>/resume`**      | n/a     |
| Claude Code | `SessionStart` (`compact`)                                              | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) **then `POST /sessions/<id>/resume`** + stdout instruction | n/a     |
| Claude Code | `UserPromptSubmit`                                                      | none (stdout nudges only)                                                                       | n/a     |
| Claude Code | `Stop` (every turn)                                                     | `POST /summary {summary, title}` — `final` OMITTED                                              | absent  |
| Claude Code | `PreCompact`                                                            | `POST /summary {summary, title, final:false}`, or `{}` when no transcript                       | false   |
| Claude Code | `PostCompact`                                                           | `POST /summary {summary, final:false}`, or `{}` when no compaction summary                      | false   |
| Claude Code | `SessionEnd`                                                            | `POST /end {summary, title, final:false}`, or `{}` when no transcript                           | false   |
| Codex CLI   | `SessionStart` (`startup\|resume\|clear`)                               | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                         | n/a     |
| Codex CLI   | `SessionStart` (`compact`)                                              | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) **then `POST /sessions/<id>/resume`** + stdout instruction | n/a     |
| Codex CLI   | `UserPromptSubmit`                                                      | none (stdout nudges only)                                                                       | n/a     |
| Codex CLI   | `Stop` (every turn)                                                     | `POST /summary {summary, title, final:false}` + stdout `'{}'`                                   | false   |
| Codex CLI   | `PreCompact`                                                            | `POST /summary {summary, title, final:false}`, or `{}` when no transcript                       | false   |
| Codex CLI   | `PostCompact`                                                           | `POST /summary {summary, final:false}`, or `{}` when no compaction summary                      | false   |
| Codex CLI   | `SessionEnd` (main thread only)                                         | `POST /end {summary, title, final:false}`, or `{}` when no transcript                           | false   |
| Hermes      | `initialize`                                                            | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                         | n/a     |
| Hermes      | `on_pre_compress(messages)`                                             | `POST /summary {summary, final:false}`                                                          | false   |
| Hermes      | `on_session_switch(new_id, parent_id)`                                  | `POST /end old` (only when the id actually changed) `+ POST /sessions new` **then `POST /sessions/new/resume`** on the first ensure of `new` in this process | n/a     |
| Hermes      | `on_session_end(messages)`                                              | `POST /end {summary, title, final:false}`                                                       | false   |
| opencode    | `session.created` (not a sub-agent)                                     | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                         | n/a     |
| opencode    | `chat.message`                                                          | `POST /sessions {id, cwd, agent}` + resume on the first ensure of the id in this process; no-op afterwards; + debounced `/summary` | false   |
| opencode    | `session.idle`                                                          | debounced `POST /summary {summary, title?, final:false}`                                        | false   |
| opencode    | `session.compacted`                                                     | `POST /summary {summary, title?, final:false}`                                                  | false   |
| opencode    | `experimental.session.compacting`                                       | `POST /sessions {id, cwd, agent}` + resume on the first ensure of the id in this process; no-op afterwards; + injected context | n/a     |
| opencode    | `session.deleted`                                                       | none (drops the in-memory accumulator only)                                                     | n/a     |
| opencode    | `server.instance.disposed`                                              | fire-and-forget `POST /summary {summary, title?, final:false}` per known session — never `/end` | false   |
| Pi          | `session_start`                                                         | none (creates the protocol client and discovers tools over MCP)                                 | n/a     |
| Pi          | `before_agent_start`                                                    | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`** on the first ensure of the id in this process; + injected nudges | n/a     |
| Pi          | `message_end`                                                           | none (feeds the in-memory accumulator only)                                                     | n/a     |
| Pi          | `agent_settled`                                                         | debounced `POST /summary {summary, title?, final:false}`                                        | false   |
| Pi          | `session_shutdown` (`quit\|new\|resume\|fork`, not a self-resume)       | `POST /end {summary, title, final:false}`, or `{}` when the accumulator is empty                | false   |
| Pi          | `session_shutdown` (`reload`, a self-resume, or an unrecognised reason) | `POST /summary {summary, title?, final:false}` — never `/end`                                   | false   |
| Any (model) | `memory.session_summary({summary, title?})` (MCP)                       | internal write (no HTTP) with `final:true`                                                      | true    |

**Every client SHALL issue exactly one `POST /api/<slug>/sessions/<id>/resume` per session id per process, immediately after the FIRST `POST /api/<slug>/sessions` ensure for that id in that process, and SHALL NOT condition it on any host signal.** This is the one uniform rule; there is no per-client variation in when the call is made, and a client SHALL NOT gate it on a `source`, `reason` or `reset` value.

Three properties make the unconditional form the correct one rather than a shortcut:

- **The resume is a documented no-op on an `active` row** (`http-api` capability), so on a genuinely new session the call changes nothing and costs one local request. The client therefore does not need to know whether it is resuming, which is fortunate, because —
- **no client has a resume signal on a cold start**, and a cold start is the case that motivates the rule. Claude Code and Codex CLI do expose `source: "resume"` on `SessionStart`, and Hermes exposes `reason="resume"` with `reset=False` on `on_session_switch`, but those fire for session changes **inside a living process**, where the client's own in-memory state already keeps attribution correct. Pi's cold-start resume arrives as `reason: "startup"`, indistinguishable from a clean start. Building the emitter on those signals would produce a per-client asymmetry that still failed the case it was built for.
- **The ordering is ensure-then-resume, and it is load-bearing.** A session whose row was physically purged by `purgeEmpty` (permitted once a terminal row's grace elapses with no memories attached) is recreated `active` by the ensure, and the resume that follows is then a no-op against the row the ensure just created. The conversation continues under the same id with no special case. Reversing the order would resume a row that does not exist and report `session_not_found` for a conversation that is about to be perfectly healthy.

The rule replaces a recovery two clients already attempt and provably cannot perform: `post-compact.sh`'s ensure carries the comment "covers the case where the row was abandoned by the stale sweep between the pre-compact moment and the post-compact resume — re-create silently", and the ensure path returns a terminal row untouched (`http-api` capability). Before this rule that comment described behaviour that did not exist.

Six rows are load-bearing and easy to get wrong:

- **Claude Code `Stop` omits `final` entirely** — it is never sent as `true` and never sent as `false`. Codex's `Stop` sends `final:false` explicitly, because Codex's `Stop` is per-turn and the row must stay `active` for the next turn. `apps/plugin/scripts/stop-sync.sh` selects between the two from its agent-name argument.
- **`SessionStart (compact)` does make HTTP calls on both clients.** `post-compact.sh` re-POSTs `/sessions` and then `/sessions/<id>/resume` before emitting its stdout block. Its stdout block is additionally injected into the resumed model's context.
- **Claude Code's `SessionStart` matcher group includes `fork`.** A forked session (`--fork-session` with `--resume`/`--continue`, the `/fork` background copy, or `/branch`) reports `source: "fork"` from v2.1.214 onward and carries a NEW session id, so it is a new session that must be registered. A matcher group that omits `fork` registers no row and emits no nudge for the entire forked conversation. Codex's `SessionStart` has no `fork` source — its documented values are `startup`, `resume`, `clear` and `compact` — so its matcher group SHALL NOT declare one, and the asymmetry is the hosts', not ours.
- **Codex CLI DOES have `SessionEnd`.** It runs for the main thread when an open conversation is archived or deleted, when Codex closes normally, or after 30 minutes idle with no connected client, and it does not run for subagents. It carries a `reason` field whose only current value is `other`. Its time budget is the tightest of any hook on either host: **1 second by default, 3 seconds maximum**, where every other Codex hook defaults to 600. A handler that does not declare `"timeout": 3` is killed after one second, and a POST allowed to consume that whole budget leaves nothing for reading the transcript or emitting the failure diagnostic. The budget is a property of the event, so it is specified here and enforced in `codex-distribution`.
- **Pi's two `session_shutdown` rows are selected by the event's `reason`, and the split is the whole point.** `reason: "reload"` is the same session continuing; ending there costs `session_id = NULL` on every later write until the next `before_agent_start` ensure-and-resume repairs it, and there is no reason to incur a repairable fault when the correct branch is free. A `resume` that names the session file already open is the same hazard under a different reason. The gate and its self-resume guard are specified in the `pi-plugin` capability; this table records which endpoint each branch reaches. Pi is the only client that chooses its shutdown endpoint at runtime.
- **opencode's dispose row is fire-and-forget and never `/end`, by decision rather than omission.** The host kills the subprocess before async handlers settle, so an awaited call there would frequently not land and no requirement could promise `ended`. An opencode row therefore stays `active` until `abandonStale` flips it.

Of the five clients, four POST `/end`: Claude Code, Codex CLI, Hermes and Pi. opencode does not, for the reason above, and its rows reach `abandoned` through the sweep. All five POST the resume.

#### Scenario: Every client has a row and no client has an undocumented lifecycle write

- **WHEN** the table above is compared against the shipped clients at HEAD
- **THEN** each of the five clients SHALL have at least one row
- **AND** every lifecycle handler in each client that issues an HTTP request SHALL correspond to a row naming that endpoint
- **AND** a handler that issues no request SHALL either be absent from the table or carry `none` in the HTTP-call column

#### Scenario: Every client resumes exactly once per session id per process

- **GIVEN** any of the five clients, running against a session id `<S>` whose row is `ended`
- **WHEN** the client performs its first `POST /sessions` ensure for `<S>` in that process
- **THEN** it SHALL immediately POST `/api/<slug>/sessions/<S>/resume`
- **AND** the row SHALL be `status='active'` with `ended_at IS NULL` afterwards
- **AND** every subsequent ensure of `<S>` in the same process SHALL NOT POST the resume again
- **AND** the control SHALL pass in the same run: a client whose first ensure is for a session id with no prior row SHALL still POST the resume, and it SHALL succeed as a no-op with `previousStatus: 'active'`

#### Scenario: The resume is not conditioned on a host signal

- **WHEN** each client's ensure path is read at HEAD
- **THEN** no client SHALL branch its resume call on `source`, `reason`, `reset`, `rewound`, or any other host-supplied indication of whether the conversation is new
- **AND** removing every such field from the host payload SHALL leave the resume behaviour unchanged

#### Scenario: A failed resume degrades to a diagnostic, never to an aborted session

- **GIVEN** a client whose server returns `404 session_not_found` for the resume (an id the server has never seen under this token)
- **WHEN** the ensure-then-resume pair runs
- **THEN** the client SHALL emit exactly one stderr diagnostic naming the path and status, per this capability's failed-POST requirement
- **AND** the host session SHALL continue, and the hook or handler SHALL exit successfully

#### Scenario: Claude Code hooks.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear|fork` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** `Stop` SHALL declare exactly two entries
- **AND** the six event types SHALL carry nine handler entries in total
- **AND** the FIRST `Stop` handler (the raw sync) SHALL declare `"async": true` and the SECOND (the end-of-turn reminder) SHALL NOT declare `async` — an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback to the turn
- **AND** the `hooks` object SHALL NOT contain a `PostToolUse` entry

#### Scenario: Codex hooks.codex.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact` — Codex has no `fork` source, so unlike Claude Code's manifest this group SHALL NOT declare one
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** `Stop` SHALL declare exactly two entries
- **AND** the six event types SHALL carry nine handler entries in total
- **AND** the `SessionEnd` entry SHALL declare `"timeout": 3`, the documented maximum for this one event, and SHALL carry no `matcher` key
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

### Requirement: The shared client core MUST be the single implementation of the cross-client protocol logic

The nudge constants and texts, the `<private>` redaction helper, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers, the session-end call and the session-resume call SHALL exist in exactly one JS/TS implementation, at `apps/plugin/bin/rembric-plugin-core.mjs`. Every JS/TS client SHALL import them from there and SHALL declare no local copy.

This is what makes the byte-identical-nudge and identical-redaction-semantics requirements structural rather than a matter of discipline: with one implementation there is no second copy to keep in step, and a client added later inherits both contracts by construction.

A member of that list SHALL live in the core even when exactly one client calls it. The session-end call is the case in point: only Pi invokes it, because opencode's host kills the subprocess before an awaited call can land. Placing it in the client that happens to use it would put a second `fetch` against a `/sessions/…` path in a client file, which is a second implementation of the session HTTP client whatever it is named, and it would leave the next client that needs the verb to write a third.

The resume SHALL be issued by the core's session-registration entry point itself, on the branch that has just added the id to its known-session set, rather than by each client after calling it. That set is already the once-per-id gate for the ensure, so making the resume ride on the same branch makes "exactly one resume per id per process" structural instead of a rule two clients each have to remember. No JS/TS client SHALL call the resume path directly, and no JS/TS client SHALL keep its own known-session set for this purpose.

The resume SHALL be skipped when the ensure that precedes it did not land. Whatever prevented the ensure — an unreachable server, a revoked token, an unresolvable slug — prevents the resume too, so issuing it anyway buys nothing and doubles the wait a quitting or starting user absorbs, each POST being separately bounded by the client's timeout. The id SHALL nevertheless remain in the known-session set, so the pair is not retried on the next call: a retry loop keyed on transport failure is a different mechanism with different failure modes, and this capability's failed-POST requirement already specifies the one diagnostic that reports it.

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

#### Scenario: The resume rides on the core's ensure, not on the client

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` and `apps/plugin/.pi-plugin/index.ts` are read at HEAD
- **THEN** neither SHALL contain a string matching `/resume`
- **AND** the core's session-registration entry point SHALL POST the resume on the branch where the id was newly added to the known-session set, and SHALL NOT POST it on the early-return branch for an already-known id

#### Scenario: A failed ensure suppresses the resume without retrying either

- **GIVEN** the server is unreachable, or answers the ensure with a non-2xx status
- **WHEN** the core's session-registration entry point runs for a new id
- **THEN** it SHALL NOT POST the resume
- **AND** the id SHALL still be in the known-session set, so a later call for the same id POSTs neither
- **AND** the control SHALL pass in the same run: with the ensure answering `200`, the resume IS POSTed
