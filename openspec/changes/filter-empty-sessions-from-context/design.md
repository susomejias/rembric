## Context

Two tightly-related call sites in `apps/server/src/services/agent-sessions.ts` already encode "this session has no content worth keeping":

- `countPurgeableEmpty()` (lines 597-612 today) — counts rows the purge job will delete.
- `purgeEmpty({adminBypass})` (lines 628-660 today) — performs the deletion.

The shared sub-predicate is:

```
summary IS NULL
AND title_final = 0
AND NOT EXISTS (SELECT 1 FROM memory        WHERE session_id = s.id)
AND NOT EXISTS (SELECT 1 FROM prompts       WHERE session_id = s.id)
AND NOT EXISTS (SELECT 1 FROM confirmations WHERE session_id = s.id)
```

Both call sites write this inline. The day someone adds a fourth content-bearing table that anchors to a session id, one site will update and the other will silently diverge. The OpenSpec invariant test surface does not catch SQL drift between two locations writing the same predicate.

`memory.context.recentSessions` is the third call site that wants this concept, in inverted form ("show me sessions that DO have content"). Adding a third inline duplicate would make the drift problem worse.

## Goals / Non-Goals

**Goals:**

- Single source of truth for the "session has content" predicate.
- `memory.context.recentSessions` returns useful sessions instead of noise. Default behavior — no opt-in flag required.
- Filter-then-truncate ordering (Option B): a `limit:5` request returns up to 5 _useful_ sessions, naturally backfilling past empty ones, instead of returning fewer-than-5 because empties consumed the top of the list.
- Zero migration. Zero schema change. Zero trigger. Zero backfill.
- Purge behavior MUST be byte-identical after the refactor (verified by test).

**Non-Goals:**

- Materialize the predicate as a stored column. SQLite generated columns cannot reference other tables; a denormalized cache would require triggers on three tables + a sync invariant + backfill, against zero perf gain (read path is ≤25 rows, ≈75 index probes total).
- Expose an `includeEmpty` arg on `memory.context`. The dashboard already shows all sessions; the MCP surface is for agents, who want signal not completeness.
- Filter empty sessions out of `memory.stats` or `/dashboard/sessions`. Operators need to see them to decide on purge.
- Apply a grace period. The 1h grace in `purgeEmpty` exists because DELETE can race with late summary writes; SELECT cannot race destructively.

## Decisions

### Decision 1 — Read-time predicate, not materialized

A `has_content` cached column on `sessions` would buy O(1) reads but cost:

- A migration + backfill.
- Triggers (or service-layer mutation) on `memory`, `prompts`, `confirmations` to flip the flag false→true on first content write.
- A new sync invariant ("cached value equals real value") with its own test.
- An UPDATE-on-write pattern that rubs against the append-only spirit of `sessions`, even though `has_content` is monotonic.
- The invariant test that white-lists files allowed to UPDATE `sessions` would need to widen.

The read path being optimized is `memory.context.recentSessions`. It is clamped to ≤25 rows. Per row, the predicate runs three EXISTS subqueries, each hitting an existing `idx_*_session_id` index (single-key lookups). Total work per `memory.context` call: roughly 75 index probes plus the base session sweep. Not a hot path, not a perf bottleneck.

**Decision:** Stay in code. Extract the predicate as a shared SQL fragment builder. Pay the read cost; skip the schema cost.

### Decision 2 — Filter-then-truncate (Option B)

Two query shapes were on the table:

```
Option A — Truncate-then-filter:
  SELECT * FROM (
    SELECT * FROM sessions WHERE scope AND deleted_at IS NULL
    ORDER BY started_at DESC LIMIT N
  ) WHERE has_content
  → returns ≤N rows; if top of list is empty, returns fewer than N.

Option B — Filter-then-truncate:
  SELECT * FROM sessions
   WHERE scope AND deleted_at IS NULL AND has_content
   ORDER BY started_at DESC LIMIT N
  → always returns up to N useful rows; naturally backfills past empties.
```

B is also the simpler SQL — single WHERE, no subquery. The natural query plan walks the `(scope, started_at DESC)` index until it has collected `limit` matching rows, then stops. Worst case (all sessions are empty) it sweeps the whole index for the scope; that's the same cost the user already pays today for purge counting.

**Decision:** Filter-then-truncate (B).

### Decision 3 — Helper signature

```ts
function sessionHasContentSql(alias: string): SqlFragment {
  return sql.raw(`(
    ${alias}.summary IS NOT NULL
    OR ${alias}.title_final = 1
    OR EXISTS (SELECT 1 FROM memory        WHERE session_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM prompts       WHERE session_id = ${alias}.id)
    OR EXISTS (SELECT 1 FROM confirmations WHERE session_id = ${alias}.id)
  )`);
}
```

The `alias` arg is what callers use to reference the sessions row (`s` in `countPurgeableEmpty`/`purgeEmpty`, the implicit drizzle alias in `recentForContext`). The helper is private to `apps/server/src/services/agent-sessions.ts` — it is not exported and not consumed outside this service. The full predicate's normative spec sits in `openspec/specs/sessions/spec.md`; the helper is the implementation expression of that spec.

### Decision 4 — No opt-out on the MCP surface

`memory.context({includeEmpty: true})` was considered. Rejected for now:

- The dashboard already gives operators a complete view.
- Adding the arg means specifying its scenarios and tests, widening the surface for a use case nobody has asked for.
- YAGNI. Re-introducing it later is a non-breaking additive change.

### Decision 5 — Caller's own session is not specially excluded

A naive instinct is "the session currently calling `memory.context` should never appear in its own `recentSessions`". This requires the service to know the active session id of the request, which couples the service layer to MCP request state. Instead, the content filter handles this naturally:

- A brand-new session that has saved nothing yet → no content → filtered out. ✓
- A session mid-task that already saved memories → has content → returned. This is correct: the agent benefits from seeing its own audit trail in compact form.

## Risks / Trade-offs

- **Agents that asserted on `recentSessions[*].id` matching the caller's own session id** would break. Mitigation: grep shows the only such assertion lives in `apps/server/src/test/mcp-integration.test.ts:266` (`recentSessions.find((s) => s.id === startedPayload.sessionId)`); we update that test as part of the change to capture content before asserting.
- **Edge case:** a session with `title_final = 1` but empty `title` and no other content. Today this is impossible — `title_final` is only set when a title is written. Belt-and-braces: the predicate uses `title_final = 1` rather than `title IS NOT NULL` for parity with `purgeEmpty`'s definition of "labeled".
- **Cost of the EXISTS scans** if the user's instance grows to 100k+ sessions per scope: bounded by `LIMIT N` short-circuit in B. The query plan stops as soon as N matching rows are collected.

## Migration / Rollout

- Single PR. No DB migration. No env var changes.
- Tests cover: the refactored purge predicate produces the same `deletedIds` as before; `recentForContext` excludes empty sessions; integration scenario for `memory.context` confirms the bootstrap snapshot is signal-only.
- No coordinated rollout across plugin clients required — the change is server-internal.
