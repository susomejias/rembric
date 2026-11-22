## ADDED Requirements

### Requirement: The Hermes prompt block MUST teach the unpersisted candidate flow

Hermes does not consume the server's `initialize.instructions`, so `system_prompt_block` cannot follow the server's `JUDGMENT_QUEUE_ENABLED` setting. It SHALL carry the guidance of the server's default: the text SHALL be byte-identical to the first paragraph of the `instructions` block the server builds with the judgment queue disabled (see the `mcp-api` capability under "Agent guidance MUST ask for a verdict only when it changes a memory while the judgment queue is disabled"). Its SAVE clause SHALL therefore direct `candidates[]` to `memory.compare` for `supersedes` and `conflicts_with` only, and SHALL NOT direct them to `memory.judge_batch`.

This overrides, in "Provider lifecycle method behavior", the part of the `system_prompt_block` bullet that names the `candidates[]`→`memory.judge` path. Every other clause of that requirement, including the 1500-character ceiling, stays in force.

Against a server run with `JUDGMENT_QUEUE_ENABLED=1`, a Hermes agent following this text records supersessions and contradictions through `memory.compare` and leaves the pending rows to the orphaning deadline. That degradation is accepted: the setting exists as a rollback, not as a supported long-term mode.

#### Scenario: The block matches the server's queue-disabled instructions

- **WHEN** Hermes calls `provider.system_prompt_block()`
- **THEN** the result SHALL equal the first paragraph of the server's `instructions` built for a path-scoped connection with the judgment queue disabled
- **AND** it SHALL contain `memory.compare only for supersedes/conflicts_with`
- **AND** it SHALL NOT contain `memory.judge_batch({judgments:[…]})`
