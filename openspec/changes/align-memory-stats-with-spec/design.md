## Context

`handleStats` (`apps/server/src/mcp/sessions-tools.ts`) returns:

```
{ scope, memoriesByStatus, memoriesByType, sessionsByStatus }
```

The `mcp-api` spec §"memory.stats returns counters by scope and status" requires:

```
{ memoriesByStatus, memoriesByType, memoriesByScope, sessionsByStatus, totalProjects, totalTokens }
```

Divergence: `memoriesByScope`, `totalProjects`, `totalTokens` are absent from the handler; `scope` is present but unspecified. Surfaced by the `add-mcp-tool-output-schemas` change, whose `statsOutput` schema mirrors the handler (so no runtime validation error today — the schema is simply narrower than the spec demands).

## Goals / Non-Goals

**Goals:** one agreed shape for `memory.stats` across spec, handler, and `outputSchema`; reuse existing repo counters; stay additive (no removal of currently-returned fields).

**Non-Goals:** changing other tools; introducing new SQL outside `db/`; a DB migration.

## Decisions

### Decision 1 — Extend the handler to the spec (don't shrink the spec to the handler)

CLAUDE.md: specs are the authoritative contract. So add the three missing fields rather than delete the requirement. `memoriesByScope` = counts keyed by `global`/`project:<id>` (or a `{ global, project }` record); `totalProjects` and `totalTokens` from cheap counts.

### Decision 2 — Resolve the `Record<string, number>` wording

Spec §387 says "each value being a `Record<string, number>`". That fits `memoriesByScope` but is wrong for `totalProjects`/`totalTokens`, which are scalars. The spec text must be corrected to type those two as `number`. This is the one substantive spec edit.

### Decision 3 — Source counts from repositories (no SQL in services)

Use `memory-repository` for `memoriesByScope` (extend `countByProject`/add a scope rollup), and add small `count()` methods to the projects and tokens repositories if absent. All SQL stays under `db/` per the data-access invariant.

### Decision 4 — Keep `scope`

The handler already returns `scope`; it's useful and harmless. Add it to the spec rather than drop it.

## Risks / Trade-offs

- [`totalTokens` semantics ambiguous — count of token rows vs. sum of something] → define as count of active token rows (operator-facing counter), state it in the spec.
- [Widening `statsOutput` before the handler returns the fields would break the tool] → land handler + schema + spec together in one change; the SDK validates on every call so a mismatch fails tests immediately.

## Migration Plan

Additive; no DB migration. Ship handler + `statsOutput` + spec text together. Rollback = revert the three-field addition.

## Open Questions

- Exact shape of `memoriesByScope`: `{ global: n, "project:<id>": n, ... }` vs a fixed `{ global, project }` rollup. Pick during apply based on what the dashboard/operator wants.
