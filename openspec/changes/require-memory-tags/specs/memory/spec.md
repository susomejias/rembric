## ADDED Requirements

### Requirement: Supplied memory tags MUST be normalized before any save transaction

`MemoryService.saveWithTopicKey` SHALL normalize supplied tags with one private normalizer before opening any transaction or changing any memory or relation. For each tag it SHALL reject NUL, apply NFKC then locale-independent lowercase, collect Unicode word runs starting with a letter or number and continuing with letters, numbers, or combining marks, and join those runs with `-`. A supplied tag yielding no runs SHALL be rejected with `invalid_input` naming `tags`; it SHALL NOT be silently discarded. Normalized tags SHALL be deduplicated preserving first occurrence. Normalization SHALL be idempotent and SHALL NOT transliterate, strip accents, or merge semantic synonyms.

`SaveMemoryInput.tags` SHALL remain optional internally. Omitted or empty internal arrays SHALL retain the existing tagless-save behavior. Mandatory operational MCP tags are governed by the `mcp-api` capability, including when illustrative topic-key examples omit other required arguments. Historical rows SHALL remain readable without rewriting or read-time normalization. Prompt tags are outside this requirement.

#### Scenario: Normalize and deduplicate in first-occurrence order

- **WHEN** a service save supplies `[' Dashboard ', 'Deploy / Docker', 'deploy_docker', 'dashboard', 'bug-fix']`
- **THEN** persisted tags SHALL be `['dashboard', 'deploy-docker', 'bug-fix']` in that order
- **AND** saving those canonical tags again SHALL preserve the same values and order

#### Scenario: Preserve Unicode labels and compatibility equivalence

- **WHEN** tags include `['autenticación', 'autenticacio\u0301n', '部署 / 数据库', 'Ｄａｓｈｂｏａｒｄ']` (with `\u0301` denoting the combining acute accent)
- **THEN** persisted tags SHALL be `['autenticación', '部署-数据库', 'dashboard']`
- **AND** Unicode letters, numbers, and combining marks SHALL be retained rather than ASCII-transliterated or accent-stripped

#### Scenario: Canonical labels do not imply semantic merging

- **WHEN** a save supplies `['bug-fix', 'fix-bug']`
- **THEN** both labels SHALL persist unchanged and in order

#### Scenario: Reject every invalid supplied element

- **WHEN** a save supplies a valid tag followed by an empty string, whitespace-only string, punctuation-only string, emoji-only string, or a tag containing NUL, each invalid case tested separately
- **THEN** it SHALL fail with `invalid_input` naming `tags` before any insert or relation mutation
- **AND** the invalid element SHALL NOT be dropped to make the remaining array acceptable

#### Scenario: Invalid tags cannot supersede a topic predecessor

- **GIVEN** an active memory with a topic key and existing relations in the resolved scope
- **WHEN** a save with that same key supplies a NUL-containing or empty-after-normalization tag, each case tested separately
- **THEN** it SHALL fail before opening the save transaction
- **AND** memory and relation rows SHALL remain unchanged, including the predecessor's active status
- **AND** a subsequent valid tagged save with the same key SHALL still atomically insert the successor, supersede the predecessor, and record the existing topic-key relation

#### Scenario: Internal tagless saves remain supported

- **WHEN** an internal service caller omits `tags` or supplies `[]`
- **THEN** the save SHALL succeed subject to the existing non-tag validations
- **AND** existing seed/evaluation callers and tagless service tests SHALL NOT need synthetic labels

#### Scenario: Historical tags remain unchanged on read

- **GIVEN** a historical memory with absent tags or noncanonical tags such as `[' Dashboard ']`
- **WHEN** it is read through existing memory reads
- **THEN** its stored tag values SHALL be returned without canonicalization or backfill
