## Why

`memory.context.recentSessions` is the agent's bootstrap snapshot — the first read of every Rembric-aware turn. Today it returns the N most-recent sessions for the scope, filtered only by `deleted_at IS NULL`. In practice this means slots are routinely consumed by sessions with `status = 'active'`, `summary = NULL`, `ended_at = NULL`, and zero referencing rows in `memory`, `prompts`, or `confirmations`. They tell a future reader nothing.

Observed on 2026-05-21 from the running stack: a default `memory.context` call returned 5 sessions where 3 were active+null-summary+no-content. Effective signal: 1 of 5 slots.

The repo already formalizes a "useful session" concept implicitly via `AgentSessionsService.countPurgeableEmpty`/`purgeEmpty` (specified in `openspec/specs/sessions/spec.md::"Sessions MAY be physically purged when empty"`). The predicate is duplicated inline in two places today, with latent drift risk: the day a fourth content-bearing table is added, one site will be updated and the other will not. This change pays down that risk and reuses the negation to give `memory.context` a content filter.

## What Changes

- **EXTRACT** a single source-of-truth SQL fragment `sessionHasContentSql(alias)` in `apps/server/src/services/agent-sessions.ts`. Definition: `summary IS NOT NULL OR title_final = 1 OR EXISTS (SELECT 1 FROM memory m WHERE m.session_id = <alias>.id) OR EXISTS (SELECT 1 FROM prompts p WHERE p.session_id = <alias>.id) OR EXISTS (SELECT 1 FROM confirmations c WHERE c.session_id = <alias>.id)`.
- **REFACTOR** `countPurgeableEmpty` and `purgeEmpty` to consume `sessionHasContentSql` (their existing inline predicates are replaced by `NOT sessionHasContentSql(s)` + the unchanged grace/status clauses). No behavior change in purge.
- **MODIFY** `AgentSessionsService.recentForContext(input)` to apply `AND sessionHasContentSql(sessions)` by default. Ordering and limit semantics unchanged: filtered candidates are still ordered by `started_at DESC`, then truncated to `limit`. This is Option B (filter-then-truncate) — a sweep finds the N most-recent _useful_ sessions, naturally backfilling past empty ones.
- **NO new arg** on `memory.context`. The operator-facing escape hatch for inspecting empty sessions is the existing `/dashboard/sessions` view (which already shows everything). Keeping the MCP surface minimal preserves the bootstrap-snapshot intent: never noise.
- **PRESERVE** existing soft-delete filter: `recentForContext` retains `AND deleted_at IS NULL` in lock-step with the content filter.
- **NO migration**, **NO schema change**, **NO trigger**, **NO backfill**, **NO materialized column**. Generated columns in SQLite cannot reference other tables, so any materialization of this predicate would require either denormalized counters maintained by triggers (new sync invariant, new test surface, append-only spirit violation) or a cached `has_content` column with the same trigger overhead. Read-time cost is bounded: `recentForContext` is clamped to ≤25 rows, EXISTS subqueries hit existing `session_id` indexes on `memory`/`prompts`/`confirmations`, total ≈ 75 index probes per call — not a hot path.

Not in scope:

- Filtering empty sessions out of `memory.stats.sessionsByStatus` (counts are operationally meaningful — operators decide when to purge based on them).
- Filtering empty sessions out of `/dashboard/sessions` (operators must see them to decide on purge).
- Excluding the caller's own active session from results. The content filter already excludes any session with no captured content; once the caller has saved anything it becomes legitimately surfaceable.
- A `grace` period (the 1h grace on `purgeEmpty` exists to avoid racing with late summary writes during a DELETE; reads cannot race with anything destructive).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sessions`: REFINE the `recentForContext` contract — it SHALL exclude sessions that fail the shared `sessionHasContent` predicate, in addition to the existing `deleted_at IS NULL` filter. ADD a normative reference to `sessionHasContent` as the single source-of-truth predicate consumed by both `recentForContext` (positive) and `purgeEmpty`/`countPurgeableEmpty` (negative).
- `mcp-api`: REFINE the `memory.context` scenario for `recentSessions` to specify that returned sessions SHALL satisfy `sessionHasContent`, and that the list is filter-then-truncate (Option B).

## Impact

**Code**

- Modified: `apps/server/src/services/agent-sessions.ts` (extract helper, apply to `recentForContext`, refactor purge call-sites).
- Modified: `apps/server/src/services/agent-sessions.test.ts` (new unit tests around the content filter and behavior parity for purge).
- Modified: `apps/server/src/test/mcp-integration.test.ts` (integration scenario: empty active session is NOT returned; useful older session IS).

**Surfaces unchanged**

- MCP tool schema: no new arg, no removed arg, no shape change.
- Dashboard: no template change.
- Plugin manifests: untouched (all four clients).
- DB schema and migrations: untouched.

**Risk**

- Behavioral change for agents that relied on seeing their own brand-new empty session in `memory.context`. Mitigation: it was never a documented guarantee, and the agent already has the session id in its own request state via `resolveActiveSessionId`. No downstream tool reads `recentSessions[*].id` programmatically (verified by grep of `recentSessions` in the repo — only test assertions and dashboard prefetches).
