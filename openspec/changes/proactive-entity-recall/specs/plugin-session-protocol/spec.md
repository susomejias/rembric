## MODIFIED Requirements

### Requirement: The shared client core MUST be the single implementation of the cross-client protocol logic

The `<private>` redaction helper, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers, the session-end call, the session-resume call, **the turn-report call, the per-session cache of the server's returned lines, and the per-turn tool-observation LATCH** (arm, disarm at the turn boundary, read-and-clear at the report, evict on forget), and the texts of the lines that remain client-composed, SHALL exist in exactly one JS/TS implementation, at `apps/plugin/bin/rembric-plugin-core.mjs`. Every JS/TS client SHALL import them from there and SHALL declare no local copy.

This is what makes the identical-redaction-semantics and byte-identical-line requirements structural rather than a matter of discipline: with one implementation there is no second copy to keep in step, and a client added later inherits both contracts by construction.

A JS/TS client SHALL contribute only the PREDICATE its host makes available — which event means "a tool ran" — and SHALL hold no per-turn state of its own for it. The invariant enforcing this SHALL be stated over the concept rather than over a symbol name: the two copies that preceded it were called `toolUsedFlags` and `toolUsedThisTurn`, so a by-name inventory could not see that they were the same mechanism, and the divergence it hid was real — one client disarmed the latch at the turn boundary and the other did not.

**The read-and-clear SHALL sit BELOW the report's own guards, never above them.** A report the core declines to send — a sub-agent session, or one it never registered — SHALL leave the latch armed. Consuming it there discards the observation into a request that was never issued, so the session's next sent report claims `usedTools: false` about a turn that used a tool. Both clients that exist today guard their own call sites, so the ordering is unreachable from either and its cost is entirely borne by the next client to call `reportTurn` without that guard; it is stated here because "unreachable today" is not a property of the core.

A member of that list SHALL live in the core even when exactly one client calls it. The session-end call is the case in point: only Pi invokes it, because opencode's host kills the subprocess before an awaited call can land. Placing it in the client that happens to use it would put a second `fetch` against a `/sessions/…` path in a client file, which is a second implementation of the session HTTP client whatever it is named, and it would leave the next client that needs the verb to write a third.

**The nudge cadence constants SHALL NOT exist in the core, or anywhere else in the plugin tree.** `SAVE_NUDGE_EVERY`, `SUMMARY_NUDGE_EVERY`, the per-session turn-count map and their bash and Python equivalents are removed: the firing decision belongs to the server (`session-nudges`), and a constant that no longer decides anything is a fifth place for a future contributor to change by mistake.

**The turn-report call and its line cache SHALL be one core-owned pair.** The cache SHALL be keyed per session, SHALL be cleared when the session is forgotten, and SHALL NOT be overwritten with an empty result — a report that returns no lines leaves any pending lines intact, so a second end-of-turn event within one turn cannot swallow a notice. Reading the cache SHALL clear it, so a notice is printed exactly once.

**The turn body retains `{usedTools}` (+`title` once) exactly as today.** The `prompt` field is NOT part of the turn body; proactive recall hints are delivered via a separate synchronous endpoint called at turn START.

**The recall-hints call SHALL be one core-owned function.** The function SHALL call `POST /api/<slug>/sessions/:id/recall-hints` with the current turn's user prompt (`<private>`-redacted, truncated to 500 chars), and SHALL return the `{lines: string[]}` response. The function SHALL accept a timeout parameter with a bounded default (e.g. 200ms) and SHALL return an empty array on timeout or error — proactive recall is best-effort, never blocking the model.

The resume SHALL be issued by the core's session-registration entry point itself, on the branch that has just added the id to its known-session set, rather than by each client after calling it. That set is already the once-per-id gate for the ensure, so making the resume ride on the same branch makes "exactly one resume per id per process" structural instead of a rule two clients each have to remember. No JS/TS client SHALL call the resume path directly, and no JS/TS client SHALL keep its own known-session set for this purpose.

The resume SHALL be skipped when the ensure that precedes it did not land. Whatever prevented the ensure — an unreachable server, a revoked token, an unresolvable slug — prevents the resume too, so issuing it anyway buys nothing and doubles the wait a quitting or starting user absorbs, each POST being separately bounded by the client's timeout. The id SHALL nevertheless remain in the known-session set, so the pair is not retried on the next call.

An invariant test in `apps/server/src/test/invariants.test.ts` SHALL fail the build when a second JS/TS definition of any of these appears. The test SHALL (a) assert a **non-zero count** of scanned files, so an empty file list cannot satisfy the negative assertions vacuously, and (b) derive its scanned file list from a repository-wide search rather than a hard-coded list, so a client added later is scanned on the day it is added. The failure message SHALL name the offending `<file>:<line>`.

**The scanned set is every JS/TS source file under `apps/plugin/`, which is broader than the set of clients, and the two halves of the invariant apply to different sets.** The repository ships a JS/TS artifact under `apps/plugin/` that is deliberately not a session client — the transport package `apps/plugin/mcp-bridge/` — and the distinction has to be normative rather than an accident of the pattern the test happens to use:

- **The no-second-definition half applies to every scanned file**, client or not. A non-client file that redefines a core-owned helper is a second implementation whatever its directory is called, and `diag` and `truncate` are the realistic collisions for any program that writes stderr diagnostics.
- **The must-import half applies to clients only.** A file that participates in no part of the session protocol SHALL NOT be required to import the core, and requiring it would be worse than useless: it would put session-protocol code inside a transport whose contract is to inspect no payload.

The set of clients SHALL be derived from the per-client directory shape (`apps/plugin/.<name>-plugin/`) rather than enumerated, and a non-client artifact under `apps/plugin/` SHALL NOT be placed in a directory matching that shape.

The core SHALL require `agent` as a mandatory parameter of session registration, with no default. `sessions.agent` is written once per session and memory is append-only, so a defaulted value misattributes sessions permanently with no repair verb.

#### Scenario: A second redaction implementation fails the build

- **GIVEN** a change introduces a local `function stripPrivateTags` in any JS/TS client file
- **WHEN** `pnpm vitest run apps/server/src/test/invariants.test.ts` runs
- **THEN** the test SHALL fail with a message naming the offending file and line

#### Scenario: No cadence constant survives anywhere in the plugin tree

- **WHEN** `git grep -n 'NUDGE_EVERY\|_HINT_EVERY\|rembric-turnnudge'` runs over `apps/plugin/` at HEAD
- **THEN** it SHALL produce no match

#### Scenario: A report returning no lines does not swallow a pending notice

- **GIVEN** a core holding cached lines for session `<S>`
- **WHEN** `reportTurn(<S>, …)` is called and the server returns an empty `lines` array
- **THEN** the cached lines SHALL still be present
- **AND** the next read for `<S>` SHALL return them and SHALL clear the cache

#### Scenario: A dropped report does not consume the tool latch

- **GIVEN** a core whose tool latch is armed for a session it has not registered
- **WHEN** `reportTurn` is called for that session
- **THEN** no request SHALL be issued
- **AND** the latch SHALL still be armed, so that session's first sent report SHALL carry `usedTools: true`

#### Scenario: A non-client file under `apps/plugin/` cannot redefine a core-owned helper

- **GIVEN** a change introduces a `function diag` or `function truncate` inside `apps/plugin/mcp-bridge/`
- **WHEN** the invariant runs
- **THEN** the test SHALL fail naming that file and line
- **AND** the message SHALL name `apps/plugin/bin/rembric-plugin-core.mjs` as the one permitted definition site

#### Scenario: A non-client file is not required to import the core

- **WHEN** the invariant enumerates the files that must import `rembric-plugin-core.mjs`
- **THEN** `apps/plugin/mcp-bridge/`'s sources SHALL NOT be among them
- **AND** the enumeration SHALL be derived from the `apps/plugin/.<name>-plugin/` directory shape

#### Scenario: The invariant cannot pass vacuously

- **GIVEN** the invariant's derived file list is empty (for example because the search pattern stopped matching)
- **WHEN** the test runs
- **THEN** it SHALL fail on the non-zero-count assertion
- **AND** it SHALL NOT report success on the strength of the negative assertions alone

#### Scenario: Bash and Python keep their own implementations

- **WHEN** the invariant runs against the repository at HEAD
- **THEN** the bash implementations (`apps/plugin/scripts/_transcript.sh`, `apps/plugin/scripts/_api.sh`) and the Python implementation (`apps/plugin/.hermes-plugin/__init__.py`) SHALL NOT be flagged
- **AND** the shared cross-language fixtures SHALL remain the mechanism keeping them in agreement

#### Scenario: The resume rides on the core's ensure, not on the client

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` and `apps/plugin/.pi-plugin/index.ts` are read at HEAD
- **THEN** neither SHALL contain a string matching `/resume`
- **AND** the core's session-registration entry point SHALL POST the resume on the branch where the id was newly added to the known-session set, and SHALL NOT POST it on the early-return branch for an already-known id

#### Scenario: A failed ensure suppresses the resume without retrying either

- **GIVEN** the server is unreachable, or answers the ensure with a non-2xx status
- **WHEN** the core's session-registration entry point runs for a new id
- **THEN** it SHALL NOT POST the resume
- **AND** the id SHALL still be in the known-session set, so a later call for the same id POSTs neither
- **AND** the control SHALL pass in the same run: with the ensure answering `200`, the resume IS posted

#### Scenario: The turn body does not carry a prompt

- **WHEN** `reportTurn` is called for any session
- **THEN** the POST body SHALL contain `{usedTools}` (and optionally `title`)
- **AND** the POST body SHALL NOT contain a `prompt` field

#### Scenario: The recall-hints call returns lines synchronously

- **GIVEN** a core with a recorded prompt "Fix the login flow in src/auth/handler.ts"
- **WHEN** `recallHints(sessionId, prompt)` is called
- **THEN** it SHALL POST to `/api/<slug>/sessions/<id>/recall-hints` with `{prompt: "<redacted and truncated>"}`
- **AND** it SHALL return the `{lines: string[]}` response
- **AND** it SHALL return an empty array on timeout or error

#### Scenario: A missing prompt omits the recall-hints call

- **GIVEN** a core with no recorded prompt for the current turn
- **WHEN** the client reaches the hints call site
- **THEN** it SHALL NOT call the recall-hints endpoint
