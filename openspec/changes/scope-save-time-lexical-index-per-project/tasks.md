## 1. Phase 1: design and measurement

- [x] 1.1 Prototype options (a), (b), (c) and (d) under `measurements/` (`prototype.mts`, `eval-prototype/`); production code unchanged
- [x] 1.2 Measure the save-time statement, pruning read and fidelity at 1 000 / 20 000 / 50 000 rows, with project shares of 2% / 20% / 60%, on both corpora (`measurements/options.txt`)
- [x] 1.3 Measure interactive search under option (a) (`measurements/search-options.txt`)
- [x] 1.4 Measure write cost, project-creation DDL and connection open, at 6 / 200 / 1 000 projects (`measurements/write-cost.txt`)
- [x] 1.5 Run `pnpm run eval:save-time`, `pnpm eval` and `dump-ids.ts` per option, with a prototype-off control that reproduces the base (`measurements/evals.txt`)
- [x] 1.6 Measure end-to-end `memory.save` latency, (d) against (b), paired (`measurements/save-latency.txt`)
- [x] 1.7 Owner decision: option (b), SQLite `WHEN` triggers, no project cap, and the storage and per-project idf costs accepted (design D1, D5)

## 2. Spec

- [x] 2.1 ADDED requirements in `specs/memory/spec.md` and `specs/persistence/spec.md`, with the draft notes removed; `openspec validate scope-save-time-lexical-index-per-project --strict` passes
- [ ] 2.2 After `prune-common-terms-from-save-time-match` archives, rewrite the memory delta as MODIFIED of its two requirements (design D6)

## 3. Index machinery

- [x] 3.1 RED, observed against a stub (`measurements/red-green.txt`): `packages/db/src/project-lexical-index.test.ts`, covering:
  - the name is injective and decodes;
  - the default project's hex id;
  - a missing, drifted or orphaned index;
  - creation in the caller's transaction, rolled back when it aborts;
  - A-only writes, purge and tag update, checked by `integrity-check`
- [x] 3.2 Add `packages/db/src/project-lexical-index.ts` (name and decode, the recipe, `ensureProjectLexicalIndex`, `reconcileProjectLexicalIndexes`, `projectLexicalVocabulary`); 3.1 goes green
- [x] 3.3 Call the reconciler from `createDb` after `migrate` and before `ANALYZE`, logging only on a pre-existing database
- [x] 3.4 `ProjectsRepository.insert` creates the index in the caller's transaction
- [x] 3.5 Classify `memory_fts_p_` objects by pattern in `packages/db/src/schema/schema-drift.test.ts` and `apps/web/src/test/invariants.test.ts`

## 4. Read path

- [x] 4.1 RED against the base code: two tests in `packages/core/src/services/save-time-candidates.test.ts`. A project-common term is omitted even when it is rare server-wide, and rows another project adds leave the candidates unchanged
- [x] 4.2 Point `searchBm25Candidates` at the project table, add `projectDocumentCount` and `projectTokenTermFrequencies` (replacing `adminTokenTermFrequencies`), and pass the project from `saveTimeMatchExpression`; 4.1 and the db statement tests go green
- [x] 4.3 Update `memory-repository.perf.test.ts`: the plan scans the project table, never `memory_fts`; the scores equal those of an index of the project alone
- [x] 4.4 `node scripts/mutate.mjs` on every new guard: 21 of 21 mutations caught (`measurements/mutation.txt`)

## 5. Gates and docs

- [x] 5.1 `pnpm run eval:save-time` is identical to option (b) in `measurements/evals.txt`, and the `pnpm eval` ids are byte-identical to the base (`implementation-gates.txt`, design D7)
- [x] 5.2 Re-run end-to-end latency against the shipped code (`measurements/save-latency-impl.txt`)
- [x] 5.3 Upgrade on populated copies: boot reconciliation time and WAL growth (`measurements/implementation-gates.txt`)
- [x] 5.4 Docs: `docs/embeddings.md` (save path, cost and supported scale, rollback cleanup), `docs/backup.md`, `docs/docker.md`, `README.md`
- [x] 5.5 Dev-server smoke: a base-built database upgraded by this branch (`measurements/smoke.txt`)
- [x] 5.6 `pnpm test` is fully green; `packages/core/src/services/ancestry-statements.test.ts` now pins the project-scoped count statement's text
