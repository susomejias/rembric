# Tasks: extract-repository-layer

Phases mirror design.md Decision 7. Each numbered group lands green (`pnpm run typecheck && pnpm run lint && pnpm test`) and is independently mergeable.

## 1. Phase 1 — Scaffold

- [x] 1.1 Create `apps/server/src/db/repositories/` with class skeletons (`MemoryRepository`, `RelationsRepository`, `AgentSessionsRepository`, `PromptsRepository`, `ProjectsRepository`, `TokensRepository`, `ConsolidationRepository`, `VectorsRepository`), each `constructor(private readonly db: Db)`, plus `index.ts` barrel
- [x] 1.2 Absorb `db/queries.ts` helpers (`findMemoryById`, `findActiveByScope`, `findMemoriesByIds`, `countMemoriesByStatus`) into `MemoryRepository` as methods; update all importers; delete `db/queries.ts`
- [x] 1.3 Create `apps/server/src/db/diagnostics.ts` with PRAGMA reads (`journal_mode`, `quick_check`, `page_count`, `page_size`, `freelist_count`), `dbstat` aggregation, dynamic table row count, and `vacuumInto(dest)` — taking `DbHandle` where `raw` is needed; co-located test against an in-memory DB
- [x] 1.4 Instantiate all repositories in `server/bootstrap.ts` and expose them through the deps wiring (services still receive `Db` for now); `pnpm test` green

## 2. Phase 2 — Dashboard stops executing SQL

- [x] 2.1 `MemoryRepository.adminSearchFts(query, limit)` + `adminList*` reads needed by `dashboard/memories.ts`; replace the inline FTS query at `dashboard/memories.ts:66-76`; repository test asserts parity with the previous SQL against seeded fixtures
- [x] 2.2 `PromptsRepository.adminSearchFts(query, limit)`; replace inline FTS at `dashboard/prompts.ts:71-79`; parity test
- [x] 2.3 `RelationsRepository.adminListWithContent(filters, page)` and `adminGetWithContent(id)` implemented with the Drizzle builder (aliased `memory` joins for source/target, dynamic status/kind filters); replace raw JOINs at `dashboard/judgments.ts:64-86,210-237`; parity test covering every filter combination
- [x] 2.4 `MemoryRepository.adminCountBySession()` and `PromptsRepository.adminCountBySession()` as builder `groupBy` queries; replace raw GROUP BYs at `dashboard/sessions.ts:86-109`; remove the stray `void memory;` at `dashboard/sessions.ts:96`
- [x] 2.5 Convert `dashboard/maintenance.ts` PRAGMA/dbstat/row-count queries to `diagnostics.ts` calls
- [x] 2.6 Convert `dashboard/consolidation.ts` and any remaining dashboard DB touches to repository/service calls
- [x] 2.7 Remove `db: Db` from every dashboard `*Deps` interface and from the dashboard wiring in `server/http.ts`; typecheck proves no dashboard module references `Db`

## 3. Phase 3 — Services consume repositories

- [ ] 3.1 `MemoryService` → `MemoryRepository`: move all builder + raw SQL (FTS5 search, topic-key lookup, `json_each` chain traversal, purge predicate + `DELETE FROM memory`); update invariant allow-list + positive anchor from `services/memory.ts` to the repository in the same commit; service keeps scope resolution, validation, transactions; existing `memory.test.ts` assertions pass unchanged
- [ ] 3.2 `RelationsService` → `RelationsRepository`: move raw WHEREs and bulk IN queries (convert to builder where expressible); `relations` tests pass unchanged
- [ ] 3.3 `PromptsService` → `PromptsRepository` incl. `DELETE FROM prompts` purge; allow-list + anchor move in same commit
- [ ] 3.4 `AgentSessionsService` + `SessionsService` → `AgentSessionsRepository` incl. `DELETE FROM sessions` purge; allow-list + anchor move in same commit
- [ ] 3.5 `ProjectsService` and `TokensService` → their repositories (pure builder moves)
- [ ] 3.6 `save-time-candidates.ts` → `VectorsRepository.knnByCosine(...)` and `MemoryRepository` FTS/BM25 method; decide here whether `embedding-worker.ts` shares `VectorsRepository` (design open question) and move its SQL accordingly
- [ ] 3.7 `consolidation/{decay,operations,runner}.ts` → `ConsolidationRepository` + `MemoryRepository`; convert the runner throttle raw WHERE (`runner.ts:100`) to builder; consolidation + sweep tests pass unchanged
- [ ] 3.8 `embeddings/state.ts` → `VectorsRepository` (count + similarity percentile sample)
- [ ] 3.9 Stop injecting `Db` into all service constructors; services receive repositories only; typecheck proves no service module imports from `db/schema` or executes SQL

## 4. Phase 4 — Closure and enforcement

- [ ] 4.1 Convert `server/bootstrap.ts` PRAGMA/backup/backlog/stat queries and `server/data-loss-guard.ts` row counts to `diagnostics.ts` / repository calls
- [ ] 4.2 Add SQL-confinement rule to `invariants.test.ts`: SQL-execution patterns (`db.select(`, `db.insert(`, `db.update(`, `db.delete(`, `db.all(`, `db.get(`, `db.run(`, `db.query.`, `sql` tag import from drizzle-orm, `raw.prepare(`, `.exec(`) forbidden outside `src/db/` (exempt: `*.test.ts`, `scripts/seed-dev.ts`); suite fails naming the file on violation
- [ ] 4.3 Add admin-callsite rule to `invariants.test.ts`: `.admin<PascalCase>` invocations forbidden outside `src/dashboard/` (exempt: `src/db/repositories/`, tests); suite fails naming the file on violation
- [ ] 4.4 Update CLAUDE.md Architecture section: repository layer, restated scope invariant (services resolve scope, repositories require it), diagnostics module
- [ ] 4.5 Full gate: `pnpm run typecheck && pnpm run lint && pnpm test` green; `git grep` confirms zero `sql\`` outside `src/db/` in non-test files

## 5. Validation (operator-assisted)

- [ ] 5.1 **Operator-only**: run `pnpm run dev:docker:up`, then the `rembric-smoke-tests` skill flow — verify dashboard pages (`/dashboard/{memories,prompts,judgments,sessions,maintenance,consolidation}`) render identical content/filters/pagination against the seeded dataset, and MCP save/search/judge round-trips behave as before
- [ ] 5.2 Decide land order vs in-flight changes (`summary-length-cap`, `filter-empty-sessions-from-context`, `add-data-protection-defaults`) before starting Phase 3 — **operator decision**
