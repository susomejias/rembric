## RENAMED Requirements

- FROM: `### Requirement: The summary reminder MUST be delivered at the end of the turn, and MUST NEVER interrupt`
- TO: `### Requirement: The summary reminder MUST be delivered at the end of the turn, and MUST NOT re-enter once the host has continued the turn to satisfy it`

## MODIFIED Requirements

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

**Apart from the loop guard above, that is the ONLY licensed silence, alongside the fail-open cases below.** The reminder SHALL NOT be suppressed because the session already carries a curated summary, and SHALL NOT derive that state from anywhere — not from the server, and not by scanning the transcript for a completed summary tool call. Suppressing it freezes whatever the first write said, because nothing afterwards ever asks the model to improve it, and it is exactly what makes a premature first summary permanent. The reason the suppression was defensible has also gone: a later curated write is recorded as a version row before it can displace anything (`sessions`, "Every curated session-summary write MUST append a version row in the same transaction"), so a redundant reminder can no longer cost stored text.

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
