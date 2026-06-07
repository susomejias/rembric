# Proposal: extract-repository-layer

## Why

SQL execution is scattered across three layers: dashboard HTTP handlers run inline queries (`dashboard/{memories,prompts,judgments,sessions,maintenance}.ts` call `db.all()`/`db.get()` directly), services mix Drizzle builder calls with raw `sql` templates, and bootstrap/diagnostics code holds its own PRAGMA/VACUUM statements. There is no single place that owns data access, so the scope-enforcement and append-only invariants are guaranteed only by grep-based tests over the whole `src/` tree, and every dashboard view re-implements its own ad-hoc admin queries because the scoped service API deliberately cannot serve them.

## What Changes

- Introduce a repository layer at `apps/server/src/db/repositories/` — one repository class per aggregate (`memory`, `relations`, `agent-sessions`, `prompts`, `projects`, `tokens`, `consolidation`, `vectors`), each owning ALL SQL (Drizzle builder and raw) for its tables, including sibling FTS5 tables.
- Repositories expose two method families: scope-required methods (consumed by services; every read/write takes an explicit `Scope`) and `admin*`-prefixed unscoped read methods (consumed only by the dashboard).
- Dashboard handlers stop executing SQL entirely; they call repositories (`admin*` reads) and services (mutations). The `db: Db` member is removed from dashboard `*Deps` interfaces.
- Services stop executing SQL entirely; they consume repositories and keep owning scope resolution, validation, and `db.transaction()` boundaries.
- Raw SQL that the Drizzle builder CAN express (per-session GROUP BY counts, judgments JOINs, throttle WHERE clauses, plain counts) is converted to builder calls during the move. Raw SQL stays only where SQLite features demand it (FTS5 `MATCH`, `vec_distance_cosine`, `json_each`, PRAGMA, `VACUUM INTO`) and only inside `src/db/`.
- New `apps/server/src/db/diagnostics.ts` module owns PRAGMA introspection, `dbstat` queries, integrity checks, and `VACUUM INTO` — consumed by bootstrap, data-loss-guard, and the maintenance dashboard.
- `apps/server/src/db/queries.ts` is absorbed into `MemoryRepository` and deleted.
- The append-only purge escape hatches (`DELETE FROM memory|sessions|prompts`) move from service files into their repositories; the invariant-test allow-lists and positive anchors move in lockstep within the same commit.
- Two new grep-enforced invariants in `apps/server/src/test/invariants.test.ts`:
  - SQL execution (Drizzle builder or raw) is permitted ONLY under `src/db/` (plus `db/migrations/`, `scripts/seed-dev.ts`, and test files).
  - `admin*` repository methods are invoked ONLY from `src/dashboard/`.
- No behavioral change: every HTTP endpoint, MCP tool, and dashboard page returns identical results before and after. No schema or migration changes.

## Capabilities

### New Capabilities

- `data-access`: where SQL may execute, the repository API contract (scoped vs `admin*` method families), transaction ownership, the relocated append-only purge allow-list, and the enforcement tests that pin all of it.

### Modified Capabilities

(none — no existing spec requirement changes behavior; scope enforcement, append-only lifecycle, topic-key convergence, and judgment freshness keep their observable semantics. The "scope enforced at the service layer" invariant is restated, not weakened: services still resolve and thread `Scope`; repositories now require it as an explicit parameter.)

## Impact

- **New files**: `apps/server/src/db/repositories/{memory,relations,agent-sessions,prompts,projects,tokens,consolidation,vectors}-repository.ts`, `apps/server/src/db/repositories/index.ts`, `apps/server/src/db/diagnostics.ts`, plus co-located tests.
- **Deleted**: `apps/server/src/db/queries.ts`.
- **Rewritten consumers (services)**: `apps/server/src/services/{memory,relations,prompts,agent-sessions,projects,tokens,sessions,save-time-candidates,embedding-worker}.ts`, `apps/server/src/consolidation/{decay,operations,runner}.ts`, `apps/server/src/embeddings/state.ts`.
- **Rewritten consumers (HTTP layer)**: `apps/server/src/dashboard/{memories,prompts,judgments,sessions,maintenance,consolidation}.ts`, `apps/server/src/server/{bootstrap,data-loss-guard,http}.ts` (dependency wiring: repositories instantiated in bootstrap, injected into services and dashboard deps).
- **Invariant tests**: `apps/server/src/test/invariants.test.ts` — relocated DELETE allow-lists/anchors, two new SQL-confinement rules.
- **Docs**: CLAUDE.md architecture section gains the repository layer and the restated scope invariant wording.
- **Invariants touched**: append-only memory (purge code relocation only), scope-at-service (restated — resolution stays in services, filtering moves to repository methods that require `Scope`). Topic-key convergence and judgment freshness untouched.
- **Coordination**: three in-progress changes (`summary-length-cap`, `filter-empty-sessions-from-context`, `add-data-protection-defaults`) touch files this refactor rewrites; land order must be decided before `/opsx:apply` on phase 3.
