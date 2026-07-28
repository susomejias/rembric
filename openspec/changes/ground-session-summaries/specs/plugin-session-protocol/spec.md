## ADDED Requirements

### Requirement: The summary reminder MUST be delivered at the end of the turn, and MUST NEVER interrupt

A reminder that a session owes a summary SHALL be delivered at the END of a turn as well as at its start. A reminder attached only to the start of a turn always arrives while there is more work to do, so it is advice about future behaviour; the end of the turn is the point at which the work of that turn is finished and the model can still act on it.

The reminder SHALL be delivered as non-interrupting feedback that continues the conversation. It SHALL NOT use the host's blocking decision. Two reasons: a memory server is an optional accessory to its host and MUST NOT be able to hold an agent's turn open, and a blocking reminder needs a loop guard whose absence on any one host would make the mechanism unsafe there. Non-interrupting feedback carries the same text and needs neither.

The host's end-of-turn event SHALL therefore carry TWO independent entries with different obligations:

- The existing raw-sync entry SHALL remain asynchronous. It is a pure side effect and SHALL NOT delay the turn.
- A second entry SHALL be synchronous, because an asynchronous handler is fire-and-forget by the host's contract and cannot contribute feedback to the turn at all. Wiring the reminder asynchronously forfeits it entirely.

**The reminder SHALL be rate-limited by the same per-session turn counter the start-of-turn nudge already uses, at the same cadence.** It SHALL NOT fire on every turn. The end-of-turn event fires once per turn, not once per session, so an unthrottled reminder would inject its payload into every turn of a long session — and the repository already owns exactly one mechanism for "remind every N turns". A second, independently-tuned cadence would be a second thing to keep in step with the first.

When the reminder fires, its payload SHALL carry the canonical summary structure in full (see `sessions`) AND the grounded facts extracted from the session, so the model summarises against evidence rather than recollection. This is the surface that carries the long form precisely because it has no length budget, unlike a tool description.

The entry SHALL NOT fire when the session has produced nothing worth summarising — a turn that only read or only talked. "Produced nothing" SHALL be decided from the session's own transcript, not from the server: no files written or edited and no commands run.

It SHALL NOT be required to know whether a curated summary already exists, and SHALL NOT make a request to find out. No read endpoint for a session exists — the HTTP surface offers only `POST .../summary` and `POST .../end` — so the reminder is cadence-gated and may fire on a session that has already been summarised. That is deliberate under-precision: the cost is one redundant reminder every N turns, and the alternative is new HTTP surface. A follow-up MAY add a read endpoint and narrow this; until it does, no requirement here SHALL assert the reminder consults server state.

**Fail-open is absolute.** On unparseable input, an unreadable or absent turn counter, a missing or unreadable transcript, an unavailable parser, or any unexpected error, the entry SHALL exit successfully and produce no output. Where a host requires a JSON object on every invocation, it SHALL emit an empty one rather than nothing. The failure mode of a missed reminder is a thinner summary; there SHALL be no failure mode in which the host is degraded.

#### Scenario: The reminder fires at the counter's cadence when a summary is owed

- **GIVEN** a session that has written or edited a file, or run a command, on a turn at which the shared counter's cadence fires
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL emit non-interrupting feedback carrying the canonical structure and the extracted facts
- **AND** it SHALL NOT emit an interrupting decision

#### Scenario: The reminder is silent on turns between cadence points

- **GIVEN** the same session on a turn at which the shared counter's cadence does not fire
- **WHEN** the end-of-turn event fires
- **THEN** the hook SHALL produce no output

#### Scenario: The reminder does not consult the server

- **GIVEN** any session state, including one that already carries a curated summary
- **WHEN** the end-of-turn event fires at a cadence point
- **THEN** the hook SHALL decide from the transcript and the counter alone, and SHALL make no request

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

## MODIFIED Requirements

### Requirement: The protocol nudge MUST be in `initialize.instructions` to cover all three clients uniformly

The MCP server's `initialize.instructions` string (loaded into the model's system prompt on connect) SHALL include a directive flow instructing the model to call `memory.session_summary` with `{title, summary}` at the end of every turn in which real work happened — never ending a working turn silent. The flow SHALL:

- Be present in both the path-scoped and path-less variants of `initialize.instructions`.
- Stay within the 1000-character cap enforced by `instructions.test.ts` (raised from 800; the cap is a self-imposed token budget chosen for token cost rather than the binding limit — Claude Code truncates `instructions` at 2048 characters, so the self-imposed cap binds first; the `mcp-api` capability holds the authoritative statement).
- Be phrased as a **calibrated imperative**: a directive to curate (not a passive suggestion), **conditioned on real memorable work having happened** (a decision, fix, discovery, or files changed). It SHALL preserve the model's discretion to skip trivial turns with nothing worth persisting (so the imperative does not induce vacuous summaries), and SHALL NOT bind the trigger solely to the literal word "done".
- Describe the title constraint (≤100 chars, descriptive of what was worked on) and the summary structure, carried verbatim from the canonical section list defined in `sessions` rather than restated here. The list names, at minimum, the goal, what was accomplished, the decisions taken AND why, what was verified AND how, what was left unfinished AND why, and the files that matter — the three `+why`/`+how` sections exist because the code records what changed and never why it beat the alternative nor what evidence a claim rests on.

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
