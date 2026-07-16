## 1. Make `undoOp` convergence-aware

- [x] 1.1 In `apps/server/src/consolidation/operations.ts`, define a `SkippedRow` type (`{ id: string; topicKey: string; occupiedBy: string }`) and change `undoOp`'s return from `void` to `{ reverted: string; skipped: SkippedRow[] }`.
- [x] 1.2 After the existing purged-row check, load the reactivation candidate rows via `repos.memory.unsafeGetByIds(...)` (decay/merge/supersede → `op.affectedIds`; orphan_promote → `[rel.targetId]` once `rel` is resolved). Each row exposes `scope`/`projectId`/`topicKey`/`status`.
- [x] 1.3 Occupancy helper: for a row with non-null `topicKey`, call `repos.memory.findActiveByTopicKey({scope, projectId, topicKey})`; slot is occupied iff it returns a row whose `id !== thisRow.id`. Rows with null `topicKey` are always reactivatable.
- [x] 1.4 Reactivate only the non-occupied subset: replace `reactivate(op.affectedIds)` with `reactivate(reactivatableIds)`; guard `reactivateOne(rel.targetId)` in the orphan_promote branch with the same check. Collect skipped rows.
- [x] 1.5 Still `markReverted(opId, now)`; return `{ reverted: opId, skipped }`. Keep the merge `archiveOne(createdId)`, the relation `resetToPending`, and the `replaces[]` strip unchanged.
- [x] 1.6 `undoRun` (same file): aggregate `skipped` across ops into its return, preserving reverse-order semantics.

## 2. Surface partial undo in the dashboard

- [x] 2.1 `apps/server/src/dashboard/consolidation.ts`: per-op and per-run undo handlers consume the new `skipped[]` and render an inline notice on the consolidation runs view — "N row(s) not reactivated: topic '<K>' is now held by memory <id>" — mirroring the existing `purged_row_missing` inline-error pattern (same view, `data-confirm` unaffected).
- [x] 2.2 Confirm re-exports in `apps/server/src/consolidation/index.ts` and any use in `apps/server/src/server/bootstrap.ts` compile with the new return shape (they ignore the value → no change needed, verify).

## 3. UNIQUE partial index migration (index-only, with heal pre-pass)

- [x] 3.1 New migration file (next sequential number) under `apps/server/src/db/migrations/`. No table rebuild → no manual FK pragmas (the runner wrapper suffices).
- [x] 3.2 Heal pre-pass FIRST: `UPDATE memory SET status='superseded'` for every active, non-null-`topic_key` row that is NOT the `ROW_NUMBER() OVER (PARTITION BY scope, project_id, topic_key ORDER BY created_at DESC, id DESC) = 1` winner of its slot. (Status flip only; no delete, no content edit.)
- [x] 3.3 Then swap the index: `DROP INDEX memory_topic_key_active_idx;` + `CREATE UNIQUE INDEX memory_topic_key_active_idx ON memory(scope, project_id, topic_key) WHERE status='active' AND topic_key IS NOT NULL;` (predicate byte-identical to the current index).
- [x] 3.4 Update the Drizzle schema comment in `apps/server/src/db/schema/memory.ts` (the raw-SQL-index note) to record the index is now UNIQUE.
- [x] 3.5 Confirm `invariants.test.ts` (append-only allow-list, migration FK-safety) still passes — the heal `UPDATE` is a status flip, not a content update or delete, so no allow-list entry is needed; verify.

- [x] 3.6 (discovered during apply) Reorder `saveWithTopicKey` (services/memory.ts) to supersede the prior active row BEFORE inserting the new one — the UNIQUE index rejects the momentary two-active-rows window the old insert-then-supersede order created.

## 4. Tests

- [x] 4.1 `operations.test.ts`: decay(R, topic_key=K) → save(N, topic_key=K) → undo(decay op). Assert N is the sole active row in the slot, R stays `archived`, and the undo result names R in `skipped`.
- [x] 4.2 `operations.test.ts`: orphan_promote analogue — target T with topic_key=K, then save N in slot, then undo; T not reactivated, relation still reset to pending, T in `skipped`.
- [x] 4.3 `operations.test.ts`: control — undo with NO occupying save reactivates R normally, `skipped` empty (no regression to existing undo scenarios).
- [x] 4.4 Migration test: seed a duplicate-active slot (R1 older, R2 newer), run the migration; R2 stays active, R1 superseded, UNIQUE index created; then a manual second-active insert in a slot fails with a UNIQUE-constraint error.
- [x] 4.5 `pnpm run typecheck` + `pnpm run lint`; `runtime-invariants.test.ts` green.

## 5. Spec delta

- [x] 5.1 Confirm `specs/consolidation/spec.md` amends "Every consolidation operation MUST be reversible" with the no-second-active-row clause + the decay and orphan_promote skip scenarios. (Done in this change dir.)
- [x] 5.2 Confirm `specs/persistence/spec.md` changes the `topic_key` index to UNIQUE and adds the heal-migration + reject-second-active scenarios. (Done in this change dir.)

## 6. e2e + ship

- [ ] 6.1 Local e2e against `pnpm run dev:docker:up` (per `rembric-smoke-tests`): seed a topic slot, force a decay (or use the seeded fixtures), resave the topic, undo from `/dashboard/consolidation`, confirm the partial-undo notice renders and only one active row remains.
- [x] 6.2 Full `pnpm test` green (pre-push). Do NOT bypass hooks.
- [ ] 6.3 Conventional commits: `fix(consolidation): keep topic_key convergence on undo` + `feat(db): UNIQUE partial index on active topic_key slot (+ heal migration)`. PR title/body in English.
