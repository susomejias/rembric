## ADDED Requirements

### Requirement: Recall guidance MUST treat a host-requested focused first-turn call as expected

The on-demand recall rule ("call `memory.context` only when you lack the prior detail you need, never speculatively on every session start") and the plugin's first-prompt relevance instruction ("call `memory.context` with `focus` set to this prompt before responding") SHALL NOT read as a contradiction to the model. Both server surfaces that carry the on-demand rule SHALL name the host hook as a reason to call:

1. The `RECALL:` line of `initialize.instructions` SHALL condition recall on the agent lacking prior detail OR a host hook asking for it, in every variant. The line SHALL keep the substring `if you lack prior detail`, so the on-demand flow required by "The MCP `initialize` response MUST ship a protocol-teaching `instructions` block" is unchanged for a connection with no host plugin. The block SHALL stay within `INSTRUCTIONS_MAX_LENGTH` without raising it; the room SHALL be reclaimed from the opening line, which carries no published obligation beyond the loop framing.
2. The `memory.context` tool description SHALL keep its guard against a speculative load on every session start, and SHALL add that a host hook asking for the call with `focus` on the first turn is not speculative and is to be acted on before responding. It SHALL define a speculative call as one with no `focus` that no hook requested. The description SHALL stay within `DESCRIPTION_MAX_LENGTH`.

The Hermes `system_prompt_block` mirrors the instructions block byte-for-byte (`hermes-agent-plugin`), so the `RECALL:` change SHALL land in both in the same commit.

The defect this closes was observed, not inferred: in Claude Code the first-prompt instruction and a conditional SessionStart line both fired, the agent loaded the deferred `memory_context` tool, read "do not load it speculatively on every session start" in its description, and skipped the call; memories with 0.82–0.89 similarity to the task surfaced only later, as save-time candidates.

#### Scenario: The RECALL line names the host hook in every variant

- **WHEN** `buildInstructions(ctx)` is built for the path-less, the unbound and the path-scoped (64-character slug) variants
- **THEN** each `RECALL:` line SHALL contain `if you lack prior detail or a host hook asks`
- **AND** each variant SHALL be `INSTRUCTIONS_MAX_LENGTH` characters or fewer

#### Scenario: The memory.context description separates a hook-requested call from a speculative one

- **WHEN** a client lists the tools
- **THEN** the `memory.context` description SHALL contain `do not load it speculatively on every session start`
- **AND** it SHALL state that a host hook asking for the call with `focus` on the first turn is not speculative and is to be made before responding
- **AND** it SHALL define a speculative call as one with no `focus` that no hook requested
- **AND** it SHALL be `DESCRIPTION_MAX_LENGTH` characters or fewer
