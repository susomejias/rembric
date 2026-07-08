## Why

The `mcp-api` spec (§ "memory.stats returns counters by scope and status") requires `memory.stats` to return `{ memoriesByStatus, memoriesByType, memoriesByScope, sessionsByStatus, totalProjects, totalTokens }`. The shipped handler (`apps/server/src/mcp/sessions-tools.ts::handleStats`) returns only `{ scope, memoriesByStatus, memoriesByType, sessionsByStatus }` — `memoriesByScope`, `totalProjects`, and `totalTokens` are missing, and `scope` is returned but unspecified. This pre-existing impl↔spec divergence was surfaced while adding `outputSchema` to the tool (the new `statsOutput` schema codifies the handler's actual shape, making the gap explicit). Left unreconciled, the spec is a lie and the new `outputSchema` enshrines the wrong contract.

## What Changes

- Reconcile handler and spec. Recommended direction: **extend the handler** to honor the spec (the spec is the authoritative contract per CLAUDE.md), then widen `statsOutput` to match.
- Add `memoriesByScope` (counts keyed by scope), `totalProjects`, `totalTokens` to `handleStats`, sourced from existing repository counters (`memory-repository.countByProject`, a projects count, a tokens count) — no new SQL outside `db/`.
- Decide the shape of `totalProjects`/`totalTokens`: the spec says "each value being a `Record<string, number>`", which fits `memoriesByScope` but reads oddly for two scalars — clarify in the spec whether they are scalars (`number`) or records, and update §387 wording accordingly.
- Keep or formally spec the extra `scope` field the handler already returns.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `mcp-api`: clarify/finalize the `memory.stats` response requirement so the spec and the handler (and its `outputSchema`) agree.

## Impact

- Code: `apps/server/src/mcp/sessions-tools.ts` (`handleStats` + `statsOutput`); possibly new lightweight count methods in `apps/server/src/db/repositories/` (projects/tokens counts) — SQL stays under `db/`.
- Spec: `openspec/specs/mcp-api/spec.md` §"memory.stats" — finalize field list + value types.
- Tests: extend `mcp-integration.test.ts` stats assertions.
- No DB migration. Additive to the response (existing clients reading the current fields keep working).
