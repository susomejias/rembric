## Why

`memory.context.recentSessions[]` returns `{id, agent, startedAt, endedAt, status, summary}` but not the session `title`. A title (≤100 chars) is the most scannable index of a past session — it complements the ≤350-char summary snippet (headline + detail) and is especially useful when the summary is an ugly hook-fallback transcript. Surfacing it costs ~125 tokens (≤100 × 5 sessions).

## What Changes

- `memory.context.recentSessions[]` gains a `title` field, emitted **verbatim** as stored (`s.title`) — the curated title when the agent set one via `memory.session_summary`, otherwise the auto-generated placeholder. No hiding/filtering logic: `null`→`null`, populated→as-is.
- Read-side only: one line in the `recentSessions` mapping in `handleContext`. `recentForContext` already returns full rows, so `title` is available — no repository change.
- No migration, no data change, no plugin change. `title` is bounded to ≤100 chars at write time, so it is emitted as-is (not snippet-truncated).

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `sessions`: the `memory.context` output requirement is extended — `recentSessions[]` SHALL include `title`, emitted verbatim as stored.

## Impact

- **Code**: `apps/server/src/mcp/sessions-tools.ts` — add `title: s.title` to the `recentSessions` map in `handleContext`.
- **Spec**: `openspec/specs/sessions/spec.md` — MODIFY the `memory.context` display requirement to document the verbatim `title` field.
- **Tests**: `apps/server/src/test/mcp-integration.test.ts` — a session summarized with a `title` (via `memory.session_summary`) exposes that exact `title`; a content-bearing session never summarized with a title still exposes its (placeholder) `title` verbatim.
- **Invariants**: none touched (append-only, scope-at-service, `topic_key`, judgment freshness unaffected — pure read-side addition).
- **No impact**: storage, the `summary`/`title` write paths and precedence, the four plugin clients, and `memory.session_get` (still returns the full row incl. title).
