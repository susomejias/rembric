## ADDED Requirements

### Requirement: The end-of-turn hook MUST ask for a summary once, and MUST NEVER trap the agent

The reminder that a session owes a summary SHALL be delivered at the end of the turn, not during it. A reminder attached to the start of a turn always arrives while there is more work to do, and is therefore advice rather than a request; the end of the turn is the only point at which the work is finished and the model can still act.

The host's end-of-turn event SHALL therefore carry TWO independent entries, with different obligations:

- The existing raw-sync entry SHALL remain asynchronous. It is a pure side effect and SHALL NOT delay the turn.
- A second entry SHALL be synchronous, because an asynchronous handler is fire-and-forget by the host's contract and cannot influence the turn at all. Wiring the reminder asynchronously forfeits the mechanism entirely.

The synchronous entry SHALL perform at most ONE bounded request to determine whether the session already carries a curated summary. When it does, or when the session has nothing worth summarising, the entry SHALL exit silently and SHALL NOT interrupt.

When a summary is owed, the entry SHALL return the host's "continue the conversation" decision together with a reason. The reason SHALL carry the canonical summary structure in full (see `sessions`) AND the grounded facts extracted from the session, so the model summarises against evidence rather than recollection. This is the surface that carries the long form precisely because it has no length budget, unlike a tool description.

**Fail-open is absolute.** On any non-2xx response, any timeout, any unparseable response, any missing configuration, or any unexpected error, the entry SHALL exit successfully and produce no output. A memory server is an optional accessory to the host, and it SHALL NEVER be able to prevent an agent from finishing a turn. The failure mode of a missed reminder is a thinner summary; the failure mode of a trapped agent is a broken session, and the two are not comparable.

The entry SHALL interrupt AT MOST ONCE per session. It SHALL use the loop-guard signal the host provides in the event payload for this purpose. Where the host provides no such signal, the entry SHALL degrade to non-blocking feedback rather than risk a loop.

#### Scenario: A session that never wrote a curated summary is asked once

- **GIVEN** a session with `summary_final = false` that produced work worth summarising
- **WHEN** the end-of-turn event fires and the loop-guard signal is not set
- **THEN** the hook SHALL return the continue decision with a reason carrying the canonical structure and the extracted facts

#### Scenario: A session that already has a curated summary is not interrupted

- **GIVEN** a session with `summary_final = true`
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL exit silently and SHALL NOT interrupt

#### Scenario: The server is unreachable

- **GIVEN** a configured server that does not answer, or answers non-2xx, or exceeds the timeout
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL exit successfully with no output, and the agent SHALL finish its turn normally

#### Scenario: The hook has already interrupted once for this session

- **GIVEN** the loop-guard signal is set in the event payload
- **WHEN** the end-of-turn event fires again
- **THEN** the hook SHALL exit silently, regardless of whether a summary was written

#### Scenario: A session with nothing worth summarising

- **GIVEN** a session that produced no files, no commands and no memories
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL exit silently

### Requirement: Delegated work MUST reach the parent session's record

Work performed by a subagent SHALL contribute to the parent session's extracted facts. A session that delegated all of its work SHALL NOT be indistinguishable from a session that did nothing.

The subagent-completion event SHALL append the subagent's extracted facts to the parent session's record. It SHALL NOT interrupt: a subagent finishing is not the point at which a handoff is owed, and interrupting there would ask for a summary of work that is still in progress.

#### Scenario: A session whose work was done entirely by subagents

- **GIVEN** a session that edited no files directly but whose subagents edited several
- **WHEN** the subagent-completion events have fired and the session ends without a curated summary
- **THEN** the fallback SHALL name the files the subagents edited

#### Scenario: Subagent completion never interrupts

- **WHEN** the subagent-completion event fires, whatever the parent session's summary state
- **THEN** the hook SHALL NOT return an interrupting decision
