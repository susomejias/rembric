## ADDED Requirements

### Requirement: Every model-facing session-summary surface MUST teach the exact Markdown heading format

The session-summary format SHALL be identical across the eight model-facing files pinned by the server invariant: `apps/server/src/mcp/instructions.ts`, `apps/server/src/mcp/server.ts`, `apps/plugin/scripts/prompt-nudge.sh`, `apps/plugin/scripts/stop-nudge.sh`, `apps/plugin/scripts/post-compact.sh`, `apps/plugin/commands/summary.md`, `apps/plugin/bin/rembric-plugin-core.mjs`, and `apps/plugin/.hermes-plugin/__init__.py`. Each SHALL carry the canonical directive from `sessions`: exactly `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, and `## Files`, in that order, as level-2 Markdown headings that belong on separate lines.

This eight-file set reaches all five bundled clients through the existing sharing boundaries: Claude Code and Codex CLI share the bash hooks, opencode and Pi consume the JS/TS core and server tool metadata, and Hermes carries the fixture-pinned Python text. No client-specific wording SHALL be introduced. A file with several summary instruction paths SHALL use the canonical directive in every one of them; one passing occurrence SHALL NOT license another flat occurrence in the same file.

#### Scenario: All eight surfaces carry the exact heading directive

- **WHEN** the invariant reads the eight tracked model-facing files
- **THEN** each SHALL carry the six canonical `##` headings in order and the separate-line instruction
- **AND** none SHALL carry the bare flat fragment `Goal · Accomplished · Decisions+why · Verified+how · Unfinished+why · Files`

#### Scenario: All five clients inherit the same format

- **WHEN** the emitted summary instruction is captured for Claude Code, Codex CLI, Hermes Agent, opencode, and Pi
- **THEN** every client SHALL direct the model to use the same six level-2 headings on separate lines
- **AND** any prefixes or host wrappers SHALL be the only permitted differences

#### Scenario: A format mutation fails the lock-step tests

- **WHEN** one heading loses its `##` prefix, moves position, is renamed, or an extra heading is appended in one surface
- **THEN** the invariant or cross-language fixture suite SHALL fail and name the divergent surface

## MODIFIED Requirements

### Requirement: The per-turn save/summary nudge text MUST be a calibrated imperative shared byte-identical across every client

The save and session-summary nudge strings emitted per-turn by every client — Claude Code and Codex via `apps/plugin/scripts/prompt-nudge.sh`, opencode and Pi via the shared JS/TS module `apps/plugin/bin/rembric-plugin-core.mjs`, Hermes via `prefetch()` (`apps/plugin/.hermes-plugin/__init__.py`) — SHALL be sourced from the single shared contract `apps/plugin/test/nudge-fixtures.json` (`save`, `saveCore`, `summaryCore`, `summary`) and SHALL be byte-identical across clients. Bash and the shared JS/TS module embed the `rembric:`-prefixed `summary`/`save` verbatim; Hermes wraps `saveCore`/`summaryCore` in `<memory-hint>…</memory-hint>` per its established convention. No individual JS/TS client SHALL carry its own copy of these strings — there is one JS/TS implementation and every JS/TS client imports it, so a newly added client is byte-identical by construction rather than by review.

The shared text SHALL be phrased as a calibrated imperative:

- It SHALL direct the model to curate (`memory.session_summary`) / save (`memory.save`) as a required action when it applies, not a passive suggestion.
- It SHALL condition that action on real, memorable work having happened (a decision, fix, discovery, or files changed), preserving the model's discretion to skip trivial turns with nothing worth persisting — so the imperative does not induce vacuous summaries or noise saves.
- It SHALL NOT change the firing cadence, which is governed separately (summary on turn 1 and every `SUMMARY_NUDGE_EVERY`; save every `SAVE_NUDGE_EVERY`) and is unchanged by this requirement.

**The summary string SHALL carry the canonical Markdown format but SHALL NOT carry the write's replace-and-rewrite semantics.** Formatting is needed at every curation prompt because the old inline `Goal · … · Files` list caused models to store one paragraph; replacement semantics remain on the longer tool, initialize, compaction, and end-of-turn surfaces. With the exact format directive the string measures 382 UTF-8 bytes against a 400-byte per-line cap. The divergent-counter firing turn measures approximately 903 bytes and is capped at 960; the ten-turn amortised cost measures approximately 42.6 tokens/turn and remains within the existing 45-token ceiling. These figures SHALL be re-measured from the final fixture in the same commit as the wording.

**`initialize.instructions` SHALL reclaim prose rather than raise its cap.** Blind substitution produces a binding variant of 1113 characters against 1000. The implementation SHALL preserve the 1000-character ceiling and every protocol obligation while shortening surrounding prose; no claimed headroom from the pre-format wording remains.

**The summary string SHALL NOT assert, or deny, that a summary already exists for the session.** One string has to be true in both states, and a claim about state is the one thing a state-blind reminder cannot make.

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

#### Scenario: The summary string is unchanged by the replace-and-rewrite contract

- **WHEN** the `summary` and `summaryCore` fixtures are inspected after the Markdown-format change
- **THEN** they SHALL still omit replace-and-rewrite semantics while requiring the canonical headings on separate lines
- **AND** the prefixed `summary` fixture SHALL be at most 400 UTF-8 bytes
- **AND** every published aggregate figure that contains this string SHALL be re-measured

#### Scenario: The summary string makes no claim about whether a summary exists

- **WHEN** the string is inspected
- **THEN** it SHALL neither assert nor deny that the session already carries a curated summary

### Requirement: The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full

A compaction is the moment at which the stored summary matters most and is least visible: the model that continues has lost the turns it would summarise, and this injection is the only instruction it receives before it acts. The block SHALL therefore be ordered read-then-write:

1. Read the stored summary (`memory.session_get`).
2. Write the session's CURRENT COMPLETE state with `memory.session_summary` — what was just read, brought up to date with the surviving window — and SHALL be told that the write replaces the stored value, so sending the window alone stores the window alone.
3. Recall further prior context (`memory.context` / `memory.search`) when what was read is not enough.

The block SHALL NOT ask for a summary of the compacted window, and SHALL NOT ask for "the compact summary shown above". Either framing, combined with a replacing write, is exactly the loss this contract exists to prevent: the model does as it is told and the stored summary becomes the window.

This block is also the compaction re-arm of the read directive specified in "A process that resumes a pre-existing session SHALL be told ONCE that a stored summary may exist". A compacted context is, for that purpose, a fresh attachment to a pre-existing session, and the injection at the compaction boundary is the earliest point at which the model can act on it — so it carries the directive itself rather than depending on a later reminder firing or on a relaxed first-ensure marker.

Where a client has NO compaction hook, this requirement SHALL NOT cause one to be added. That client's coverage is its always-present protocol block (`mcp-api`, "The `instructions` block MUST state that a curated summary write replaces the stored value"), which carries the replacement and current-state obligations on every turn but no `memory.session_get` directive. That is a named gap, not a solved problem.

The block SHALL keep every obligation it already carries: the `10000` cap substring and one copy of the text shared by the clients that use it. It SHALL add the exact canonical Markdown heading directive. A reworded block SHALL be re-measured, and the measurement SHALL be recorded rather than assumed: direct replacement measures 683 bytes, so the published cap becomes 700 UTF-8 bytes.

#### Scenario: The block asks for the current whole state, after a read

- **WHEN** the post-compaction injection is emitted
- **THEN** it SHALL direct the model to call `memory.session_get` before writing
- **AND** it SHALL ask for the session's current complete state
- **AND** it SHALL state that the write replaces the stored value

#### Scenario: The block carries no window-only framing

- **WHEN** the same text is inspected
- **THEN** it SHALL NOT ask for a summary of the compacted window, of "what THIS window did", or of the host's own compact summary

#### Scenario: The block keeps its published obligations

- **WHEN** the emitted block is measured and grepped
- **THEN** it SHALL contain the substring `10000`
- **AND** it SHALL require the six canonical `##` headings on separate lines
- **AND** it SHALL be ≤700 bytes in UTF-8

#### Scenario: One copy of the text

- **WHEN** the clients that inject at a compaction boundary are inspected
- **THEN** the text SHALL come from the shared fixture contract, byte-identical, with no per-client copy
