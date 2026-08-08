## ADDED Requirements

### Requirement: Sessions under the Pi client MUST converge on a non-null summary

Every closed session created by the Pi client SHALL end with a non-null `sessions.summary` whenever **either** of the following held during its lifetime:

- The agent called `memory.session_summary({summary, title?})` at any point, or
- the harness's session-shutdown handler ran with a non-empty per-session transcript accumulator.

The second condition is a stronger guarantee than the equivalent opencode condition, and the difference is measured rather than assumed. The harness awaits its shutdown handler with no timeout (measured against 0.84.1: a 300 ms awaited fetch completes, a 10 s one completes, and an MCP `tools/call` issued from inside the handler completes; SIGTERM and SIGHUP both reach it; the discriminating control — SIGKILL — runs nothing). So this client's final flush is an **awaited** POST and its landing is a guarantee, not a race, whereas the opencode dispose-time flush is explicitly best-effort because that host kills the subprocess before async handlers finish.

A per-turn debounced flush SHALL also run, as for the other in-process clients, so the server's summary is current at all times and any loss is bounded to one turn.

**One documented exception:** an interrupt does not reach the shutdown handler in either mode. In print mode SIGINT is not registered as a signal (`dist/modes/print-mode.js:32`, `const signals = ["SIGTERM"]`, with SIGHUP wired separately). In the interactive TUI the interrupt byte is a keypress and is measured not to exit: under a pty with keys at t=4 s and stdin held open to t=14 s, Ctrl-C left the handler firing at 13.6 s (the stdin EOF, byte-identical to the no-keys control) while Ctrl-D fired it at 3.6 s. So a Ctrl-C loses the final flush in both modes, Ctrl-D does not, and the per-turn flush bounds the loss to one turn. Convergence after a Ctrl-C is therefore out of scope in exactly the way a hard crash already is.

#### Scenario: Cooperating agent

- **GIVEN** a Pi session in which the agent called `memory.session_summary({summary, title})`
- **WHEN** the session ends
- **THEN** `sessions.summary` SHALL be the model-authored content
- **AND** it SHALL NOT be overwritten by the shutdown flush (which POSTs with `final:false`)

#### Scenario: Non-cooperating agent, normal shutdown

- **GIVEN** a Pi session with at least one user turn and no `memory.session_summary` call
- **WHEN** the harness shuts the session down through its normal exit path or SIGTERM
- **THEN** the awaited summary POST SHALL complete before the process exits
- **AND** `sessions.summary` SHALL be non-null

#### Scenario: SIGKILL loses the final flush (the discriminating control)

- **GIVEN** a Pi session with accumulated transcript entries
- **WHEN** the process is SIGKILLed
- **THEN** no shutdown handler SHALL run
- **AND** convergence SHALL rest on the last per-turn flush, so the stored summary SHALL lag by at most one turn

### Requirement: The shared client core MUST be the single implementation of the cross-client protocol logic

The nudge constants and texts, the `<private>` redaction helper, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, and the flush helpers SHALL exist in exactly one JS/TS implementation, at `apps/plugin/bin/rembric-plugin-core.mjs`. Every JS/TS client SHALL import them from there and SHALL declare no local copy.

This is what makes the byte-identical-nudge and identical-redaction-semantics requirements structural rather than a matter of discipline: with one implementation there is no second copy to keep in step, and a client added later inherits both contracts by construction.

An invariant test in `apps/server/src/test/invariants.test.ts` SHALL fail the build when a second JS/TS definition of any of these appears. The test SHALL (a) assert a **non-zero count** of scanned files, so an empty file list cannot satisfy the negative assertions vacuously, and (b) derive its scanned file list from a repository-wide search rather than a hard-coded list, so a client added later is scanned on the day it is added. The failure message SHALL name the offending `<file>:<line>`.

The core SHALL require `agent` as a mandatory parameter of session registration, with no default. `sessions.agent` is written once per session and memory is append-only, so a defaulted value misattributes sessions permanently with no repair verb.

#### Scenario: A second redaction implementation fails the build

- **GIVEN** a change introduces a local `function stripPrivateTags` in any JS/TS client file
- **WHEN** `pnpm vitest run apps/server/src/test/invariants.test.ts` runs
- **THEN** the test SHALL fail with a message naming the offending file and line

#### Scenario: The invariant cannot pass vacuously

- **GIVEN** the invariant's derived file list is empty (for example because the search pattern stopped matching)
- **WHEN** the test runs
- **THEN** it SHALL fail on the non-zero-count assertion
- **AND** it SHALL NOT report success on the strength of the negative assertions alone

#### Scenario: Bash and Python keep their own implementations

- **WHEN** the invariant runs against the repository at HEAD
- **THEN** the bash implementations (`apps/plugin/scripts/_transcript.sh`, `apps/plugin/scripts/_api.sh`) and the Python implementation (`apps/plugin/.hermes-plugin/__init__.py`) SHALL NOT be flagged
- **AND** the shared cross-language fixtures SHALL remain the mechanism keeping them in agreement

### Requirement: The per-turn save/summary nudge text MUST be a calibrated imperative shared byte-identical across every client

The save and session-summary nudge strings emitted per-turn by every client — Claude Code and Codex via `apps/plugin/scripts/prompt-nudge.sh`, opencode and Pi via the shared JS/TS module `apps/plugin/bin/rembric-plugin-core.mjs`, Hermes via `prefetch()` (`apps/plugin/.hermes-plugin/__init__.py`) — SHALL be sourced from the single shared contract `apps/plugin/test/nudge-fixtures.json` (`save`, `saveCore`, `summaryCore`, `summary`) and SHALL be byte-identical across clients. Bash and the shared JS/TS module embed the `rembric:`-prefixed `summary`/`save` verbatim; Hermes wraps `saveCore`/`summaryCore` in `<memory-hint>…</memory-hint>` per its established convention. No individual JS/TS client SHALL carry its own copy of these strings — there is one JS/TS implementation and every JS/TS client imports it, so a newly added client is byte-identical by construction rather than by review.

The shared text SHALL be phrased as a calibrated imperative:

- It SHALL direct the model to curate (`memory.session_summary`) / save (`memory.save`) as a required action when it applies, not a passive suggestion.
- It SHALL condition that action on real, memorable work having happened (a decision, fix, discovery, or files changed), preserving the model's discretion to skip trivial turns with nothing worth persisting — so the imperative does not induce vacuous summaries or noise saves.
- It SHALL NOT change the firing cadence, which is governed separately (summary on turn 1 and every `SUMMARY_NUDGE_EVERY`; save every `SAVE_NUDGE_EVERY`) and is unchanged by this requirement.

#### Scenario: Shared nudge text is imperative and work-conditioned

- **WHEN** the `nudge-fixtures.json` `summary` and `save` strings are inspected
- **THEN** each SHALL read as a directive to act (imperative) AND SHALL reference the real-work condition (decision / fix / discovery / files changed), not merely an unconditional "call X now"

#### Scenario: Nudge text stays byte-identical across clients

- **WHEN** `nudge-fixtures.test.ts` compares the bash, shared JS/TS, and Python nudge sources against `nudge-fixtures.json`
- **THEN** all SHALL match the shared fixture (Python's `_SUMMARY_HINT` SHALL equal `<memory-hint>${summaryCore}</memory-hint>`, `_SAVE_HINT` SHALL equal `<memory-hint>${saveCore}</memory-hint>`; bash turn-1 output SHALL equal `summary`; bash turn-5 output SHALL equal `save`)
- **AND** the JS/TS arm SHALL read the shared module, not any individual client file

#### Scenario: A client carrying its own nudge copy fails the build

- **GIVEN** a JS/TS client file declares its own nudge string constant instead of importing it
- **WHEN** `pnpm test` runs
- **THEN** the single-implementation invariant SHALL fail, naming the offending file and line

#### Scenario: Cadence constants are unchanged

- **WHEN** the cadence constants are inspected across clients (`SUMMARY_NUDGE_EVERY`, `SAVE_NUDGE_EVERY`, and the `turn === 1` summary trigger)
- **THEN** they SHALL be unchanged by this requirement — only the sourcing mechanism changes

## MODIFIED Requirements

### Requirement: Transcript-derived uploads MUST redact `<private>` spans client-side in every client

Any transcript-derived text a plugin sends to the server (session summaries, transcript snapshots, stop/pre-compact payloads, derived titles) SHALL have every `<private>…</private>` span replaced with `[REDACTED]` BEFORE the payload leaves the client. Matching SHALL be case-insensitive, SHALL span newlines, SHALL close each span at the first `</private>`, and an unclosed `<private>` SHALL redact through end-of-text (fail closed). All five clients (Claude Code, Codex CLI, Hermes Agent, opencode, Pi) SHALL implement identical observable semantics; the server SHALL NOT be relied upon to strip these tags.

There SHALL be exactly three implementations — bash, Python, and one shared JS/TS module (`apps/plugin/bin/rembric-plugin-core.mjs`) — and they SHALL be kept in agreement by the shared fixture set `apps/plugin/test/redaction-fixtures.json`. A new JS/TS client SHALL NOT add a fourth implementation; it imports the shared one, and the single-implementation invariant fails the build if it does otherwise.

Every implementation SHALL be exercised against **every** fixture in that set. The fixture arms SHALL be co-located in `apps/plugin/test/redaction.test.ts` and SHALL assert on the redaction function's own return value, not indirectly through a transport payload: an indirect arm cannot express the empty-input fixture and so silently skips it, which is how the JS/TS arm came to run 12 of 13.

#### Scenario: Private span in a bash-client transcript upload

- **WHEN** a Claude Code or Codex CLI session transcript contains `Connect to <private>postgresql://u:p@host/db</private> now`
- **THEN** every payload POSTed by the hook scripts SHALL contain `Connect to [REDACTED] now` and the original span SHALL NOT appear anywhere in the request body

#### Scenario: Multiline and case-variant spans

- **WHEN** the transcript contains `<PRIVATE>line one\nline two</Private>`
- **THEN** the uploaded text SHALL replace the whole span with a single `[REDACTED]`

#### Scenario: Unclosed private tag fails closed

- **WHEN** the transcript contains `<private>secret with no closing tag` followed by end-of-text
- **THEN** the uploaded text SHALL be redacted from the opening tag through end-of-text

#### Scenario: Hermes transcript formatting redacts before POST

- **WHEN** the Hermes plugin formats transcript entries containing a `<private>` span for upload
- **THEN** the formatted payload SHALL contain `[REDACTED]` in place of the span

#### Scenario: Every implementation runs every fixture

- **WHEN** the redaction fixture arms run
- **THEN** each of the three implementations (bash, Python, shared JS/TS) SHALL be asserted against every fixture in `apps/plugin/test/redaction-fixtures.json`, with none filtered out
- **AND** the asserted fixture count per arm SHALL equal the fixture file's length

#### Scenario: A fifth client inherits redaction with no new code

- **WHEN** the Pi client uploads a transcript-derived payload containing a `<private>` span
- **THEN** the span SHALL be replaced with `[REDACTED]` before the request leaves the process
- **AND** the redaction SHALL come from the shared JS/TS module, with no redaction code in the client's own source

## REMOVED Requirements

### Requirement: The per-turn save/summary nudge text MUST be a calibrated imperative shared byte-identical across all four clients

**Reason**: The requirement's own header states a client count ("all four clients") that this change makes false, and `openspec archive` matches requirements by header, so a `MODIFIED` block cannot rewrite it. `REMOVED` + `ADDED` is the mechanism this repository already uses for renames (`archive/2026-07-29-align-supply-chain-allowlist`, `archive/2026-06-07-rename-session-get-tool`). Re-added immediately below with the same policy, a client-count-free header, the fifth client's source named, and the sourcing mechanism tightened from "sourced from the fixture" to "sourced from the one shared module" for the JS/TS clients.

**Migration**: None for operators — the nudge strings are unchanged and remain byte-identical. For contributors: a JS/TS client no longer embeds the nudge constants; it imports them from `apps/plugin/bin/rembric-plugin-core.mjs`.

