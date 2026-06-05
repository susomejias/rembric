## MODIFIED Requirements

### Requirement: Sessions MUST converge on a non-null summary when the agent cooperates OR the transcript is reachable

Every closed session in the dashboard SHALL display a non-null `summary` whenever ANY of the following held during its lifetime:

- The agent called `memory.session_summary({summary, title?})` at any point.
- The session compacted (Claude Code only) and the model produced a compact summary the post-compact instruction injection could refer to.
- The session reached `SessionEnd` (Claude Code) or successive `Stop` invocations (Codex) with a readable `transcript_path` containing at least one assistant turn.
- The session ran under Hermes Agent (`on_session_end(messages)` with non-empty messages).
- The session ran under opencode and **either** the agent called `memory.session_summary({summary, title?})` voluntarily, **or** opencode's `server.instance.disposed` event fired with a non-empty per-session transcript accumulator. The opencode plugin POSTs `/api/<slug>/sessions/<id>/summary` with `final:false` for every known top-level session at dispose time, populated from the in-memory `sessionMessages` Map fed by `chat.message` and `message.updated` handlers during the session. `status` stays `'active'` until `abandonStale` flips it (the plugin never POSTs `/end`).

A session SHALL be considered to have "converged on a summary" if its `sessions.summary` column is non-null. Coverage in the contrary case (transcript file missing, hook scripts never fired, agent ignored every instruction, Hermes messages list empty, opencode hard-crashed before `server.instance.disposed` could fire) is OUT of scope — these are degenerate states the dashboard surfaces as "no summary captured" without crashing.

Plugin-side fallback writers (bash transcript dump, Hermes `_format_transcript`, opencode dispose-time flush) MAY post bodies up to the HTTP wire upper bound (`summary` ≤20,000 chars at the zod boundary). The server SHALL truncate any body whose `summary.length` exceeds `SUMMARY_MAX_CHARS` (2000) at the HTTP handler before calling the service, by replacing it with `summary.slice(0, SUMMARY_MAX_CHARS - SUFFIX.length) + '…[truncated]'`. Convergence is therefore on a row whose stored `summary` is bounded by `SUMMARY_MAX_CHARS` regardless of what the fallback writer sent. The literal number `19500` that appeared in scenarios in the prior version of this spec was a derived wire-side budget; the spec now references the server cap (`SUMMARY_MAX_CHARS`) abstractly so it does not drift when the cap is changed in a future OpenSpec change.

#### Scenario: Claude Code short session with cooperating agent

- **GIVEN** a Claude Code session of N user prompts (N ≥ 1, no compact)
- **AND** the agent called `memory.session_summary({summary, title})` at any point before stop with `summary.length <= 2000`
- **WHEN** the user closes the session and `SessionEnd` fires
- **THEN** `sessions.summary` SHALL be the model-authored content (preserved because `final:true` blocks the bash overwrite)
- **AND** `sessions.title` SHALL be the model-authored title
- **AND** `sessions.status` SHALL be `'ended'`

#### Scenario: Claude Code short session with non-cooperating agent

- **GIVEN** a Claude Code session of N user prompts (N ≥ 1, no compact)
- **AND** the agent never called `memory.session_summary`
- **WHEN** the user closes the session and `SessionEnd` fires with a non-empty `transcript_path` JSONL
- **THEN** `sessions.summary` SHALL be the bash fallback's formatted transcript (oldest-first, role: content) truncated server-side to at most `SUMMARY_MAX_CHARS` (2000) chars, with the suffix `…[truncated]` when truncation fired
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
- **AND** the server SHALL truncate any body exceeding `SUMMARY_MAX_CHARS` (2000) before storing
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
- **AND** the server SHALL truncate `summary` to `SUMMARY_MAX_CHARS` (2000) chars with the suffix `…[truncated]` when the wire body exceeded the cap
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
- **AND** the next agent (post-compaction) reads that reminder and calls `memory.session_summary({summary: <compacted summary content>, title})` with `summary.length <= 2000`
- **AND** the resulting row in `sessions` has the compacted summary as `summary` and a non-null `title`

## ADDED Requirements

### Requirement: Plugin-injected protocol nudges MUST surface the summary length cap

The agent-facing protocol nudges injected by the per-client plugins SHALL state the summary length cap inline so the agent budgets for it on the first attempt and does not trip the MCP rejection path. The affected injection sites are:

- `apps/plugin/scripts/post-compact.sh` — Claude Code `SessionStart matcher:"compact"` hook stdout (≤120 tokens budget). The protocol block listed for the agent SHALL include the cap on the `summary` field.
- `apps/plugin/.hermes-plugin/__init__.py` — Hermes provider's system-message injection (around line 313). The session-close protocol sentence SHALL include the cap.
- `apps/plugin/commands/summary.md` — the slash command description SHALL mention the cap so users invoking `/rembric:summary` see the budget too.

Each plugin SHALL emit the literal substring `2000` (the cap value) in the injected text so a test can grep for it and a contributor changing the cap is forced to update every site.

#### Scenario: Claude Code post-compact injection mentions the cap

- **WHEN** `apps/plugin/scripts/post-compact.sh` runs and emits its stdout protocol block
- **THEN** the emitted text SHALL contain the substring `2000`
- **AND** the text SHALL describe the cap as a limit on the `summary` field passed to `memory.session_summary`

#### Scenario: Hermes provider injection mentions the cap

- **WHEN** Hermes loads the rembric plugin and its system-message injection runs
- **THEN** the injected protocol text SHALL contain the substring `2000`

#### Scenario: Slash command description mentions the cap

- **WHEN** a user opens the `/rembric:summary` slash command's description text
- **THEN** the description SHALL contain the substring `2000`
