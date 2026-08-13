## Why

Curated dashboard summaries are still rendered as one flat paragraph because every model-facing summary instruction presents the six fields as a dot-separated inline list, so agents reproduce that shape even though the dashboard correctly renders stored Markdown through `mdBody`. The defect is present in the server guidance and the shared plugin guidance consumed by all five clients; the existing invariant proves the eight files agree with one another, but only on the wrong flat text.

## What Changes

- Define the canonical session-summary structure as these exact Markdown level-2 headings, in this order and each on its own line: `## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`, `## Unfinished+why`, `## Files`. Keep layout advisory at the storage boundary: free-form summaries remain accepted.
- Replace the flat `Goal · … · Files` instruction in all eight invariant-pinned surfaces: the server's MCP initialize instructions and `memory.session_summary` description; the shared Claude Code/Codex prompt, end-of-turn, and post-compaction hooks; the shared summary command; the JS/TS core consumed by opencode and Pi; and Hermes's Python guidance.
- Strengthen the existing invariant and cross-language fixture tests so they reject an inline dot-separated rubric, missing/reordered headings, extra headings, or instructions that do not say each heading belongs on its own line.
- Preserve the shared-plugin architecture: Claude Code and Codex continue to share bash resources, opencode and Pi continue to import the one JS/TS core, and Hermes keeps only its required Python copy pinned to the same fixtures. No client receives a private variant.
- Reclaim prose so both MCP initialize-instruction variants remain within the existing 1000-character cap. Deliberately raise and re-measure only the plugin fixture caps that the canonical wording cannot satisfy (`summary` and `postCompact`) and the aggregate firing-turn budgets that contain them; do not loosen unrelated budgets.
- Add plugin unit/fixture coverage and a real dev-Docker end-to-end pass across the five client delivery paths, including a stored canonical summary rendered as six separate dashboard sections.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sessions`: make the documented canonical structure an exact six-heading Markdown contract while retaining unenforced/free-form storage.
- `mcp-api`: require both server-owned summary guidance surfaces to carry the heading-format instruction and stay within their existing MCP length ceilings.
- `plugin-session-protocol`: require lock-step canonical Markdown wording across the shared nudge, command, compaction, end-of-turn, JS/TS, and Python paths used by all five clients.
- `claude-code-plugin`: replace the obsolete byte/token measurements and caps for the longer shared summary and post-compaction fixtures.
- `hermes-agent-plugin`: correct the lifecycle requirement's stale flat section list and pin `system_prompt_block` to the same exact heading contract as the server.

## Impact

- Server guidance/tests: `apps/server/src/mcp/summary-rubric.ts`, `apps/server/src/mcp/instructions.ts`, `apps/server/src/mcp/server.ts`, `apps/server/src/mcp/instructions.test.ts`, `apps/server/src/test/invariants.test.ts`, and MCP integration tests.
- Shared plugin guidance/tests: `apps/plugin/scripts/{prompt-nudge,stop-nudge,post-compact}.sh`, `apps/plugin/commands/summary.md`, `apps/plugin/bin/rembric-plugin-core.mjs`, `apps/plugin/.hermes-plugin/__init__.py`, `apps/plugin/test/nudge-fixtures.json`, `apps/plugin/test/nudge-fixtures.test.ts`, and affected per-client tests for Hermes, opencode, and Pi.
- Distribution: one unified plugin change reaches Claude Code, Codex CLI, Hermes Agent, opencode, and Pi; no per-client copies, protocol fields, dependencies, migrations, or dashboard renderer changes.
- Existing installations: stored summaries are untouched and require no migration or derived-data invalidation. First boot after upgrade changes only future model guidance; rollback restores the old guidance without affecting `sessions.summary`, `session_summary_versions`, `memory_fts`, `memory_vec`, or entity tables. Append-only memory, service-layer scope, `topic_key`, and judgment-freshness invariants are unaffected.
