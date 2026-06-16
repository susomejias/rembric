## ADDED Requirements

### Requirement: Every MCP tool MUST advertise behavioral annotations

Every tool registered on the MCP server SHALL declare an `annotations` object consistent with Rembric's append-only and closed-store invariants. The annotation set SHALL satisfy:

- Read-only tools (`memory.search`, `memory.get`, `memory.context`, `memory.session_get`, `memory.timeline`, `memory.search_prompts`, `memory.doctor`, `memory.about`, `memory.stats`, `memory.suggest_topic_key`, `project.list`, `project.current`) SHALL carry `readOnlyHint: true`.
- Mutating tools SHALL carry `readOnlyHint: false`.
- Because no tool performs an irreversible destructive update (supersede is a reversible, journaled `status` flip; rows are never deleted), **every** tool SHALL carry `destructiveHint: false`.
- Because Rembric is a closed local store, **every** tool SHALL carry `openWorldHint: false`.
- Tools whose repeated invocation is side-effect-free or last-call-wins (`memory.compare`, `memory.session_end`, `memory.session_summary`, `memory.suggest_topic_key`, and all read-only tools) SHALL carry `idempotentHint: true`.

Annotations are advisory metadata only: they SHALL NOT change tool inputs, outputs, or the `text` result contract.

#### Scenario: Read-only tools report readOnlyHint

- **WHEN** a client calls `tools/list`
- **THEN** each of `memory.search`, `memory.get`, `memory.context`, `memory.session_get`, `memory.timeline`, `memory.search_prompts`, `memory.doctor`, `memory.about`, `memory.stats`, `memory.suggest_topic_key`, `project.list`, and `project.current` SHALL report `annotations.readOnlyHint === true`

#### Scenario: No tool is advertised as destructive

- **WHEN** a client calls `tools/list`
- **THEN** every registered tool SHALL report `annotations.destructiveHint === false`

#### Scenario: No tool is advertised as open-world

- **WHEN** a client calls `tools/list`
- **THEN** every registered tool SHALL report `annotations.openWorldHint === false`

#### Scenario: Mutating tools are not marked read-only

- **WHEN** a client calls `tools/list`
- **THEN** `memory.save`, `memory.confirm`, `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, `memory.session_summary`, `memory.session_end`, `memory.judge`, `memory.compare`, and `project.use` SHALL report `annotations.readOnlyHint === false`

#### Scenario: Annotations do not alter the result contract

- **WHEN** any annotated tool is invoked successfully
- **THEN** the result SHALL still be returned as a `text` content block (no `structuredContent` is required), unchanged from the pre-annotation behavior
