## Context

`undoOp` is the operator's escape hatch for the deterministic decay/orphan sweep. It already guards against undoing onto physically-purged rows (`PurgedRowMissingError`) and refuses terminal purge ops (`NotUndoableError`). It does NOT guard against undoing onto a `topic_key` slot that a newer save has since claimed — the gap this change closes. The convergence invariant it must protect is owned by the `memory` spec (upsert-by-topic-key) and physically backed by the `persistence` spec's partial index, which is currently non-unique and therefore enforces nothing.

Relevant current code:

- `undoOp` (`operations.ts:118`) — reactivates `op.affectedIds` (decay/merge/supersede) and `rel.targetId` (orphan_promote undo) unconditionally.
- `findActiveByTopicKey({scope, projectId, topicKey})` (`memory-repository.ts:62`) — returns the single active row in a slot, or undefined.
- `unsafeGetByIds(ids)` (`memory-repository.ts:289`) — returns full `Memory[]` (incl. `scope`, `projectId`, `topicKey`, `status`); consolidation legitimately crosses scope, so the `unsafe*` read is the right tool.
- `memory_topic_key_active_idx` — `ON memory(scope, project_id, topic_key) WHERE status='active' AND topic_key IS NOT NULL`, non-unique, defined in raw SQL (Drizzle can't express the `WHERE`).

## Goals / Non-Goals

**Goals**

- `undoOp` never yields two active rows in one `(scope, project_id, topic_key)` slot.
- The DB rejects a second active row in a slot regardless of the writer (backstop).
- The operator is told when an undo was partial and why.

**Non-Goals**

- No change to purged-row blocking, merge archive-of-created, or reverse-order run undo.
- No new consolidation op types; no LLM.
- Not fixing the `prompt_purge`/`noop`/`failed` terminal-undo nit (noted out of scope in the proposal).
- No `saveWithTopicKey` change — it is already correct; this change protects it from `undoOp`.

## Decisions

### Decision 1 — `undoOp` skips (does not refuse) rows whose topic slot is occupied

Inside `undoOp`, after the existing purged-row check, load the candidate reactivation set via `unsafeGetByIds`. Partition it:

- For a row with `topic_key === null`: always reactivatable (no slot).
- For a row with a non-null `topic_key`: call `findActiveByTopicKey({scope, projectId, topicKey})`. If it returns nothing, or returns the row itself, reactivatable. If it returns a _different_ active row, the slot is occupied → **skip** (leave this row in its current status).

Reactivate only the reactivatable subset (`reactivate(reactivatableIds)`; the `orphan_promote` branch guards `reactivateOne(rel.targetId)` the same way). Still `markReverted` the op (the op _was_ undone to the extent convergence allows), and return `{ reverted: opId, skipped: SkippedRow[] }` where each `SkippedRow` names the id, topic_key, and the occupying active id.

**Skip vs. refuse the whole op.** Refusing (throw, leave op un-reverted) is simpler but strands the operator: an unrelated newer save in the same topic would make the decay permanently un-undoable. Skipping restores everything it safely can and reports the exception. The skipped row is not lost — it remains a superseded/archived predecessor in the lineage the newer head can still reference.

**Why not reactivate-then-supersede-under-the-new-head.** We could reactivate R and immediately mark it superseded by N (append R to N.replaces). Rejected: it rewrites lineage the operator did not ask to change and muddies "undo == reverse"; leaving R as-is is the least-surprise outcome.

### Decision 2 — Return-shape change on `undoOp`/`undoRun`

`undoOp` changes from `void` to `{ reverted: string; skipped: SkippedRow[] }`; `undoRun` aggregates skipped across ops. Callers that ignore the return keep compiling (bootstrap/index re-exports). The dashboard undo handlers (`dashboard/consolidation.ts`) consume `skipped` and render an inline notice ("N row(s) not reactivated — topic now owned by a newer memory <id>"), mirroring the existing `purged_row_missing` inline-error pattern on the same view. This is additive to the operator UX, not a breaking wire change (dashboard is server-rendered).

### Decision 3 — UNIQUE partial index (COALESCE-keyed), added alongside the lookup index, with a heal pre-pass

Add a UNIQUE partial index; keep the existing non-unique `memory_topic_key_active_idx` for lookups:

```
CREATE UNIQUE INDEX memory_topic_key_active_uidx
  ON memory(scope, COALESCE(project_id, ''), topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL;
```

**Why COALESCE, and why a second index rather than replacing the first.** SQLite treats `NULL` as DISTINCT in a UNIQUE index, so a plain UNIQUE index on `(scope, project_id, topic_key)` would silently fail to constrain global memories (`project_id IS NULL`) — the exact convergence we most want to guarantee for user-wide memories. Keying the UNIQUE index on `COALESCE(project_id, '')` turns the NULL project into a concrete `''` slot key that the constraint enforces. But `findActiveByTopicKey` queries `WHERE ... project_id = ?` on the raw column, and SQLite will not use a `COALESCE(project_id,'')` expression index for a raw-column equality — so replacing the plain index would regress that hot lookup. We therefore keep the plain `memory_topic_key_active_idx` for lookups and add `memory_topic_key_active_uidx` purely as the enforcement backstop. Two partial indexes on the same predicate is a small, bounded storage cost.

This is **index-only DDL** — no `CREATE TABLE _new`/`INSERT SELECT`/rename, so the SQLite table-rebuild FK dance does not apply; the migration runner's standard wrapper is enough.

**Heal pre-pass (same migration, before the index swap).** A DB that already hit this bug can hold duplicate-active slots; `CREATE UNIQUE INDEX` would fail on them. So the migration first collapses each offending slot deterministically:

```
-- For every (scope, project_id, topic_key) slot with >1 active row,
-- keep the most-recently-created active row; supersede the rest.
UPDATE memory SET status = 'superseded'
WHERE status = 'active' AND topic_key IS NOT NULL
  AND id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY scope, project_id, topic_key
        ORDER BY created_at DESC, id DESC
      ) AS rn
      FROM memory
      WHERE status = 'active' AND topic_key IS NOT NULL
    ) WHERE rn = 1
  );
```

Only a status flip (append-only-legal — content untouched, nothing deleted); it touches only already-broken slots, and is a no-op on a healthy DB (the common case, since triggering the bug requires a specific operator undo). Tiebreak `created_at DESC, id DESC` is deterministic (ULID ids are monotonic, so `id DESC` breaks equal-timestamp ties stably).

## Risks / Trade-offs

- **The heal pre-pass mutates rows in an existing prod DB.** It is confined to slots that already violate the invariant (data that is already wrong), performs only a legal status flip, and is idempotent/no-op on healthy data. This is the one item worth an explicit reviewer sign-off. It does not run `foreign_key_check` concerns (no schema change to rows).
- **UNIQUE index as a live backstop — required a `saveWithTopicKey` reorder.** After this migration, any path that would create a second active row throws a SQLite constraint error. `saveWithTopicKey` previously inserted the new active row and _then_ superseded the incumbent — momentarily two active rows in the slot, which the non-unique index tolerated but the UNIQUE index rejects. The fix reorders it to supersede-then-insert within the same transaction (no functional change; the old order was only ever safe by accident of the index being non-unique). This is exactly the latent hazard the constraint exists to surface, and the property test "at most one active row per slot" now passes against it.
- **`undoOp` return-shape change.** Low blast radius (callers listed); covered by updating them in the same change.

## Migration Plan

Single new migration file (next sequential number). Body: heal pre-pass `UPDATE`, then `DROP INDEX` + `CREATE UNIQUE INDEX`. No feature flag — the fix should apply on deploy. Rollback is a forward-only concern here (dropping the UNIQUE index and recreating the plain one), standard for this repo.

## Open Questions

- Fold in the `prompt_purge`/`noop`/`failed` terminal-undo nit (one line in `undoOp`'s `NotUndoableError` guard)? Proposed as out-of-scope; trivial to include on request.
