## REMOVED Requirements

### Requirement: The protocol nudge MUST be in `initialize.instructions` to cover all three clients uniformly

**Reason**: Re-added below with the same normative content, but two things had to change that a `MODIFIED` block cannot express. First, the **requirement header** states a count ("all three clients") that has been wrong since the fourth client landed; a header change is only expressible as `REMOVED` + `ADDED`, and `openspec validate` rejects the pair when the header is unchanged. Second, the rationale paragraph asserted that `initialize.instructions` "is likewise the only nudging surface available to in-process clients (e.g. Hermes Agent)" — which `hermes-agent-plugin/spec.md:81` denies verbatim: _"Hermes does NOT consume the MCP server's `initialize.instructions` block"_. Two published requirements have contradicted each other since 2026-06-14; this re-adds the one that was wrong.

**Migration**: None. No behaviour, configuration, code path or file changes. The nudge's content, its two variants, its 1000-character cap and its calibrated-imperative phrasing are all carried through unchanged; only the header and the per-client rationale are corrected.

## ADDED Requirements

### Requirement: The protocol nudge MUST live in `initialize.instructions`, and every client MUST reach it or document its own equivalent

The MCP server's `initialize.instructions` string (loaded into the model's system prompt on connect) SHALL include a directive flow instructing the model to call `memory.session_summary` with `{title, summary}` at the end of every turn in which real work happened — never ending a working turn silent. The flow SHALL:

- Be present in both the path-scoped and path-less variants of `initialize.instructions`.
- Stay within the 1000-character cap enforced by `instructions.test.ts` (raised from 800; the cap is a self-imposed token budget chosen for token cost rather than the binding limit — Claude Code truncates `instructions` at 2048 characters, so the self-imposed cap binds first; the `mcp-api` capability holds the authoritative statement).
- Be phrased as a **calibrated imperative**: a directive to curate (not a passive suggestion), **conditioned on real memorable work having happened** (a decision, fix, discovery, or files changed). It SHALL preserve the model's discretion to skip trivial turns with nothing worth persisting (so the imperative does not induce vacuous summaries), and SHALL NOT bind the trigger solely to the literal word "done".
- Describe the title constraint (≤100 chars, descriptive of what was worked on) and the summary structure, carried verbatim from the canonical section list defined in `sessions` rather than restated here. The list names, at minimum, the goal, what was accomplished, the decisions taken AND why, what was verified AND how, what was left unfinished AND why, and the files that matter — the three `+why`/`+how` sections exist because the code records what changed and never why it beat the alternative nor what evidence a claim rests on.

This nudge is the only mechanism that covers the case where Codex CLI cannot inject post-compact instructions and where short sessions never compact. All clients ship with the same MCP server reachable, so this is the single deployment surface for every client whose host consumes it.

**Which clients consume it is a per-client fact, and this requirement SHALL state only what is verified.** Claude Code and Codex CLI consume it host-side. Pi consumes it in-extension: `apps/plugin/.pi-plugin/index.ts` appends `mcp.instructions()` to `event.systemPrompt` in `beforeAgentStart`, so it reaches the harness's prompt like the others. **Hermes Agent does NOT** — see the `hermes-agent-plugin` capability, whose `system_prompt_block` requirement exists precisely because of that, and returns the same BASE text byte-identically across the TS/Python boundary. No prose, spec text, code comment or documentation SHALL name Hermes among the consumers of `initialize.instructions`; a client that does not consume it reaches parity by carrying its own equivalent surface, and that surface is what must be named instead.

#### Scenario: Instructions string contains the protocol nudge

- **WHEN** an MCP client retrieves `initialize.instructions` from either `/mcp` or `/mcp/<slug>`
- **THEN** the string SHALL contain the substring `memory.session_summary` AND the substring `title` AND the substring `before` (referring to before ending a working turn)

#### Scenario: Instructions string respects the 1000-char cap

- **WHEN** the test suite runs `instructions.test.ts` against both variants
- **THEN** both outputs SHALL be ≤1000 characters

#### Scenario: Protocol nudge is imperative and work-conditioned

- **WHEN** the `initialize.instructions` SUMMARIZE flow is read
- **THEN** it SHALL read as a directive to curate (imperative), conditioned on real work having happened, rather than an unconditional or purely advisory phrasing

#### Scenario: No surface claims Hermes consumes `initialize.instructions`

- **WHEN** every tracked surface that names the consumers of `initialize.instructions` is read — at minimum `apps/server/src/mcp/instructions.ts`'s header comment, `docs/agents.md`, `docs/troubleshooting.md`, `apps/plugin/.hermes-plugin/README.md`, and this capability's own rationale
- **THEN** none of them SHALL list Hermes Agent among the clients that receive the block
- **AND** each SHALL name Pi among the clients that do
- **AND** where a surface explains how Hermes reaches the same guidance, it SHALL name `system_prompt_block` rather than `initialize.instructions`
