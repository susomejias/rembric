## MODIFIED Requirements

### Requirement: Scoped, unsafe, and admin method families

Repository read methods consumed by scoped service paths SHALL require scope context as explicit parameters and SHALL NOT default to unfiltered reads. Deliberately cross-scope repository methods consumed by services and operational code (consolidation engine, scope-check-then-use patterns) SHALL carry the `unsafe` prefix, mirroring the `MemoryService.unsafe*` convention. Dashboard-facing unscoped reads SHALL carry the `admin` name prefix, SHALL be read-only, and SHALL be invoked only from modules under `apps/server/src/dashboard/` (plus the two explicitly named non-dashboard call sites below). Services remain the sole resolvers of effective scope (`resolveEffectiveProject` / `scopeFromContext`); repositories enforce the filter they are given.

There is no third, unprefixed category. An aggregate-count method is NOT exempt from the prefixes: the grep gate matches call sites by method-name prefix, so an unscoped read carrying neither prefix is invisible to it and can be served from an agent-facing path while the invariant test passes — which is exactly how an unscoped session count reached `memory.stats`. Every unscoped repository read SHALL therefore carry `admin`, whatever it returns.

Two `admin*` call sites legitimately sit outside `src/dashboard/`, and both are named here rather than left to a general exemption:

- `src/server/dashboard-router.ts`, which renders the operator overview directly.
- The boot-time `memory.doctor` closure in `src/server/bootstrap.ts`. The doctor report is deliberately server-wide — `sessions.active`, the embedding and entity backlogs, the latest consolidation run and the review/pending queue depths are all unscoped by design, so that an operator debugging one project still sees the whole process's health. The closure is constructed once at boot and reads nothing per-request-scoped, so it does not leak cross-scope ROWS: every field it returns is a count or a timestamp. Reads reachable only from it SHALL still carry the `admin` prefix, so the gate sees them and the exemption is a listed call site rather than an unnamed naming gap.

#### Scenario: Invariant test pins admin call sites to the dashboard

- **WHEN** the invariants suite scans non-test source files outside the dashboard modules, the two named call sites, and `apps/server/src/db/repositories/` for invocations of `admin`-prefixed repository methods
- **THEN** the suite SHALL fail, naming the offending file, when any such call site is found

#### Scenario: An unscoped aggregate reachable from the doctor carries the prefix

- **WHEN** an unscoped repository read is reachable from the `memory.doctor` report
- **THEN** it SHALL carry the `admin` prefix, so it is inside the confinement gate rather than invisible to it

#### Scenario: Cross-scope semantics are preserved

- **WHEN** a service requests a memory through a repository with a scope that does not match the row's `(scope, project_id)`
- **THEN** the repository SHALL return no row and the service SHALL surface `not_found`, identical to pre-refactor behavior
