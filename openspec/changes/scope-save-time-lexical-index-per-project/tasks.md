## 1. Phase 1: design and measurement (this change)

- [x] 1.1 Prototype options (a), (b), (c) and (d) under `measurements/` (`prototype.mts`, `eval-prototype/`); production code unchanged
- [x] 1.2 Measure the save-time statement, pruning read and fidelity at 1 000 / 20 000 / 50 000 rows, with project shares of 2% / 20% / 60%, on both corpora (`measurements/options.txt`)
- [x] 1.3 Measure interactive search under option (a) (`measurements/search-options.txt`)
- [x] 1.4 Measure write cost, project-creation DDL and connection open, at 6 / 200 / 1 000 projects (`measurements/write-cost.txt`)
- [x] 1.5 Run `pnpm run eval:save-time`, `pnpm eval` and `dump-ids.ts` per option, with a prototype-off control that reproduces the base (`measurements/evals.txt`)
- [x] 1.6 Measure end-to-end `memory.save` latency, (d) against (b), paired (`measurements/save-latency.txt`)
- [ ] 1.7 OWNER DECISION: approve option (b), the routing mechanism (design D5), the supported project count and the storage cost (design Open Questions)

## 2. Phase 2: spec (after 1.7 and after `prune-common-terms-from-save-time-match` archives)

- [ ] 2.1 Rewrite `specs/memory/spec.md` as MODIFIED of the two archived #469 requirements (design D6), and remove the draft notes; `openspec validate scope-save-time-lexical-index-per-project --strict` passes
- [ ] 2.2 Add the `memory_fts_p_` name-pattern rule to the derived-classification requirement in `specs/persistence/spec.md`

## 3. Phase 2: index machinery

- [ ] 3.1 RED: tests in `packages/db/src/project-lexical-index.test.ts`. A project table equals its view after an insert, an allow-listed purge and a tag update (FTS5 `integrity-check` plus a match probe). Another project's table never matches. Each test is observed failing first
- [ ] 3.2 Add `packages/db/src/project-lexical-index.ts`: the name function (rejects ids outside `^[0-9a-z]{26}$` after lowercasing), the DDL recipe and `reconcileProjectLexicalIndexes`; 3.1 goes green
- [ ] 3.3 Call the reconciler from `packages/db/src/client.ts` after `migrate`, under `BEGIN IMMEDIATE`. Test that a missing or drifted object is recreated and rebuilt, and that a clean database is a no-op
- [ ] 3.4 `ProjectsRepository.create` runs the DDL in its transaction; test that the index exists, and is rolled back with the project
- [ ] 3.5 Classify `memory_fts_p_%` objects by pattern in `packages/db/src/test-support/schema-inventory.ts`, `apps/web/src/test/schema-inventory.ts` and `apps/web/src/test/invariants.test.ts`; `pnpm test` is green

## 4. Phase 2: read path

- [ ] 4.1 RED: a test in `packages/core/src/services/save-time-candidates.test.ts`. Rows added to another project do not change the saving project's lexical pool, and a project-common term is omitted
- [ ] 4.2 Point `MemoryRepository.searchBm25Candidates` at the project table. Add the project-scoped document count and token frequencies to `TermStatisticsRepository`, through a temp-schema `fts5vocab` per project in `packages/db/src/query-tokenizer.ts`. Pass the project from `saveTimeMatchExpression`. 4.1 goes green
- [ ] 4.3 Update `packages/db/src/repositories/memory-repository.perf.test.ts` for the plan shape (no `memory_fts` in the save-time plan)
- [ ] 4.4 Run `node scripts/mutate.mjs` on the routing `WHEN`, the reconciler drift check, the id check and the project filter. Every mutation is caught

## 5. Phase 2: gates

- [ ] 5.1 `pnpm run eval:save-time` matches option (b) in `measurements/evals.txt`, and `pnpm eval` ids are byte-identical to the base
- [ ] 5.2 Re-run `measurements/save-latency.mts` against the implementation; every b − d interval at 20 000 and 50 000 rows lies outside the noise band
- [ ] 5.3 Upgrade test on a populated 50 000-row copy: record the boot reconciliation time and the WAL growth
- [ ] 5.4 Document the rollback cleanup (dropping `memory_fts_p_%` objects), and update `docs/embeddings.md` for the detection path
- [ ] 5.5 `pnpm run typecheck`, `pnpm run lint` and `pnpm test` are green
