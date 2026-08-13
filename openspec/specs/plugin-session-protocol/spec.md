# plugin-session-protocol Specification

## Purpose

TBD - created by archiving change fix-session-summary-all-clients. Update Purpose after archive.

## Requirements

### Requirement: Sessions MUST converge on a non-null summary when the agent cooperates OR the transcript is reachable

Every closed session in the dashboard SHALL display a non-null `summary` whenever ANY of the following held during its lifetime:

- The agent called `memory.session_summary({summary, title?})` at any point.
- The session compacted on a client that injects a post-compaction instruction (Claude Code, Codex CLI and opencode) and the agent followed that instruction, reading the stored summary and rewriting the session's current state. What converges the row is the `memory.session_summary` call the first bullet already covers; what this bullet adds is that a compaction is a moment at which the client actively asks for one. The instruction SHALL NOT be satisfied by storing the host's compacted window — see "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full".
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
- **THEN** the plugin appends the read-then-rewrite instruction to `output.context` (the `opencode-plugin` capability holds the text's contract)
- **AND** the next agent (post-compaction) reads that instruction, calls `memory.session_get` to read the stored summary, and then calls `memory.session_summary({summary, title})` with the session's CURRENT COMPLETE state and `summary.length <= SUMMARY_MAX_CHARS`
- **AND** the resulting row in `sessions` has that current-state summary as `summary` and a non-null `title`
- **AND** the text it displaced survives as a version row, so an agent that rewrote thinly costs recoverable text rather than lost text

#### Scenario: Claude Code session ends with a torn trailing transcript line

- **GIVEN** a Claude Code session whose transcript JSONL's final line was torn mid-write (a `Stop` hook race or a crash), while every earlier line is well-formed JSON containing at least one assistant turn
- **AND** the agent never called `memory.session_summary`
- **WHEN** the user closes the session and `SessionEnd` fires with that transcript's path
- **THEN** `sessions.summary` SHALL contain every well-formed line before the torn one (oldest-first, role: content)
- **AND** `sessions.summary` SHALL NOT be `NULL` or empty — the torn line degrades the summary by at most itself, it does not discard the lines that parsed successfully before it

### Requirement: Write precedence for summary and title MUST be expressed via a `final:boolean` flag

The server SHALL accept summary/title writes carrying an optional `final:boolean` flag (default `false`). Behaviour:

- A `final:true` write SHALL persist summary/title and SHALL mark the row's `summary_final` and `title_final` columns as `true`.
- A subsequent `final:false` write SHALL be silently ignored if the corresponding `*_final` flag is already `true` for that field.
- A subsequent `final:true` write SHALL replace the prior value (the latest cooperating writer wins; this matters when an admin tool eventually wants to overwrite).
- Non-final writes overwrite earlier non-final writes (last non-final wins).

`memory.session_summary` (MCP) SHALL always send `final:true`. Hook bash/Python fallbacks SHALL always send `final:false`. The placeholder written at SessionStart (`basename(cwd) · HH:MM UTC`) SHALL be `final:false`.

#### Scenario: Model summary preserved when bash fallback fires later

- **GIVEN** session `<S>` whose `summary` was written via `memory.session_summary({summary: "A", title: "B"})` (so `summary_final` and `title_final` are both `true`)
- **WHEN** the SessionEnd bash hook POSTs `/end {summary: "X", title: "Y", final: false}`
- **THEN** `sessions.summary` SHALL remain `"A"` and `sessions.title` SHALL remain `"B"`
- **AND** the call SHALL still transition `status` to `'ended'`

#### Scenario: Bash fallback writes title because model didn't

- **GIVEN** session `<S>` whose `title` is the placeholder `"rembric · 22:14"` (written at SessionStart with `final:false`) and whose `summary` is null
- **WHEN** the SessionEnd bash hook POSTs `/end {summary: "raw transcript", title: "Fix Stop bug", final: false}`
- **THEN** both `summary` and `title` SHALL be overwritten with the bash values (non-final overwrites non-final)

#### Scenario: Last non-final write wins among same-priority writers

- **GIVEN** a Codex session where Stop has fired twice, posting `/summary {summary: "turn1+turn2 transcript", final:false}` after turn 2
- **WHEN** Stop fires for turn 3 and posts `/summary {summary: "turn1+turn2+turn3 transcript", final:false}`
- **THEN** `sessions.summary` SHALL be the turn3 version

### Requirement: Initial title MUST be written at SessionStart as a recognisable placeholder

When `/api/<slug>/sessions` creates a new session row (`created:true`), the server SHALL write a title of the form `basename(cwd) · HH:MM UTC` using the request's `cwd` field (or a hardcoded fallback `"session"` when `cwd` is unset). The time component is rendered in UTC with two-digit hour and minute. The title SHALL be persisted with `title_final = false` so any subsequent non-placeholder write overwrites it.

When `cwd` is missing or fails to parse, the placeholder SHALL be `"session · HH:MM UTC"`.

#### Scenario: Placeholder title written on session creation

- **WHEN** a client POSTs `{id, cwd: "/Users/jane/projects/rembric"}` to `/api/foo/sessions` at 22:14 UTC and the row does not exist
- **THEN** the inserted row SHALL have `title = "rembric · 22:14 UTC"` and `title_final = false`

#### Scenario: Placeholder when cwd is unparseable

- **WHEN** a client POSTs `{id}` (no `cwd` field)
- **THEN** the inserted row SHALL have `title = "session · HH:MM UTC"`

#### Scenario: Placeholder is overwritten by any later non-final write

- **GIVEN** a session with the placeholder title
- **WHEN** any non-placeholder write (model `memory.session_summary({title})`, Hermes `on_session_end`, bash SessionEnd) lands
- **THEN** the title SHALL be replaced with the new value (because both writes are `final:false` and last-write-wins among non-finals)

### Requirement: The per-turn save/summary nudge text MUST be a calibrated imperative shared byte-identical across every client

The save and session-summary nudge strings emitted per-turn by every client — Claude Code and Codex via `apps/plugin/scripts/prompt-nudge.sh`, opencode and Pi via the shared JS/TS module `apps/plugin/bin/rembric-plugin-core.mjs`, Hermes via `prefetch()` (`apps/plugin/.hermes-plugin/__init__.py`) — SHALL be sourced from the single shared contract `apps/plugin/test/nudge-fixtures.json` (`save`, `saveCore`, `summaryCore`, `summary`) and SHALL be byte-identical across clients. Bash and the shared JS/TS module embed the `rembric:`-prefixed `summary`/`save` verbatim; Hermes wraps `saveCore`/`summaryCore` in `<memory-hint>…</memory-hint>` per its established convention. No individual JS/TS client SHALL carry its own copy of these strings — there is one JS/TS implementation and every JS/TS client imports it, so a newly added client is byte-identical by construction rather than by review.

The shared text SHALL be phrased as a calibrated imperative:

- It SHALL direct the model to curate (`memory.session_summary`) / save (`memory.save`) as a required action when it applies, not a passive suggestion.
- It SHALL condition that action on real, memorable work having happened (a decision, fix, discovery, or files changed), preserving the model's discretion to skip trivial turns with nothing worth persisting — so the imperative does not induce vacuous summaries or noise saves.
- It SHALL NOT change the firing cadence, which is governed separately (summary on turn 1 and every `SUMMARY_NUDGE_EVERY`; save every `SAVE_NUDGE_EVERY`) and is unchanged by this requirement.

**The summary string SHALL NOT carry the write's replace-and-rewrite semantics, and that exclusion is a measured decision rather than an omission.** The string measures 259 UTF-8 bytes against its own published per-line cap of 260 (`claude-code-plugin`), and the firing-turn ceiling is ≤840 bytes against a measured worst case of 780, so any added clause costs a cap edit plus a re-measurement of three published aggregate figures, paid on turn 1 and every tenth turn in five clients. The semantics are delivered instead where the model is already reading a longer text about this tool and where there is measured headroom: the tool description (1175 of 1900 characters, after this change's own additions to it) and `initialize.instructions` (990 of 1000, after this change's own clause), plus the two surfaces that fire exactly when a summary is about to be written — the compaction block and the end-of-turn rubric. A future change MAY move the clause here, and if it does it SHALL raise the per-line cap deliberately and re-measure every published figure that contains this string; it SHALL NOT append the clause and leave the caps as published.

**`initialize.instructions`'s remaining headroom is 10 characters, not a number that invites more prose.** 990 of the published 1000-character cap is already spent; a contributor reading "measured headroom" here SHALL NOT read it as an invitation to add further text to this block — there is none to spare. Any future addition to `initialize.instructions` SHALL either reclaim prose from the existing block first (the same rule `mcp-api`'s `instructions` requirement already states) or raise the cap deliberately with its own re-measurement; it SHALL NOT be attempted as a small addition on the assumption that ~84 characters remain.

**The summary string SHALL NOT assert, or deny, that a summary already exists for the session.** One string has to be true in both states, and a claim about state is the one thing a state-blind reminder cannot make.

#### Scenario: Shared nudge text is imperative and work-conditioned

- **WHEN** the `nudge-fixtures.json` `summary` and `save` strings are inspected
- **THEN** each SHALL read as a directive to act (imperative) AND SHALL reference the real-work condition (decision / fix / discovery / files changed), not merely an unconditional "call X now"

#### Scenario: Nudge text stays byte-identical across clients

- **WHEN** `nudge-fixtures.test.ts` compares the bash, shared JS/TS, and Python nudge sources against `nudge-fixtures.json`
- **THEN** all SHALL match the shared fixture (Python's `_SUMMARY_HINT` SHALL equal `<memory-hint>${summaryCore}</memory-hint>`, `_SAVE_HINT` SHALL equal `<memory-hint>${saveCore}</memory-hint>`; bash turn-1 output SHALL equal `summary`; bash turn-5 output SHALL equal `save`)
- **AND** the JS/TS arm SHALL read the shared module, not any individual client file

#### Scenario: A client carrying its own nudge copy fails the build

- **GIVEN** a JS/TS client file declares its own nudge string constant instead of importing it
- **WHEN** `pnpm test` runs
- **THEN** the single-implementation invariant SHALL fail, naming the offending file and line

#### Scenario: Cadence constants are unchanged

- **WHEN** the cadence constants are inspected across clients (`SUMMARY_NUDGE_EVERY`, `SAVE_NUDGE_EVERY`, and the `turn === 1` summary trigger)
- **THEN** they SHALL be unchanged by this requirement — only the sourcing mechanism changes

#### Scenario: The summary string is unchanged by the replace-and-rewrite contract

- **WHEN** the `summary` and `summaryCore` fixtures are compared against their values before this change
- **THEN** they SHALL be byte-identical, and each SHALL remain within its published per-line cap
- **AND** no published byte or token figure that contains this string SHALL need re-measuring

#### Scenario: The summary string makes no claim about whether a summary exists

- **WHEN** the string is inspected
- **THEN** it SHALL neither assert nor deny that the session already carries a curated summary

### Requirement: Clients that know their own session id MUST surface it per-turn as a standalone nudge

The server cannot resolve which of several concurrently-active sessions an implicit MCP write belongs to (see the `sessions` capability's `findActiveForTransport` never-guess contract). Clients that DO know their own current session id at nudge-emission time — Claude Code/Codex (`session_id` from hook stdin), opencode (`input.sessionID`), Hermes (`session_id` from the `prefetch` kwarg, falling back to `self._session_id`) — SHALL surface it to the model as a separate, standalone nudge line whenever the save or summary nudge fires (same turn, emitted first), so the model can pass it explicitly to the tools named in the `mcp-api` `sessionId` reinforcement requirement.

- The line SHALL be sourced from the shared template `apps/plugin/test/nudge-fixtures.json`'s `sessionIdTemplate`/`sessionIdCoreTemplate` (a `{{SESSION_ID}}` placeholder interpolated with the real value), byte-identical across clients modulo that interpolation — the same lock-step discipline as the save/summary nudge text.
- The line SHALL be OMITTED when no session id is known (e.g. the host provided none) — never emit a placeholder or invented id.
- The line SHALL NOT change the save/summary nudge cadence or text; it is purely additive.

#### Scenario: sessionId nudge fires alongside the save nudge

- **GIVEN** a client that knows its session id
- **WHEN** the save nudge fires (turn is a multiple of `SAVE_NUDGE_EVERY`)
- **THEN** the sessionId nudge line SHALL be emitted immediately before the save nudge line, with the real session id interpolated into `sessionIdTemplate`

#### Scenario: sessionId nudge fires alongside the summary nudge

- **GIVEN** a client that knows its session id
- **WHEN** the summary nudge fires (turn 1 or a multiple of `SUMMARY_NUDGE_EVERY`)
- **THEN** the sessionId nudge line SHALL be emitted immediately before the summary nudge line

#### Scenario: sessionId nudge is omitted when the session id is unknown

- **GIVEN** a client turn where no session id could be resolved (e.g. Claude Code/Codex with unparseable hook stdin, or Hermes with no `initialize()` call yet)
- **WHEN** the save or summary nudge fires
- **THEN** the sessionId nudge line SHALL NOT be emitted — only the save/summary nudge line(s) appear, unchanged from before this requirement

### Requirement: Per-client lifecycle mapping MUST be honoured

The cross-client write contract maps lifecycle events to HTTP endpoints as follows. Implementations SHALL conform; divergences from this mapping SHALL be considered specification violations.

| Client      | Lifecycle event                                                         | HTTP call                                                                                                                                                    | `final` |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Claude Code | `SessionStart` (`startup\|resume\|clear\|fork`)                         | `POST /sessions {id, cwd, agent}` (placeholder title) **then `POST /sessions/<id>/resume`**                                                                  | n/a     |
| Claude Code | `SessionStart` (`compact`)                                              | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) **then `POST /sessions/<id>/resume`** + stdout instruction                                          | n/a     |
| Claude Code | `UserPromptSubmit`                                                      | none (stdout nudges only)                                                                                                                                    | n/a     |
| Claude Code | `Stop` (every turn)                                                     | `POST /summary {summary, title}` — `final` OMITTED                                                                                                           | absent  |
| Claude Code | `PreCompact`                                                            | `POST /summary {summary, title, final:false}`, or `{}` when no transcript                                                                                    | false   |
| Claude Code | `PostCompact`                                                           | `POST /summary {summary, final:false}`, or `{}` when no compaction summary                                                                                   | false   |
| Claude Code | `SessionEnd`                                                            | `POST /end {summary, title, final:false}`, or `{}` when no transcript                                                                                        | false   |
| Codex CLI   | `SessionStart` (`startup\|resume\|clear`)                               | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| Codex CLI   | `SessionStart` (`compact`)                                              | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) **then `POST /sessions/<id>/resume`** + stdout instruction                                          | n/a     |
| Codex CLI   | `UserPromptSubmit`                                                      | none (stdout nudges only)                                                                                                                                    | n/a     |
| Codex CLI   | `Stop` (every turn)                                                     | `POST /summary {summary, title, final:false}` + stdout `'{}'`                                                                                                | false   |
| Codex CLI   | `PreCompact`                                                            | `POST /summary {summary, title, final:false}`, or `{}` when no transcript                                                                                    | false   |
| Codex CLI   | `PostCompact`                                                           | `POST /summary {summary, final:false}`, or `{}` when no compaction summary                                                                                   | false   |
| Codex CLI   | `SessionEnd` (main thread only)                                         | `POST /end {summary, title, final:false}`, or `{}` when no transcript                                                                                        | false   |
| Hermes      | `initialize`                                                            | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| Hermes      | `on_pre_compress(messages)`                                             | `POST /summary {summary, final:false}`                                                                                                                       | false   |
| Hermes      | `on_session_switch(new_id, parent_id)`                                  | `POST /end old` (only when the id actually changed) `+ POST /sessions new` **then `POST /sessions/new/resume`** on the first ensure of `new` in this process | n/a     |
| Hermes      | `on_session_end(messages)`                                              | `POST /end {summary, title, final:false}`                                                                                                                    | false   |
| opencode    | `session.created` (not a sub-agent)                                     | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| opencode    | `chat.message`                                                          | `POST /sessions {id, cwd, agent}` + resume on the first ensure of the id in this process; no-op afterwards; + debounced `/summary`                           | false   |
| opencode    | `session.idle`                                                          | debounced `POST /summary {summary, title?, final:false}`                                                                                                     | false   |
| opencode    | `session.compacted`                                                     | `POST /summary {summary, title?, final:false}`                                                                                                               | false   |
| opencode    | `experimental.session.compacting`                                       | `POST /sessions {id, cwd, agent}` + resume on the first ensure of the id in this process; no-op afterwards; + injected context                               | n/a     |
| opencode    | `session.deleted`                                                       | none (drops the in-memory accumulator only)                                                                                                                  | n/a     |
| opencode    | `server.instance.disposed`                                              | fire-and-forget `POST /summary {summary, title?, final:false}` per known session — never `/end`                                                              | false   |
| Pi          | `session_start`                                                         | none (creates the protocol client and discovers tools over MCP)                                                                                              | n/a     |
| Pi          | `before_agent_start`                                                    | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`** on the first ensure of the id in this process; + injected nudges                     | n/a     |
| Pi          | `message_end`                                                           | none (feeds the in-memory accumulator only)                                                                                                                  | n/a     |
| Pi          | `agent_settled`                                                         | debounced `POST /summary {summary, title?, final:false}`                                                                                                     | false   |
| Pi          | `session_shutdown` (`quit\|new\|resume\|fork`, not a self-resume)       | `POST /end {summary, title, final:false}`, or `{}` when the accumulator is empty                                                                             | false   |
| Pi          | `session_shutdown` (`reload`, a self-resume, or an unrecognised reason) | `POST /summary {summary, title?, final:false}` — never `/end`                                                                                                | false   |
| Any (model) | `memory.session_summary({summary, title?})` (MCP)                       | internal write (no HTTP) with `final:true`                                                                                                                   | true    |

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

### Requirement: Plugin-injected protocol nudges MUST surface the summary length cap

The agent-facing protocol nudges injected by the per-client plugins SHALL state the summary length cap inline so the agent budgets for it on the first attempt and does not trip the MCP rejection path. The affected injection sites are:

- `apps/plugin/scripts/post-compact.sh` — the `SessionStart matcher:"compact"` hook stdout, shared by Claude Code and Codex CLI (budget ≤150 tokens; see `claude-code-plugin`'s token-budget requirement for the measurement unit). The protocol block listed for the agent SHALL include the cap on the `summary` field.
- `apps/plugin/.hermes-plugin/__init__.py` — Hermes provider's system-message injection (around line 313). The session-close protocol sentence SHALL include the cap.
- `apps/plugin/commands/summary.md` — the slash command description SHALL mention the cap so users invoking `/rembric:summary` see the budget too.

Each plugin SHALL emit the literal substring `10000` (the current cap value) in the injected text so a test can grep for it and a contributor changing the cap is forced to update every site.

The `≤150` budget replaces a previously-published `≤120`, which the shipped block exceeded from the moment it was written (measured 552 bytes = 138.0 tokens under the newline-exclusive per-line convention `claude-code-plugin` pins; 138.3 if the emitting script's trailing newline is counted, which only turn totals do). The cap was raised rather than the text trimmed: this block fires at the moment of highest consequence — the model has just lost its context and this is the only instruction telling it what to persist — so trimming it to recover 16 tokens once per compaction trades instruction-following for nothing. `claude-code-plugin` asserts the same number and the two SHALL be changed together.

**The 552-byte figure above is history, not a claim about the block's current size, and this change is what makes that distinction load-bearing.** "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full" rewords this same block's text: 574 bytes on `main` immediately before that rewrite, 560 bytes after it. Neither number is 552, and neither needs to be — the 552 figure describes the block as it stood at a still-earlier point, when the `≤120`→`≤150` budget decision was made, and is retained here as the record of that decision rather than corrected to track every later reword. Both 574 and 560 stay within the ≤600-byte / ≤150-token cap this paragraph sets, so no cap change follows from the reword; a future reader who measures the current block and finds neither 552 nor a cap violation has found exactly what this note says to expect.

#### Scenario: Claude Code post-compact injection mentions the cap

- **WHEN** `apps/plugin/scripts/post-compact.sh` runs and emits its stdout protocol block
- **THEN** the emitted text SHALL contain the substring `10000`
- **AND** the text SHALL describe the cap as a limit on the `summary` field passed to `memory.session_summary`

#### Scenario: The post-compact block stays within its raised budget

- **WHEN** the `postCompact` fixture is measured in UTF-8 bytes
- **THEN** it SHALL be ≤600 bytes (≤150 tokens at the pinned bytes÷4 proxy)
- **AND** the assertion SHALL fail the build when exceeded

#### Scenario: Hermes provider injection mentions the cap

- **WHEN** Hermes loads the rembric plugin and its system-message injection runs
- **THEN** the injected protocol text SHALL contain the substring `10000`

#### Scenario: Slash command description mentions the cap

- **WHEN** a user opens the `/rembric:summary` slash command's description text
- **THEN** the description SHALL contain the substring `10000`

### Requirement: Transcript-derived uploads MUST redact `<private>` spans client-side in every client

Any transcript-derived text a plugin sends to the server (session summaries, transcript snapshots, stop/pre-compact payloads, derived titles) SHALL have every `<private>…</private>` span replaced with `[REDACTED]` BEFORE the payload leaves the client. Matching SHALL be case-insensitive, SHALL span newlines, SHALL close each span at the first `</private>`, and an unclosed `<private>` SHALL redact through end-of-text (fail closed). All five clients (Claude Code, Codex CLI, Hermes Agent, opencode, Pi) SHALL implement identical observable semantics; the server SHALL NOT be relied upon to strip these tags.

There SHALL be exactly three implementations — bash, Python, and one shared JS/TS module (`apps/plugin/bin/rembric-plugin-core.mjs`) — and they SHALL be kept in agreement by the shared fixture set `apps/plugin/test/redaction-fixtures.json`. A new JS/TS client SHALL NOT add a fourth implementation; it imports the shared one, and the single-implementation invariant fails the build if it does otherwise.

Every implementation SHALL be exercised against **every** fixture in that set. The fixture arms SHALL be co-located in `apps/plugin/test/redaction.test.ts` and SHALL assert on the redaction function's own return value, not indirectly through a transport payload: an indirect arm cannot express the empty-input fixture and so silently skips it, which is how the JS/TS arm came to run 12 of 13.

#### Scenario: Private span in a bash-client transcript upload

- **WHEN** a Claude Code or Codex CLI session transcript contains `Connect to <private>postgresql://u:p@host/db</private> now`
- **THEN** every payload POSTed by the hook scripts SHALL contain `Connect to [REDACTED] now` and the original span SHALL NOT appear anywhere in the request body

#### Scenario: Multiline and case-variant spans

- **WHEN** the transcript contains `<PRIVATE>line one\nline two</Private>`
- **THEN** the uploaded text SHALL replace the whole span with a single `[REDACTED]`

#### Scenario: Unclosed private tag fails closed

- **WHEN** the transcript contains `<private>secret with no closing tag` followed by end-of-text
- **THEN** the uploaded text SHALL be redacted from the opening tag through end-of-text

#### Scenario: Hermes transcript formatting redacts before POST

- **WHEN** the Hermes plugin formats transcript entries containing a `<private>` span for upload
- **THEN** the formatted payload SHALL contain `[REDACTED]` in place of the span

#### Scenario: Every implementation runs every fixture

- **WHEN** the redaction fixture arms run
- **THEN** each of the three implementations (bash, Python, shared JS/TS) SHALL be asserted against every fixture in `apps/plugin/test/redaction-fixtures.json`, with none filtered out
- **AND** the asserted fixture count per arm SHALL equal the fixture file's length

#### Scenario: A fifth client inherits redaction with no new code

- **WHEN** the Pi client uploads a transcript-derived payload containing a `<private>` span
- **THEN** the span SHALL be replaced with `[REDACTED]` before the request leaves the process
- **AND** the redaction SHALL come from the shared JS/TS module, with no redaction code in the client's own source

### Requirement: Failed lifecycle POSTs MUST emit one stderr diagnostic in every client

When a session-lifecycle HTTP POST fails (non-2xx, connection error, timeout), the client plugin SHALL emit exactly one one-line diagnostic to stderr identifying the path and the failure (e.g. curl return code or HTTP status), and SHALL still exit/return success so the host agent is never broken by Rembric unavailability. This aligns the bash clients (Claude Code, Codex CLI) with the diagnostics opencode (`diag()`) and Hermes (`_stderr()`) already emit. The diagnostic SHALL NOT include the request body or the token.

#### Scenario: Bad token configured in a bash client

- **WHEN** a Claude Code or Codex CLI hook POSTs a lifecycle event and the server responds `401`
- **THEN** the hook SHALL print one `[rembric] POST <path> failed …` line to stderr and SHALL exit 0

#### Scenario: Server unreachable

- **WHEN** the configured server is down during a lifecycle POST
- **THEN** the hook SHALL print one stderr diagnostic and SHALL exit 0 without delaying the host beyond curl's existing bounds

### Requirement: The awk transcript-parser fallback MUST be POSIX-portable and equivalent to the jq path

`apps/plugin/scripts/_transcript.sh` provides, for each parser, a `jq` implementation and an `awk` fallback used when `jq` is not on `PATH`. The awk fallback SHALL be written in POSIX awk (it MUST run correctly under mawk, BSD awk, and gawk) and SHALL produce output byte-equivalent to the `jq` path for the shared transcript fixtures.

- The awk fallbacks SHALL NOT pass a regexp constant (`/re/`) as a function argument. A regexp constant used outside a direct match operator evaluates to a boolean in awk, which corrupts the parse (it yields the literal string `"1"` instead of the message). Regex literals SHALL be used directly in `match()` at the call site; helper functions SHALL receive only already-sliced strings.
- Applies to all four fallbacks: `_rembric_format_transcript_{claude_code,codex_cli}_fallback` and `_rembric_extract_first_assistant_{claude_code,codex_cli}_fallback`.
- The shared fixtures test (`apps/server/src/test/transcript-parser.test.ts`) SHALL genuinely exercise the awk fallback — its "awk fallback" cases MUST NOT silently fall through to `jq` when `jq` happens to be on the stripped test `PATH`.

#### Scenario: First-assistant extraction on a host without jq

- **WHEN** `rembric_extract_first_assistant_codex_cli` (or `_claude_code`) runs on a host where `jq` is not on `PATH`, against a transcript whose first assistant/agent message is non-empty (including non-ASCII text such as `¡Hola! ¿En qué te ayudo hoy?`)
- **THEN** the awk fallback SHALL return that message text verbatim (after un-escaping `\n \r \t \" \\`)
- **AND** it SHALL NOT return the literal string `"1"` or any boolean-coercion artifact

#### Scenario: Transcript formatting on a host without jq

- **WHEN** `rembric_format_transcript_codex_cli` (or `_claude_code`) runs without `jq` on `PATH` against a multi-message fixture
- **THEN** the awk fallback SHALL emit the same `role: content` lines, oldest-first, as the `jq` path for that fixture
- **AND** non-conversation/metadata rows SHALL be dropped exactly as on the `jq` path

#### Scenario: Shared fixtures exercise the awk path, not jq

- **WHEN** the transcript-parser test runs its "awk fallback" cases
- **THEN** the awk implementation SHALL be the code under test (jq unreachable for those cases)
- **AND** the awk output SHALL equal the expected fixture output, so a broken awk fallback fails the suite regardless of whether `jq` is installed in a standard location

### Requirement: The summary reminder MUST be delivered at the end of the turn, and MUST NEVER interrupt

A reminder that a session owes a summary SHALL be delivered at the END of a turn as well as at its start. A reminder attached only to the start of a turn always arrives while there is more work to do, so it is advice about future behaviour; the end of the turn is the point at which the work of that turn is finished and the model can still act on it.

The reminder SHALL be delivered as non-interrupting feedback that continues the conversation. It SHALL NOT use the host's blocking decision. Two reasons: a memory server is an optional accessory to its host and MUST NOT be able to hold an agent's turn open, and a blocking reminder needs a loop guard whose absence on any one host would make the mechanism unsafe there. Non-interrupting feedback carries the same text and needs neither.

The host's end-of-turn event SHALL therefore carry TWO independent entries with different obligations:

- The existing raw-sync entry SHALL remain asynchronous. It is a pure side effect and SHALL NOT delay the turn.
- A second entry SHALL be synchronous, because an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback to the turn at all. Wiring the reminder asynchronously forfeits it entirely.

**The reminder SHALL be rate-limited by the same per-session turn counter the start-of-turn nudge already uses, at the same cadence.** It SHALL NOT fire on every turn. The end-of-turn event fires once per turn, not once per session, so an unthrottled reminder would inject its payload into every turn of a long session — and the repository already owns exactly one mechanism for "remind every N turns". A second, independently-tuned cadence would be a second thing to keep in step with the first.

When the reminder fires, its payload SHALL carry the canonical summary structure in full (see `sessions`) AND the grounded facts extracted from the session, so the model summarises against evidence rather than recollection. This is the surface that carries the long form precisely because it has no length budget, unlike a tool description.

Because it is also the surface a model reads immediately before writing, the payload SHALL state that the write replaces the stored summary and SHALL ask for the session's current complete state, current first.

The entry SHALL NOT fire when the session has produced nothing worth summarising — a turn that only read or only talked. "Produced nothing" SHALL be decided from the session's own transcript, not from the server: no files written or edited and no commands run.

**That is the ONLY licensed silence, alongside the fail-open cases below.** The reminder SHALL NOT be suppressed because the session already carries a curated summary, and SHALL NOT derive that state from anywhere — not from the server, and not by scanning the transcript for a completed summary tool call. Suppressing it freezes whatever the first write said, because nothing afterwards ever asks the model to improve it, and it is exactly what makes a premature first summary permanent. The reason the suppression was defensible has also gone: a later curated write is recorded as a version row before it can displace anything (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"), so a redundant reminder can no longer cost stored text.

It SHALL NOT be required to know whether a curated summary already exists, and SHALL NOT make a request to find out. No read endpoint for a session exists — the HTTP surface offers only `POST .../summary` and `POST .../end` — so the reminder is cadence-gated and may fire on a session that has already been summarised. That is deliberate under-precision: the cost is one redundant reminder every N turns, and the alternative is new HTTP surface. A follow-up MAY add a read endpoint and narrow this; until it does, no requirement here SHALL assert the reminder consults server state.

That sentence is about the CLIENT. A model directed to read the stored summary before rewriting it (see "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist") calls the `memory.session_get` MCP tool itself; the client still asks the server nothing beyond the session-ensure it already makes.

**Fail-open is absolute.** On unparseable input, an unreadable or absent turn counter, a missing or unreadable transcript, an unavailable parser, or any unexpected error, the entry SHALL exit successfully and produce no output. Where a host requires a JSON object on every invocation, it SHALL emit an empty one rather than nothing. The failure mode of a missed reminder is a thinner summary; there SHALL be no failure mode in which the host is degraded.

#### Scenario: The reminder fires at the counter's cadence when a summary is owed

- **GIVEN** a session that has written or edited a file, or run a command, on a turn at which the shared counter's cadence fires
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL emit non-interrupting feedback carrying the canonical structure and the extracted facts
- **AND** it SHALL NOT emit an interrupting decision

#### Scenario: The reminder is silent on turns between cadence points

- **GIVEN** the same session on a turn at which the shared counter's cadence does not fire
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL produce no output

#### Scenario: The reminder does not consult the server

- **GIVEN** any session state, including one that already carries a curated summary
- **WHEN** the end-of-turn event fires at a cadence point
- **THEN** the hook SHALL decide from the transcript and the counter alone, and SHALL make no request

#### Scenario: An already-curated session still gets the reminder, never silence

- **GIVEN** a session whose transcript shows a completed `memory.session_summary` call, on a turn at which the cadence fires and files were written
- **WHEN** the end-of-turn event fires
- **THEN** the reminder SHALL be emitted
- **AND** no code path SHALL inspect the transcript for a prior summary call in order to suppress it

#### Scenario: The rubric asks for the current whole state

- **WHEN** the emitted rubric text is inspected
- **THEN** it SHALL state that the write replaces the stored summary
- **AND** it SHALL ask for the session's current complete state, current first, rather than for what is new since the last write

#### Scenario: The transcript is missing or unreadable

- **GIVEN** an end-of-turn event whose payload names no transcript, or one that cannot be parsed
- **WHEN** the hook runs
- **THEN** it SHALL exit successfully with no output, and the turn SHALL complete normally

#### Scenario: The turn counter is unreadable

- **GIVEN** an environment in which the shared turn counter cannot be read or written
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL produce no output rather than fall back to reminding on every turn

#### Scenario: A session with nothing worth summarising

- **GIVEN** a session that wrote or edited no file and ran no command
- **WHEN** the end-of-turn event fires at a cadence point
- **THEN** the hook SHALL produce no output

### Requirement: Sessions under the Pi client MUST converge on a non-null summary

Every closed session created by the Pi client SHALL end with a non-null `sessions.summary` whenever **either** of the following held during its lifetime:

- The agent called `memory.session_summary({summary, title?})` at any point, or
- the harness's session-shutdown handler ran with a non-empty per-session transcript accumulator.

The second condition SHALL hold for **every** shutdown reason, and it is not the same request in both cases. On a reason that closes the session the awaited POST is `/end` carrying `{summary, title, final:false}`; on `reload`, on a self-resume, and on an unrecognised reason it is `/summary` with the same body. Convergence is therefore independent of the reason gate: whichever branch the gate selects, the accumulated transcript is written by one awaited request. The reason gate decides `status`, never `summary` — its contract lives in the `pi-plugin` capability.

An empty accumulator does NOT converge and is not expected to: on a closing reason the client POSTs `/end` with an empty body, so the row reaches `'ended'` with `summary` still `NULL`. That is a session with nothing in it, and the dashboard surfaces it as "no summary captured" exactly as for the other degenerate cases.

The second condition is a stronger guarantee than the equivalent opencode condition, and the difference is measured rather than assumed. The harness awaits its shutdown handler with no timeout (measured against 0.84.1: a 300 ms awaited fetch completes, a 10 s one completes, and an MCP `tools/call` issued from inside the handler completes; SIGTERM and SIGHUP both reach it; the discriminating control — SIGKILL — runs nothing). So this client's final flush is an **awaited** POST and its landing is a guarantee, not a race, whereas the opencode dispose-time flush is explicitly best-effort because that host kills the subprocess before async handlers finish.

A per-turn debounced flush SHALL also run, as for the other in-process clients, so the server's summary is current at all times and any loss is bounded to one turn.

**The exception is narrower than this capability first published, and is stated per exit path.** In the interactive TUI an interrupt **does** reach the handler when it is pressed twice within 500 ms: measured against 0.84.1 with timed stdin, that arm fired `session_shutdown` at **5809 ms** against a no-keys stdin-EOF baseline of **10577 ms**, so the session converges exactly as it does on Ctrl-D. Two presses 1500 ms apart landed at **11839 ms** — the EOF — so a single press still reaches nothing. The full measurement, the three qualifiers it depends on, and the retraction of the earlier "in either mode" reading live in the `pi-plugin` capability and are not restated here.

What remains out of scope for convergence, in exactly the way a hard crash already is: a single interrupt press followed by a kill, print-mode SIGINT (read from `dist/modes/print-mode.js:32-44`, which registers `["SIGTERM"]` plus SIGHUP — a source read, not an executed measurement), and SIGKILL. For those the per-turn flush bounds the summary loss to one turn, and the row stays `active` until the stale-active sweep retires it.

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

### Requirement: The protocol nudge MUST live in `initialize.instructions`, and every client MUST reach it or document its own equivalent

The MCP server's `initialize.instructions` string (loaded into the model's system prompt on connect) SHALL include a directive flow instructing the model to call `memory.session_summary` with `{title, summary}` at the end of every turn in which real work happened — never ending a working turn silent. The flow SHALL:

- Be present in both the path-scoped and path-less variants of `initialize.instructions`.
- Stay within the 1000-character cap enforced by `instructions.test.ts` (raised from 800; the cap is a self-imposed token budget chosen for token cost rather than the binding limit — Claude Code truncates `instructions` at 2048 characters, so the self-imposed cap binds first; the `mcp-api` capability holds the authoritative statement).
- Be phrased as a **calibrated imperative**: a directive to curate (not a passive suggestion), **conditioned on real memorable work having happened** (a decision, fix, discovery, or files changed). It SHALL preserve the model's discretion to skip trivial turns with nothing worth persisting (so the imperative does not induce vacuous summaries), and SHALL NOT bind the trigger solely to the literal word "done".
- Describe the title constraint (≤100 chars, descriptive of what was worked on) and the summary structure, carried verbatim from the canonical section list defined in `sessions` rather than restated here. The list names, at minimum, the goal, what was accomplished, the decisions taken AND why, what was verified AND how, what was left unfinished AND why, and the files that matter — the three `+why`/`+how` sections exist because the code records what changed and never why it beat the alternative nor what evidence a claim rests on.

This nudge is the only mechanism that covers the case where Codex CLI cannot inject post-compact instructions and where short sessions never compact. All clients ship with the same MCP server reachable, so this is the single deployment surface for every client whose host consumes it.

**Which clients consume it is a per-client fact, and this requirement SHALL state only what is verified.** Claude Code and Codex CLI consume it host-side. Pi consumes it in-extension: `apps/plugin/.pi-plugin/index.ts` appends `mcp.instructions()` to `event.systemPrompt` in `beforeAgentStart`, so it reaches the harness's prompt like the others. **Hermes Agent does NOT** — see the `hermes-agent-plugin` capability, whose `system_prompt_block` requirement exists precisely because of that, and returns the same BASE text byte-identically across the TS/Python boundary. No prose, spec text, code comment or documentation SHALL name Hermes among the consumers of `initialize.instructions`; a client that does not consume it reaches parity by carrying its own equivalent surface, and that surface is what must be named instead.

#### Scenario: Instructions string contains the protocol nudge

- **WHEN** an MCP client retrieves `initialize.instructions` from either `/mcp` or `/mcp/<slug>`
- **THEN** the string SHALL contain the substring `memory.session_summary` AND the substring `title` AND the substring `before` (referring to before ending a working turn)

#### Scenario: Instructions string respects the 1000-char cap

- **WHEN** the test suite runs `instructions.test.ts` against both variants
- **THEN** both outputs SHALL be ≤1000 characters

#### Scenario: Protocol nudge is imperative and work-conditioned

- **WHEN** the `initialize.instructions` SUMMARIZE flow is read
- **THEN** it SHALL read as a directive to curate (imperative), conditioned on real work having happened, rather than an unconditional or purely advisory phrasing

#### Scenario: No surface claims Hermes consumes `initialize.instructions`

- **WHEN** every tracked surface that names the consumers of `initialize.instructions` is read — at minimum `apps/server/src/mcp/instructions.ts`'s header comment, `docs/agents.md`, `docs/troubleshooting.md`, `apps/plugin/.hermes-plugin/README.md`, and this capability's own rationale
- **THEN** none of them SHALL list Hermes Agent among the clients that receive the block
- **AND** each SHALL name Pi among the clients that do
- **AND** where a surface explains how Hermes reaches the same guidance, it SHALL name `system_prompt_block` rather than `initialize.instructions`

### Requirement: A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist

A process whose FIRST `POST /api/<slug>/sessions` of its lifetime reports `created: false` attached to a session it did not author. It cannot know whether a curated summary is already stored, and the model driving it cannot see the turns that produced one. It SHALL therefore emit, once, a standalone line directing the model to read the stored summary (`memory.session_get`) before its next curated write.

**What the line buys is the QUALITY of the rewrite, not the safety of it.** Safety is the server's: a curated write is recorded as a version row before it can displace anything (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"), so a model that never reads first can no longer destroy text. What it can still do is write a worse summary — rebuilding the session's state from an empty recollection instead of from the text that is actually stored. The line closes that gap and nothing else, so its absence SHALL cost correctness nothing.

The line SHALL be governed by four constraints:

- **Sourced from the shared fixture contract** (`apps/plugin/test/nudge-fixtures.json`'s `resumedRead` key) and byte-identical across clients, on the same discipline as every other nudge line.
- **Emitted as its own line**, never interpolated into the summary reminder. There SHALL still be exactly ONE summary-reminder string whose content depends on no session state; a state-dependent variant of that string is REJECTED, because one string has to be true in both states and a claim about state is the one thing a state-blind reminder cannot make.
- **Once per session id per process.** The resumed verdict SHALL be latched from the FIRST ensure of the process and SHALL NOT be recomputed; the emission SHALL be gated so a later firing of the reminder does not repeat it.
- **No new request.** The verdict SHALL be read from the response of the session-ensure the client already makes. No client SHALL issue a request whose only purpose is to learn whether a stored summary exists, and no client SHALL read the response body of a summary POST to obtain summary state. This keeps the reminder's existing contract intact: the reminder consults the transcript and the counter, and the CLIENT still asks the server nothing — it is the MODEL that is directed to call an MCP tool.

An unknown outcome — a failed ensure, or a response with no `created` field — SHALL be treated as "do not advise", never as "advise anyway". Where the marker that carries the verdict between two processes cannot be read, the line SHALL be suppressed rather than guessed.

The verdict marker SHALL remain write-once per session id. The write-once property is what stops every post-startup re-ensure's `created: false` from claiming a freshly-created session was resumed, and it SHALL NOT be relaxed in order to re-arm the line at a compaction boundary — that re-arm is a separate act, specified in "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full".

#### Scenario: A resumed session gets the read line once

- **GIVEN** a client whose first `POST /api/<slug>/sessions` of the process returned `created: false`
- **WHEN** the summary reminder fires for the first time in that process
- **THEN** the client SHALL emit the `resumedRead` line as its own line alongside the reminder
- **AND** it SHALL NOT emit it again on any later firing in the same process

#### Scenario: A freshly created session never gets the read line

- **GIVEN** a client whose first `POST /api/<slug>/sessions` of the process returned `created: true`
- **WHEN** the summary reminder fires at turn 1 and at every later cadence point in that process
- **THEN** the `resumedRead` line SHALL NOT be emitted at all

#### Scenario: A failed ensure suppresses the line rather than guessing

- **GIVEN** a client whose first `POST /api/<slug>/sessions` of the process failed, or returned no `created` field
- **WHEN** the summary reminder fires
- **THEN** the reminder SHALL be emitted and the `resumedRead` line SHALL NOT

#### Scenario: The line does not become a second summary variant

- **WHEN** the shared fixture contract and every client's reminder path are inspected
- **THEN** there SHALL still be exactly one summary-reminder string, unchanged in content by this requirement
- **AND** `resumedRead` SHALL be a separate key emitted as a separate line, never interpolated into it

#### Scenario: No per-turn state is retained and no extra request is made

- **WHEN** the shared JS/TS core, the bash scripts and the Python provider are inspected
- **THEN** none SHALL read the response body of any summary POST to obtain summary state
- **AND** none SHALL issue a request whose only purpose is to learn whether a stored summary exists

### Requirement: The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full

A compaction is the moment at which the stored summary matters most and is least visible: the model that continues has lost the turns it would summarise, and this injection is the only instruction it receives before it acts. The block SHALL therefore be ordered read-then-write:

1. Read the stored summary (`memory.session_get`).
2. Write the session's CURRENT COMPLETE state with `memory.session_summary` — what was just read, brought up to date with the surviving window — and SHALL be told that the write replaces the stored value, so sending the window alone stores the window alone.
3. Recall further prior context (`memory.context` / `memory.search`) when what was read is not enough.

The block SHALL NOT ask for a summary of the compacted window, and SHALL NOT ask for "the compact summary shown above". Either framing, combined with a replacing write, is exactly the loss this contract exists to prevent: the model does as it is told and the stored summary becomes the window.

This block is also the compaction re-arm of the read directive specified in "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist". A compacted context is, for that purpose, a fresh attachment to a pre-existing session, and the injection at the compaction boundary is the earliest point at which the model can act on it — so it carries the directive itself rather than depending on a later reminder firing or on a relaxed first-ensure marker.

Where a client has NO compaction hook, this requirement SHALL NOT cause one to be added. That client's coverage is its always-present protocol block (`mcp-api`, "The `instructions` block MUST state that a curated summary write replaces the stored value"), which carries the replacement and current-state obligations on every turn but no `memory.session_get` directive. That is a named gap, not a solved problem.

The block SHALL keep every obligation it already carries: the `10000` cap substring and the ≤600-byte budget of "Plugin-injected protocol nudges MUST surface the summary length cap", and one copy of the text shared by the clients that use it. A reworded block SHALL be re-measured, and the measurement SHALL be recorded rather than assumed: the rewritten block measures 560 bytes against the published 600.

#### Scenario: The block asks for the current whole state, after a read

- **WHEN** the post-compaction injection is emitted
- **THEN** it SHALL direct the model to call `memory.session_get` before writing
- **AND** it SHALL ask for the session's current complete state
- **AND** it SHALL state that the write replaces the stored value

#### Scenario: The block carries no window-only framing

- **WHEN** the same text is inspected
- **THEN** it SHALL NOT ask for a summary of the compacted window, of "what THIS window did", or of the host's own compact summary

#### Scenario: The block keeps its published obligations

- **WHEN** the emitted block is measured and grepped
- **THEN** it SHALL contain the substring `10000`
- **AND** it SHALL be ≤600 bytes in UTF-8

#### Scenario: One copy of the text

- **WHEN** the clients that inject at a compaction boundary are inspected
- **THEN** the text SHALL come from the shared fixture contract, byte-identical, with no per-client copy

### Requirement: Every client with a compaction event MUST inject the read-then-rewrite directive, and where no such event exists the version history MUST be the accepted mitigation

A compaction is the only moment at which a curated summary is rewritten by a model that cannot see what it is rewriting. Whether the client injects an instruction at that moment therefore decides whether the rewrite is informed or blind, and this requirement fixes both the per-client matrix and the meaning of an absent injection.

**Measured with real CLIs against a local server, four arms: two models × injected-block / no-injected-block.** Each arm's phase 1 curated a summary carrying four concrete anchors (`orders-service.ts:142`, `340ms`, `retry-cap.test.ts`, `50rps`). Each arm's phase 2 was a NEW process with no memory of phase 1 — the post-compaction condition — given new work and required to rewrite.

| arm                               | stored summary, chars | called `memory.session_get`? | phase-1 anchors surviving |
| --------------------------------- | --------------------- | ---------------------------- | ------------------------- |
| stronger model, injected block    | 2034 → 3006           | yes (1)                      | 3 of 4                    |
| stronger model, no injected block | 1794 → 2909           | yes (1)                      | 2 of 4                    |
| weaker model, injected block      | 1019 → 1762           | yes (1)                      | **4 of 4**                |
| weaker model, no injected block   | 975 → 1077            | **no (0)**                   | **0 of 4**                |

Three findings, each with a different consequence for this contract:

1. **The rewrite grows the stored value; it does not thin it.** All four arms ended longer than they started, and no arm wrote a delta-shaped summary. That is the assumption the read-then-rewrite design rests on, and it is now evidence rather than an argument.
2. **The injected block is what makes a weak model read.** Without it the weaker model called `memory.session_get` zero times and lost all four anchors, writing a full-looking summary of the new stretch alone; with it, it read once and kept all four. This is the measurement that makes the injection normative rather than best-effort.
3. **Detail erodes even when the model obeys.** The stronger model lost `50rps` in BOTH arms, by paraphrasing rather than by dropping a section. A rewrite is therefore NOT a durability mechanism for facts: a fact that must survive belongs in `memory.save`, and the summary is a state description that may lose precision on every pass. No requirement SHALL be written that depends on a specific fact surviving an unbounded number of rewrites.

**A stronger tool description is not the remedy, and that is measured too.** `memory.session_summary`'s description already carries the read directive verbatim (`apps/server/src/mcp/server.ts:326`: `Can't see your earlier work? Call memory.session_get first, then write the whole updated state.`), and the weaker model with no injected block ignored it. Strengthening description text against that result would be speculation; what the datum supports is the injected block.

This finding is scoped to the READ directive specifically: it says a stronger nudge toward `memory.session_get` would not have moved the arm that already ignored the one there. It says nothing about a description obligation the tool did not carry at all — copying concrete facts verbatim instead of paraphrasing them, which finding 3 above (the stronger model losing `50rps` to paraphrase, not omission) targets and which `mcp-api`'s `memory.session_summary` requirement adds as its own, separate fact. That addition is not a repeat of the rejected experiment.

**The matrix.** For each client, the compaction event it exposes and the obligation that follows:

- **Claude Code** and **Codex CLI** — `SessionStart` with the `compact` matcher, whose stdout is injected into the resumed model's context on both hosts. Covered by `apps/plugin/scripts/post-compact.sh`, which already carries the directive.
- **opencode** — `experimental.session.compacting`, whose `output.context` appends reach the post-compaction agent. It SHALL carry the directive; the `opencode-plugin` capability holds that text's contract.
- **Hermes Agent** — `on_pre_compress`, which fires AT the compaction, plus `prefetch()`, whose return is injected every turn and is therefore the first surface the post-compaction agent reads. It SHALL carry the directive, delivered under the four constraints below.
- **Pi** — no compaction event exists. `apps/plugin/.pi-plugin/index.ts` registers `session_start`, `before_agent_start`, `message_end`, `agent_settled` and `session_shutdown`, none of which fires at a compaction, so there is nothing to inject into. Governed by the accepted-risk clause below.

**Hermes's four constraints**, because the obvious implementation is the wrong one in two independent ways:

- **The directive SHALL be armed by the compaction event, NOT by the `remaining_tokens` estimate.** The provider's existing urgent save reminder is armed from `on_turn_start`'s `remaining_tokens` falling below `_COMPACTION_TOKEN_FLOOR` — a prediction that a compaction is coming, which may never be followed by one. This directive is only correct AFTER a compaction, so its trigger SHALL be `on_pre_compress` firing.
- **`on_pre_compress`'s return value SHALL remain the empty string.** Its documented destination is the compressor prompt — the summariser that builds the compacted window, not the agent that continues afterwards. Placing the directive there would instruct the wrong consumer and would shape the window instead of the stored summary, which is the exact confusion this contract exists to remove.
- **It SHALL be emitted once, on the first `prefetch()` after the compaction, as its own line**, independent of the save, summary and resumed-read lines; none SHALL replace another. Where the resumed-read line and this directive would both be emitted on the same turn, only this directive SHALL be emitted: it is a strict superset of the read instruction the other carries.
- **Its flags SHALL reset on session end and session switch**, matching the provider's existing per-session counters and warned flags.

**The accepted-risk clause, for a client with no compaction event.** This requirement SHALL NOT cause a client to invent one, and the absence SHALL be recorded as an accepted risk rather than tracked as an open defect:

- The expected outcome on such a client is a THIN post-compaction rewrite — a full-looking summary of the window the model can still see, with earlier detail gone from the stored value. That is the no-block arm measured above, and it is an accepted outcome, not a bug report.
- `session_summary_versions` IS the mitigation, and it SHALL be treated as sufficient for this case: the displaced text is a version row, so the loss is recoverable rather than destructive. That is precisely the guarantee "Every curated session-summary write MUST append a version row in the same transaction" exists to provide.
- Recovery SHALL use the two surfaces that already exist and no third SHALL be added for this case: `memory.session_get` with a positive `limit` for the agent, and the session detail view's version history for the operator.
- The client's only preventive coverage is its always-present protocol block ("The `instructions` block MUST state that a curated summary write replaces the stored value"), which Pi reaches by appending the server's `instructions` to the harness system prompt. That block carries the replacement and current-state obligations but no `memory.session_get` directive bound to a compaction moment, and finding 2 above says always-present text of that kind is not sufficient for a weak model. It is a named gap, not a solved problem.
- Closing the gap requires a host capability that does not exist today. If such a client later exposes a compaction event, the matrix clause applies to it with no further change to this requirement.

#### Scenario: Every client with a compaction event injects the directive

- **WHEN** each client's compaction surface is inspected — `post-compact.sh` (Claude Code, Codex CLI), `experimental.session.compacting` (opencode), `on_pre_compress` + the next `prefetch()` (Hermes)
- **THEN** each SHALL deliver text directing the model to read the stored summary with `memory.session_get` and then write the session's current complete state with `memory.session_summary`
- **AND** none SHALL direct the model to store the host's compacted window

#### Scenario: Hermes arms the directive from the compaction, not from the token estimate

- **GIVEN** a Hermes session whose `remaining_tokens` has fallen below `_COMPACTION_TOKEN_FLOOR` but for which `on_pre_compress` has not fired
- **WHEN** `prefetch()` is next called
- **THEN** the post-compaction directive SHALL NOT be emitted (the urgent save reminder's own behaviour is unchanged)
- **WHEN** `on_pre_compress` then fires and `prefetch()` is called again
- **THEN** the directive SHALL be emitted exactly once, as its own line, and SHALL NOT be repeated on later turns of the same session

#### Scenario: The compressor prompt receives nothing

- **WHEN** `on_pre_compress` returns
- **THEN** its return value SHALL be the empty string
- **AND** the directive SHALL NOT appear in it

#### Scenario: The directive supersedes the resumed-read line on a shared turn

- **GIVEN** a Hermes session in which the resumed-read line has not yet been emitted and `on_pre_compress` has just fired
- **WHEN** `prefetch()` is called on a turn where both would apply
- **THEN** only the post-compaction directive SHALL be emitted
- **AND** the resumed-read line SHALL NOT also be emitted on that turn

#### Scenario: A client with no compaction event is not required to invent one

- **GIVEN** a client whose host exposes no compaction event
- **WHEN** its event registrations are inspected
- **THEN** no compaction-time injection SHALL be required of it, and its absence SHALL NOT be treated as a defect against this requirement

#### Scenario: A thin post-compaction rewrite stays recoverable without any client mechanism

- **GIVEN** a session with a curated summary, on a client with no compaction event
- **WHEN** a post-compaction model writes a summary of only the window it can still see
- **THEN** `sessions.summary` SHALL be that thin text
- **AND** the displaced text SHALL be readable in full by `memory.session_get` with a positive `limit`, and in the session detail view's version history
- **AND** no additional client-side or server-side mechanism SHALL be required for that recovery
