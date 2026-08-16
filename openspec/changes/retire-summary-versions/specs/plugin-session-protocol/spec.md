## RENAMED Requirements

- FROM: `### Requirement: Every client with a compaction event MUST inject the read-then-rewrite directive, and where no such event exists the version history MUST be the accepted mitigation`
- TO: `### Requirement: Every client with a compaction event MUST inject the read-then-rewrite directive, and where no such event exists a thin rewrite MUST be an accepted, partly-unrecoverable loss`

## MODIFIED Requirements

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
- **AND** every `##` section the rewrite did not carry survives byte-identically (`sessions`, "A curated session-summary write MUST be merged section-wise with the stored summary"), so an agent that rewrote thinly costs only the sections it actually rewrote
- **AND** where the rewrite DOES carry a section, the text it replaced is gone — no version row, no history, no restore — which is why the cooperating agent's `memory.session_get` read is what makes the rewrite a condensation rather than a substitution

#### Scenario: Claude Code session ends with a torn trailing transcript line

- **GIVEN** a Claude Code session whose transcript JSONL's final line was torn mid-write (a `Stop` hook race or a crash), while every earlier line is well-formed JSON containing at least one assistant turn
- **AND** the agent never called `memory.session_summary`
- **WHEN** the user closes the session and `SessionEnd` fires with that transcript's path
- **THEN** `sessions.summary` SHALL contain every well-formed line before the torn one (oldest-first, role: content)
- **AND** `sessions.summary` SHALL NOT be `NULL` or empty — the torn line degrades the summary by at most itself, it does not discard the lines that parsed successfully before it

### Requirement: A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist

A process whose FIRST `POST /api/<slug>/sessions` of its lifetime reports `created: false` attached to a session it did not author. It cannot know whether a curated summary is already stored, and the model driving it cannot see the turns that produced one. It SHALL therefore emit, once, a standalone line directing the model to read the stored summary (`memory.session_get`) before its next curated write.

**What the line buys is the QUALITY of the rewrite AND the part of its safety the server cannot provide.** The server's own protection is preservation by OMISSION and nothing else (`sessions`, "A curated session-summary write MUST be merged section-wise with the stored summary"): a `##` section the write does not carry survives byte-identically, and a curated write carrying no `##` heading at all against a sectioned stored summary is refused outright. That covers the model which forgets a section and the model which collapses the document into one paragraph. It does NOT cover the model which carries a section and puts less under it — that write replaces the section and the previous bytes are retained nowhere.

The line closes exactly that residual: a model can only preserve what it can see, so directing it to read the stored summary first is what turns an in-section rewrite into a condensation instead of a substitution. Its absence is therefore no longer free, and this requirement SHALL NOT claim that it is. It remains a nudge and not a precondition — the server SHALL NOT gate a curated write on a prior read, because a model that never reads still writes a summary worth having for the sections it does carry.

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

### Requirement: Every client with a compaction event MUST inject the read-then-rewrite directive, and where no such event exists a thin rewrite MUST be an accepted, partly-unrecoverable loss

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
- **The mitigation is the write contract, and it is PARTIAL. This requirement SHALL state the partiality rather than claim recoverability it does not have.** The server retains no copy of replaced text: there is no version history, no journal payload and no restore verb (`sessions`, "A session summary MUST follow the documented structure"). What protects a thin rewrite is preservation by omission (`sessions`, "A curated session-summary write MUST be merged section-wise with the stored summary"), which reaches exactly two of the three shapes this failure takes:
  - A rewrite that OMITS a `##` section costs nothing at all — that section survives byte-identically, whatever the model can no longer see.
  - A rewrite that degenerates into a flat paragraph, carrying no `##` heading against a sectioned stored summary, is REFUSED with `invalid_input`. The worst shape — six sections replaced by one paragraph — therefore cannot land at all, which is a stronger outcome than the version history ever gave (that shape used to be stored, and merely recoverable afterwards by someone who noticed).
  - A rewrite that CARRIES a `##` heading and puts less under it replaces that section outright, and the previous text is gone. **This is the residual, it is accepted knowingly, and no mechanism covers it.** The server SHALL NOT attempt to distinguish a legitimate condensation from a substitution: a correct summary legitimately shrinks, and every guard proposed on that basis has been rejected on that ground.
- No recovery surface SHALL be added for this case, because there is nothing to recover from. In particular this requirement SHALL NOT be satisfied by reintroducing a stored history, and SHALL NOT reference `memory.session_get`'s retired `limit` argument or any operator-facing version list.
- The client's only preventive coverage is its always-present protocol block ("The `instructions` block MUST state that a curated summary write replaces the stored value"), which Pi reaches by appending the server's `instructions` to the harness system prompt. That block carries the merge, replacement and current-state obligations but no `memory.session_get` directive bound to a compaction moment, and finding 2 above says always-present text of that kind is not sufficient for a weak model. It is a named gap, not a solved problem — and after the retirement of the version history the gap is narrower in scope and sharper in cost: narrower because two of the three shapes are now handled by the write contract, sharper because the one that remains has no undo.
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

#### Scenario: A thin post-compaction rewrite that omits sections costs nothing

- **GIVEN** a session on a client with no compaction event, storing a curated six-section summary
- **WHEN** a post-compaction model writes only the two `##` sections covering the window it can still see
- **THEN** the other four sections SHALL survive byte-identically in `sessions.summary`
- **AND** no additional client-side or server-side mechanism SHALL be required for that preservation

#### Scenario: A thin post-compaction rewrite that collapses into one paragraph is refused

- **GIVEN** the same session and the same client
- **WHEN** a post-compaction model writes a flat paragraph carrying no `##` heading
- **THEN** the call SHALL be rejected with `invalid_input` and `sessions.summary` SHALL be unchanged
- **AND** the worst shape of this failure SHALL therefore be unreachable rather than merely recoverable

#### Scenario: A thin post-compaction rewrite that fills a section thinly is an accepted, unrecoverable loss

- **GIVEN** the same session, whose `## Accomplished` section holds several hundred characters of detail
- **WHEN** a post-compaction model writes a `## Accomplished` section of one line
- **THEN** `sessions.summary` SHALL carry the one-line section
- **AND** the replaced text SHALL NOT be readable from any server surface — no version, no history, no restore
- **AND** this SHALL be recorded as an accepted risk of the client's missing compaction event, not as a defect against this requirement

### Requirement: The summary reminder MUST be delivered at the end of the turn, and MUST NOT re-enter once the host has continued the turn to satisfy it

A reminder that a session owes a summary SHALL be delivered at the END of a turn as well as at its start. A reminder attached only to the start of a turn always arrives while there is more work to do, so it is advice about future behaviour; the end of the turn is the point at which the work of that turn is finished and the model can still act on it.

The reminder SHALL be delivered on the host's end-of-turn feedback channel (`hookSpecificOutput.additionalContext` on the shell clients) and SHALL NOT use the host's blocking decision: no `decision` key and no stop reason.

That channel is NOT, however, a channel that leaves the turn alone, and the previously-published claim that it "cannot hold a turn open" was never measured. Measured against the shipped Claude Code host (2.1.232): the `Stop` runner appends this hook's `additionalContext` to the very array it returns as `blockingErrors`, and the query loop treats a non-empty array as a block — it appends those messages, sets the stop event's loop-guard flag, increments its consecutive-block counter and re-invokes the model. The host's own cap on that counter SHALL NOT be relied on as a bound: it counts CONSECUTIVE blocks only and a continuation the model answers with a tool call resets it, so a model that obeys this very reminder (which asks for a tool call) loops without limit — measured end-to-end on that host, an unguarded reminder re-fired on 141 consecutive continuations over 10 minutes and the cap never engaged. Whether an earlier host delivered this channel without continuing the turn is undetermined and SHALL NOT be asserted.

**The reminder SHALL therefore cost at most ONE host continuation per cadence point.** Whenever the host reports that the stop event is already being continued in order to satisfy this hook — the `stop_hook_active` boolean carried in the stop event's own input, which both shell hosts send under that same name (measured on Claude Code 2.1.232; documented for Codex as "Whether this turn was already continued by `Stop`") — the hook SHALL emit nothing at all: no reminder, no facts, no diagnostic, and an empty JSON object only where the host requires one. That silence SHALL NOT depend on the cadence, on the transcript, or on configuration, all of which are unchanged by a continuation and therefore cannot bound the loop themselves: the turn counter advances only on a user prompt, and a continuation submits none. A memory server is an optional accessory to its host and MUST NOT be able to hold an agent's turn open; honouring the host's own loop guard is what makes that true, and on this channel it is the only thing that does.

The flag SHALL be read from the stop event's input alone, and SHALL be decided BEFORE the transcript is located or parsed, so that a continuation costs process start and nothing else — measured as hook wall-clock per invocation on an 8.36 MB transcript: 790 ms of synchronous parsing without the guard versus 5 ms with it, on a path the host waits for. An absent, `null` or unreadable flag SHALL be treated as `false` — this one fail-open points toward FIRING, unlike every other fail-open in this requirement, because treating an unknown flag as `true` would silence the reminder permanently on any host that does not send it. The flag SHALL NOT be inferred from any other source, and in particular SHALL NOT be reconstructed from the transcript.

The host's end-of-turn event SHALL therefore carry TWO independent entries with different obligations:

- The existing raw-sync entry SHALL remain asynchronous. It is a pure side effect and SHALL NOT delay the turn.
- A second entry SHALL be synchronous, because an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback to the turn at all. Wiring the reminder asynchronously forfeits it entirely.

**The reminder SHALL be rate-limited by the same per-session turn counter the start-of-turn nudge already uses, at the same cadence.** It SHALL NOT fire on every turn. The end-of-turn event fires once per turn, not once per session, so an unthrottled reminder would inject its payload into every turn of a long session — and the repository already owns exactly one mechanism for "remind every N turns". A second, independently-tuned cadence would be a second thing to keep in step with the first.

When the reminder fires, its payload SHALL carry the canonical summary structure in full (see `sessions`) AND the grounded facts extracted from the session, so the model summarises against evidence rather than recollection. This is the surface that carries the long form precisely because it has no length budget, unlike a tool description.

Because it is also the surface a model reads immediately before writing, the payload SHALL state that the write replaces the stored summary and SHALL ask for the session's current complete state, current first.

The entry SHALL NOT fire when the session has produced nothing worth summarising — a turn that only read or only talked. "Produced nothing" SHALL be decided from the session's own transcript, not from the server: no files written or edited and no commands run.

**Apart from the loop guard above, that is the ONLY licensed silence, alongside the fail-open cases below.** The reminder SHALL NOT be suppressed because the session already carries a curated summary, and SHALL NOT derive that state from anywhere — not from the server, and not by scanning the transcript for a completed summary tool call. Suppressing it freezes whatever the first write said, because nothing afterwards ever asks the model to improve it, and it is exactly what makes a premature first summary permanent.

The rule stands on an ASYMMETRY of cost rather than on a guarantee, and SHALL be read that way. A redundant reminder is bounded: the write it prompts composes with what is stored, so every `##` section that write omits survives byte-identically and a write carrying no heading at all is refused (`sessions`, "A curated session-summary write MUST be merged section-wise with the stored summary"). Suppression is unbounded: a premature first summary becomes the permanent one, with nothing that ever asks for better. This requirement SHALL NOT claim that a redundant reminder cannot cost stored text — a prompted write that fills a section more thinly than it found it replaces that section with no copy retained, which is the accepted residual recorded in `sessions`, "A session summary MUST follow the documented structure". The bounded cost is still the smaller of the two, which is why the reminder fires.

It SHALL NOT be required to know whether a curated summary already exists, and SHALL NOT make a request to find out. No read endpoint for a session exists — the HTTP surface offers only `POST .../summary` and `POST .../end` — so the reminder is cadence-gated and may fire on a session that has already been summarised. That is deliberate under-precision: the cost is one redundant reminder every N turns, and the alternative is new HTTP surface. A follow-up MAY add a read endpoint and narrow this; until it does, no requirement here SHALL assert the reminder consults server state.

That sentence is about the CLIENT. A model directed to read the stored summary before rewriting it (see "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist") calls the `memory.session_get` MCP tool itself; the client still asks the server nothing beyond the session-ensure it already makes.

**Fail-open is absolute.** On unparseable input, an unreadable or absent turn counter, a missing or unreadable transcript, an unavailable parser, or any unexpected error, the entry SHALL exit successfully and produce no output. Where a host requires a JSON object on every invocation, it SHALL emit an empty one rather than nothing. The failure mode of a missed reminder is a thinner summary; there SHALL be no failure mode in which the host is degraded.

#### Scenario: The reminder fires at the counter's cadence when a summary is owed

- **GIVEN** a session that has written or edited a file, or run a command, on a turn at which the shared counter's cadence fires
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL emit the host's end-of-turn feedback channel carrying the canonical structure and the extracted facts
- **AND** it SHALL NOT emit an interrupting decision — no `decision` key and no stop reason

#### Scenario: The reminder is silent on turns between cadence points

- **GIVEN** the same session on a turn at which the shared counter's cadence does not fire
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL produce no output

#### Scenario: The reminder does not consult the server

- **GIVEN** any session state, including one that already carries a curated summary
- **WHEN** the end-of-turn event fires at a cadence point
- **THEN** the hook SHALL decide from the transcript, the counter and the stop event's own input alone, and SHALL make no request

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

#### Scenario: The reminder yields once the host has continued the turn to satisfy it

- **GIVEN** a session at a cadence point whose transcript would otherwise yield extracted facts, and a configured server
- **WHEN** the end-of-turn event fires with `stop_hook_active: true` in its input
- **THEN** the hook SHALL exit successfully having emitted nothing at all, or exactly `{}` on the client whose host requires a JSON object
- **AND** it SHALL do the same on every further continuation of the same turn, so the host's consecutive-block cap is never reached and no override warning is shown to the user

#### Scenario: An absent or null loop-guard flag still fires the reminder

- **GIVEN** the same session and cadence point
- **WHEN** the end-of-turn event fires with no `stop_hook_active` key in its input, or with that key set to `null`
- **THEN** the reminder SHALL be emitted exactly as it is when the flag is `false`
- **AND** the control SHALL pass in the same run: the identical input with `stop_hook_active: true` SHALL emit nothing, so a passing guard test cannot be a broken probe

#### Scenario: The loop guard is decided before the transcript is touched

- **WHEN** the end-of-turn script is inspected
- **THEN** the loop-guard check SHALL appear before the transcript path is resolved and before any transcript-parsing call
- **AND** a test SHALL assert that order, so a later edit cannot move the guard behind the parse the host waits on
