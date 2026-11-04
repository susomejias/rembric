## ADDED Requirements

### Requirement: The notice MUST ask for `memory.save` when tool work followed the session's last memory write

On each active turn report the server SHALL evaluate, beside the summary condition of "The session-summary reminder MUST use completed activity and a minimum interval, never a turn counter", a SAVE condition. It reads the row and one derived input, `last_memory_at`: the newest `created_at` among memory rows that carry this session's id inside the session's own project scope, in any status. `last_memory_at` SHALL be read at evaluation time through a scoped repository method and SHALL NOT be stored — there is no column, nothing to backfill, and a memory later superseded or archived still records that the session saved. A memory carrying the session id in another project's scope SHALL NOT count.

The save condition holds when ALL THREE hold:

1. `last_work_at IS NOT NULL`;
2. `last_memory_at IS NULL` OR `last_work_at > last_memory_at`;
3. `last_nudge_at IS NULL` OR `last_work_at >= last_nudge_at`.

Condition (2) is STRICT for the reason the summary comparison is: `last_work_at` is the START of the tool-using turn, so a memory written during that turn is later than it and suppresses the clause on exactly the turn that complied. Condition (3) is what keeps a clause the model read and skipped from repeating over turns that did no further tool work; it is NOT strict because the turn that receives a notice starts at the previous report's arrival, which is the instant `last_nudge_at` was stamped, and tool work in that turn is new work.

The notice SHALL be emitted when the floor condition holds AND at least one of the summary condition and the save condition holds. Where the summary requirement states its emission rule as "if and only if", that biconditional governs the summary directive; the notice as a whole follows this rule. The composed notice SHALL be:

- **save condition only:** the save clause alone;
- **summary condition only:** the summary notice, byte-identical to its composition without this requirement;
- **both:** the save clause, a newline, then the summary notice.

The save clause SHALL read `rembric: <elapsed> without a \`memory.save\` in this session. Fix, decision or discovery settled? Save each now; nothing durable? Skip.`, where `<elapsed>` is `now - COALESCE(last_memory_at, started_at)` rendered as `<m> min` below one hour and `<h>h <mm>m` from one hour on.

The clause is composed by the server, so every client prints it through the report-ping-print contract it already implements, and a deployed client of any version receives it without a plugin release.

#### Scenario: A session that keeps its summary fresh but never saves is asked to save

- **GIVEN** an active session that refreshes its curated summary in every turn and reports `usedTools: true` on every turn for four hours, and writes no memory
- **WHEN** each report is handled
- **THEN** no report SHALL carry the summary directive
- **AND** at least one report per elapsed floor SHALL carry the save clause

#### Scenario: A memory saved during the turn suppresses the clause

- **GIVEN** an active session past the floor whose current turn used tools and wrote a memory attached to the session
- **WHEN** that turn's report arrives
- **THEN** the returned lines SHALL NOT contain `memory.save`
- **WHEN** the same timeline runs without the memory
- **THEN** the returned lines SHALL begin with the save clause naming the elapsed time since `started_at`

#### Scenario: A memory written before the latest tool-using turn does not suppress it

- **GIVEN** a session that wrote one memory five minutes after it started, and whose later turns used tools
- **WHEN** a report arrives past the floor
- **THEN** the save clause SHALL be returned, naming the time since that memory

#### Scenario: A memory in another project's scope does not count

- **GIVEN** a memory carrying the session's id but stored in a different project
- **WHEN** the session's report arrives past the floor after tool work
- **THEN** the save clause SHALL be returned

#### Scenario: A skipped clause is not repeated without further tool work

- **GIVEN** a session that was returned the save clause and whose later turns report `usedTools: false`
- **WHEN** a report arrives after a further floor
- **THEN** no save clause SHALL be returned
- **WHEN** a later turn reports `usedTools: true` and a further floor elapses
- **THEN** the save clause SHALL be returned again

#### Scenario: A session that never used a tool is never asked to save

- **GIVEN** a session whose every report carried `usedTools: false`
- **WHEN** a report arrives past the floor and the summary condition holds
- **THEN** the notice SHALL carry the summary directive and SHALL NOT contain `memory.save`

#### Scenario: The clause shares the floor and travels first

- **GIVEN** a session for which both conditions hold
- **WHEN** a report arrives one millisecond before `COALESCE(last_nudge_at, started_at) + NUDGE_FLOOR_MS`
- **THEN** no lines SHALL be returned
- **WHEN** the next report arrives at that instant
- **THEN** exactly one notice SHALL be returned, whose first line is the save clause and whose remainder is byte-identical to the summary-only notice

#### Scenario: The boundary the plugins call carries the clause

- **WHEN** `POST /api/<slug>/sessions/:id/turn` is called with `usedTools: true` for a session with a fresh curated summary, no memory, and an elapsed floor
- **THEN** the response `lines` SHALL equal exactly the save clause

## MODIFIED Requirements

### Requirement: The save reminder MUST be folded into the one notice, and MUST NOT claim to know what is memorable

There SHALL be ONE periodic notice, not a save reminder and a summary reminder with separate floors. The save clause and the summary directive share `NUDGE_FLOOR_MS` and `last_nudge_at`: whichever is due, at most one notice is emitted per floor, and when both are due they travel in the same notice. A second floor would reintroduce the second constant this capability exists to remove.

The always-present protocol block (`mcp-api`, the `initialize.instructions` requirement) SHALL keep directing the model to save as soon as a fix, decision or discovery is settled. It is NOT sufficient on its own, and that is a measurement rather than a judgement: while the notice carried no save clause, nine Claude Code sessions over two days — one of them 4h38m long with 20 `memory.session_summary` calls, each answering a notice — wrote zero memories (issue #439), and the five clients had all carried a periodic save reminder before the notice replaced it. The notice therefore carries the save clause defined in "The notice MUST ask for `memory.save` when tool work followed the session's last memory write".

The save clause SHALL address saving only in terms the server can defend — the time elapsed since the session last wrote a memory, or since it started when it never did — and SHALL NOT assert that something memorable happened: it asks whether a fix, decision or discovery settled and licenses skipping when nothing durable did. It SHALL sit inside the notice's 640-byte bound and SHALL NOT be elided: when the bound binds, the title is cut and the inventory collapses into `+N more` first, because the clause is the one line of the notice that no other surface delivers on a cadence.

#### Scenario: One reminder, one floor

- **WHEN** the server's nudge module is inspected
- **THEN** it SHALL expose exactly one floor constant
- **AND** no code path SHALL emit a save clause on a cadence of its own

#### Scenario: The notice claims nothing about what was worth saving

- **GIVEN** a session that has attached no memory for longer than the floor while reporting tool work
- **WHEN** the notice is composed
- **THEN** its save clause SHALL name the elapsed time
- **AND** it SHALL ask a question and license skipping rather than assert that the session produced something worth saving

#### Scenario: The clause survives the byte bound

- **GIVEN** a save clause naming 999 hours, a stored summary of forty 90-character headings, and a 1000-character title
- **WHEN** the notice is composed
- **THEN** it SHALL be within 640 bytes
- **AND** it SHALL begin with the complete save clause followed by a newline
- **AND** it SHALL carry `+N more`
