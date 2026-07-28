## ADDED Requirements

### Requirement: The summary reminder MUST be delivered at the end of the turn, and MUST NEVER interrupt

A reminder that a session owes a summary SHALL be delivered at the END of a turn as well as at its start. A reminder attached only to the start of a turn always arrives while there is more work to do, so it is advice about future behaviour; the end of the turn is the point at which the work of that turn is finished and the model can still act on it.

The reminder SHALL be delivered as non-interrupting feedback that continues the conversation. It SHALL NOT use the host's blocking decision. Two reasons: a memory server is an optional accessory to its host and MUST NOT be able to hold an agent's turn open, and a blocking reminder needs a loop guard whose absence on any one host would make the mechanism unsafe there. Non-interrupting feedback carries the same text and needs neither.

The host's end-of-turn event SHALL therefore carry TWO independent entries with different obligations:

- The existing raw-sync entry SHALL remain asynchronous. It is a pure side effect and SHALL NOT delay the turn.
- A second entry SHALL be synchronous, because an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback to the turn at all. Wiring the reminder asynchronously forfeits it entirely.

**The reminder SHALL be rate-limited by the same per-session turn counter the start-of-turn nudge already uses, at the same cadence.** It SHALL NOT fire on every turn. The end-of-turn event fires once per turn, not once per session, so an unthrottled reminder would inject its payload into every turn of a long session — and the repository already owns exactly one mechanism for "remind every N turns". A second, independently-tuned cadence would be a second thing to keep in step with the first.

When the reminder fires, its payload SHALL carry the canonical summary structure in full (see `sessions`) AND the grounded facts extracted from the session, so the model summarises against evidence rather than recollection. This is the surface that carries the long form precisely because it has no length budget, unlike a tool description.

The entry SHALL NOT fire when the session already carries a curated summary, and SHALL NOT fire when the session has produced nothing worth summarising.

**Fail-open is absolute.** On any non-2xx response, any timeout, any unparseable response, any missing configuration, any unreadable turn counter, or any unexpected error, the entry SHALL exit successfully and produce no output. The failure mode of a missed reminder is a thinner summary; there SHALL be no failure mode in which the host is degraded.

#### Scenario: The reminder fires at the counter's cadence when a summary is owed

- **GIVEN** a session with `summary_final = false` that has produced work worth summarising, on a turn at which the shared counter's cadence fires
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL emit non-interrupting feedback carrying the canonical structure and the extracted facts
- **AND** it SHALL NOT emit an interrupting decision

#### Scenario: The reminder is silent on turns between cadence points

- **GIVEN** the same session on a turn at which the shared counter's cadence does not fire
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL produce no output

#### Scenario: A session that already has a curated summary is never reminded

- **GIVEN** a session with `summary_final = true`
- **WHEN** the end-of-turn event fires at a cadence point
- **THEN** the hook SHALL produce no output

#### Scenario: The server is unreachable

- **GIVEN** a configured server that does not answer, or answers non-2xx, or exceeds the timeout
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL exit successfully with no output, and the turn SHALL complete normally

#### Scenario: The turn counter is unreadable

- **GIVEN** an environment in which the shared turn counter cannot be read or written
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL produce no output rather than fall back to reminding on every turn

#### Scenario: A session with nothing worth summarising

- **GIVEN** a session that produced no files, no commands and no memories
- **WHEN** the end-of-turn event fires at a cadence point
- **THEN** the hook SHALL produce no output

### Requirement: Delegated work MUST reach the parent session's record

Work performed by a subagent SHALL contribute to the parent session's extracted facts. A session that delegated all of its work SHALL NOT be indistinguishable from a session that did nothing.

Where a host exposes a subagent-completion event, it SHALL append the subagent's extracted facts to the parent session's record, and SHALL NOT emit feedback of any kind: a subagent finishing is not the point at which a handoff is owed.

Host parity SHALL be pursued only where it does not require per-host logic beyond the existing per-host seams. Where a host exposes no end-of-turn or subagent-completion event, the absence SHALL be recorded per client rather than emulated.

#### Scenario: A session whose work was done entirely by subagents

- **GIVEN** a session that edited no files directly but whose subagents edited several
- **WHEN** the subagent-completion events have fired and the session ends without a curated summary
- **THEN** the fallback SHALL name the files the subagents edited

#### Scenario: A host without a subagent-completion event

- **GIVEN** a client whose host exposes no subagent-completion event
- **WHEN** the plugin is installed for that client
- **THEN** the absence SHALL be recorded for that client and SHALL NOT be emulated by other means
