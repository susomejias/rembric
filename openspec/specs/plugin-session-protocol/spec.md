# plugin-session-protocol Specification

## Purpose

TBD - created by archiving change fix-session-summary-all-clients. Update Purpose after archive.

## Requirements

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
- **AND** `sessions.status` SHALL transition to `'ended'` only if the cooperating `memory.session_summary` call routed through the MCP server's terminating path; otherwise stays `'active'` until `abandonStale` flips it

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

### Requirement: The protocol nudge MUST be in `initialize.instructions` to cover all three clients uniformly

The MCP server's `initialize.instructions` string (loaded into the model's system prompt on connect) SHALL include a directive flow instructing the model to call `memory.session_summary` with `{title, summary}` at the end of every turn in which real work happened — never ending a working turn silent. The flow SHALL:

- Be present in both the path-scoped and path-less variants of `initialize.instructions`.
- Stay within the 1000-character cap enforced by `instructions.test.ts` (raised from 800; the cap is a self-imposed token budget, not a client or protocol limit).
- Be phrased as a **calibrated imperative**: a directive to curate (not a passive suggestion), **conditioned on real memorable work having happened** (a decision, fix, discovery, or files changed). It SHALL preserve the model's discretion to skip trivial turns with nothing worth persisting (so the imperative does not induce vacuous summaries), and SHALL NOT bind the trigger solely to the literal word "done".
- Describe the title constraint (≤100 chars, descriptive of what was worked on) and the summary structure (Goal · Discoveries · Accomplished · Next Steps · Files).

This nudge is the only mechanism that covers the case where Codex CLI cannot inject post-compact instructions and where short sessions never compact; it is likewise the only nudging surface available to in-process clients (e.g. Hermes Agent) that expose no per-turn hook. All clients ship with the same MCP server reachable, so this is the single deployment surface.

#### Scenario: Instructions string contains the protocol nudge

- **WHEN** an MCP client retrieves `initialize.instructions` from either `/mcp` or `/mcp/<slug>`
- **THEN** the string SHALL contain the substring `memory.session_summary` AND the substring `title` AND the substring `before` (referring to before ending a working turn)

#### Scenario: Instructions string respects the 1000-char cap

- **WHEN** the test suite runs `instructions.test.ts` against both variants
- **THEN** both outputs SHALL be ≤1000 characters

#### Scenario: Protocol nudge is imperative and work-conditioned

- **WHEN** the `initialize.instructions` SUMMARIZE flow is read
- **THEN** it SHALL read as a directive to curate (imperative), conditioned on real work having happened, rather than an unconditional or purely advisory phrasing

### Requirement: The per-turn save/summary nudge text MUST be a calibrated imperative shared byte-identical across all four clients

The save and session-summary nudge strings emitted per-turn by every client — Claude Code and Codex via `apps/plugin/scripts/prompt-nudge.sh`, opencode via `chat.message` (`apps/plugin/.opencode-plugin/plugin.ts`), Hermes via `prefetch()` (`apps/plugin/.hermes-plugin/__init__.py`) — SHALL be sourced from the single shared contract `apps/plugin/test/nudge-fixtures.json` (`save`, `saveCore`, `summaryCore`, `summary`) and SHALL be byte-identical across clients. Bash and TS embed the `rembric:`-prefixed `summary`/`save` verbatim; Hermes wraps `saveCore`/`summaryCore` in `<memory-hint>…</memory-hint>` per its established convention. The shared text SHALL be phrased as a calibrated imperative:

- It SHALL direct the model to curate (`memory.session_summary`) / save (`memory.save`) as a required action when it applies, not a passive suggestion.
- It SHALL condition that action on real, memorable work having happened (a decision, fix, discovery, or files changed), preserving the model's discretion to skip trivial turns with nothing worth persisting — so the imperative does not induce vacuous summaries or noise saves.
- It SHALL NOT change the firing cadence, which is governed separately (summary on turn 1 and every `SUMMARY_NUDGE_EVERY`; save every `SAVE_NUDGE_EVERY`) and is unchanged by this requirement.

#### Scenario: Shared nudge text is imperative and work-conditioned

- **WHEN** the `nudge-fixtures.json` `summary` and `save` strings are inspected
- **THEN** each SHALL read as a directive to act (imperative) AND SHALL reference the real-work condition (decision / fix / discovery / files changed), not merely an unconditional "call X now"

#### Scenario: Nudge text stays byte-identical across clients

- **WHEN** `nudge-fixtures.test.ts` compares the bash, TS, and Python nudge sources against `nudge-fixtures.json`
- **THEN** all SHALL match the shared fixture (Python's `_SUMMARY_HINT` SHALL equal `<memory-hint>${summaryCore}</memory-hint>`, `_SAVE_HINT` SHALL equal `<memory-hint>${saveCore}</memory-hint>`; bash turn-1 output SHALL equal `summary`; bash turn-5 output SHALL equal `save`)

#### Scenario: Cadence constants are unchanged

- **WHEN** the cadence constants are inspected across clients (`SUMMARY_NUDGE_EVERY`, `SAVE_NUDGE_EVERY`, and the `turn === 1` summary trigger)
- **THEN** they SHALL be unchanged by this requirement — only the nudge text changes

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
| Any (model) | `memory.session_summary({summary, title?})` (MCP) | internal write (no HTTP) with `final:true`                                    | true    |

Two rows are load-bearing and easy to get wrong:

- **Claude Code `Stop` omits `final` entirely** — it is never sent as `true` and never sent as `false`. Codex's `Stop` sends `final:false` explicitly, because Codex has no `SessionEnd` and its row must stay `active` for the next turn. `apps/plugin/scripts/stop-sync.sh` selects between the two from its agent-name argument.
- **`SessionStart (compact)` does make an HTTP call on both clients.** `post-compact.sh` re-POSTs `/sessions` as an idempotent ensure before emitting its stdout block, covering the case where the stale sweep abandoned the row between the pre-compact moment and the resume. Its stdout block is additionally injected into the resumed model's context.

Codex CLI has no `SessionEnd` event, so a Codex session row stays `active` until the `abandonStale` job flips it to `abandoned`.

#### Scenario: Claude Code hooks.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** the six event types SHALL carry eight handler entries in total
- **AND** the `Stop` handler SHALL declare `"async": true`
- **AND** the `hooks` object SHALL NOT contain a `PostToolUse` entry

#### Scenario: Codex hooks.codex.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these five event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** the five event types SHALL carry seven handler entries in total
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

### Requirement: Plugin-injected protocol nudges MUST surface the summary length cap

The agent-facing protocol nudges injected by the per-client plugins SHALL state the summary length cap inline so the agent budgets for it on the first attempt and does not trip the MCP rejection path. The affected injection sites are:

- `apps/plugin/scripts/post-compact.sh` — the `SessionStart matcher:"compact"` hook stdout, shared by Claude Code and Codex CLI (budget ≤150 tokens; see `claude-code-plugin`'s token-budget requirement for the measurement unit). The protocol block listed for the agent SHALL include the cap on the `summary` field.
- `apps/plugin/.hermes-plugin/__init__.py` — Hermes provider's system-message injection (around line 313). The session-close protocol sentence SHALL include the cap.
- `apps/plugin/commands/summary.md` — the slash command description SHALL mention the cap so users invoking `/rembric:summary` see the budget too.

Each plugin SHALL emit the literal substring `10000` (the current cap value) in the injected text so a test can grep for it and a contributor changing the cap is forced to update every site.

The `≤150` budget replaces a previously-published `≤120`, which the shipped block exceeded from the moment it was written (measured 552 bytes = 138.0 tokens under the newline-exclusive per-line convention `claude-code-plugin` pins; 138.3 if the emitting script's trailing newline is counted, which only turn totals do). The cap was raised rather than the text trimmed: this block fires at the moment of highest consequence — the model has just lost its context and this is the only instruction telling it what to persist — so trimming it to recover 16 tokens once per compaction trades instruction-following for nothing. `claude-code-plugin` asserts the same number and the two SHALL be changed together.

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

Any transcript-derived text a plugin sends to the server (session summaries, transcript snapshots, stop/pre-compact payloads, derived titles) SHALL have every `<private>…</private>` span replaced with `[REDACTED]` BEFORE the payload leaves the client. Matching SHALL be case-insensitive, SHALL span newlines, SHALL close each span at the first `</private>`, and an unclosed `<private>` SHALL redact through end-of-text (fail closed). All four clients (Claude Code, Codex CLI, Hermes Agent, opencode) SHALL implement identical observable semantics; the server SHALL NOT be relied upon to strip these tags.

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
