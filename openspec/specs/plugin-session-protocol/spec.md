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

### Requirement: Every model-facing session-summary surface MUST teach the exact Markdown heading format

The session-summary format SHALL be identical across the seven model-facing files pinned by the server invariant: `apps/server/src/mcp/instructions.ts`, `apps/server/src/mcp/server.ts`, `apps/server/src/services/session-nudge.ts`, `apps/plugin/scripts/post-compact.sh`, `apps/plugin/commands/summary.md`, `apps/plugin/bin/rembric-plugin-core.mjs`, and `apps/plugin/.hermes-plugin/__init__.py`. Each SHALL carry the canonical directive from `sessions`: exactly `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`, in that order, as level-2 Markdown headings that belong on separate lines. A surface that INTERPOLATES the shared `SUMMARY_SECTIONS` constant rather than embedding the literal SHALL satisfy this by that interpolation, which is stronger — the server's notice composer is the one surface that does so (`session-nudges`).

**The set changed shape when the nudge gate moved to the server, and the membership rule is what makes that safe rather than the list.** Two bash surfaces left it — `apps/plugin/scripts/prompt-nudge.sh`, which no longer composes a reminder, and `apps/plugin/scripts/stop-nudge.sh`, which no longer exists — and one server surface joined it, `apps/server/src/services/session-nudge.ts`. Membership is "emits model-facing text that asks for a session summary", and the invariant asserts its own completeness from a repository-wide search, so a surface that keeps the directive but leaves the list fails the test rather than escaping it.

This seven-file set reaches all five bundled clients through the existing sharing boundaries: Claude Code and Codex CLI reach it through the bash hook that survives plus the server-composed notice, opencode and Pi consume the JS/TS core and server tool metadata, and Hermes carries the fixture-pinned Python text. No client-specific wording SHALL be introduced. A file with several summary instruction paths SHALL use the canonical directive in every one of them; one passing occurrence SHALL NOT license another flat occurrence in the same file.

#### Scenario: All seven surfaces carry the exact heading directive

- **WHEN** the invariant reads the seven tracked model-facing files
- **THEN** each SHALL carry the six canonical `##` headings in order and the separate-line instruction
- **AND** none SHALL carry the bare flat fragment `Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files`

#### Scenario: All five clients inherit the same format

- **WHEN** the emitted summary instruction is captured for Claude Code, Codex CLI, Hermes Agent, opencode, and Pi
- **THEN** every client SHALL direct the model to use the same six level-2 headings on separate lines
- **AND** any prefixes or host wrappers SHALL be the only permitted differences

#### Scenario: A format mutation fails the lock-step tests

- **WHEN** one heading loses its `##` prefix, moves position, is renamed, or an extra heading is appended in one surface
- **THEN** the invariant or cross-language fixture suite SHALL fail and name the divergent surface

### Requirement: The per-turn save/summary nudge text MUST be a calibrated imperative shared byte-identical across every client

The reminder that a session owes a curated summary SHALL be composed by the SERVER and printed verbatim by the client (`session-nudges`). No client SHALL declare a reminder string of its own, and no client SHALL hold a cadence constant, a turn counter or a modulo for this purpose. Byte-identity across the five clients is therefore a structural property rather than a fixture assertion: there is one implementation, in one language, and a client added later inherits it by printing what it is handed.

The strings that REMAIN client-composed SHALL continue to be sourced from the single shared contract `apps/plugin/test/nudge-fixtures.json` and SHALL be byte-identical across clients, on the discipline this requirement has always imposed. Those strings are the recall line, the first-prompt relevance line, the session-start line, the resumed-read line, the post-compaction block, the session-id line, and the **session opening** (`session-nudges`, "The session opening MUST ask for a title and `## Goal` before the turn ends, on every client"). Bash and the shared JS/TS module embed the `rembric:`-prefixed value verbatim; Hermes wraps the unprefixed `…Core` variant in `<memory-hint>…</memory-hint>` per its established convention. No individual JS/TS client SHALL carry its own copy — there is one JS/TS implementation and every JS/TS client imports it.

**The `save`, `saveCore`, `summary` and `summaryCore` keys SHALL be removed from the fixture contract**, together with `endOfTurnRubric`. They were the cross-language pins for a text that no client composes any more, and a fixture that pins a string nobody emits is a test that cannot fail for the right reason.

The server-composed text SHALL keep the calibration this requirement established, restated where it now lives:

- It SHALL direct the model to curate as a required action when it applies, not as a passive suggestion.
- It SHALL preserve the model's discretion to skip: the notice states explicitly that a model with nothing to add should not call the tool. This is what stops a periodic reminder from manufacturing vacuous writes, and it SHALL NOT be dropped in favour of an unconditional imperative.
- It SHALL carry the canonical Markdown format only where the model needs it — that is, when nothing is stored. When sections ARE stored, the notice lists them by name, which teaches the same structure from the session's own state and costs fewer bytes.
- Its firing is governed by `session-nudges` and SHALL NOT be restated here. The former parenthetical — "summary on turn 1 and every `SUMMARY_NUDGE_EVERY`; save every `SAVE_NUDGE_EVERY`" — describes a mechanism that no longer exists.

**The notice MAY assert what is stored, and that is a change of position rather than an oversight.** This requirement previously forbade any claim about whether a summary exists, on the ground that "one string has to be true in both states, and a claim about state is the one thing a state-blind reminder cannot make". The reminder is no longer state-blind: it is composed by the process that holds the state, per session, at the moment it is emitted. The prohibition applied to a shared static string and SHALL continue to apply to every client-composed line; it SHALL NOT be read as forbidding the server from describing the row it just read.

#### Scenario: No client composes a cadence-driven reminder

- **WHEN** every client's source is read at HEAD
- **THEN** none SHALL declare a string directing the model to call `memory.session_summary` on a cadence
- **AND** none SHALL declare a modulo, counter or interval constant governing such a string

#### Scenario: The remaining fixtures still lock across languages

- **WHEN** `nudge-fixtures.test.ts` compares the bash, shared JS/TS and Python sources against `nudge-fixtures.json`
- **THEN** every remaining agent-facing key SHALL match across the clients that emit it
- **AND** Python's `…_HINT` values SHALL equal `<memory-hint>${…Core}</memory-hint>`
- **AND** the JS/TS arm SHALL read the shared module, not any individual client file

#### Scenario: The retired keys are gone

- **WHEN** `apps/plugin/test/nudge-fixtures.json` is read at HEAD
- **THEN** it SHALL NOT contain `save`, `saveCore`, `summary`, `summaryCore` or `endOfTurnRubric`

#### Scenario: The notice preserves the model's discretion to skip

- **WHEN** the server-composed notice is inspected
- **THEN** it SHALL state that a model with nothing to add should not call the tool
- **AND** it SHALL NOT read as an unconditional instruction to write on every emission

#### Scenario: A client that carries its own reminder copy fails the build

- **GIVEN** a JS/TS client file declares a local reminder string constant
- **WHEN** `pnpm test` runs
- **THEN** the single-implementation invariant SHALL fail, naming the offending file and line

### Requirement: Clients that know their own session id MUST surface it per-turn as a standalone nudge

The server cannot resolve which of several concurrently-active sessions an implicit MCP write belongs to (see the `sessions` capability's `findActiveForTransport` never-guess contract). Clients that DO know their own current session id at emission time — Claude Code/Codex (`session_id` from hook stdin), opencode (`input.sessionID`), Hermes (`session_id` from the `prefetch` kwarg, falling back to `self._session_id`), Pi (`ctx.sessionManager.getSessionId()`) — SHALL surface it to the model as a separate, standalone line **whenever any line directing a write is emitted on that turn**, emitted first, so the model can pass it explicitly to the tools named in the `mcp-api` `sessionId` reinforcement requirement.

"Any line directing a write" covers both the server-composed stretch-close notice (`session-nudges`) and the client-composed session opening. The former trigger — "whenever the save or summary nudge fires" — named two client-composed lines that no longer exist; restating the rule over the surfaces that replaced them is what keeps it enforceable.

- The line SHALL be sourced from the shared template `apps/plugin/test/nudge-fixtures.json`'s `sessionIdTemplate`/`sessionIdCoreTemplate` (a `{{SESSION_ID}}` placeholder interpolated with the real value), byte-identical across clients modulo that interpolation.
- **It SHALL stay client-composed rather than being folded into the server's response**, even though the server has the id — the report carried it. Two reasons: the line must also accompany the client-composed session opening, which the server knows nothing about; and its byte-identity across five clients is an existing, passing assertion with nothing to gain from moving.
- The line SHALL be OMITTED when no session id is known — never a placeholder, never an invented id.
- The line SHALL NOT alter the text or the firing of the line it accompanies; it is purely additive.

#### Scenario: sessionId line accompanies the server-composed notice

- **GIVEN** a client that knows its session id and holds cached notice lines
- **WHEN** it prints them at the start of the next turn
- **THEN** the sessionId line SHALL be emitted immediately before them, with the real id interpolated

#### Scenario: sessionId line accompanies the session opening

- **GIVEN** a client on the first turn of a newly created session
- **WHEN** the opening line is emitted
- **THEN** the sessionId line SHALL be emitted immediately before it

#### Scenario: sessionId line is omitted when the id is unknown

- **GIVEN** a client turn where no session id could be resolved
- **WHEN** any write-directing line is emitted
- **THEN** the sessionId line SHALL NOT be emitted, and the other line(s) SHALL appear unchanged

#### Scenario: The sessionId line is not emitted on a turn with nothing to accompany

- **GIVEN** a client turn on which no notice was cached and no opening applies
- **WHEN** the turn starts
- **THEN** the sessionId line SHALL NOT be emitted — it accompanies a write-directing line and is never emitted alone

### Requirement: Per-client lifecycle mapping MUST be honoured

The cross-client write contract maps lifecycle events to HTTP endpoints as follows. Implementations SHALL conform; divergences from this mapping SHALL be considered specification violations.

| Client      | Lifecycle event                                                         | HTTP call                                                                                                                                                    | `final` |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Claude Code | `SessionStart` (`startup\|resume\|clear\|fork`)                         | `POST /sessions {id, cwd, agent}` (placeholder title) **then `POST /sessions/<id>/resume`**                                                                  | n/a     |
| Claude Code | `SessionStart` (`compact`)                                              | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) **then `POST /sessions/<id>/resume`** + stdout instruction                                          | n/a     |
| Claude Code | `UserPromptSubmit`                                                      | none (stdout lines only — local lines plus the cached notice)                                                                                                | n/a     |
| Claude Code | `Stop` (every turn)                                                     | `POST /sessions/<id>/turn {usedTools, title?}` — the response's `lines` are cached, never printed here                                                       | n/a     |
| Claude Code | `PreCompact`                                                            | `POST /summary {summary, title, final:false}`, or `{}` when no transcript                                                                                    | false   |
| Claude Code | `PostCompact`                                                           | `POST /summary {summary, final:false}`, or `{}` when no compaction summary                                                                                   | false   |
| Claude Code | `SessionEnd`                                                            | `POST /end {summary, title, final:false}`, or `{}` when no transcript                                                                                        | false   |
| Codex CLI   | `SessionStart` (`startup\|resume\|clear`)                               | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| Codex CLI   | `SessionStart` (`compact`)                                              | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) **then `POST /sessions/<id>/resume`** + stdout instruction                                          | n/a     |
| Codex CLI   | `UserPromptSubmit`                                                      | none (stdout lines only — local lines plus the cached notice)                                                                                                | n/a     |
| Codex CLI   | `Stop` (every turn)                                                     | `POST /sessions/<id>/turn {usedTools, title?}` + stdout `'{}'` — the response's `lines` are cached, never printed here                                       | n/a     |
| Codex CLI   | `PreCompact`                                                            | `POST /summary {summary, title, final:false}`, or `{}` when no transcript                                                                                    | false   |
| Codex CLI   | `PostCompact`                                                           | `POST /summary {summary, final:false}`, or `{}` when no compaction summary                                                                                   | false   |
| Codex CLI   | `SessionEnd` (main thread only)                                         | `POST /end {summary, title, final:false}`, or `{}` when no transcript                                                                                        | false   |
| Hermes      | `initialize`                                                            | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| Hermes      | `on_pre_compress(messages)`                                             | `POST /summary {summary, final:false}`                                                                                                                       | false   |
| Hermes      | `on_session_switch(new_id, parent_id)`                                  | `POST /end old` (only when the id actually changed) `+ POST /sessions new` **then `POST /sessions/new/resume`** on the first ensure of `new` in this process | n/a     |
| Hermes      | `sync_turn(user, assistant, **kwargs)`                                  | `POST /sessions/<id>/turn {usedTools, title?}` on a background thread; the response's `lines` are cached for the next `prefetch()`                           | n/a     |
| Hermes      | `on_session_end(messages)`                                              | `POST /end {summary, title, final:false}`                                                                                                                    | false   |
| opencode    | `session.created` (not a sub-agent)                                     | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`**                                                                                      | n/a     |
| opencode    | `chat.message`                                                          | `POST /sessions {id, cwd, agent}` + resume on the first ensure of the id in this process; no-op afterwards; + cached notice and local lines pushed           | n/a     |
| opencode    | `session.idle`                                                          | `POST /sessions/<id>/turn {usedTools, title?}`; the response's `lines` are cached for the next `chat.message`                                                | n/a     |
| opencode    | `session.compacted`                                                     | `POST /summary {summary, title?, final:false}`                                                                                                               | false   |
| opencode    | `experimental.session.compacting`                                       | `POST /sessions {id, cwd, agent}` + resume on the first ensure of the id in this process; + injected context                                                 | n/a     |
| opencode    | `session.deleted`                                                       | none (drops the in-memory accumulator only)                                                                                                                  | n/a     |
| opencode    | `server.instance.disposed`                                              | fire-and-forget `POST /summary {summary, title?, final:false}` per known session — never `/end`                                                              | false   |
| Pi          | `session_start`                                                         | none (creates the protocol client and discovers tools over MCP)                                                                                              | n/a     |
| Pi          | `before_agent_start`                                                    | `POST /sessions {id, cwd, agent}` **then `POST /sessions/<id>/resume`** on the first ensure of the id in this process; + cached notice and local lines       | n/a     |
| Pi          | `message_end`                                                           | none (feeds the in-memory accumulator and the turn's tool observation only)                                                                                  | n/a     |
| Pi          | `agent_settled`                                                         | `POST /sessions/<id>/turn {usedTools, title?}`; the response's `lines` are cached for the next `before_agent_start`                                          | n/a     |
| Pi          | `session_shutdown` (`quit\|new\|resume\|fork`, not a self-resume)       | `POST /end {summary, title, final:false}`, or `{}` when the accumulator is empty                                                                             | false   |
| Pi          | `session_shutdown` (`reload`, a self-resume, or an unrecognised reason) | `POST /summary {summary, title?, final:false}` — never `/end`                                                                                                | false   |
| Any (model) | `memory.session_summary({summary, title?})` (MCP)                       | internal write (no HTTP) with `final:true`                                                                                                                   | true    |

**Every client SHALL issue exactly one `POST /api/<slug>/sessions/<id>/resume` per session id per process, immediately after the FIRST `POST /api/<slug>/sessions` ensure for that id in that process, and SHALL NOT condition it on any host signal.** This is the one uniform rule; there is no per-client variation in when the call is made, and a client SHALL NOT gate it on a `source`, `reason` or `reset` value.

Three properties make the unconditional form the correct one rather than a shortcut:

- **The resume is a documented no-op on an `active` row** (`http-api` capability), so on a genuinely new session the call changes nothing and costs one local request. The client therefore does not need to know whether it is resuming, which is fortunate, because —
- **no client has a resume signal on a cold start**, and a cold start is the case that motivates the rule. Claude Code and Codex CLI do expose `source: "resume"` on `SessionStart`, and Hermes exposes `reason="resume"` with `reset=False` on `on_session_switch`, but those fire for session changes **inside a living process**, where the client's own in-memory state already keeps attribution correct. Pi's cold-start resume arrives as `reason: "startup"`, indistinguishable from a clean start. Building the emitter on those signals would produce a per-client asymmetry that still failed the case it was built for.
- **The ordering is ensure-then-resume, and it is load-bearing.** A session whose row was physically purged by `purgeEmpty` (permitted once a terminal row's grace elapses with no memories attached) is recreated `active` by the ensure, and the resume that follows is then a no-op against the row the ensure just created. The conversation continues under the same id with no special case. Reversing the order would resume a row that does not exist and report `session_not_found` for a conversation that is about to be perfectly healthy.

The rule replaces a recovery two clients already attempt and provably cannot perform: `post-compact.sh`'s ensure carries the comment "covers the case where the row was abandoned by the stale sweep between the pre-compact moment and the post-compact resume — re-create silently", and the ensure path returns a terminal row untouched (`http-api` capability). Before this rule that comment described behaviour that did not exist.

**Every client SHALL issue exactly one `POST /api/<slug>/sessions/<id>/turn` per finished turn**, on its own end-of-turn event, and SHALL NOT issue it on a start-of-turn event. That is the row that replaces the per-turn `POST /summary` the shell clients previously performed on `Stop`, and it carries the obligations that write used to carry: it is what advances `last_activity_at`, so a live session is not retired by the stale-active sweep, and it is what delivers the provisional title. The clients that also flush a transcript at a MILESTONE — opencode's `session.compacted` and dispose, Pi's shutdown, Hermes's `on_pre_compress` and `on_session_end`, the shell clients' `PreCompact` and `SessionEnd` — keep those rows unchanged; only the PER-TURN raw sync is replaced.

**"Finished" is load-bearing in that sentence, and exactly one client cannot satisfy it on every turn.** Hermes reports from `sync_turn`, which its host does not call at all on an interrupted turn — the memory fan-out returns first. So a Hermes turn the user interrupts yields no report and therefore no `last_activity_at` stamp. That deviation is permitted, is specified with its consequence in `hermes-agent-plugin`, and SHALL NOT be worked around client-side by reporting from a start-of-turn handler or a timer: a report is a statement that a turn finished, and issuing one for a turn that did not would corrupt the only signal this endpoint carries. Any client added later that cannot observe turn completion SHALL be documented the same way rather than made to approximate it.

Seven rows are load-bearing and easy to get wrong:

- **The shell clients no longer POST a transcript on `Stop`.** `apps/plugin/scripts/stop-sync.sh` is deleted. The per-turn body it sent was re-derived from a JSONL file the host already persists and which `pre-compact.sh` and `session-end.sh` re-read anyway; what is lost is the case of a session hard-killed between two terminal events, which now stores nothing in Rembric rather than the previous turn's transcript. That exposure is a SIGKILL, and it is the same class of loss this capability already documents as out of scope for opencode and Pi.
- **The in-process clients' transcript accumulator and terminal flushes are UNCHANGED.** opencode's dispose flush and Pi's shutdown POST hold the only copy of those sessions' transcripts, and both convergence guarantees in this capability rest on them. The turn report does not replace them and SHALL NOT be read as doing so.
- **`SessionStart (compact)` does make HTTP calls on both shell clients.** `post-compact.sh` re-POSTs `/sessions` and then `/sessions/<id>/resume` before emitting its stdout block, which is additionally injected into the resumed model's context.
- **Claude Code's `SessionStart` matcher group includes `fork`.** A forked session reports `source: "fork"` from v2.1.214 onward and carries a NEW session id, so it is a new session that must be registered. Codex's `SessionStart` has no `fork` source — its documented values are `startup`, `resume`, `clear` and `compact` — so its matcher group SHALL NOT declare one, and the asymmetry is the hosts', not ours.
- **Codex CLI DOES have `SessionEnd`.** It runs for the main thread when an open conversation is archived or deleted, when Codex closes normally, or after 30 minutes idle with no connected client, and it does not run for subagents. Its time budget is the tightest of any hook on either host: **1 second by default, 3 seconds maximum**, where every other Codex hook defaults to 600. A handler that does not declare `"timeout": 3` is killed after one second, and a POST allowed to consume that whole budget leaves nothing for reading the transcript or emitting the failure diagnostic.
- **Pi's two `session_shutdown` rows are selected by the event's `reason`, and the split is the whole point.** `reason: "reload"` is the same session continuing; ending there costs `session_id = NULL` on every later write until the next `before_agent_start` ensure-and-resume repairs it. A `resume` that names the session file already open is the same hazard under a different reason. Pi is the only client that chooses its shutdown endpoint at runtime.
- **opencode's dispose row is fire-and-forget and never `/end`, by decision rather than omission.** The host kills the subprocess before async handlers settle, so an awaited call there would frequently not land and no requirement could promise `ended`. An opencode row therefore stays `active` until `abandonStale` flips it.

Of the five clients, four POST `/end`: Claude Code, Codex CLI, Hermes and Pi. opencode does not, for the reason above, and its rows reach `abandoned` through the sweep. All five POST the resume, and all five POST the turn report.

#### Scenario: Every client has a row and no client has an undocumented lifecycle write

- **WHEN** the table above is compared against the shipped clients at HEAD
- **THEN** each of the five clients SHALL have at least one row
- **AND** every lifecycle handler in each client that issues an HTTP request SHALL correspond to a row naming that endpoint
- **AND** a handler that issues no request SHALL either be absent from the table or carry `none` in the HTTP-call column

#### Scenario: Every client reports exactly one turn per turn

- **GIVEN** any of the five clients driven through three consecutive turns, all of which the user allows to finish
- **WHEN** the requests it issues are recorded
- **THEN** exactly three `POST /api/<slug>/sessions/<id>/turn` requests SHALL have been made
- **AND** none SHALL have been made from a start-of-turn event

#### Scenario: A turn the host never finishes is not reported, and is not faked

- **GIVEN** a Hermes session in which the middle of three turns is interrupted
- **WHEN** the requests are recorded
- **THEN** exactly two reports SHALL have been made
- **AND** no report SHALL have been synthesised for the interrupted turn from a start-of-turn handler, a timer, or any other substitute

#### Scenario: No shell client POSTs a transcript per turn

- **WHEN** `apps/plugin/scripts/` is read at HEAD
- **THEN** `stop-sync.sh` SHALL NOT exist
- **AND** no script wired to the `Stop` event SHALL POST to `/summary`

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

#### Scenario: A failed turn report degrades to a diagnostic, never to an aborted session

- **GIVEN** a client whose server returns `404` for the turn report (an old server that does not implement the route)
- **WHEN** the end-of-turn handler runs
- **THEN** the client SHALL emit exactly one stderr diagnostic naming the path and status, per this capability's failed-POST requirement
- **AND** it SHALL cache no lines and SHALL NOT clear any pending ones
- **AND** the host session SHALL continue, and the hook or handler SHALL exit successfully

#### Scenario: Claude Code hooks.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear|fork` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** `Stop` SHALL declare exactly ONE entry, invoking `stop-report.sh`, and it SHALL NOT declare `async` — an asynchronous handler is fire-and-forget by the host's contract and could not deliver a response the next turn depends on
- **AND** the six event types SHALL carry eight handler entries in total
- **AND** the `hooks` object SHALL NOT contain a `PostToolUse` entry

#### Scenario: Codex hooks.codex.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact` — Codex has no `fork` source, so unlike Claude Code's manifest this group SHALL NOT declare one
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** `Stop` SHALL declare exactly ONE entry
- **AND** the six event types SHALL carry eight handler entries in total
- **AND** the `SessionEnd` entry SHALL declare `"timeout": 3`, the documented maximum for this one event, and SHALL carry no `matcher` key
- **AND** the `Stop` script SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout — plain text is invalid per docs)

#### Scenario: `pre-compact.sh` exists and is wired on both clients

- **WHEN** the repository is inspected at HEAD
- **THEN** `apps/plugin/scripts/pre-compact.sh` SHALL exist and be executable
- **AND** `hooks.json`'s `PreCompact` entry SHALL invoke it with the agent argument `claude-code`
- **AND** `hooks.codex.json`'s `PreCompact` entry SHALL invoke it with the agent argument `codex-cli`

#### Scenario: Hermes plugin.yaml declares the lifecycle methods

- **WHEN** `apps/plugin/.hermes-plugin/plugin.yaml` is loaded
- **THEN** the `hooks` array SHALL contain `on_pre_compress`, `on_session_end`, `on_session_switch` and `sync_turn`

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

The `<private>` redaction helper, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers, the session-end call, the session-resume call, **the turn-report call, the per-session cache of the server's returned lines, and the per-turn tool-observation LATCH** (arm, disarm at the turn boundary, read-and-clear at the report, evict on forget), and the texts of the lines that remain client-composed, SHALL exist in exactly one JS/TS implementation, at `apps/plugin/bin/rembric-plugin-core.mjs`. Every JS/TS client SHALL import them from there and SHALL declare no local copy.

This is what makes the identical-redaction-semantics and byte-identical-line requirements structural rather than a matter of discipline: with one implementation there is no second copy to keep in step, and a client added later inherits both contracts by construction.

A JS/TS client SHALL contribute only the PREDICATE its host makes available — which event means "a tool ran" — and SHALL hold no per-turn state of its own for it. The invariant enforcing this SHALL be stated over the concept rather than over a symbol name: the two copies that preceded it were called `toolUsedFlags` and `toolUsedThisTurn`, so a by-name inventory could not see that they were the same mechanism, and the divergence it hid was real — one client disarmed the latch at the turn boundary and the other did not.

**The read-and-clear SHALL sit BELOW the report's own guards, never above them.** A report the core declines to send — a sub-agent session, or one it never registered — SHALL leave the latch armed. Consuming it there discards the observation into a request that was never issued, so the session's next sent report claims `usedTools: false` about a turn that used a tool. Both clients that exist today guard their own call sites, so the ordering is unreachable from either and its cost is entirely borne by the next client to call `reportTurn` without that guard; it is stated here because "unreachable today" is not a property of the core.

A member of that list SHALL live in the core even when exactly one client calls it. The session-end call is the case in point: only Pi invokes it, because opencode's host kills the subprocess before an awaited call can land. Placing it in the client that happens to use it would put a second `fetch` against a `/sessions/…` path in a client file, which is a second implementation of the session HTTP client whatever it is named, and it would leave the next client that needs the verb to write a third.

**The nudge cadence constants SHALL NOT exist in the core, or anywhere else in the plugin tree.** `SAVE_NUDGE_EVERY`, `SUMMARY_NUDGE_EVERY`, the per-session turn-count map and their bash and Python equivalents are removed: the firing decision belongs to the server (`session-nudges`), and a constant that no longer decides anything is a fifth place for a future contributor to change by mistake.

**The turn-report call and its line cache SHALL be one core-owned pair.** The cache SHALL be keyed per session, SHALL be cleared when the session is forgotten, and SHALL NOT be overwritten with an empty result — a report that returns no lines leaves any pending lines intact, so a second end-of-turn event within one turn cannot swallow a notice. Reading the cache SHALL clear it, so a notice is printed exactly once.

The resume SHALL be issued by the core's session-registration entry point itself, on the branch that has just added the id to its known-session set, rather than by each client after calling it. That set is already the once-per-id gate for the ensure, so making the resume ride on the same branch makes "exactly one resume per id per process" structural instead of a rule two clients each have to remember. No JS/TS client SHALL call the resume path directly, and no JS/TS client SHALL keep its own known-session set for this purpose.

The resume SHALL be skipped when the ensure that precedes it did not land. Whatever prevented the ensure — an unreachable server, a revoked token, an unresolvable slug — prevents the resume too, so issuing it anyway buys nothing and doubles the wait a quitting or starting user absorbs, each POST being separately bounded by the client's timeout. The id SHALL nevertheless remain in the known-session set, so the pair is not retried on the next call.

An invariant test in `apps/server/src/test/invariants.test.ts` SHALL fail the build when a second JS/TS definition of any of these appears. The test SHALL (a) assert a **non-zero count** of scanned files, so an empty file list cannot satisfy the negative assertions vacuously, and (b) derive its scanned file list from a repository-wide search rather than a hard-coded list, so a client added later is scanned on the day it is added. The failure message SHALL name the offending `<file>:<line>`.

**The scanned set is every JS/TS source file under `apps/plugin/`, which is broader than the set of clients, and the two halves of the invariant apply to different sets.** The repository ships a JS/TS artifact under `apps/plugin/` that is deliberately not a session client — the transport package `apps/plugin/mcp-bridge/` — and the distinction has to be normative rather than an accident of the pattern the test happens to use:

- **The no-second-definition half applies to every scanned file**, client or not. A non-client file that redefines a core-owned helper is a second implementation whatever its directory is called, and `diag` and `truncate` are the realistic collisions for any program that writes stderr diagnostics.
- **The must-import half applies to clients only.** A file that participates in no part of the session protocol SHALL NOT be required to import the core, and requiring it would be worse than useless: it would put session-protocol code inside a transport whose contract is to inspect no payload.

The set of clients SHALL be derived from the per-client directory shape (`apps/plugin/.<name>-plugin/`) rather than enumerated, and a non-client artifact under `apps/plugin/` SHALL NOT be placed in a directory matching that shape.

The core SHALL require `agent` as a mandatory parameter of session registration, with no default. `sessions.agent` is written once per session and memory is append-only, so a defaulted value misattributes sessions permanently with no repair verb.

#### Scenario: A second redaction implementation fails the build

- **GIVEN** a change introduces a local `function stripPrivateTags` in any JS/TS client file
- **WHEN** `pnpm vitest run apps/server/src/test/invariants.test.ts` runs
- **THEN** the test SHALL fail with a message naming the offending file and line

#### Scenario: No cadence constant survives anywhere in the plugin tree

- **WHEN** `git grep -n 'NUDGE_EVERY\|_HINT_EVERY\|rembric-turnnudge'` runs over `apps/plugin/` at HEAD
- **THEN** it SHALL produce no match

#### Scenario: A report returning no lines does not swallow a pending notice

- **GIVEN** a core holding cached lines for session `<S>`
- **WHEN** `reportTurn(<S>, …)` is called and the server returns an empty `lines` array
- **THEN** the cached lines SHALL still be present
- **AND** the next read for `<S>` SHALL return them and SHALL clear the cache

#### Scenario: A dropped report does not consume the tool latch

- **GIVEN** a core whose tool latch is armed for a session it has not registered
- **WHEN** `reportTurn` is called for that session
- **THEN** no request SHALL be issued
- **AND** the latch SHALL still be armed, so that session's first SENT report SHALL carry `usedTools: true`

#### Scenario: A non-client file under `apps/plugin/` cannot redefine a core-owned helper

- **GIVEN** a change introduces a `function diag` or `function truncate` inside `apps/plugin/mcp-bridge/`
- **WHEN** the invariant runs
- **THEN** the test SHALL fail naming that file and line
- **AND** the message SHALL name `apps/plugin/bin/rembric-plugin-core.mjs` as the one permitted definition site

#### Scenario: A non-client file is not required to import the core

- **WHEN** the invariant enumerates the files that must import `rembric-plugin-core.mjs`
- **THEN** `apps/plugin/mcp-bridge/`'s sources SHALL NOT be among them
- **AND** the enumeration SHALL be derived from the `apps/plugin/.<name>-plugin/` directory shape

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
2. Write the session's CURRENT COMPLETE state with `memory.session_summary` — what was just read, brought up to date with the surviving window — **and SHALL be told what the write does to the stored value, in terms that are true under the section-wise merge: each `##` section the write carries replaces its stored counterpart, and a section the write omits keeps its stored text. Sending a summary of the window alone therefore replaces every section the window happens to mention and silently leaves the rest stale.**
3. Recall further prior context (`memory.context` / `memory.search`) when what was read is not enough.

The rationale in clause 2 is a correction, not a reword, and the correction is recorded because the previous form is quoted elsewhere. This requirement previously argued "so sending the window alone stores the window alone", which was exactly true of a whole-document replacement and is true after `refine-session-summary-writes` only of a window carrying no `##` heading, or one carrying every stored heading. The obligation is unchanged — the block must state what the write does — and the danger it points at is unchanged in kind but different in shape: the loss is now silent staleness in the sections the window did not mention, rather than wholesale replacement.

The block SHALL NOT ask for a summary of the compacted window, and SHALL NOT ask for "the compact summary shown above". Either framing, combined with a merging write, still produces the loss this contract exists to prevent: the model does as it is told, the sections the window covers become the window, and the sections it does not cover go quietly out of date with nothing marking them.

This block is also the compaction re-arm of the read directive specified in "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist". A compacted context is, for that purpose, a fresh attachment to a pre-existing session, and the injection at the compaction boundary is the earliest point at which the model can act on it — so it carries the directive itself rather than depending on a later reminder firing or on a relaxed first-ensure marker.

Where a client has NO compaction hook, this requirement SHALL NOT cause one to be added. That client's coverage is its always-present protocol block (`mcp-api`, "The `instructions` block MUST state that a curated summary write replaces the stored value"), which carries the merge and current-state obligations on every turn but no `memory.session_get` directive. That is a named gap, not a solved problem.

The block SHALL keep every obligation it already carries: the `10000` cap substring and one copy of the text shared by the clients that use it. It SHALL carry the exact canonical Markdown heading directive. **A reworded block SHALL be re-measured against the published ≤700-byte cap in the same commit as the wording**, and the measured value recorded. Measured on the shipped fixture after the merge correction: the `rembric:`-prefixed `postCompact` is **599 bytes** and the unprefixed `postCompactCore` is **590**, against the 683 bytes the direct-replacement wording measured and the 675 the pre-correction fixture measured.

#### Scenario: The block asks for the current whole state, after a read

- **WHEN** the post-compaction injection is emitted
- **THEN** it SHALL direct the model to call `memory.session_get` before writing
- **AND** it SHALL ask for the session's current complete state
- **AND** it SHALL state that the `##` sections the write carries replace their stored counterparts and that omitted sections keep their stored text

#### Scenario: The block no longer claims a whole-document replacement

- **WHEN** the emitted block is inspected
- **THEN** it SHALL NOT state that the write REPLACES the stored value without qualification
- **AND** it SHALL NOT imply that a thin rewrite overwrites everything stored

#### Scenario: The block carries no window-only framing

- **WHEN** the same text is inspected
- **THEN** it SHALL NOT ask for a summary of the compacted window, of "what THIS window did", or of the host's own compact summary

#### Scenario: The block keeps its published obligations and its cap

- **WHEN** the emitted block is measured and grepped
- **THEN** it SHALL contain the substring `10000`
- **AND** it SHALL require the six canonical `##` headings on separate lines
- **AND** it SHALL be ≤700 bytes in UTF-8, with the measured value recorded alongside the wording

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

### Requirement: Every client's end-of-turn handler MUST report the turn exactly once and MUST NOT emit on the host's end-of-turn channel

The end-of-turn handler's only output SHALL be the HTTP turn report and, where the host requires one, an empty JSON object. It SHALL write nothing a host could treat as feedback on the turn.

**That is what retires the re-entry hazard at its root.** On Claude Code 2.1.232 the `Stop` runner appends a hook's `additionalContext` to the very array it returns as `blockingErrors`, and the query loop treats a non-empty array as a block: it appends those messages, sets the stop event's loop-guard flag, increments its consecutive-block counter and re-invokes the model. The host's own cap on that counter is not a bound — it counts CONSECUTIVE blocks and a continuation the model answers with a tool call resets it — and an unguarded reminder was measured re-firing on 141 consecutive continuations over 10 minutes. A handler that emits nothing on that channel cannot start the loop, so the reminder is delivered on the NEXT turn's start-of-turn channel instead, where the host has no such behaviour.

**The `stop_hook_active` check nevertheless survives, for a smaller and different reason: report idempotence.** Where the host reports that the end-of-turn event is already being continued — the boolean both shell hosts send under that name — the handler SHALL exit having issued no report. A continuation is not a new turn, and a second report for one turn would re-scan the same transcript delta and, worse, could overwrite a pending notice with an empty result. An absent, `null` or unreadable flag SHALL be treated as `false`, so the report still fires on a host that does not send it.

The check SHALL be decided BEFORE the transcript is located or read, so a continuation costs process start and nothing else.

**Fail-open is absolute.** On unparseable input, a missing or unreadable transcript, an unreachable server, a non-2xx response, or any unexpected error, the handler SHALL exit successfully and produce no output beyond the host-required empty object and the one stderr diagnostic this capability's failed-POST requirement specifies. The failure mode of a missed report is a later notice; there SHALL be no failure mode in which the host is degraded.

The handler SHALL NOT be given a byte or token budget for model-facing output, because it emits none. The budget that applies to the notice is the server's 640-byte bound on the composed string (`session-nudges`), paid on the next turn's start-of-turn channel.

#### Scenario: The end-of-turn handler writes nothing to the model

- **GIVEN** a turn at which the gate fires and the server returns notice lines
- **WHEN** the end-of-turn handler runs
- **THEN** its stdout SHALL be empty, or exactly `{}` on the host that requires a JSON object
- **AND** it SHALL NOT emit `hookSpecificOutput`, `additionalContext`, a `decision` key or a stop reason
- **AND** the returned lines SHALL be cached, not printed

#### Scenario: A continuation issues no second report

- **GIVEN** a turn already reported, whose host then continues the turn for an unrelated reason
- **WHEN** the end-of-turn event fires with `stop_hook_active: true`
- **THEN** no report SHALL be issued and no transcript SHALL be read
- **AND** the control SHALL pass in the same run: the identical input with the flag `false` SHALL issue exactly one report

#### Scenario: An absent loop-guard flag still reports

- **GIVEN** an end-of-turn event carrying no `stop_hook_active` key, or that key set to `null`
- **WHEN** the handler runs
- **THEN** the report SHALL be issued exactly as it is when the flag is `false`

#### Scenario: The guard is decided before the transcript is touched

- **WHEN** the end-of-turn script is inspected
- **THEN** the loop-guard check SHALL appear before the transcript path is resolved and before any read of it
- **AND** a test SHALL assert that order, so a later edit cannot move the guard behind work the host waits on

#### Scenario: An unreachable server costs one diagnostic and nothing else

- **GIVEN** a configured server that does not respond
- **WHEN** the end-of-turn handler runs
- **THEN** it SHALL print one `[rembric] POST <path> failed …` line to stderr
- **AND** it SHALL exit successfully within the client's POST timeout
- **AND** the next turn SHALL emit only the client-composed lines
