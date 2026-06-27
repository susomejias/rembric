# Tasks — add-type-aware-decay

## 1. Per-type decay threshold constant + helper

- [x] 1.1 In `apps/server/src/consolidation/decay.ts`, change `DecayThresholds` from `{ thresholdMs: number; confidenceFloor: number }` to `{ thresholdByType: Partial<Record<MemoryType, number>>; defaultThresholdMs: number; confidenceFloor: number }`, importing `MemoryType` from `../db/schema/memory.js`.
- [x] 1.2 In `apps/server/src/consolidation/decay.ts`, replace `DEFAULT_DECAY` so it carries the static per-type map (mirroring the shape of `REVIEW_TTL_MS`), a `defaultThresholdMs` of `90 * 24 * 60 * 60 * 1000` (the current global value, kept as the fallback), and `confidenceFloor: 1`. Add a comment noting `reference` gets a long/never decay threshold and that this map is intentionally SEPARATE from `REVIEW_TTL_MS` to keep the decay/review axes orthogonal.
- [x] 1.3 In `apps/server/src/consolidation/decay.ts`, update `findDecayCandidates` to build a `thresholdByType` ladder array (`Object.entries(thresholds.thresholdByType).filter((e): e is [MemoryType, number] => typeof e[1] === 'number')`, mirroring `apps/server/src/services/memory.ts:267-269`) and pass `now.getTime()`, the ladder, `thresholds.defaultThresholdMs`, and `thresholds.confidenceFloor` to `findDecayCandidateIds` (no longer pre-compute a single `cutoff`).

## 2. Per-type decay candidate query

- [x] 2.1 In `apps/server/src/db/repositories/memory-repository.ts`, change `findDecayCandidateIds` to accept `nowMs: number`, `thresholdByType: ReadonlyArray<readonly [MemoryType, number]>`, `defaultThresholdMs: number`, and `confidenceFloor: number` (replacing the scalar `cutoff: Date`).
- [x] 2.2 In the same method, replace the scalar `last_seen_at < cutoff` predicate with a per-type `CASE WHEN ${memory.type} = ${t} THEN ${ms} ... ELSE ${defaultThresholdMs} END` threshold expression and compare `last_seen_at < (nowMs - thresholdExpr)` — reusing the `sql.join` / `CASE` ladder construction already proven in `runNeedsReview` (`apps/server/src/db/repositories/memory-repository.ts:563-592`). Keep the existing scope filter and the confirmation-count `< confidenceFloor` sub-select unchanged.

## 3. Wire the runner

- [x] 3.1 In `apps/server/src/consolidation/runner.ts`, keep passing `this.opts.decay ?? DEFAULT_DECAY` to `findDecayCandidates` (now the per-type shape), and change the `applyDecay` reasoning string (currently `` `last_seen_at older than ${...thresholdMs}ms with low confidence` ``) to a deterministic, type-agnostic string such as `last_seen_at older than per-type decay threshold with low confidence`.
- [x] 3.2 Confirm `apps/server/src/consolidation/index.ts` still re-exports `DEFAULT_DECAY` / `DecayThresholds`; no API name change, only the shape — verify `pnpm run typecheck` is clean for the barrel and all importers.

## 4. Tests

- [x] 4.1 Extend `apps/server/src/db/repositories/memory-repository.test.ts` with cases for `findDecayCandidateIds`: a row of a type with a SHORT per-type threshold is selected once past that threshold; a row of a type with a LONGER threshold (e.g. `user`) is NOT selected at the same `last_seen_at`; a type with NO explicit entry falls back to `defaultThresholdMs`. Verify with `pnpm vitest run apps/server/src/db/repositories/memory-repository.test.ts`.
- [x] 4.2 Add/extend a sweep test in `apps/server/src/consolidation/runner.test.ts` (or `apps/server/src/consolidation/operations.test.ts`) asserting that with a mix of types, the decay pass archives only rows past their per-type threshold, and that `reference` is exempt under a short clock. Verify with `pnpm vitest run apps/server/src/consolidation/runner.test.ts apps/server/src/consolidation/operations.test.ts`.
- [x] 4.3 Add an idempotency assertion: back-to-back forced sweeps with no intervening writes produce zero new decay archives on the second run (per the existing "idempotent on stable input" requirement). Verify with `pnpm vitest run apps/server/src/consolidation/runner.test.ts`.

## 5. Validation gate

- [x] 5.1 Run `pnpm run typecheck` and `pnpm run lint` — both clean (no `any`, no floating promises).
- [x] 5.2 Run `pnpm test` (or at minimum the three touched test files) — all green; invariant tests under `apps/server/src/test/invariants.test.ts` (data-access confinement, append-only) still pass.
- [x] 5.3 Run `openspec validate --strict add-type-aware-decay` — exits clean.
- [x] 5.4 (operator smoke) Validated against `pnpm run dev:docker:up`: backdated three zero-confirmation active rows (project/user/reference) to `last_seen_at` 200 days ago, forced the sweep via `POST /admin/consolidation/run`, and confirmed only the `project` row was archived (`user`/`reference` exempt under their longer per-type thresholds). The decay op journaled `op_type=decay` with reasoning `last_seen_at older than per-type decay threshold with low confidence`; a second sweep archived 0 (idempotent).
