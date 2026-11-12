## Why

Pending work recorded in a session summary never reaches the next session (issue #451).

- `memory.context` shows each recent session as a snippet of the first `CONTEXT_SNIPPET_CHARS = 350` characters of its summary. With the canonical section order, those characters are `## Goal` and the start of `## Accomplished`. `## Unfinished+why` is the fifth of six sections, so it never appears.
- The only paths that read the whole summary are `memory.session_get_batch` after a compaction and after a resume. Both read the same session's own summary. A new conversation that continues the work reads only the snippets.
- Measured on 2026-11-12 over every session in project `rembric` from 2026-10-16 to 2026-11-12: 29 sessions in total, of which 20 list real pending items. In a sample of 15 items, 8 (about 53%) never appear in any later session, even after counting git history as evidence of completion. No item was ever recorded as explicitly abandoned.
- In 16 recent sessions with a real `## Unfinished+why` section, the section body measured a median of 474 characters, a p75 of 703 and a maximum of 844.

The issue proposes durable todos with explicit states. That entity is deferred: it adds a tool, extra calls per session, and fixed instruction tokens, and it overlaps with the task lists that agent hosts and users already keep. This change tries the cheapest step first, making pending work visible. The same measurement will be repeated after it ships, to decide whether the entity is still needed.

## What Changes

- **The recent-session snippet shows pending work.** When a summary has a `## Unfinished+why` section whose body lists something, `recentSessions[].summary` carries that section (heading plus trimmed body) instead of the summary's opening.
- **Bounds.** The snippet is bounded by `CONTEXT_PENDING_CHARS = 600`. 11 of the 16 measured sections fit entirely; at most 250 characters are added per session over the current 350.
- **Fallback.** A summary with no such section, or whose section only says nothing is pending (`none`, `nothing`, `n/a`, `nada`, `ninguna`, `ninguno`, `—`, `-`, optionally followed by a period), keeps today's 350-character opening snippet.
- **Description.** The `memory.context` description says what the snippet shows.
- **Spec drift fixed.** The requirement this change rewrites stated a default of 5 recent sessions. The handler and the tool description use 3, so the rewritten text states 3.

Not in scope:

- A todo entity.
- Changing the canonical summary sections or the five clients.
- Updating a stale `## Unfinished+why` within the session that wrote it.

## Capabilities

### Modified Capabilities

- `sessions`: renames and modifies the `memory.context` display-truncation requirement. Every text field stays bounded, but the recent-session summary snippet may show the pending-work section under its own, wider bound.

## Impact

- **Server:** `packages/core/src/services/summary-sections.ts` (`pendingSection`), `packages/mcp/src/memory-tools.ts` (`sessionSnippet`, `CONTEXT_PENDING_CHARS`) and `packages/mcp/src/server.ts` (the `memory.context` description, +77 characters).
- **Docs:** `docs/agents.md` names the exception to the 350-character bound.
- **No schema change, no new tool, no client or plugin change.** Rollback is a plain revert.
- **Tokens.** Each `memory.context` response grows by at most about 60 tokens per recent session that lists pending work; the description adds about 20 tokens to `tools/list`.
