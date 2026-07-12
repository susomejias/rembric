## MODIFIED Requirements

### Requirement: The protocol nudge MUST be in `initialize.instructions` to cover all three clients uniformly

The MCP server's `initialize.instructions` string (loaded into the model's system prompt on connect) SHALL include a directive flow instructing the model to call `memory.session_summary` with `{title, summary}` at the end of every turn in which real work happened — never ending a working turn silent. The flow SHALL:

- Be present in both the path-scoped and path-less variants of `initialize.instructions`.
- Stay within the 1000-character cap enforced by `instructions.test.ts` (raised from 800; the cap is a self-imposed token budget, not a client or protocol limit).
- Be phrased as a **calibrated imperative**: a directive to curate (not a passive suggestion), **conditioned on real memorable work having happened** (a decision, fix, discovery, or files changed). It SHALL preserve the model's discretion to skip trivial turns with nothing worth persisting (so the imperative does not induce vacuous summaries), and SHALL NOT bind the trigger solely to the literal word "done".
- Describe the title constraint (≤100 chars, descriptive of what was worked on) and the summary structure (Goal · Discoveries · Accomplished · Next Steps · Files).

This nudge is the only mechanism that covers the case where Codex CLI cannot inject post-compact instructions and where short sessions never compact; it is likewise the only nudging surface available to in-process clients (e.g. Hermes Agent) that expose no per-turn hook. All clients ship with the same MCP server reachable, so this is the single deployment surface.

#### Scenario: Instructions string contains the protocol nudge

- **WHEN** an MCP client retrieves `initialize.instructions` from either `/mcp` or `/mcp/<slug>`
- **THEN** the string SHALL contain the substring `memory.session_summary` AND the substring `title` AND the substring `before` (referring to before ending a working turn)

#### Scenario: Instructions string respects the 1000-char cap

- **WHEN** the test suite runs `instructions.test.ts` against both variants
- **THEN** both outputs SHALL be ≤1000 characters

#### Scenario: Protocol nudge is imperative and work-conditioned

- **WHEN** the `initialize.instructions` SUMMARIZE flow is read
- **THEN** it SHALL read as a directive to curate (imperative), conditioned on real work having happened, rather than an unconditional or purely advisory phrasing

## ADDED Requirements

### Requirement: The per-turn save/summary nudge text MUST be a calibrated imperative shared byte-identical across all four clients

The save and session-summary nudge strings emitted per-turn by every client — Claude Code and Codex via `apps/plugin/scripts/prompt-nudge.sh`, opencode via `chat.message` (`apps/plugin/.opencode-plugin/plugin.ts`), Hermes via `prefetch()` (`apps/plugin/.hermes-plugin/__init__.py`) — SHALL be sourced from the single shared contract `apps/plugin/test/nudge-fixtures.json` (`save`, `summaryCore`, `summary`) and SHALL be byte-identical across clients. Bash and TS embed the `rembric:`-prefixed `summary`/`save` verbatim; Hermes wraps `summaryCore` in `<memory-hint>…</memory-hint>` per its established convention. The shared text SHALL be phrased as a calibrated imperative:

- It SHALL direct the model to curate (`memory.session_summary`) / save (`memory.save`) as a required action when it applies, not a passive suggestion.
- It SHALL condition that action on real, memorable work having happened (a decision, fix, discovery, or files changed), preserving the model's discretion to skip trivial turns with nothing worth persisting — so the imperative does not induce vacuous summaries or noise saves.
- It SHALL NOT change the firing cadence, which is governed separately (summary on turn 1 and every `SUMMARY_NUDGE_EVERY`; save every `SAVE_NUDGE_EVERY`) and is unchanged by this requirement.

#### Scenario: Shared nudge text is imperative and work-conditioned

- **WHEN** the `nudge-fixtures.json` `summary` and `save` strings are inspected
- **THEN** each SHALL read as a directive to act (imperative) AND SHALL reference the real-work condition (decision / fix / discovery / files changed), not merely an unconditional "call X now"

#### Scenario: Nudge text stays byte-identical across clients

- **WHEN** `nudge-fixtures.test.ts` compares the bash, TS, and Python nudge sources against `nudge-fixtures.json`
- **THEN** all SHALL match the shared fixture (Python's `_SUMMARY_HINT` SHALL equal `<memory-hint>${summaryCore}</memory-hint>`; bash turn-1 output SHALL equal `summary`; bash turn-5 output SHALL equal `save`)

#### Scenario: Cadence constants are unchanged

- **WHEN** the cadence constants are inspected across clients (`SUMMARY_NUDGE_EVERY`, `SAVE_NUDGE_EVERY`, and the `turn === 1` summary trigger)
- **THEN** they SHALL be unchanged by this requirement — only the nudge text changes
