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

Plugin-side fallback writers (bash transcript dump, Hermes `_format_transcript`, opencode dispose-time flush) MAY post bodies up to the HTTP wire upper bound (`summary` ≤20,000 chars at the zod boundary). The server SHALL truncate any body whose `summary.length` exceeds `SUMMARY_MAX_CHARS` at the HTTP handler before calling the service, by replacing it with `summary.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + '…[truncated]'`. Convergence is therefore on a row whose stored `summary` is bounded by `SUMMARY_MAX_CHARS` regardless of what the fallback writer sent. Historical specs used literal numbers (`19500`, then `2000`) for derived or previous caps; this spec now references the server cap (`SUMMARY_MAX_CHARS`) abstractly so it does not drift when the cap is changed in a future OpenSpec change.

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
- Be phrased proactively and SHALL NOT bind the trigger solely to the literal word "done".
- Describe the title constraint (≤100 chars, descriptive of what was worked on) and the summary structure (Goal · Discoveries · Accomplished · Next Steps · Files).

This nudge is the only mechanism that covers the case where Codex CLI cannot inject post-compact instructions and where short sessions never compact; it is likewise the only nudging surface available to in-process clients (e.g. Hermes Agent) that expose no per-turn hook. All clients ship with the same MCP server reachable, so this is the single deployment surface.

#### Scenario: Instructions string contains the protocol nudge

- **WHEN** an MCP client retrieves `initialize.instructions` from either `/mcp` or `/mcp/<slug>`
- **THEN** the string SHALL contain the substring `memory.session_summary` AND the substring `title` AND the substring `before` (referring to before ending a working turn)

#### Scenario: Instructions string respects the 1000-char cap

- **WHEN** the test suite runs `instructions.test.ts` against both variants
- **THEN** both outputs SHALL be ≤1000 characters

### Requirement: Per-client lifecycle mapping MUST be honoured

The cross-client write contract maps lifecycle events to HTTP endpoints as follows. Implementations SHALL conform; divergences from this mapping SHALL be considered specification violations.

| Client      | Lifecycle event                                   | HTTP call                                                     | `final` |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------- | ------- |
| Claude Code | `SessionStart` (`startup\|resume\|clear`)         | `POST /sessions {id, cwd, agent}` (placeholder title)         | n/a     |
| Claude Code | `SessionStart` (`compact`)                        | stdout instruction to model; no HTTP                          | n/a     |
| Claude Code | `SessionEnd`                                      | `POST /end {summary, title, final:false}`                     | false   |
| Codex CLI   | `SessionStart` (any)                              | `POST /sessions {id, cwd, agent}`                             | n/a     |
| Codex CLI   | `Stop` (every turn)                               | `POST /summary {summary, title, final:false}` + stdout `'{}'` | false   |
| Hermes      | `initialize`                                      | `POST /sessions {id, cwd, agent}`                             | n/a     |
| Hermes      | `on_pre_compress(messages)`                       | `POST /summary {summary, final:false}`                        | false   |
| Hermes      | `on_session_switch(new_id, parent_id)`            | `POST /end old + POST /sessions new`                          | n/a     |
| Hermes      | `on_session_end(messages)`                        | `POST /end {summary, title, final:false}`                     | false   |
| Any (model) | `memory.session_summary({summary, title?})` (MCP) | internal write (no HTTP) with `final:true`                    | true    |

The Claude Code `Stop` hook SHALL NOT be wired in `apps/plugin/hooks/hooks.json`. The Claude Code `pre-compact.sh` script SHALL NOT exist. The Codex `pre-compact.sh` reference in `hooks.codex.json` SHALL be removed (there is no equivalent event in Codex).

#### Scenario: Claude Code hooks.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for `SessionStart` (with two matcher groups — one for `startup|resume|clear`, one for `compact`), `UserPromptSubmit`, and `SessionEnd`
- **AND** the `hooks` object SHALL NOT contain a `Stop` entry
- **AND** the `hooks` object SHALL NOT contain a `PreCompact` entry

#### Scenario: Codex hooks.codex.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for `SessionStart`, `UserPromptSubmit`, and `Stop`
- **AND** the `hooks` object SHALL NOT contain a `PreCompact` entry
- **AND** the `Stop` script SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout — plain text is invalid per docs)

#### Scenario: Hermes plugin.yaml declares the lifecycle methods

- **WHEN** `apps/plugin/.hermes-plugin/plugin.yaml` is loaded
- **THEN** the `hooks` array SHALL contain `on_pre_compress`, `on_session_end`, and `on_session_switch`

### Requirement: Plugin-injected protocol nudges MUST surface the summary length cap

The agent-facing protocol nudges injected by the per-client plugins SHALL state the summary length cap inline so the agent budgets for it on the first attempt and does not trip the MCP rejection path. The affected injection sites are:

- `apps/plugin/scripts/post-compact.sh` — Claude Code `SessionStart matcher:"compact"` hook stdout (≤120 tokens budget). The protocol block listed for the agent SHALL include the cap on the `summary` field.
- `apps/plugin/.hermes-plugin/__init__.py` — Hermes provider's system-message injection (around line 313). The session-close protocol sentence SHALL include the cap.
- `apps/plugin/commands/summary.md` — the slash command description SHALL mention the cap so users invoking `/rembric:summary` see the budget too.

Each plugin SHALL emit the literal substring `10000` (the current cap value) in the injected text so a test can grep for it and a contributor changing the cap is forced to update every site.

#### Scenario: Claude Code post-compact injection mentions the cap

- **WHEN** `apps/plugin/scripts/post-compact.sh` runs and emits its stdout protocol block
- **THEN** the emitted text SHALL contain the substring `10000`
- **AND** the text SHALL describe the cap as a limit on the `summary` field passed to `memory.session_summary`

#### Scenario: Hermes provider injection mentions the cap

- **WHEN** Hermes loads the rembric plugin and its system-message injection runs
- **THEN** the injected protocol text SHALL contain the substring `10000`

#### Scenario: Slash command description mentions the cap

- **WHEN** a user opens the `/rembric:summary` slash command's description text
- **THEN** the description SHALL contain the substring `10000`
