## MODIFIED Requirements

### Requirement: The shared client core MUST be the single implementation of the cross-client protocol logic

The nudge constants and texts, the `<private>` redaction helper, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers, the session-end call and the session-resume call SHALL exist in exactly one JS/TS implementation, at `apps/plugin/bin/rembric-plugin-core.mjs`. Every JS/TS client SHALL import them from there and SHALL declare no local copy.

This is what makes the byte-identical-nudge and identical-redaction-semantics requirements structural rather than a matter of discipline: with one implementation there is no second copy to keep in step, and a client added later inherits both contracts by construction.

A member of that list SHALL live in the core even when exactly one client calls it. The session-end call is the case in point: only Pi invokes it, because opencode's host kills the subprocess before an awaited call can land. Placing it in the client that happens to use it would put a second `fetch` against a `/sessions/…` path in a client file, which is a second implementation of the session HTTP client whatever it is named, and it would leave the next client that needs the verb to write a third.

The resume SHALL be issued by the core's session-registration entry point itself, on the branch that has just added the id to its known-session set, rather than by each client after calling it. That set is already the once-per-id gate for the ensure, so making the resume ride on the same branch makes "exactly one resume per id per process" structural instead of a rule two clients each have to remember. No JS/TS client SHALL call the resume path directly, and no JS/TS client SHALL keep its own known-session set for this purpose.

The resume SHALL be skipped when the ensure that precedes it did not land. Whatever prevented the ensure — an unreachable server, a revoked token, an unresolvable slug — prevents the resume too, so issuing it anyway buys nothing and doubles the wait a quitting or starting user absorbs, each POST being separately bounded by the client's timeout. The id SHALL nevertheless remain in the known-session set, so the pair is not retried on the next call: a retry loop keyed on transport failure is a different mechanism with different failure modes, and this capability's failed-POST requirement already specifies the one diagnostic that reports it.

An invariant test in `apps/server/src/test/invariants.test.ts` SHALL fail the build when a second JS/TS definition of any of these appears. The test SHALL (a) assert a **non-zero count** of scanned files, so an empty file list cannot satisfy the negative assertions vacuously, and (b) derive its scanned file list from a repository-wide search rather than a hard-coded list, so a client added later is scanned on the day it is added. The failure message SHALL name the offending `<file>:<line>`.

**The scanned set is every JS/TS source file under `apps/plugin/`, which is broader than the set of clients, and the two halves of the invariant apply to different sets.** The repository now ships a JS/TS artifact under `apps/plugin/` that is deliberately not a session client — the transport package `apps/plugin/mcp-bridge/` — and the distinction has to be normative rather than an accident of the pattern the test happens to use:

- **The no-second-definition half applies to every scanned file**, client or not. A non-client file that redefines a core-owned helper is a second implementation whatever its directory is called, and `diag` and `truncate` are the realistic collisions for any program that writes stderr diagnostics.
- **The must-import half applies to clients only.** A file that participates in no part of the session protocol SHALL NOT be required to import the core, and requiring it would be worse than useless: it would put session-protocol code inside a transport whose contract is to inspect no payload.

The set of clients SHALL be derived from the per-client directory shape (`apps/plugin/.<name>-plugin/`) rather than enumerated, and a non-client artifact under `apps/plugin/` SHALL NOT be placed in a directory matching that shape.

The core SHALL require `agent` as a mandatory parameter of session registration, with no default. `sessions.agent` is written once per session and memory is append-only, so a defaulted value misattributes sessions permanently with no repair verb.

#### Scenario: A second redaction implementation fails the build

- **GIVEN** a change introduces a local `function stripPrivateTags` in any JS/TS client file
- **WHEN** `pnpm vitest run apps/server/src/test/invariants.test.ts` runs
- **THEN** the test SHALL fail with a message naming the offending file and line

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
- **AND** the control SHALL pass in the same run: with the ensure answering `200`, the resume IS POSTed
