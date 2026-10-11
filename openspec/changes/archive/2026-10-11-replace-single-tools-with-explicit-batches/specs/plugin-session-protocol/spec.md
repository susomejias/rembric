## MODIFIED Requirements

### Requirement: A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist

A process whose FIRST `POST /api/<slug>/sessions` of its lifetime reports `created: false` attached to a session it did not author. It cannot know whether a curated summary is already stored, and the model driving it cannot see the turns that produced one. It SHALL therefore emit, once, a standalone line directing the model to read the stored summary (`memory.session_get_batch`) before its next curated write.

**What the line buys is the QUALITY of the rewrite AND the part of its safety the server cannot provide.** The server's own protection is preservation by OMISSION and nothing else (`sessions`, "A curated session-summary write MUST be merged section-wise with the stored summary"): a `##` section the write does not carry survives byte-identically, and a curated write carrying no `##` heading at all against a sectioned stored summary is refused outright. That covers the model which forgets a section and the model which collapses the document into one paragraph. It does NOT cover the model which carries a section and puts less under it — that write replaces the section and the previous bytes are retained nowhere.

The line closes exactly that residual: a model can only preserve what it can see, so directing it to read the stored summary first is what turns an in-section rewrite into a condensation instead of a substitution. Its absence is therefore no longer free, and this requirement SHALL NOT claim that it is. It remains a nudge and not a precondition — the server SHALL NOT gate a curated write on a prior read, because a model that never reads still writes a summary worth having for the sections it does carry.

The line SHALL direct `memory.session_get_batch({ ids: [sessionId] })` and consumption of the full `sessions[]` entry before a curated write.

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

1. Read the stored summary (`memory.session_get_batch({ ids: [sessionId] })`) from the full `sessions[]` entry.
2. Write the session's CURRENT COMPLETE state with `memory.session_summary` — what was just read, brought up to date with the surviving window — **and SHALL be told what the write does to the stored value, in terms that are true under the section-wise merge: each `##` section the write carries replaces its stored counterpart, and a section the write omits keeps its stored text. Sending a summary of the window alone therefore replaces every section the window happens to mention and silently leaves the rest stale.**
3. Recall further prior context (`memory.context` / `memory.search`) when what was read is not enough.

The rationale in clause 2 is a correction, not a reword, and the correction is recorded because the previous form is quoted elsewhere. This requirement previously argued "so sending the window alone stores the window alone", which was exactly true of a whole-document replacement and is true after `refine-session-summary-writes` only of a window carrying no `##` heading, or one carrying every stored heading. The obligation is unchanged — the block must state what the write does — and the danger it points at is unchanged in kind but different in shape: the loss is now silent staleness in the sections the window did not mention, rather than wholesale replacement.

The block SHALL NOT ask for a summary of the compacted window, and SHALL NOT ask for "the compact summary shown above". Either framing, combined with a merging write, still produces the loss this contract exists to prevent: the model does as it is told, the sections the window covers become the window, and the sections it does not cover go quietly out of date with nothing marking them.

This block is also the compaction re-arm of the read directive specified in "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist". A compacted context is, for that purpose, a fresh attachment to a pre-existing session, and the injection at the compaction boundary is the earliest point at which the model can act on it — so it carries the directive itself rather than depending on a later reminder firing or on a relaxed first-ensure marker.

Where a client has NO compaction hook, this requirement SHALL NOT cause one to be added. That client's coverage is its always-present protocol block (`mcp-api`, "The `instructions` block MUST state what a curated summary write replaces and what it keeps"), which carries the merge and current-state obligations on every turn but no `memory.session_get_batch` directive. That is a named gap, not a solved problem.

The block SHALL keep every obligation it already carries: the `10000` cap substring and one copy of the text shared by the clients that use it. It SHALL carry the exact canonical Markdown heading directive. **A reworded block SHALL be re-measured against the published ≤700-byte cap in the same commit as the wording**, and the measured value recorded. Measured on the shipped fixture after the merge correction: the `rembric:`-prefixed `postCompact` is **599 bytes** and the unprefixed `postCompactCore` is **590**, against the 683 bytes the direct-replacement wording measured and the 675 the pre-correction fixture measured.

#### Scenario: The block asks for the current whole state, after a read

- **WHEN** the post-compaction injection is emitted
- **THEN** it SHALL direct the model to call `memory.session_get_batch` before writing
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

### Requirement: Every client with a compaction event MUST inject the read-then-rewrite directive, and where no such event exists a thin rewrite MUST be an accepted, partly-unrecoverable loss

**The accepted-risk clause, for a client with no compaction event.** This requirement SHALL NOT cause a client to invent one, and the absence SHALL be recorded as an accepted risk rather than tracked as an open defect:

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

**A stronger tool description is not the remedy, and that is measured too.** `memory.session_summary`'s description already carries the read directive verbatim (`packages/mcp/src/server.ts:326`: `Can't see your earlier work? Call memory.session_get first, then write the whole updated state.`), and the weaker model with no injected block ignored it. Strengthening description text against that result would be speculation; what the datum supports is the injected block.

This finding is scoped to the READ directive specifically: it says a stronger nudge toward `memory.session_get` would not have moved the arm that already ignored the one there. It says nothing about a description obligation the tool did not carry at all — copying concrete facts verbatim instead of paraphrasing them, which finding 3 above (the stronger model losing `50rps` to paraphrase, not omission) targets and which `mcp-api`'s `memory.session_summary` requirement adds as its own, separate fact. That addition is not a repeat of the rejected experiment.

**The matrix.** For each client, the compaction event it exposes and the obligation that follows:

- **Claude Code** and **Codex CLI** — `SessionStart` with the `compact` matcher, whose stdout is injected into the resumed model's context on both hosts. Covered by `apps/plugin/scripts/post-compact.sh`, which already carries the directive.
- **opencode** — `experimental.session.compacting`, whose `output.context` appends reach the post-compaction agent. It SHALL carry the directive; the `opencode-plugin` capability holds that text's contract.
- **Hermes Agent** — `on_pre_compress`, which fires AT the compaction, plus `prefetch()`, whose return is injected every turn and is therefore the first surface the post-compaction agent reads. It SHALL carry the directive, delivered under the four constraints below.
- **Pi** — no compaction event exists. `apps/plugin/.pi-plugin/index.ts` registers `session_start`, `before_agent_start`, `message_end`, `agent_settled` and `session_shutdown`, none of which fires at a compaction, so there is nothing to inject into. Governed by the accepted-risk clause below.

**Hermes's four constraints**, because the obvious implementation is the wrong one in two independent ways:

- **The directive SHALL be armed by the compaction event, NOT by the `remaining_tokens` estimate.** The provider's existing urgent save reminder is armed from `on_turn_start`'s `remaining_tokens` falling below `_COMPACTION_TOKEN_FLOOR` — a prediction that a compaction is coming, which may never be followed by one. This directive is only correct AFTER a compaction, so its trigger SHALL be `on_pre_compress` firing.
- **`on_pre_compress`'s return value SHALL remain the empty string.** Its documented destination is the compressor prompt — the summariser that builds the compacted window, not the agent that continues afterwards. Placing the directive there would instruct the wrong consumer and would shape the window instead of the stored summary, which is the exact confusion this contract exists to remove.
- **It SHALL be emitted once, on the first `prefetch()` after the compaction, as its own line**, independent of every other line that turn's `prefetch()` may carry; none SHALL replace another. The one exception is the resumed-read line: where it and this directive would both be emitted on the same turn, only this directive SHALL be emitted, because it is a strict superset of the read instruction the other carries. The per-turn summary line this clause used to name no longer exists — the stretch-close reminder is server-composed and arrives as the notice (`session-nudges`, "Recall, the session opening and the resumed-read line MUST stay client-composed, and the split MUST be stated") — and naming it here would pin a line no client emits.
- **Its flags SHALL reset on session end and session switch**, matching the provider's existing per-session counters and warned flags.

- The expected outcome on such a client is a THIN post-compaction rewrite — a full-looking summary of the window the model can still see, with earlier detail gone from the stored value. That is the no-block arm measured above, and it is an accepted outcome, not a bug report.
- **The mitigation is the write contract, and it is PARTIAL. This requirement SHALL state the partiality rather than claim recoverability it does not have.** The server retains no copy of replaced text: there is no version history, no journal payload and no restore verb (`sessions`, "A session summary MUST follow the documented structure"). What protects a thin rewrite is preservation by omission (`sessions`, "A curated session-summary write MUST be merged section-wise with the stored summary"), which reaches exactly two of the three shapes this failure takes:
  - A rewrite that OMITS a `##` section costs nothing at all — that section survives byte-identically, whatever the model can no longer see.
  - A rewrite that degenerates into a flat paragraph, carrying no `##` heading against a sectioned stored summary, is REFUSED with `invalid_input`. The worst shape — six sections replaced by one paragraph — therefore cannot land at all, which is a stronger outcome than the version history ever gave (that shape used to be stored, and merely recoverable afterwards by someone who noticed).
  - A rewrite that CARRIES a `##` heading and puts less under it replaces that section outright, and the previous text is gone. **This is the residual, it is accepted knowingly, and no mechanism covers it.** The server SHALL NOT attempt to distinguish a legitimate condensation from a substitution: a correct summary legitimately shrinks, and every guard proposed on that basis has been rejected on that ground.
- No recovery surface SHALL be added for this case, because there is nothing to recover from. In particular this requirement SHALL NOT be satisfied by reintroducing a stored history, and SHALL NOT reference `memory.session_get`'s retired `limit` argument or any operator-facing version list.
- The client's only preventive coverage is its always-present protocol block (`mcp-api`, "The `instructions` block MUST state what a curated summary write replaces and what it keeps"), which Pi reaches by appending the server's `instructions` to the harness system prompt. That block carries the merge, replacement and current-state obligations but no `memory.session_get` directive bound to a compaction moment, and finding 2 above says always-present text of that kind is not sufficient for a weak model. It is a named gap, not a solved problem — and after the retirement of the version history the gap is narrower in scope and sharper in cost: narrower because two of the three shapes are now handled by the write contract, sharper because the one that remains has no undo.
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
