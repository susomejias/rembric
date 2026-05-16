## Context

Rembric's foundational invariant is that rows in `memory`, `sessions`, `consolidation_ops`, and `memory_relations` are never physically deleted. Lifecycle is expressed via status flips, `replaces` chains, and journaled consolidation operations — every step is reversible. That contract is the product's audit story.

Operating Rembric for several weeks revealed two row categories that the invariant protects without delivering value:

1. **Sessions opened by client hooks that never produced output.** A Claude Code or Codex hook fires `POST /api/<slug>/sessions` on `SessionStart`, the agent then says nothing the operator cared to record, and `SessionEnd` fires later with no summary. The row exists, has `status='ended'`, and references absolutely nothing.
2. **Decayed memories that the consolidator's nightly pass has long forgotten about.** A memory's `last_seen_at` ages past the decay threshold, the consolidator transitions it to `archived`, and the consolidator's reversible op records the transition. If years pass and nothing else ever references that memory (no later supersede chain pointing back at it, no consolidation op operating on it, no user confirmation), the row is a leaf of a forest no traversal can reach.

Both categories share the property that **no other row in the database references them**. That is the structural justification for relaxing the invariant: removing a row that nothing references cannot break any audit traversal, because there is no traversal that would reach it.

The trigger choice is a manual dashboard button, not a scheduled cron, for the reasons enumerated in `proposal.md::Why`. The page is admin-scoped because the action permanently mutates state outside the append-only contract.

## Goals / Non-Goals

**Goals:**

- Provide a deterministic, predicate-based path to remove rows that have no audit value.
- Preserve the invariant's spirit (audit + reversibility) for every row that has any reference whatsoever.
- Keep the trigger surface narrow: dashboard-only, admin-scope-only, operator-confirmed.
- Journal the purge so even after rows are gone, the audit trail records WHAT was removed and WHEN.
- Update `src/test/invariants.test.ts` to permit the new code paths and explicitly forbid all others. The invariant test remains the load-bearing safeguard.

**Non-Goals:**

- Scheduling. The cron path is rejected because volume is low and operator visibility is preferred over automation.
- A CLI equivalent (`rembric purge`). Operators who want automation can build it on top of the dashboard's HTTP route later.
- Adding new tables. The `consolidation_ops` table already accommodates journal rows with arbitrary `op_type` values.
- Recovering disk via VACUUM. SQLite's auto-vacuum or a manual `VACUUM` is the operator's call after the purge; this proposal does NOT trigger one. (Rationale: VACUUM rewrites the entire file and can be slow on multi-GB DBs; the operator should opt into it.)
- Touching `consolidation_ops`, `confirmations`, `prompts`, `memory_relations`, `tokens`, or `projects`. Their append-only contracts are unchanged.

## Decisions

### Decision 1: Predicates are deterministic, no age threshold on archived memories

The empty-sessions predicate includes a 1-hour grace on `ended_at` to avoid racing with summary writes that arrive after `SessionEnd`. The disconnected-archived predicate has NO age threshold — if a memory is archived AND nothing references it, age adds no information. A 30-day-old disconnected leaf and a 30-second-old disconnected leaf carry identical (zero) audit value.

This was the explicit call of the operator (2026-05-16): "Lo dejamos sin floor, sólo desconectadas y archivadas". If experience reveals that races exist (e.g., a memory is mid-supersession and briefly appears disconnected), a future change can add a floor; today the structural predicate is strong enough on its own.

### Decision 2: Admin-scope gate, not separate token type

The dashboard already supports tokens with scope `*` (global admin) vs `project:<id>` (project-scoped). The maintenance page reuses that distinction: the sidebar entry is conditionally rendered, the route handler returns `403 forbidden` for non-admin sessions, and the POSTs reject non-admin sessions before touching any service.

This avoids inventing a new "maintenance role" or requiring re-authentication. Operators who want extra friction can rotate their admin token after a purge.

### Decision 3: Journaling lives in `consolidation_ops`, not a new table

`consolidation_ops` already carries `affected_ids` and `reasoning` columns. Reusing it means:

- The dashboard's existing consolidation-runs view can display purge ops alongside merges and decays (with a small renderer addition).
- No migration needed.
- The journal is uniform: anything that mutated row state is in one table.

The `op_type` enum gains two values: `session_purge` and `archived_memory_purge`. These ops have NO undo (the rows are gone), and the consolidation undo handler SHALL reject undo attempts on them with a structured error.

### Decision 4: Consolidator reversibility is narrowed, not removed

The consolidation spec requires every op to be reversible. With physical purge, that becomes conditional: undo is guaranteed when no `affected_ids` row of the op has been purged. The undo handler SHALL:

1. Look up every `affected_ids` row of the op being undone.
2. If any are missing from `memory` (because a later purge removed them), return `{ ok: false, code: 'purged_row_missing', missing: [ids] }`.
3. Otherwise proceed as today.

This makes the new failure mode explicit instead of letting it surface as a confusing NULL deref. The dashboard's undo button SHALL render the error inline.

### Decision 5: Service-layer enforcement, not SQL-layer

The two purge methods live on the existing service classes (`AgentSessionsService`, `MemoryService`). They require `adminBypass: true` in their input — matching the existing pattern used by `softDelete`/`undelete`. Without that flag they throw `DomainError('forbidden')`.

This keeps the public service contract uniform: every method that mutates rows outside the normal lifecycle requires the same flag. The dashboard handler is the ONLY caller that passes `adminBypass: true`, and that caller asserts admin scope before calling.

### Decision 6: The `data-confirm` modal pattern is reused as-is

The dashboard already has a `data-confirm` mechanism (`src/dashboard/sessions.ts:122` uses it for soft-delete). The maintenance page uses the same attributes:

```html
<button
  type="submit"
  data-confirm="Purge 12 empty sessions? This is irreversible."
  data-confirm-label="PURGE 12 SESSIONS"
  data-confirm-tone="danger"
>
  Purge empty (12)
</button>
```

No new JS. No new patterns. The modal is rendered by the existing shell script.

### Decision 7: Pre-flight counts run on every page render

The two counts are cheap SQL aggregates with indexed `NOT EXISTS` clauses. They run on every GET of `/dashboard/maintenance` — there is no caching layer. If the operator clicks "Purge" and the count is now stale (because more rows became eligible between render and click), the POST handler is the source of truth: it runs the same predicate again and deletes whatever currently matches. The response surfaces the actual deleted count so the operator can see the discrepancy if it happened.

## Risks / Trade-offs

- **Loss of long-tail audit.** A purged archived memory cannot be inspected later for "did Rembric ever know X?". The operator accepts this in exchange for cleanup. Mitigation: the `consolidation_ops` journal preserves the deleted ids and the timestamp, so the answer "was the id `01KX...` ever in the DB?" remains answerable.
- **Consolidation undo can fail.** Operators who undo a consolidation op weeks later, after a purge, will see a `purged_row_missing` error. Mitigation: the dashboard surfaces this clearly and tells the operator which specific ids were missing. In practice undo is rare and usually exercised on recent ops, so the overlap window is small.
- **Foot-gun for multi-operator setups.** If Rembric were operated by multiple humans, one operator's purge could surprise another. Mitigation: admin scope gates the action and the journal records who triggered it. The product today is effectively single-operator; if multi-operator becomes a target, this trade-off needs revisiting.
- **No automatic VACUUM.** Disk usage doesn't drop until the operator runs `VACUUM` themselves (or auto-vacuum is enabled). Mitigation: the maintenance page surfaces freelist size after a purge ("X pages freed; run VACUUM to reclaim disk") so the operator knows what's left.
- **Test invariant relaxation.** The change to `invariants.test.ts` is itself a load-bearing change — the test must still fail if any OTHER code path adds `DELETE FROM sessions` or `DELETE FROM memory`. The relaxation pinpoints the two exact callers, no more. A second pass on the test design is warranted at code review time.

## Migration Plan

No data migration. No schema change. The two new code paths are additive. Existing rows are unaffected until the operator explicitly clicks a purge button.

Once merged, operators upgrading their installation see the new "Maintenance" sidebar link the next time their token (with scope `*`) opens the dashboard. The two pre-flight counts will show how much accumulated noise the database carries; the operator decides whether to act on it.

## Open Questions

- **Should the consolidation undo handler offer a "force-undo" path that ignores missing rows?** Today's design says no — it errors cleanly. If experience shows operators want to undo "as much as possible" even after a purge, a follow-up change can add that mode.
- **Should `memory_vec` and `memory_fts` clean-up be a separate "lighter" button?** Originally floated as "drop embeddings of archived memories, keep the row". Rejected for V1 to avoid two near-identical workflows. If disk pressure on `memory_vec` (the 6KB-per-row table) turns out to be the dominant concern in practice, a follow-up change can split the action.
- **Should the maintenance page show a "last purge" timestamp and counts?** Useful for operator memory but easily reconstructible from `consolidation_ops`. Deferring to V2 unless requested.
