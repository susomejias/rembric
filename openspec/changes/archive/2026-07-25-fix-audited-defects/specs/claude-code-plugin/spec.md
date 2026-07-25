## ADDED Requirements

### Requirement: All agent-facing text MUST be English and lock-step tested

Agent-facing instruction text is a protocol surface, not user copy. The post-compaction protocol block is currently emitted in Spanish while every other agent-facing string in the product is English, and it fires at the moment of highest consequence — the model has just lost its context and this text is the only instruction telling it what to persist before continuing. A mid-conversation language switch degrades instruction-following and reliably causes the model to continue answering in that language, which is user-visible.

Every string emitted to a model by the plugin SHALL be English. Each such string SHALL be represented in the shared nudge fixtures and asserted in lock-step against the equivalent string in every other client that emits it, with a character budget, matching the discipline already applied to the save, summary, and session-id nudges.

#### Scenario: The post-compaction block is English

- **WHEN** the post-compaction hook emits its protocol block
- **THEN** the emitted text SHALL be English

#### Scenario: The block is covered by the shared fixtures

- **WHEN** the post-compaction text diverges from the equivalent text in another client
- **THEN** the lock-step fixture test SHALL fail and the build SHALL be rejected

#### Scenario: The block stays within its budget

- **WHEN** the post-compaction text exceeds its documented character budget
- **THEN** the fixture test SHALL fail
