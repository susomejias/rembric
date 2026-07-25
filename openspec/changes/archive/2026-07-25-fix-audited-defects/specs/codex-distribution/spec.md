## ADDED Requirements

### Requirement: The Codex post-compaction block MUST share the English protocol text

Codex CLI and Claude Code invoke the same post-compaction script, so the language defect and its fix apply to both clients simultaneously. The Codex hook manifest SHALL continue to invoke the shared script, and the English protocol text SHALL be asserted once in the shared fixtures rather than duplicated per client — a per-client copy is a sync bug by the plugin-tree discipline.

#### Scenario: Codex emits the same English block

- **WHEN** the Codex post-compaction hook fires
- **THEN** the emitted protocol block SHALL be byte-identical to the block emitted for Claude Code

#### Scenario: No per-client copy of the text exists

- **WHEN** the plugin tree is inspected for the post-compaction protocol text
- **THEN** exactly one copy SHALL exist outside the test fixtures
