# Phase 1 — what the `Scope` collapse deliberately did NOT do

Task 1.11. `retire-the-global-scope` `tasks.md` 16.1 bundles the type half and the schema half of
release N+1 into one entry. Phase 1 took the **type half only** (design D2). This file exists so a
later reader finds the remainder recorded as deferred rather than concluding it was forgotten.

## Done

- `Scope` is `{ kind: 'project'; projectId: string }`.
- `SCOPE_GLOBAL`, `GLOBAL_PARTITION_KEY`, `memoryMatchesScope`'s global branch, the global branches of
  `scopeWhere` / `scopeCondition` / `partitionKeyFor`, the six `opts.project?.kind === 'global'` arms
  in the memory and prompts repositories, and every `Scope`→column ternary: gone.
- The repository option bags that carried a `scope: MemoryScope` field solely to feed those clause
  builders lost it, and their `projectId` narrowed to `string`.
- The retrieval harness's ten formerly-global corpus memories and four formerly-global queries are a
  third project, `shared` (design OQ5).
- `test/invariants.test.ts::scope-is-one-arm invariant` greps every `.ts` under `src/` — tests
  included — for the deleted symbols and the two `Scope`-arm literals.

## NOT done, and reserved elsewhere

| left in place                                                   | reserved by                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| `memory.scope`, still written as the constant `'project'`       | `memory/spec.md:1619` — "Its removal is a separate change"     |
| the five scope-bearing indexes on `memory`                      | same; they lead on `scope`, so they go with the column         |
| `memory_entities_identity_idx` (leads on `scope`, `project_id`) | same                                                           |
| `sessions.project_id` / `prompts.project_id` still nullable     | `retire-the-global-scope` 16.1's `NOT NULL` flips              |
| `MemoryScope = 'global' \| 'project'` as a column type          | it types the column, not a scope; it goes when the column goes |

**Why not now.** `retire-the-global-scope` open question 1 — "how many releases may an operator skip
and still roll back?" — has a recorded default of "N+1 lands no earlier than one release after N", and
N shipped as server 0.26.0. That is an operational judgement about the installed base, which a
retrieval feature has no standing to make. The schema half is also the half that carries the migration
risk: a five-index drop plus `DROP COLUMN` plus recreation on a populated table, measured at 200 000
rows in `retire-the-global-scope/measurements/scale.md`.

**Phase 1 makes the remainder strictly easier, not harder.** 16.1 named `memory-repository.ts`'s
`scopeWhere('global', null, 'm')` call site as the reason those branches were still live. That call
site no longer exists, and neither does the branch it reached.

## Two consequences of the collapse that a reader will meet before they meet this file

1. **A row with no project belongs to no scope, so the two backfill workers skip it.**
   `findMissingEmbeddings` and `findMissingScans` gained `project_id IS NOT NULL`, and the two
   `adminBacklogCount`s match them so the operator's backlog can still reach zero. Before the collapse
   such a row was indexed into the `__global__` partition; that partition no longer exists, and letting
   the drain return a row it cannot place would have hot-looped it. The stranded-row hazard
   (`retire-the-global-scope` 16.14, this change's task 7.12) is unchanged: the row was unreachable
   before and is unreachable in exactly the same way after, and no data was deleted.

2. **`migrations-0031.test.ts` builds its pre-migration corpus with SQL now.** It used to call
   `MemoryService.save(…, SCOPE_GLOBAL)` and then drive the two workers. The service can no longer
   express the scope that migration exists to migrate away from, and the workers now skip the rows, so
   the fixture writes the global `memory`, `memory_vec` and entity rows directly. This is a property of
   every migration test whose "before" state predates a type the current image still has to migrate:
   the fixture has to outlive the type.

## Evidence that the collapse was behaviour-preserving

- `pnpm run eval` green **without** `--lower-floors`, and every metric byte-identical to the
  pre-change run: hybrid `P@8=0.156 R@8=1.000 MRR@8=0.828`, grep `0.148 / 0.938 / 0.724`,
  memory-md-dump `0.094 / 0.656 / 0.295`. The fixture reshuffle (OQ5) was landed as its own commit
  and measured on its own first, producing the identical figures — so the "did the fixture move it or
  did the collapse move it" question has an answer for both stages, and the answer is neither.
- End-to-end `memory.search` p50 within ±2.4% at 1k / 20k / 50k, paired and interleaved against a
  worktree at the pre-collapse commit (`measurements/narrow-path-regression.md` §6).
- `scopeWhere` emits `scope = 'project' AND project_id = ?` before and after; `partitionKeyFor`
  returns the project id before and after. The deleted branches are ones the project arm never took.
