# Design: extract-repository-layer

## Context

Today SQL execution lives in three layers at once:

- **Dashboard handlers** run inline queries: FTS5 `MATCH` in `dashboard/memories.ts:66-76` and `dashboard/prompts.ts:71-79`, two-way memory JOINs in `dashboard/judgments.ts:64-86,210-237`, GROUP BY counts in `dashboard/sessions.ts:86-109`, PRAGMA/dbstat in `dashboard/maintenance.ts:88-133`. They do this because the scoped service API deliberately cannot serve unscoped operator views, so each handler grew its own admin query.
- **Services** mix Drizzle builder calls with raw `sql` templates (`services/memory.ts` ~7 raw statements: FTS5, `json_each` purge predicates; `services/relations.ts` ~3; `services/save-time-candidates.ts` sqlite-vec kNN; `consolidation/runner.ts` one trivially-builder WHERE).
- **Bootstrap/operational code** holds PRAGMA introspection, `VACUUM INTO`, and dynamic row counts (`server/bootstrap.ts`, `server/data-loss-guard.ts`, `embeddings/state.ts`).

Roughly 82% of DB access already uses the Drizzle builder; `consolidation/{decay,operations}.ts` are pure builder. The MCP layer never touches the DB directly. A nascent helper module (`db/queries.ts`, 63 lines, function-style) exists.

Wiring is constructor injection: `bootstrap.ts` creates `DbHandle { db: Drizzle, raw: better-sqlite3 }`, instantiates service classes with `db`, and passes both services and `db` into per-page dashboard `*Deps` interfaces.

`apps/server/src/test/invariants.test.ts` enforces append-only via source greps with per-file allow-lists AND positive anchors asserting the allow-listed files actually contain their `DELETE` statements.

## Goals / Non-Goals

**Goals:**

- All SQL (builder and raw) executes only under `src/db/` — repositories per aggregate plus a diagnostics module.
- Dashboard handlers and services become SQL-free consumers; handlers render, services orchestrate.
- A first-class home for unscoped operator reads (`admin*` methods) so the dashboard stops re-implementing ad-hoc queries.
- Raw SQL expressible in the Drizzle builder is converted during the move; raw remains only for FTS5 `MATCH`, sqlite-vec functions, `json_each`, PRAGMA/dbstat, `VACUUM INTO`.
- Both new boundaries grep-enforced in `invariants.test.ts`, same style as the append-only rules.
- Zero behavioral change: identical responses on every HTTP endpoint, MCP tool, and dashboard page; no schema or migration changes.

**Non-Goals:**

- No generic repository abstraction (`BaseRepository<T>`, unit-of-work, identity map). Concrete classes per aggregate.
- No async/await conversion — better-sqlite3 is synchronous; repositories stay synchronous.
- No change to scope _semantics_: cross-scope reads still return `not_found`; path-scoping contract in `mcp/tools.ts` untouched.
- No new packages/\* extraction; repositories live inside `apps/server`.
- No rework of the three in-flight changes; coordination is sequencing, not merging.

## Decisions

### Decision 1: Repositories per aggregate, owning sibling FTS/vec tables

`MemoryRepository` owns `memory` + `memory_fts`; `PromptsRepository` owns `prompts` + `prompts_fts`; `VectorsRepository` owns `memory_vec` and the sqlite-vec kNN queries; `ConsolidationRepository` owns `consolidation_ops` + `consolidation_runs`; plus `relations`, `agent-sessions`, `projects`, `tokens`. (Added during phase 3.4: a 9th `DashboardSessionsRepository` for `dashboard_sessions` — the cookie-auth table, distinct from agent `sessions`; missed in the initial enumeration. Its `DELETE` is legitimate, not a purge escape hatch — cookie sessions are not append-only.)

_Alternatives considered:_ (a) per-table repositories — rejected: FTS shadow tables are an implementation detail of their content table, splitting them forces two-repo choreography for one logical read; (b) a single `Database` god-object — rejected: recreates the problem with extra steps; (c) function modules instead of classes (style of `db/queries.ts`) — rejected: services are constructor-injected classes, and class repos give one injection point per aggregate and a natural place for the `admin*` naming convention.

### Decision 2: Method families on the same repository — scoped, `unsafe*`, and `admin*`

Scoped service-facing methods take an explicit `Scope` (or narrower required params) — repositories never default to "all rows". Deliberately cross-scope methods used by services keep the existing `unsafe*` naming convention (consolidation engine, scope-check-then-use patterns) alongside plain aggregate-count methods for operational stats. Dashboard-facing reads are `admin*`-prefixed, unscoped, read-only. A new invariant grep forbids `.admin<PascalCase>` call sites outside `src/dashboard/` (allow-listing repository files themselves and tests). (Amended during phase 2: the original two-family contract had no home for the service-side cross-scope reads that `MemoryService.unsafe*` already models.)

This _restates_ the scope invariant rather than weakening it: services still resolve scope once via `resolveEffectiveProject`/`scopeFromContext` and thread it down; repositories make the filter mandatory at the type level instead of implicit in hand-written WHERE clauses.

_Alternatives considered:_ (a) separate `*AdminRepository` classes — rejected: doubles file count, and the two families share row mappers and table knowledge; (b) admin methods on services — rejected during exploration: mixes scoped and unscoped APIs in classes whose entire contract is "every query is scope-filtered", one accidental call from an MCP path violates the sacred invariant; (c) keep dashboard inline SQL — rejected: that is the smell this change removes.

### Decision 3: Services own transactions; repositories never call `db.transaction()`

better-sqlite3 is synchronous and single-connection. `db.transaction()` issues BEGIN/COMMIT on that one connection, so repository methods invoked inside a service transaction callback automatically participate — no `tx` threading, no repository-level transaction API. `saveWithTopicKey` and consolidation op journaling keep their existing atomicity with services as the orchestrators.

_Alternatives considered:_ (a) passing a `tx` handle into every repository method — rejected: pure ceremony under a single synchronous connection; (b) repositories owning transactions — rejected: atomic units (save + supersede + journal) span aggregates and are business decisions, i.e., service territory.

[Trade-off] This relies on the single-connection model → Accepted because the architecture is one Node process over one SQLite file by definition; a connection pool is out of the question per the persistence spec.

### Decision 4: `db/diagnostics.ts` as a function module, not a repository

PRAGMA introspection (`journal_mode`, `quick_check`, `page_count`, `freelist_count`), `dbstat` aggregation, dynamic table row counts, and `VACUUM INTO` operate on the database itself, not on an aggregate. They take `DbHandle` (some need `raw`) and stay function-style. Consumers: `server/bootstrap.ts` (doctor report, backup), `server/data-loss-guard.ts`, `dashboard/maintenance.ts`.

_Alternative considered:_ a `MaintenanceRepository` class — rejected: there is no table, no rows, no scoped/admin split; a class adds nothing.

### Decision 5: Purge escape hatches move into repositories; invariant allow-lists move in the same commit

`DELETE FROM memory` moves to `MemoryRepository`, `DELETE FROM sessions` to `AgentSessionsRepository`, `DELETE FROM prompts` to `PromptsRepository`. The grep allow-lists AND the positive anchors in `invariants.test.ts` are updated in the same commit so the suite never passes with the purge duplicated or orphaned. Services keep the gating (admin bypass, journaling); repositories only execute.

_Alternative considered:_ leaving the purge DELETEs in services as a grandfathered exception — rejected: it would permanently break the "only db/ executes SQL" end-state invariant and leave the most dangerous SQL in the layer we just emptied.

### Decision 6: SQL-confinement invariant via grep, mirroring the existing style

New rule in `invariants.test.ts`: files outside `src/db/` (excluding `*.test.ts`, `scripts/seed-dev.ts`) must not match SQL-execution patterns — Drizzle entry points (`db.select(`, `db.insert(`, `db.update(`, `db.delete(`, `db.all(`, `db.get(`, `db.run(`, `db.query.`), the drizzle `sql` tag import from `drizzle-orm`, and `raw.prepare(`/`.exec(`. Activated last (phase 4), after all consumers are converted; until then the new repositories land alongside untouched call sites without red CI.

_Alternatives considered:_ (a) ESLint `no-restricted-imports` zones — viable, but the repo's established mechanism for load-bearing boundaries is `invariants.test.ts`, and greps with allow-lists are already proven there; (b) TypeScript visibility tricks (not exporting `Db`) — insufficient: `Db` must still reach repository constructors through bootstrap.

### Decision 7: Migration order — scaffold, dashboard, services, closure

1. **Scaffold**: empty repositories + `diagnostics.ts`; absorb `db/queries.ts` into `MemoryRepository`; wire instantiation in bootstrap.
2. **Dashboard first**: convert the five SQL-running handlers to `admin*` reads; convert cube-2 raw SQL (GROUP BY counts, judgments JOINs) to builder in the process; drop `db` from dashboard `*Deps`. Kills the original smell while the heavy service work is still pending.
3. **Services one aggregate at a time**: memory → relations → prompts → agent-sessions → save-time-candidates/vectors → consolidation → embeddings/state. Each lands green with allow-list updates where purges move.
4. **Closure**: bootstrap/data-loss-guard onto `diagnostics.ts`; delete dead helpers; activate the SQL-confinement and `admin*`-callsite invariants; update CLAUDE.md.

_Alternative considered:_ big-bang single PR — rejected: ~1,000 rewritten service lines plus five handlers in one diff is unreviewable, and the phased order keeps `main` releasable (release-please cuts releases continuously).

## Risks / Trade-offs

- [Risk] Behavioral drift while converting raw SQL to builder (NULL handling, implicit type coercion, ORDER BY stability) → Mitigation: each converted query keeps its existing co-located test coverage; where a query had no direct test (dashboard reads), add a repository test asserting parity against seeded fixtures before deleting the inline version.
- [Risk] The three in-flight changes (`summary-length-cap`, `filter-empty-sessions-from-context`, `add-data-protection-defaults`) edit `services/sessions`, context filtering, and backup code that phases 3–4 rewrite → Mitigation: decide land order before applying phase 3; this change's phases are individually mergeable, so in-flight work can land between them.
- [Risk] `admin*` grep invariant has false negatives (method aliased, destructured) → Mitigation: accepted as grep-level enforcement, same fidelity as the existing append-only greps; code review covers the exotic cases.
- [Trade-off] Repositories double the indirection for one-line queries (`findMemoryById`) → Accepted because the uniform boundary is the point: "where does this query live" stops being a judgment call, and the SQL-confinement invariant only works with zero exceptions.
- [Trade-off] `db.query.*` relational API usage inside repositories remains free-form (no per-method spec) → Accepted because specs pin the boundary and observable behavior, not internal query construction.
- [Risk] Phase 2 ships repositories while services still hold SQL, so two patterns coexist for a while → Mitigation: phases are short-lived sequential PRs; the closing invariant (phase 4) guarantees the intermediate state cannot become permanent.

## Migration Plan

Deploy is a normal release per phase — no schema changes, no data migration, rollback = revert the PR. The Docker image contract is unchanged.

## Open Questions

- Land order relative to the three in-flight changes (recommendation: land `summary-length-cap` and `filter-empty-sessions-from-context` first — both are small and touch `sessions`; `add-data-protection-defaults` can interleave since `diagnostics.ts` lands in phase 1 and backup code only moves in phase 4).
- Whether `embedding-worker.ts` needs its own repository or shares `VectorsRepository` (leaning: share; both operate on `memory_vec`).
