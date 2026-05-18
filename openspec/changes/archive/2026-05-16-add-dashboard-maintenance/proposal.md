## Why

Rembric's append-only contract is a load-bearing tenet: `memory`, `sessions`, `consolidation_ops`, and related tables never `DELETE` rows. That contract is designed for a multi-tenant, audit-first scenario where every row carries forensic value. The author's actual use of Rembric is single-operator and personal — a "memory layer built to my taste" — where two specific categories of row accumulate as pure noise:

1. **Empty ended sessions.** A session row created by a hook that never produced a memory, prompt, summary, title, or confirmation. Status terminal (`ended` or `abandoned`), zero downstream artefacts. The row has no forensic value: there is literally nothing to audit.
2. **Disconnected archived memories.** A row in `status='archived'` (decayed or superseded into archive by consolidation) whose id is referenced by nothing else in the database: no other memory's `replaces` array, no `consolidation_ops.affected_ids`, no `consolidation_ops.created_id`, no `memory_relations` row, no `confirmations` row. The row is a leaf of the graph that no other row can reach.

Both categories are detectable with deterministic SQL predicates that do NOT depend on time or judgment. Leaving them in the database serves no audit need (nothing references them) and contradicts the operator's mental model of "Rembric is mine, I get to clean it up". Today the only path to remove them is editing the SQLite file directly, which violates every safeguard the project ships.

The trigger choice is **manual operator action**, not a background cron, because:

- The volume is low enough that scheduled cleanup is over-engineering (a session row is ~400B, an embedding ~6KB, and growth is bounded by usage).
- An operator-visible button surfaces the count beforehand and turns the decision into an explicit act, which is appropriate for an operation that relaxes a load-bearing invariant.
- No environment variables, no scheduler integration, no race against in-flight summary writes — the action runs when the operator explicitly clicks it.

## What Changes

- **DASHBOARD** Add a new top-level page `/dashboard/maintenance` (linked from the sidebar). The page is gated to dashboard sessions whose underlying token has scope `*` (admin). Tokens with project scope SHALL NOT see the link in the sidebar, and direct navigation SHALL return `403 forbidden` with a copy explaining that maintenance requires an admin-scoped token.
- **DASHBOARD** The maintenance page surfaces a DB breakdown (total file size + per-table page count via `dbstat`) and two cleanup cards: "Purge empty sessions" and "Purge disconnected archived memories". Each card shows a pre-flight count and a `data-confirm` modal-backed POST.
- **SCHEMA** No schema changes. The two purge predicates run as `DELETE`s gated by the existing indexes and FK guarantees (the predicates' `NOT EXISTS` clauses are precisely the conditions that prove the FK from `prompts.session_id` and the soft FK from `memory.session_id` cannot dangle).
- **SERVICE** `AgentSessionsService` gains `purgeEmpty({ adminBypass: true }): { deletedIds: string[] }`. The method runs the empty-session predicate, deletes rows in a single transaction, and returns the deleted ids. Without `adminBypass: true`, the method throws `forbidden` — agent-facing surfaces never reach it.
- **SERVICE** `MemoryService` gains `purgeDisconnectedArchived({ adminBypass: true }): { deletedIds: string[] }`. The method runs the disconnected-archived predicate, deletes rows from `memory`, `memory_vec`, and `memory_fts` in a single transaction, and returns the deleted ids. Without `adminBypass: true`, the method throws `forbidden`.
- **SCOPE OF INVARIANTS** The append-only invariant on `sessions` and `memory` is narrowed: a row MAY be physically deleted when (and only when) it satisfies the corresponding predicate AND the deletion is triggered by `AgentSessionsService.purgeEmpty` or `MemoryService.purgeDisconnectedArchived` with `adminBypass: true`. No other code path SHALL emit `DELETE FROM sessions` or `DELETE FROM memory`. The existing CI invariant test SHALL be updated to enforce that exact source-of-call restriction.
- **CONSOLIDATION REVERSIBILITY** The "Every consolidation operation MUST be reversible" requirement is narrowed: undo is guaranteed only when no row referenced by the op's `affected_ids` has been physically purged. When undo is attempted and a referenced row is missing, the dashboard SHALL surface a structured error (`purged_row_missing`) instead of silently failing.
- **JOURNALING** Both purges write a row to `consolidation_ops` with `op_type='session_purge'` or `op_type='archived_memory_purge'`, `affected_ids` carrying the deleted ids, and `reasoning` carrying a static string. This preserves an audit trail of what was removed even though the rows themselves are gone. The `consolidation_ops` rows are NOT subject to purge — they remain forever.
- **DOCS** Update `CLAUDE.md` and `README.md` to document the maintenance page, the two purges, and the invariant relaxation. Mention explicitly that purging is irreversible and that the consolidator's reversibility horizon is now `(now − last purge of an affected row)`.

## Capabilities

### New Capabilities

None — the maintenance page and the two purges modify existing capabilities (`dashboard`, `sessions`, `memory`, `consolidation`).

### Modified Capabilities

- `sessions`: relax append-only invariant with the operator-only physical-purge escape hatch. Add the `purgeEmpty` service contract.
- `memory`: relax append-only invariant with the operator-only physical-purge escape hatch. Add the `purgeDisconnectedArchived` service contract.
- `consolidation`: narrow the reversibility requirement to "reversible when affected rows still exist".
- `dashboard`: add the `/dashboard/maintenance` page, the admin-scope gate, the DB breakdown, and the two cleanup cards.

## Impact

- **New files**:
  - `src/dashboard/maintenance.ts` — page renderer + the two POST handlers
  - `openspec/changes/add-dashboard-maintenance/` — this proposal + design + deltas + tasks
- **Modified files**:
  - `src/services/agent-sessions.ts` — add `purgeEmpty`
  - `src/services/memory.ts` — add `purgeDisconnectedArchived`
  - `src/server/dashboard-router.ts` — wire the new page + 2 POST routes
  - `src/server/dashboard-routes.ts` (or equivalent) — register the routes
  - `src/dashboard/page-shell.ts` — sidebar entry for `Maintenance` (visible only to admin-scope tokens)
  - `src/test/invariants.test.ts` — update the `DELETE FROM sessions` and `DELETE FROM memory` rules
  - `src/db/schema/consolidation.ts` — extend the `op_type` enum with `session_purge` and `archived_memory_purge`
  - `CLAUDE.md`, `README.md` — note the maintenance surface and the narrowed invariant
- **No changes**:
  - `plugin/` tree (the purge is dashboard-only)
  - CLI (no `rembric maintenance` subcommand in V1; can be added later)
  - `src/consolidation/scheduler.ts` and `runner.ts` (the purge is NOT scheduled)
  - Migrations directory (no schema changes)
