# session-nudges Specification

## Purpose

Owns the one periodic, model-facing reminder in this system: the stretch-close notice that tells a model its stored session summary has gone stale, and the server-side gate that decides when to send it.

The decision used to be a turn counter, duplicated across five constants and three counter mechanisms, and a turn counter correlates with nothing — turn 20 does not say whether anything happened. Measured on the pre-change tree, a twenty-turn conversation that invoked no tool at all still received five reminders (1880 bytes), while Codex CLI, whose end-of-turn script had no fact extractor, had never received the reminder at all. This capability replaces that with four timestamps on the session row, one floor constant, and one HTTP endpoint: the client reports the turn that just finished and prints whatever it is handed back, and the server owns every judgement about cadence and wording.

Three things follow and are the shape of everything below. **Five-client symmetry is a requirement rather than an aspiration** — one implementation composes the notice, so byte-identity across Claude Code, Codex CLI, Hermes, opencode and Pi is structural instead of a cross-language fixture assertion. **The client reports an observation, never an interpretation** — a boolean naming whether the host showed it a tool invocation, because a turn that edited eight files without calling a Rembric tool is, to the server, indistinguishable from a turn of conversation. And **what stays local stays local for a stated reason**: the recall line needs the prompt, the session opening exists for the one-turn session, and the resumed-read line fires before any floor can elapse.

The columns themselves, their nullability and which of them are monotone belong to `sessions`; the endpoint's auth, body schema and response shape belong to `http-api`; each client's own observation source and print surface belong to that client's capability. This capability owns the gate, the notice, and the boundary between the two halves.

## Requirements

### Requirement: Every client MUST report each finished turn to the server and print what it is handed back

The five bundled clients SHALL behave identically in the core of this capability: each SHALL report the turn that has just finished, SHALL cache whatever lines the server returns, and SHALL print them at the start of its next turn. A client SHALL hold no cadence, no turn counter and no reminder text for this purpose.

**The report is at the END of the turn.** Issuing it at the start would put an HTTP round trip on the path where the user has just submitted a prompt, and would report a turn that has not happened yet. **The print is at the START of the next turn**, from the cache, so the notice costs no request on the latency-critical path.

The report SHALL carry a boolean naming what the CLIENT OBSERVED — whether at least one tool was invoked during the turn — rather than an interpretation of it. The server owns the interpretation; separating them is what allows the interpretation to change without touching five clients.

**The turn body retains `{usedTools}` (+`title` once) exactly as today.** The proactive recall hints are delivered via a separate synchronous endpoint (`POST /sessions/:id/recall-hints`) called at turn START, not via a `prompt` field on the turn body. The turn body SHALL NOT gain a `prompt` field; the prompt is sent to the hints endpoint instead.

**A client that cannot observe tool invocation SHALL report `true`, and its inability SHALL be recorded in that client's own capability.** Reporting `false` on an unobservable client silently disables the reminder there, which is the asymmetry this requirement exists to remove; reporting `true` costs at most one notice per floor on a session with no work. The per-client observation source SHALL be named in each client's capability, together with the grade of the evidence behind it — an executed run, a host declaration, or neither — so a reader can tell a measured source from an inferred one without re-deriving it. A source graded below an executed run SHALL carry the fail-open branch above, and its verification SHALL be an obligation of the change that introduces it rather than a note for a later one.

The report MAY carry an optional `title`, sent at most once per session, so that the provisional label a client used to derive from its per-turn transcript sync still lands. Where sent, it SHALL be the session's FIRST user prompt, truncated to 100 characters and `<private>`-redacted before it leaves the client, and it SHALL be written under the existing `final: false` precedence so any later model-authored title replaces it.

**A report that returns no lines SHALL NOT clear a non-empty cache.** A second report for the same turn — a host continuation triggered by an unrelated handler — would otherwise overwrite a pending notice with nothing.

Each client's report SHALL be issued at most once per turn. Where a host can re-enter the end-of-turn event within one turn, the client SHALL use the host's own re-entry signal to suppress the repeat rather than deduplicate downstream.

#### Scenario: The notice is printed one turn after the work that earned it

- **GIVEN** any of the five clients on a turn that used tools, where the gate's conditions are all satisfied
- **WHEN** the turn ends and the client reports it
- **THEN** the response SHALL carry the notice lines
- **AND** the client SHALL print nothing at that moment
- **AND** the client SHALL print exactly those lines at the start of its next turn, before the model responds

#### Scenario: A client cannot observe tool use and says so

- **GIVEN** a client whose host exposes no per-turn tool signal
- **WHEN** it reports a turn
- **THEN** it SHALL send `usedTools: true`
- **AND** its own capability SHALL name the absent signal, so the fail-open is a recorded gap rather than an undocumented default

#### Scenario: A second report inside one turn does not lose a pending notice

- **GIVEN** a client holding cached notice lines that have not yet been printed
- **WHEN** the end-of-turn event fires a second time within the same turn and the server returns no lines
- **THEN** the cached lines SHALL survive
- **AND** they SHALL be printed at the start of the next turn

#### Scenario: The provisional title is sent once

- **GIVEN** a session whose first turn has just ended
- **WHEN** the client reports it
- **THEN** the report MAY carry `title` equal to the first user prompt, ≤100 characters, with every `<private>` span replaced
- **AND** no later report in the same session SHALL carry `title`

#### Scenario: Five clients, one behaviour

- **WHEN** each of the five bundled clients is driven through a turn that used tools at a moment the gate fires
- **THEN** each SHALL issue exactly one report at the end of that turn
- **AND** each SHALL print the server's lines at the start of the next turn
- **AND** the printed text SHALL be byte-identical across the five, modulo the host wrapper each uses to inject context

#### Scenario: Recall hints arrive at turn start, not via the turn channel

- **GIVEN** a client whose prompt mentions an entity with matching memories
- **WHEN** the client calls the recall-hints endpoint at turn START
- **THEN** the response SHALL contain entity recall lines
- **AND** the client SHALL merge these lines into the model's context before the model responds
- **AND** the turn channel (`POST /sessions/:id/turn`) at turn END SHALL NOT carry entity recall lines

#### Scenario: The turn body does not carry a prompt field

- **WHEN** a client reports a turn via `POST /sessions/:id/turn`
- **THEN** the body SHALL contain only `{usedTools}` (and optionally `title`)
- **AND** the body SHALL NOT contain a `prompt` field

### Requirement: The notice MUST carry an inventory of what is stored, worded so its sizes cannot read as targets

When the gate fires, the server SHALL compose the notice and SHALL return it as a list of lines. The client SHALL print those lines verbatim and SHALL NOT compose, edit, reorder or supplement them.

The notice SHALL carry three things:

1. **The directive** — refresh the stored summary with `memory.session_summary`; send ONLY the `##` sections that changed, because a section the write omits keeps its stored text; a partial write is the expected shape rather than a degraded one. The merge semantics are stated by reference to the contract `sessions` already publishes ("A curated session-summary write MUST be merged section-wise with the stored summary") and SHALL NOT be restated in terms that could diverge from it.
2. **Explicit permission not to call.** The notice SHALL state that a model with nothing to add should not call the tool. Without it a periodic reminder manufactures vacuous writes, which is the failure the existing work-conditioned phrasing was calibrated against.
3. **The inventory** — the session's live `title`, then each stored `##` heading with the CURRENT size of its body, closed with the total against the cap.

**The inventory's wording is contract text, not presentation.** A size rendered as a bare parenthetical reads as a budget: a draft rendering `Summary for this session (2 412 ch)` was read by a human reviewer as a LIMIT, and a model under length pressure would trim to it. The inventory SHALL therefore be introduced with an explicit statement that the sizes are current values and not targets, and SHALL close by naming both numbers — the characters used and the characters available — so the only figure that reads as a bound is the bound.

Where the session has no stored `##` section, the inventory SHALL be replaced by the canonical section list, interpolated from its single source (`sessions`, "A session summary MUST follow the documented structure") rather than restated, so the notice tells a model with nothing stored what to write.

The composed notice SHALL be bounded at **640 UTF-8 bytes**, and the bound SHALL be enforced by construction rather than by review, because the input is unbounded: the merge contract admits any `##` heading, so a stored summary may carry many sections with long names. The renderer SHALL walk the stored sections in STORED order, SHALL truncate each heading name at 32 characters, and SHALL replace the remainder of the list with a count of the sections not shown as soon as the next entry would exceed the bound. Elision from the TAIL of the stored order is what keeps `## Goal` and `## Accomplished` from ever being the entries dropped, since stored order is the canonical order.

The 640 figure is DERIVED rather than chosen, and the derivation lives in `claude-code-plugin`'s token-budget requirement: the worst reachable start-of-turn combination is the first-prompt line (125 bytes) plus the recall line (90) plus the rendered sessionId line (204) plus this notice plus four newlines, and that combination is what the published per-firing-turn ceiling bounds. Changing the notice's bound therefore requires re-deriving that ceiling in the same commit.

#### Scenario: The inventory names current sizes and the total against the cap

- **WHEN** the notice is composed for a session whose stored summary carries six sections totalling 2412 characters
- **THEN** it SHALL name the live title
- **AND** it SHALL name each stored `##` heading with the current character count of its body
- **AND** it SHALL state that those sizes are current values rather than targets
- **AND** it SHALL close by naming both the characters used and the characters available

#### Scenario: The notice licenses not calling

- **WHEN** the composed notice is inspected
- **THEN** it SHALL state that a model with nothing to add should not call `memory.session_summary`

#### Scenario: A session with nothing stored is told the canonical structure instead

- **GIVEN** a session whose `summary` is `NULL` or carries no `##` heading
- **WHEN** the notice is composed
- **THEN** the inventory SHALL be replaced by the canonical section list
- **AND** that list SHALL come from the single source the canonical-structure requirement names, not from a copy in this module

#### Scenario: A pathological stored summary cannot blow the byte bound

- **GIVEN** a stored summary carrying forty `##` sections whose heading names are 100 characters each
- **WHEN** the notice is composed
- **THEN** the composed notice SHALL be ≤640 UTF-8 bytes
- **AND** heading names SHALL be truncated at 32 characters
- **AND** the sections not shown SHALL be reported as a count
- **AND** the `## Goal` entry SHALL be present, because elision removes entries from the tail of the stored order

#### Scenario: The notice states the merge rule without re-deriving it

- **WHEN** the composed notice is inspected
- **THEN** it SHALL state that the `##` sections the write carries replace their stored counterparts and that a section the write omits keeps its stored text
- **AND** it SHALL NOT ask for a summary of the current turn, of the current context window, or of what changed since the last write

### Requirement: The save reminder MUST be folded into the one notice, and MUST NOT claim to know what is memorable

There SHALL be ONE periodic reminder, not a save reminder and a summary reminder with separate floors. A second floor would reintroduce the second constant this capability exists to remove, and it would buy frequency at the same imprecision: neither the server nor the client can decide what is worth saving.

Prompt saving SHALL remain the obligation of the always-present protocol block (`mcp-api`, the `initialize.instructions` requirement), which already directs the model to save as soon as there is a fix, decision or discovery and which costs nothing per turn because it is already in the prompt.

**As shipped the notice carries no save clause at all, and that is recorded rather than left to be inferred from its absence.** The design took the default of naming the time elapsed since the session last wrote a memory; the composed notice is the directive, the inventory and the closing line and nothing else. The omission is not a byte-budget consequence — measured, a six-section notice is 448 bytes against the 640-byte bound, and the row shape the composer receives carries no last-memory-write timestamp to name. Where the notice addresses saving at all it SHALL do so in terms the server can defend — the time elapsed since the session last wrote a memory — and SHALL NOT assert that something memorable happened; that clause SHALL sit inside the notice's 640-byte bound and SHALL be the first thing the elision rule drops. Adding it is a change of its own, not a licence this requirement already grants.

#### Scenario: One reminder, one floor

- **WHEN** the server's nudge module is inspected
- **THEN** it SHALL expose exactly one floor constant
- **AND** no code path SHALL emit a save-only reminder on a cadence of its own

#### Scenario: The notice claims nothing about what was worth saving

- **GIVEN** a session that has attached no memory for longer than the floor
- **WHEN** the notice is composed
- **THEN** it SHALL NOT assert that the session produced something worth saving
- **AND** any save clause it carries SHALL name the elapsed time rather than a judgement about content

### Requirement: Recall, the session opening and the resumed-read line MUST stay client-composed, and the split MUST be stated

Moving the stretch-close reminder to the server does not remove the client's local rules; it moves one of them. The boundary SHALL be published rather than left to be inferred from code, and it is:

- **Server-composed:** the stretch-close notice (delivered via the turn channel at turn END, printed at next turn START).
- **Server-composed:** entity recall hints (delivered via the recall-hints endpoint at turn START, merged into the model's context immediately).
- **Client-composed:** the recall line (keyword regex), the session opening, and the resumed-read line.

Each local line stays local for a reason that is a property of the mechanism, not a matter of convenience:

- **Recall** is a regular expression over the user's prompt, and fires at the START of the current turn — the same moment the prompt arrives — while entity recall hints are fetched synchronously at the same moment via the hints endpoint. The two are complementary: the keyword regex catches explicit recall intent; entity recall catches implicit relevance. Both fire at turn START and neither subsumes the other.
- **The session opening** is gated on the `created` flag the session-ensure already returns, and it exists for the ONE-TURN session. The notice is a turn behind by construction, so a session that ends after a single turn would otherwise receive nothing at all.
- **The resumed-read line** is gated on the same `created` flag and fires before any floor can elapse. Its purpose partly overlaps the notice's inventory, which also tells a model that something is stored; the overlap is recorded and deliberately not resolved, because the two fire at different moments.

#### Scenario: The recall line is still emitted with the server unreachable

- **GIVEN** a client whose server is unreachable
- **WHEN** the user submits a prompt matching the recall keywords
- **THEN** the recall line SHALL still be emitted
- **AND** no notice SHALL be emitted, because none could be fetched
- **AND** no entity recall hints SHALL be available, because the hints endpoint is unreachable

#### Scenario: No client composes stretch-close text of its own

- **WHEN** every client's source is inspected at HEAD
- **THEN** none SHALL declare a string directing the model to refresh the session summary on a cadence
- **AND** the only cadence-driven reminder text in the repository SHALL be the server's

#### Scenario: Entity recall hints and keyword recall fire at the same moment

- **GIVEN** a turn whose prompt matches the recall keywords AND mentions an entity with matching memories
- **WHEN** the client prints the start-of-turn lines and fetches hints
- **THEN** the keyword recall line SHALL be emitted (client-composed, on this turn)
- **AND** the entity recall hints SHALL be merged into the model's context (server-computed, fetched synchronously at turn START)
- **AND** both SHALL be visible to the model from the first token of its response

### Requirement: The session opening MUST ask for a title and `## Goal` before the turn ends, on every client

Every client SHALL emit, exactly once per session and only on a session the server reports as newly created, a line directing the model to call `memory.session_summary` with a title and a single `## Goal` section, leaving the other five canonical headings out.

Sending one section is a legitimate write only because a `##` section absent from a curated write keeps its stored text (`sessions`, "A curated session-summary write MUST be merged section-wise with the stored summary"). Before that contract this instruction would have asked the model to store a one-section document in place of everything.

**The line SHALL say "before you finish this turn", and SHALL NOT say "now".** A reminder that fires at the start of turn 1 and asks for an immediate write produces a summary of a session that has not happened; deferring it to the close of the turn makes the model do the user's work first and write what it actually did. This wording is the difference between the turn-1 firing being protocol and it being noise, and it SHALL NOT be softened to a generic "at the end of the session", which no host event delivers reliably.

The line SHALL be sourced from the shared cross-language fixture contract, byte-identical across clients on the same discipline every remaining client-composed line follows.

#### Scenario: The opening fires once, on a new session only

- **GIVEN** a client whose first session-ensure of the process reported `created: true`
- **WHEN** the first turn begins
- **THEN** the opening line SHALL be emitted
- **AND** it SHALL NOT be emitted again in that session

#### Scenario: A resumed session gets no opening

- **GIVEN** a client whose first session-ensure of the process reported `created: false`
- **WHEN** the first turn begins
- **THEN** the opening line SHALL NOT be emitted

#### Scenario: The opening defers the write to the end of the turn

- **WHEN** the opening line is inspected
- **THEN** it SHALL direct the model to write before it finishes the turn
- **AND** it SHALL NOT direct the model to write immediately or before answering the user
- **AND** it SHALL name `## Goal` and SHALL state that the other five headings are left out

### Requirement: A server-composed reminder MUST be pinned by a server test, and the retired fixtures MUST leave the cross-language contract

Byte-identity of the stretch-close reminder across five clients SHALL cease to be a cross-language fixture assertion and SHALL become a structural property: there is one implementation, on the server, and every client prints what it is handed.

The `save`, `saveCore`, `summary` and `summaryCore` keys SHALL be removed from `apps/plugin/test/nudge-fixtures.json`, together with the `endOfTurnRubric` key whose surface is deleted. The fixture contract SHALL continue to pin every line that remains client-composed.

Because the notice has no fixture, the per-line byte assertions in `claude-code-plugin` cannot reach it. Its bound SHALL therefore be asserted on the server, against the composed string, at the boundary — a session whose stored summary would render an over-bound inventory SHALL be part of that assertion, not only a representative one.

Each client SHALL carry a test proving it prints the server's lines VERBATIM. Asserting that a client prints "a notice" is not sufficient: the property this requirement buys is that no client can alter the text, and only a verbatim comparison against the response can show it.

#### Scenario: The retired keys are gone and the remaining ones still lock

- **WHEN** `apps/plugin/test/nudge-fixtures.json` is read at HEAD
- **THEN** it SHALL NOT contain `save`, `saveCore`, `summary`, `summaryCore` or `endOfTurnRubric`
- **AND** every remaining agent-facing key SHALL still be asserted byte-identical across the clients that emit it

#### Scenario: The notice bound is asserted at the boundary, not on a sample

- **WHEN** the server's notice test runs
- **THEN** it SHALL include a case whose stored summary forces elision
- **AND** it SHALL assert the composed length against the 640-byte bound in UTF-8

#### Scenario: A client that edits the server's lines fails its own test

- **GIVEN** a client that appends its own sentence to the returned lines before printing
- **WHEN** that client's test suite runs
- **THEN** the verbatim comparison SHALL fail and name the client

### Requirement: The session-summary reminder MUST use completed activity and a minimum interval, never a turn counter

The server SHALL evaluate reminder eligibility on each completed-turn report for an active session, including `usedTools:false` conversational reports. Clients SHALL NOT decide cadence or memorability. A row without an incoming completed report SHALL NOT independently cause emission.

The four nullable persisted timestamps SHALL retain distinct meanings:

- `last_turn_report_at`: written only by active turn reports, on every report regardless of `usedTools`, with the current instant and without a forward clamp. The incoming report SHALL first capture `activityStartedAt = existing.last_turn_report_at ?? started_at`, before advancing this column. This ephemeral value is the activity anchor, not a new column.
- `last_work_at`: monotone tool-observation timestamp, advanced only on `usedTools:true`, to the later of its existing value and the captured activity anchor. `usedTools:false` SHALL leave it untouched. It SHALL NOT decide conversational reminder eligibility.
- `last_summary_at`: monotone timestamp written at the shared final-precedence write site only when a `summary` carrying `final:true` is actually stored. Neither RAW `final:false` writes nor precedence-discarded writes SHALL advance it.
- `last_nudge_at`: monotone timestamp advanced only when the server returns notice lines.

For the incoming active report, the server SHALL emit if and only if BOTH conditions hold:

1. `last_summary_at IS NULL` OR `activityStartedAt > last_summary_at`.
2. `now - COALESCE(last_nudge_at, started_at) >= NUDGE_FLOOR_MS`.

The pure gate SHALL receive the captured activity anchor explicitly under an activity-named input, not relabel it as tool work. The comparison SHALL be strict: equality suppresses. The server SHALL NOT use `last_activity_at` or report arrival as the activity anchor. Both can follow a mid-turn curated write because of transcript sync or other mutations and would incorrectly remind the complying turn.

`NUDGE_FLOOR_MS` SHALL remain one exported constant, 25 minutes, a minimum interval rather than a periodic timer. At most one notice SHALL be emitted per floor. An ignored notice SHALL NOT repeat before the floor elapses; continued completed conversation after the floor SHALL be eligible even without tools. No client counter, second cadence, model-message analysis, LLM, similarity measure or MCP-volume proxy SHALL govern this gate. Tool observation remains truthful; eligibility does not assert that anything is memorable.

An absent summary timestamp SHALL mean no known curated write; an absent tool-work timestamp SHALL no longer exclude conversation. An absent report timestamp SHALL anchor the first report at `started_at`; an absent nudge timestamp SHALL measure the first floor from `started_at`. Rows SHALL NOT be backfilled or evaluated by a timer. A lost report leaves an earlier anchor and can conservatively suppress a notice; it SHALL NOT be replaced by a fabricated report.

#### Scenario: A session that only converses is eligible without claiming tool work

- **GIVEN** an active session with no curated write whose reports all carry `usedTools:false` over three hours
- **WHEN** a completed report arrives at or after the floor
- **THEN** the server SHALL return notice lines and stamp `last_nudge_at`
- **AND** `last_work_at` SHALL remain NULL throughout
- **AND** reports inside the floor after each emission SHALL return no notice

#### Scenario: Work followed by a summary re-arms on further completed activity

- **GIVEN** a session whose curated summary is at or after the captured activity anchor and whose floor has elapsed
- **WHEN** that report is handled
- **THEN** it SHALL return no notice
- **WHEN** a later completed report has an anchor strictly after that summary and the floor has elapsed
- **THEN** it SHALL return a notice regardless of `usedTools`

#### Scenario: The turn that refreshes the summary does not then remind itself

- **GIVEN** an active session past the floor whose current turn stored a curated summary mid-turn
- **WHEN** the completed report arrives
- **THEN** the captured activity anchor SHALL be no later than `last_summary_at` and no notice SHALL be returned
- **AND** equality SHALL also suppress
- **WHEN** a later completed conversational turn has an anchor after the summary and the floor has elapsed
- **THEN** it SHALL be eligible without tool use

#### Scenario: A notice the model ignores is not repeated inside the floor

- **GIVEN** a session just returned notice lines
- **WHEN** ten further completed reports arrive inside the floor with either `usedTools` value
- **THEN** none SHALL return notice lines
- **AND** each SHALL still advance `last_turn_report_at`

#### Scenario: The first notice of a session cannot fire before one floor has elapsed

- **GIVEN** an uncurated session with no prior notice
- **WHEN** its completed report arrives at `started_at + NUDGE_FLOOR_MS - 1`
- **THEN** it SHALL return no notice
- **WHEN** a report arrives at `started_at + NUDGE_FLOOR_MS`
- **THEN** it SHALL return a notice, including with `usedTools:false`

#### Scenario: A pre-existing session upgraded into this capability starts silent

- **GIVEN** a pre-existing row whose observation timestamps are NULL
- **WHEN** no completed report arrives
- **THEN** no notice SHALL be emitted
- **WHEN** its first completed report arrives after the floor without a known curated timestamp
- **THEN** it SHALL be eligible using `started_at`, without rewriting historical summary content

#### Scenario: A `final: false` write does not count as a summary

- **GIVEN** an active session past the floor
- **WHEN** a RAW transcript is stored with `final:false` and its completed report arrives
- **THEN** `last_summary_at` SHALL remain unchanged
- **AND** the RAW write alone SHALL NOT suppress conversational eligibility

#### Scenario: A raw transcript write between the curated one and the report does not re-arm the gate

- **GIVEN** an active session past the floor whose current turn stored a curated summary
- **WHEN** its RAW sync advances `last_activity_at` after that curated write and the completed report arrives
- **THEN** the gate SHALL use the captured previous-report anchor, not `last_activity_at`
- **AND** no notice SHALL be returned
- **AND** the same timeline without the curated write SHALL return a notice when the floor permits
