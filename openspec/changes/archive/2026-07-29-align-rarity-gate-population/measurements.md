# Measurements — align-rarity-gate-population

Recorded 2026-07-29 during apply. Every ratio carries its denominator, per tasks §4.

## Preconditions re-verified on disk (tasks 1.1–1.3)

`tune-hot-query-paths/tasks.md` task 4.5 is still `- [ ]` (unstarted), so no maintained
counter exists over `!= 'archived'` and D4's reconciliation is not triggered.

Predicates found in `db/repositories/entities-repository.ts` before the edit — line numbers
as found, not as written in the proposal:

| method                       | line found | predicate found        |
| ---------------------------- | ---------- | ---------------------- |
| `scopeActiveMemoryCount`     | `:242`     | `!= 'archived'`        |
| `entityLinkCount`            | `:266`     | `!= 'archived'`        |
| `findOtherMemoriesForEntity` | `:298`     | `= 'active'` (already) |

`findMemoriesByEntity` (`:164`) left on `!= 'archived'` deliberately — out of scope
(design.md Non-Goals). It is the retrieval path, not the candidate-pool path.

## The diff (task 2.3)

Two changed lines, one source file. `ENTITY_RARITY_THRESHOLD` unchanged at `0.15`.
`test/invariants.test.ts` untouched (task 3.7), `apps/plugin/` untouched (task 6.6).

## Mutation check (task 3.6) — each predicate is load-bearing for exactly ONE direction

Baseline asserted first: **51 passed** across `entities-repository.test.ts` (24) and
`save-time-candidates.test.ts` (27).

An earlier draft of the two service tests asserted the intermediate counts before the
decision. Under mutation they failed on the _count_ line, so the decision assertion never
ran — the test would have passed the behaviour it claimed to pin. The count assertions were
removed (they duplicate the repository-level tests) so the decision is what fails.

| mutation reverted to `!= 'archived'` | result                     | failing assertion                                                                |
| ------------------------------------ | -------------------------- | -------------------------------------------------------------------------------- |
| `scopeActiveMemoryCount` only        | 3 failed \| 48 passed (51) | `expected true to be false` — entity candidates appear where the gate must block |
| `entityLinkCount` only               | 2 failed \| 49 passed (51) | `expected undefined to be defined` — the one active target vanishes              |
| both                                 | 4 failed \| 47 passed (51) | both of the above                                                                |
| restored                             | 51 passed                  | —                                                                                |

Stronger than the task asked for: the two predicates are **not** redundant. Reverting the
denominator alone flips only the newly-BLOCKED direction (`2/4` active vs `2/20`
non-archived); reverting the numerator alone flips only the newly-ADMITTED direction (`1/11`
active vs `6/16` non-archived). Neither test passes under either single mutation by accident.

## Behavioural delta on a production-shaped corpus (tasks 4.1–4.6)

The eval corpus (40 items, 2 entity links) cannot take a gate decision, so it was not used
as the instrument. Substituted: the resident dev database, **2055 memories**, which has the
population this change is about.

```
active 1443 · superseded 601 · archived 11
entity links 2441 (1711 on active, 708 on superseded, 22 on archived)
distinct entities 32 · topic_key chains with >1 row: 21
```

Gate decisions computed for every entity under both predicates:

```
gate evaluations taken:  32 / 32 entities  (0 skipped for an empty denominator)
  BEFORE   admitted 32/32   blocked 0/32
  AFTER    admitted 32/32   blocked 0/32
newly ADMITTED:  0 / 0 previously-blocked
newly BLOCKED :  0 / 32 previously-admitted
smallest A at which a decision was taken: 1443   (task 4.5)
```

**Zero decisions moved, and the reason is a property of the corpus — this is not evidence the
fix is inert.** Entity links are distributed almost uniformly across statuses:

```
links per row:  active 1711/1443 = 1.186   superseded 708/601 = 1.178
```

so both proportions track each other within ±0.0043 across all 32 entities (18 moved up
toward blocking, 14 down toward admitting, mean `+0.00007`). The fix bites only when the
superseded population _concentrates_ on the same entity values, which is what real
`topic_key` convergence produces and what this seed's random entity assignment does not.
That concentration is constructed exactly, with exact arithmetic, by the two service tests.

Worth recording separately: this corpus sits **one link away from the gate**. Top entity
`path:apps/server/src/services/dashboard.ts` is at `215/1443 = 0.1490` against a threshold of
`0.15`, and under the old predicate at `297/2044 = 0.1453`. At this size the two predicates
disagree by 0.004 — enough to straddle `0.15` once any entity crosses it. This is the
distribution D3's deferred recalibration needs and it is recorded here for task 8.1.

**Net direction (task 4.6):** a wash on this corpus (18 up / 14 down, mean `+0.00007`), so
neither newly-blocked nor newly-admitted dominates and D3's recalibration stays deferred
rather than becoming required. Displacement (task 4.4) is unobservable here: no save's
composition changed because no gate decision changed.

## Verification (task 6)

| check                            | result                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm run typecheck`             | clean                                                                                          |
| `pnpm run lint`                  | clean                                                                                          |
| `pnpm test`                      | **1873 passed \| 10 skipped**, 113 files — baseline 1870, delta **+3** (the tests added in §3) |
| `pnpm run eval`                  | `hybrid P@8=0.156 R@8=1.000 MRR@8=0.783` — baseline files untouched, unmoved                   |
| `pnpm run check:spec-provenance` | `ok (main...HEAD)`                                                                             |
| `openspec validate --strict`     | valid                                                                                          |

Baseline measured, not assumed. Note the two invocations differ and are not comparable:
`pnpm test` excludes `install.test.ts` and `scripts/*.history.test.ts` (66 tests, 2 files),
a bare `vitest run` from `apps/server` does not — 1873/113 vs 1939/115 on the same tree.

## Not done, and why

**Task 7 (Docker smoke) was not run.** Task 7.1 marks it operator-supervised and forbids
`dev:docker:up` against `data-dev`, because that wipes and reseeds — and `data-dev` currently
holds the 2055-row corpus the operator asked to keep for device testing. The §4 measurement
above was taken from a _copy_ of that database, which covers 7.2's corpus-shape requirement,
but 7.4's live both-directions probe over `/mcp/<slug>` was not performed. Left for the
operator.
