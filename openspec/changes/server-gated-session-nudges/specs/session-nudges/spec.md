## ADDED Requirements

### Requirement: The session-summary reminder MUST be gated on the server by three timestamps, never by a turn counter

The decision to remind a model to refresh its session summary SHALL be taken by the server, from state on the session row, and SHALL NOT be taken by any client from a turn count. A turn count does not answer the question the reminder exists to ask — whether anything has happened since the summary was last written — and no client can answer it either, because no client knows when the stored summary was last written.

`sessions` SHALL carry four nullable timestamps, whose write rules are normative and whose meanings SHALL NOT be conflated with `last_activity_at`:

- **`last_turn_report_at`** — the moment the most recent turn report arrived. Written by the turn report and by NOTHING else, on every report regardless of `usedTools`. It exists so that `last_work_at` below has an anchor with a single writer; a column many paths write cannot answer "when did this turn begin".
- **`last_work_at`** — the START of the most recent turn a client reported as having used a tool, which is the row's `last_turn_report_at` as it stood BEFORE that report advanced it (`started_at` where it is NULL, i.e. on the session's first report). Set only by the turn report ("Every client MUST report each finished turn to the server and print what it is handed back"), and only when that report carries `usedTools: true`. **It SHALL NOT be stamped with the moment the report arrives.** The report is issued at the END of the turn, while a curated `memory.session_summary` written during that turn stamps `last_summary_at` MID-turn — and is itself an MCP call the client observes as tool use — so stamping `now` would make condition (2) below true forever after the first curated write, degrading the gate into a bare `NUDGE_FLOOR_MS` timer that fires on conversation-only turns too.

  **`last_activity_at` SHALL NOT be used as that anchor**, notwithstanding that it, too, sits on the row and is nominally "the turn's start". It is advanced by the per-turn transcript sync (which advances it even on a write precedence discards) and by `memory.save`, `memory.confirm`, `memory.save_prompt` and `memory.capture_passive` — so on a client that posts the raw transcript and then the report within one turn, as the Hermes provider does sequentially on every turn, it reads LATER than the mid-turn curated write and the notice fires on exactly the turn that complied. A dedicated column with one writer is immune to that by construction, and its failure mode is the safe direction: a report lost to an interrupted turn leaves the anchor further back, which suppresses more, never less.
- **`last_summary_at`** — the moment the session's curated summary was last STORED. Set by the same single site that folds per-field `final` precedence into an update `set`, on exactly those writes that store a `summary` carrying `final: true` (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction", **One site**). It SHALL NOT be set by a `final: false` write and SHALL NOT be set by a write precedence discards.
- **`last_nudge_at`** — the moment the notice was last emitted to a client. Set when, and only when, the server returns notice lines in a turn-report response.

The notice SHALL be emitted for a turn report when ALL THREE hold:

1. `last_work_at IS NOT NULL`,
2. `last_summary_at IS NULL` OR `last_work_at > last_summary_at`,
3. `now - COALESCE(last_nudge_at, started_at) >= NUDGE_FLOOR_MS`.

Condition (2)'s comparison is STRICT, and that is load-bearing rather than incidental: the curated write is normally the last activity of the turn that made it, so the state such a turn produces is `last_work_at == last_summary_at`, and a `>=` there would fire on exactly the turn that just complied.

The NULL readings are normative rather than incidental, because they decide the first firing of every session: an absent `last_summary_at` means "never written" and satisfies (2); an absent `last_work_at` means "no work has been reported" and fails (1), so a session that only converses is never reminded; an absent `last_nudge_at` measures the floor from `started_at`, so the earliest a notice can fire is one floor after the session began.

`NUDGE_FLOOR_MS` SHALL be a single exported constant and SHALL be a MINIMUM INTERVAL rather than a period: condition (2) means nothing fires without new work, so the floor bounds the notice from above and work bounds it from below. **At most one notice SHALL be emitted per floor.** A notice the model does not act on SHALL NOT be repeated before the next floor elapses — condition (3) alone guarantees this, because `last_nudge_at` advances on emission and not on compliance.

The gate SHALL be a pure function of the row and the current time. It SHALL NOT consult the model's messages, any LLM, any similarity measure, or Rembric's own MCP call volume. Ranking a session's memory traffic as a proxy for work is the failure mode this rule exists to avoid: a turn that edits eight files without calling a memory tool is, to the server, identical to a turn of conversation, so a server-side proxy goes quiet exactly when the reminder is most needed.

#### Scenario: A session that only converses is never reminded

- **GIVEN** a session whose every turn report carried `usedTools: false`, over three hours
- **WHEN** each report is handled
- **THEN** `last_work_at` SHALL remain `NULL`
- **AND** no report SHALL return notice lines

#### Scenario: Work followed by a summary re-arms only on further work

- **GIVEN** a session with `last_work_at` set, `last_summary_at` set later than it, and `last_nudge_at` older than `NUDGE_FLOOR_MS`
- **WHEN** a turn report arrives carrying `usedTools: false`
- **THEN** no notice SHALL be returned, because condition (2) fails
- **WHEN** a later report carries `usedTools: true` and the floor is still elapsed
- **THEN** a notice SHALL be returned

#### Scenario: The turn that refreshes the summary does not then remind itself

- **GIVEN** an `active` session past the floor whose current turn called `memory.session_summary`, so `last_summary_at` is that mid-turn moment
- **WHEN** that turn's report arrives carrying `usedTools: true`, as it must, since the curated call is itself tool use
- **THEN** `last_work_at` SHALL be the turn's start and therefore no later than `last_summary_at`
- **AND** no notice SHALL be returned
- **WHEN** the next turn is conversation only
- **THEN** no notice SHALL be returned
- **WHEN** a later turn does work without refreshing the summary and reports it
- **THEN** a notice SHALL be returned

#### Scenario: A notice the model ignores is not repeated inside the floor

- **GIVEN** a session that has just been returned a notice, so `last_nudge_at` is `now`
- **WHEN** the next ten turn reports arrive, every one carrying `usedTools: true`, all inside `NUDGE_FLOOR_MS`
- **THEN** none SHALL return notice lines
- **AND** `last_work_at` SHALL still advance on each of them

#### Scenario: The first notice of a session cannot fire before one floor has elapsed

- **GIVEN** a session created `NUDGE_FLOOR_MS - 1` milliseconds ago, with `last_nudge_at IS NULL`
- **WHEN** a turn report carrying `usedTools: true` arrives
- **THEN** no notice SHALL be returned
- **WHEN** a further report arrives after `started_at + NUDGE_FLOOR_MS`
- **THEN** a notice SHALL be returned

#### Scenario: A pre-existing session upgraded into this capability starts silent

- **GIVEN** a session row that predates the three columns, so all three are `NULL`, and whose stored `summary` is a curated six-section document
- **WHEN** the server evaluates the gate before any turn report has arrived
- **THEN** no notice SHALL be emitted, because `last_work_at IS NULL`

#### Scenario: A `final: false` write does not count as a summary

- **GIVEN** a session with `last_work_at` set
- **WHEN** a `final: false` transcript write stores a `summary`
- **THEN** `last_summary_at` SHALL be unchanged
- **AND** the gate's condition (2) SHALL still hold

#### Scenario: A raw transcript write between the curated one and the report does not re-arm the gate

- **GIVEN** an `active` session past the floor whose current turn called `memory.session_summary`, so `last_summary_at` is that mid-turn moment
- **WHEN** the client then stores its raw transcript with a `final: false` write, advancing `last_activity_at` past `last_summary_at`
- **AND** the turn's report arrives carrying `usedTools: true`
- **THEN** `last_work_at` SHALL be the previous report's arrival, which is before the curated write
- **AND** no notice SHALL be returned

### Requirement: Every client MUST report each finished turn to the server and print what it is handed back

The five bundled clients SHALL behave identically in the core of this capability: each SHALL report the turn that has just finished, SHALL cache whatever lines the server returns, and SHALL print them at the start of its next turn. A client SHALL hold no cadence, no turn counter and no reminder text for this purpose.

**The report is at the END of the turn.** Issuing it at the start would put an HTTP round trip on the path where the user has just submitted a prompt, and would report a turn that has not happened yet. **The print is at the START of the next turn**, from the cache, so the notice costs no request on the latency-critical path.

The report SHALL carry a boolean naming what the CLIENT OBSERVED — whether at least one tool was invoked during the turn — rather than an interpretation of it. The server owns the interpretation; separating them is what allows the interpretation to change without touching five clients.

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

Where the notice addresses saving at all it SHALL do so in terms the server can defend — the time elapsed since the session last wrote a memory — and SHALL NOT assert that something memorable happened. That clause SHALL sit inside the notice's 640-byte bound and SHALL be the first thing the elision rule drops.

#### Scenario: One reminder, one floor

- **WHEN** the server's nudge module is inspected
- **THEN** it SHALL expose exactly one floor constant
- **AND** no code path SHALL emit a save-only reminder on a cadence of its own

#### Scenario: The save clause is time-stated, never memorability-stated

- **GIVEN** a session that has attached no memory for longer than the floor
- **WHEN** the notice is composed
- **THEN** any save clause it carries SHALL name the elapsed time
- **AND** it SHALL NOT assert that the session produced something worth saving

### Requirement: Recall, the session opening and the resumed-read line MUST stay client-composed, and the split MUST be stated

Moving the stretch-close reminder to the server does not remove the client's local rules; it moves one of them. The boundary SHALL be published rather than left to be inferred from code, and it is:

- **Server-composed:** the stretch-close notice, and nothing else.
- **Client-composed:** the recall line, the session opening, and the resumed-read line.

Each local line stays local for a reason that is a property of the mechanism, not a matter of convenience:

- **Recall** is a regular expression over the user's prompt, and the server does not have the prompt at the moment it composes a notice — that notice was decided by a report issued at the END of the previous turn. Reaching the prompt would require a request per prompt on the latency-critical path, which `claude-code-plugin` already considered and rejected for this hook.
- **The session opening** is gated on the `created` flag the session-ensure already returns, and it exists for the ONE-TURN session. The notice is a turn behind by construction, so a session that ends after a single turn would otherwise receive nothing at all.
- **The resumed-read line** is gated on the same `created` flag and fires before any floor can elapse. Its purpose partly overlaps the notice's inventory, which also tells a model that something is stored; the overlap is recorded and deliberately not resolved, because the two fire at different moments.

#### Scenario: The recall line is still emitted with the server unreachable

- **GIVEN** a client whose server is unreachable
- **WHEN** the user submits a prompt matching the recall keywords
- **THEN** the recall line SHALL still be emitted
- **AND** no notice SHALL be emitted, because none could be fetched

#### Scenario: No client composes stretch-close text of its own

- **WHEN** every client's source is inspected at HEAD
- **THEN** none SHALL declare a string directing the model to refresh the session summary on a cadence
- **AND** the only cadence-driven reminder text in the repository SHALL be the server's

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
