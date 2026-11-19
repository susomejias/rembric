## Why

At the start of a Claude Code session the agent receives three recall signals that disagree, and it follows the one that lets it skip the call:

1. `prompt-search.sh` (and the shared core used by opencode and Pi, and Hermes' `_RELEVANCE_HINT`) tells it, on the first prompt, to call `memory.context` with `focus` set to that prompt before responding.
2. `session-start.sh` tells it to call `memory.context` only "if this is a continuation of recent work".
3. The server says recall is on-demand: the `RECALL:` line of `initialize.instructions` conditions it on "if you lack prior detail", and the `memory.context` description says "do not load it speculatively on every session start".

Claude Code also loads the Rembric MCP tools as deferred tools, so before the first call the agent has to load the tool through a tool-search step that no hook mentions, one more step that makes skipping easier.

Observed on server 0.32.x with plugin 0.40–0.43: in a fresh Claude Code session both hook lines fired. The agent loaded `memory_context` through tool search, read the anti-speculative clause in its description, and skipped recall. Memories with 0.82–0.89 similarity to the task surfaced only at the first `memory.save`, as candidates.

The on-demand wording is deliberate. It is a token-cost decision (`openspec/changes/archive/2026-06-14-strengthen-memory-protocol-instructions/design.md`, D4), so this change reconciles it with the later first-prompt instruction instead of deleting it.

## What Changes

- `session-start.sh` no longer emits a `memory.context` instruction. It emits a generic deferred-tools hint instead: `rembric: If Rembric memory tools are deferred, load them via tool search before calling them.` (93 bytes, within the existing ≤100-byte budget). It appears on the plain path and, when a slug resolved, appended to the notice path's `additionalContext`.
- The `RECALL:` line of `initialize.instructions` becomes `... if you lack prior detail or a host hook asks.` The cap stays at 1500: the room is reclaimed from the opening line. Measured: 1466 (path-less), 1485 (unbound) and 1468 (path-scoped, 64-char slug).
- The Hermes `system_prompt_block` mirrors that change byte-for-byte.
- The `memory.context` description keeps "do not load it speculatively on every session start" and adds that a host hook asking for the call with `focus` on the first turn is not speculative, and that a speculative call is one with no `focus` that no hook requested (1521 → 1705 chars, under `DESCRIPTION_MAX_LENGTH` 1900).
- The first-prompt relevance line is unchanged in every client.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-plugin`: the SessionStart (startup|resume|clear|fork) hook emits the deferred-tools hint instead of a conditional recall line.
- `mcp-api`: new requirement that both server recall surfaces treat a host-requested focused first-turn call as expected.

## Impact

- `apps/plugin/scripts/session-start.sh`: the emitted line. Only Claude Code and Codex CLI run this script. opencode, Pi and Hermes do not run it and do not defer tools, so the hint never reaches them. They do receive the reworded instructions: Hermes through its mirrored `system_prompt_block`, and opencode and Pi through `initialize.instructions`.
- `packages/mcp/src/instructions.ts` and `apps/plugin/.hermes-plugin/__init__.py`: the opening and `RECALL:` lines.
- `packages/mcp/src/server.ts`: the `memory.context` description.
- Tests: `apps/plugin/test/{nudge-fixtures.json,nudge-fixtures.test.ts,project-resolution-sh.test.ts,session-hook-scripts.test.ts}`, `packages/mcp/src/instructions.test.ts`, `apps/web/src/test/{mcp-tool-surface,mcp-transport}.test.ts`.
- Releases: one PR moves both the `server` track (instructions and description) and the `plugin` track (`session-start.sh` and Hermes).
- Invariants touched: none.

## Archive order

`restore-memory-save-reminder` and `proactive-entity-recall` both MODIFY the `mcp-api` instructions requirement. `proactive-entity-recall` and `capture-subagent-learnings` both MODIFY the `claude-code-plugin` hook requirement. None of the three is archived yet.

This change only ADDS an `mcp-api` requirement, so it does not compete for that block. Its `claude-code-plugin` MODIFIED block is authored against the published text, so it SHALL be archived after those changes, re-based on the requirement as they publish it. Otherwise their later archive would silently revert the SessionStart line (`pnpm run check:delta-freshness` reports that case).
