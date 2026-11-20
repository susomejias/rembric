## Why

After a compaction the agent receives the post-compaction block, which tells it to call `memory.session_get_batch({ ids: [sessionId] })` and then `memory.session_summary({title, summary})`. `sessionId` is a name, not a value. The literal id reaches the model only through the turn-1 `sessionId="…"` line, and the host's compaction summary does not always keep that line. When the id is gone, the server's own instructions say "Pass known sessionId; never guess", and the agent skips both steps rather than guess.

Measured with Claude Code auto-compaction against a local server (Sonnet, interactive): in 9 of 11 runs the compaction summary lost the id, and in all 9 the agent made no Rembric call after the block. Six of the nine said why, in the same words: it had no session id and would not guess one. With this change's block, the agent made both calls in 3 of the 5 runs whose summary had lost the id (Fisher exact, one-sided p = 0.027). The two that did not gave other reasons: the tools were not loaded, and the step was not part of the user's request. Opus kept the id in every summary, so it acted with either block.

## What Changes

- The post-compaction block names the session when the client knows its id: the read becomes `memory.session_get_batch({ ids: ["<id>"] })` and the write becomes `memory.session_summary({sessionId, title, summary})`. Nothing else in the block changes.
- When the client has no id, it emits the current symbolic block unchanged. It never emits an empty id.
- The shared fixtures gain the template (`postCompactTemplate`, `postCompactCoreTemplate`, placeholder `{{SESSION_ID}}`), next to the symbolic `postCompact` and `postCompactCore`. The JS/TS core exports the template and one renderer.
- The rendered block is 669 bytes (660 without the `rembric:` prefix) with a 36-character id, inside the existing ≤700-byte cap. No cap moves.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `plugin-session-protocol`: new requirement that the post-compaction block names the session it applies to when the client knows the id.

## Impact

- `apps/plugin/scripts/post-compact.sh` (Claude Code and Codex CLI), `apps/plugin/bin/rembric-plugin-core.mjs` and its `.d.mts`, `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.hermes-plugin/__init__.py`. Pi has no compaction hook and is unchanged. The opencode 2.x shape injects no post-compaction text and is unchanged.
- Tests: `apps/plugin/test/{nudge-fixtures.json,nudge-fixtures.test.ts}`, `apps/plugin/.opencode-plugin/plugin.test.ts`, `apps/plugin/.hermes-plugin/tests/test_post_compact_directive.py`, and the one-source grep in `apps/web/src/test/invariants.test.ts`.
- Releases: `plugin` track only. No server change.
- Invariants touched: none.

## Archive order

This change only ADDS a `plugin-session-protocol` requirement and does not compete for any MODIFIED block, so it has no archive-order constraint. It is independent of `reconcile-session-start-recall`: both edit `nudge-fixtures.json` and `nudge-fixtures.test.ts`, but in different keys and tests.
