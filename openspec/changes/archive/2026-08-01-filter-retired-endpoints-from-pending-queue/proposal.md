## Why

`memory.context.pendingJudgments[]` is the agent's only standing view of the judgment queue, and it is a page: `PENDING_JUDGMENTS_DEFAULT = 5` (`apps/server/src/mcp/memory-tools.ts:85`), ordered oldest-first. Neither read that backs it constrains the lifecycle of the memories it names, so a pair whose source was retired by a `topic_key` supersede stays in the queue — and because a superseded row is by definition older than the row that superseded it, the dead entries sort **ahead** of the live ones and occupy the page.

It self-amplifies in the direction of correct usage. `topic_key` iteration is the documented convergence workflow, and every revision adds up to `CANDIDATES_PER_SAVE_MAX` (default 5, `apps/server/src/config.ts:47`) more unadjudicable pendings. They clear only at `JUDGMENT_ORPHAN_DEADLINE_MS` (default `14 * 86_400_000`, `apps/server/src/config.ts:151-156`).

Measured against `main` with a throwaway probe — save A with a `topic_key`, attach 5 aged pendings to A, save B on the same `topic_key` (so B supersedes A), attach 1 newer aged pending to B, then call the `memory.context` handler:

```
listed page (cap 5):              5 entries
dead entries on the page:         5
live entry on the page?           false
pendingJudgmentsTotal:            6
listPendingInScope rows:          6    countPendingInScope: 6
of those, retired-endpoint rows:  5
```

Control that passed in the same run, so this is not a supersede that never happened: `repos.memory.unsafeGetById(a.id)?.status === 'superseded'` and `…(b.id)?.status === 'active'`. **One `topic_key` revision fully evicts the live pending from the agent's window.**

Real-deployment corroboration from the report (issue #298, v0.25.1, single-user self-hosted, 39 memories / 30 pendings): 6 distinct sources × 5 candidates, of which **2 sources were `superseded`** by a later save on the same `topic_key` — 10 of 30 pendings (33%) hanging off dead rows, each duplicating a question the live successor had already raised against largely the same targets.

## What Changes

- **Both reads gain a both-endpoints-active predicate**, at read time, in `apps/server/src/db/repositories/relations-repository.ts`: `listPendingInScope` (~:376) and `countPendingInScope` (~:402). A pending row SHALL be surfaced to the agent only while its source AND its target are `status = 'active'`.
- **The target is filtered as well as the source**, deliberately: a candidate against a memory that has since been archived or superseded is as unadjudicable as one whose source is gone, and the load-bearing verdict for such a pair — `supersedes` — already throws `conflict` on either endpoint being retired (commit `b5f8366`, change `reject-supersedes-from-retired-endpoints`, `mcp-api/spec.md:2184-2186`).
- **Hide, not demote.** An earlier counter-proposal — keep the rows but rank them below live ones — is dropped: it buys nothing, because the operator surface does not read these methods at all (see Impact), so demotion would only complicate the `ORDER BY` for an audience that has a better view already. The `ORDER BY` cost question that counter-proposal raised is therefore moot.
- **Predicate, not join.** The `sourceMemory` / `targetMemory` aliased tables (`relations-repository.ts:65-66`) are already `innerJoin`ed in both methods to enforce `endpointsInScope`, so this adds one conjunct to an existing `and(…)`.
- **One definition serving both reads**, so the page can never contain a row the total omits, nor the reverse — the failure mode the `pendingJudgmentsTotal` requirement exists to prevent.
- **The 14-day sweep stays the retirement mechanism.** No new orphaning path, no new mutation verb, no write on the save path. The sweep's own selection (`findPendingOlderThanInScope`, `relations-repository.ts:263`, consumed by `consolidation/runner.ts:156`) is deliberately NOT filtered: these rows must still reach `orphaned` rather than becoming invisible-but-immortal.
- Not **BREAKING**: no tool schema changes, no field is added or removed, and `pendingJudgmentsTotal` keeps meaning "the depth of the queue this page pages". What changes is which rows are in that queue.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `memory`: the queue-depth guarantee. "Review and judgment queue depths MUST be observable by the agent" (`openspec/specs/memory/spec.md:979-993`) promises "the total number of unresolved pending judgments in the effective scope"; the delta defines _unresolved_ as _adjudicable_ — both endpoints still active — and adds the requirement that states the filter and its rationale.
- `mcp-api`: "The MCP server MUST expose three research tools" (`openspec/specs/mcp-api/spec.md:479-620`). Two bullets currently read against this change and so must be MODIFIED rather than qualified from a distance: `:493` ("at most `judgments ?? 5` pending relations in scope") and `:494` ("`pendingJudgmentsTotal` SHALL be the count of ALL pending relations in scope"). The word ALL is the contradiction; the delta restates the whole requirement.
- `data-access`: adds the repository-level read contract — the two reads share one predicate, and the count is not eligible for the arithmetic-difference rewrite the capability elsewhere prefers, because it now filters on a column the difference cannot see.

## Impact

Durable invariants touched: **review state is derived, never stored** — this change is an instance of it. Adjudicability is computed at read time from the endpoints' `status`; no column, no migration, no sweep change, no new mutation verb. **Append-only** is untouched: nothing is deleted, no `content` is updated, no `status` is flipped by this change. Scope enforcement is unchanged — the new predicate sits beside `endpointsInScope`, which keeps requiring the resolved `Scope` parameter.

Code:

- `apps/server/src/db/repositories/relations-repository.ts` — one predicate helper beside `endpointsInScope` (~:69), applied in `listPendingInScope` (~:376) and `countPendingInScope` (~:402). No other method changes; `findPendingOlderThanInScope` (~:263) and every `admin*` read are left exactly as they are.

Callers, all agent-facing, none needing a change:

- `apps/server/src/mcp/memory-tools.ts:1444` (`pendingJudgments[]`) and `:1459` (`pendingJudgmentsTotal`).
- `apps/server/src/mcp/observability-tools.ts:279` → `memory.stats.pendingJudgmentsTotal`, via `RelationsService.countPendingInScope` (`apps/server/src/services/relations.ts:504`).

The operator surface is **unaffected and deliberately so**: `/dashboard/judgments` reads `adminListWithContent` (`apps/server/src/dashboard/judgments.ts:59`) and `adminCountWithFilters` (`:63`), neither of which is one of the two filtered methods. Operators keep seeing every pending row, including the retired-endpoint ones, with their existing per-row orphan action.

Tests: `apps/server/src/mcp/context-pending-judgments.test.ts` (the regression the issue suggests, plus controls) and `apps/server/src/db/repositories/*` repository-level cases. No migration, no schema change, no dependency change, no plugin change, no MCP tool signature change.

Deferred, named so they are not lost: a `stale` facet on `/dashboard/judgments` distinguishing retired-endpoint pendings from live ones, and a warning on `memory.stats` / the dashboard when the `global` scope is empty — both suggested in #298, both out of scope here.

Closes #298.
