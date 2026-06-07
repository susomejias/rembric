## Why

`memory.context` is read at (almost) every session start and is meant to be a cheap awareness payload. Today two of its text fields are emitted **verbatim**: session `summary` (up to the 2000-char cap) and user-prompt `content` (uncapped). The other two — memory `snippet` and relation `sourceSnippet`/`targetSnippet` — are already truncated, but at an ad-hoc 200 and with no shared bound. The verbatim session summaries alone cost ~10K chars (~2.5K tokens) at the default of 5 sessions, directly undercutting Rembric's token-efficiency promise. There is no single source of truth for "how much of each item context shows."

## What Changes

- Introduce a single module-level bound `CONTEXT_SNIPPET_CHARS = 350` in `apps/server/src/mcp/sessions-tools.ts` and apply it to **every text field** of the `memory.context` output via the existing `snippet(content, max)` helper:
  - `recentSessions[].summary` — was emitted verbatim; now `s.summary ? snippet(s.summary, CONTEXT_SNIPPET_CHARS) : null`.
  - `recentPrompts[].content` — was emitted verbatim; now `snippet(p.content, CONTEXT_SNIPPET_CHARS)`.
  - `recentMemories[].snippet` — was `snippet(…, 200)`; now uses the shared bound (200 → 350).
  - `pendingJudgments[].sourceSnippet` / `targetSnippet` — were `snippet(…, 200)`; now use the shared bound (200 → 350).
- 350 (chosen over the prior 200) gives each item a little more information while keeping the payload bounded; a single constant means the four fields can never drift apart.
- The default recent-session count stays at **5** (`args.sessions ?? 5`, unchanged). The cost driver was per-item size, not item count.
- **Read-side only.** Nothing about storage changes: the `sessions.summary` column, its `SUMMARY_MAX_CHARS = 2000` write cap, `summary_final` precedence, prompt rows, and memory rows are untouched. Full values remain retrievable verbatim via `memory.get`, the dashboard, and `memory.search`.
- No schema change, no migration, no `CHECK` change, no write-path change, no session-summary fallback change, no plugin-client change. The HTTP/MCP write contract is unchanged.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `sessions`: the `memory.context` output contract gains an explicit requirement that **every** text field it returns (session summary, prompt content, memory snippet, relation snippets) is display-truncated to a single shared bound (`CONTEXT_SNIPPET_CHARS`), while storage remains full and unbounded-by-this-change. This documents context-surfaced text as display snippets and removes the ad-hoc per-field literals.

## Impact

- **Code**: `apps/server/src/mcp/sessions-tools.ts` — `handleContext` only: add `CONTEXT_SNIPPET_CHARS` constant; route `recentSessions[].summary`, `recentPrompts[].content`, `recentMemories[].snippet`, and `pendingJudgments[].{source,target}Snippet` through `snippet(…, CONTEXT_SNIPPET_CHARS)`. The `snippet` helper already exists in-file.
- **Tests**: `apps/server/src/test/mcp-integration.test.ts` — assert a context response truncates an over-350-char session summary to ≤350 chars ending in `…`; a short summary passes through unchanged; a `NULL` summary yields `null`; and the stored row read back directly still returns the full untruncated summary. (`handleContext` is internal; the end-to-end MCP harness already exercises `memory.context`, so tests live there rather than in the co-located `sessions-tools.test.ts`.)
- **Spec**: `openspec/specs/sessions/spec.md` — add the `memory.context` display-truncation requirement covering all four text fields.
- **Invariants**: none touched. Append-only storage, scope-at-service, `topic_key`, and judgment freshness are all unaffected — this changes only what the read-side context handler emits.
- **No impact**: DB schema/migrations, the 2000-char `summary` `CHECK`, the session-summary write path (`writeSummary`/`final` precedence), HTTP `POST /:slug/sessions/:id/summary`, and the four plugin clients (all POST-and-forget; none read context text back).
