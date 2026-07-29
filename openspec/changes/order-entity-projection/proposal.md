## Why

`ENTITIES_PROJECTION_CAP = 10` is applied to a list ordered by `(kind, value)`, so which entities survive is decided by the **alphabetical spelling of the kind name**. `path` sorts eighth of twelve kinds, and `ticket`, `url`, `uuid` sort last — so on a memory whose entity list exceeds the bound, the minority kinds are evicted first and the dominant kind keeps the remaining slots. `a01d051` made that order stable (`surface-entity-projection-total` had left the projection non-deterministic — two identical reads of the same memory could return different subsets); it did not make it useful, and the archived `design.md` D2 recorded the ordering gap as deferred rather than denied.

The consequence is concrete, not theoretical. Measured with the shipped `extractEntities` (`v7-tracked-dotfiles-fair-budget`) over 284 production-shaped documents — this repo's own commit bodies, p50 855 chars, p90 2534, max 8602, the shape a `memory.session_summary` carries (`summary` ≤ 10000):

| figure                                                               | value                          |
| -------------------------------------------------------------------- | ------------------------------ |
| entities per document                                                | p50 1 · p90 3 · p99 8 · max 23 |
| documents where the bound binds (`entitiesTotal > 10`)               | 2 / 284 = **0.7%**             |
| binding documents that lose an **entire kind** under `(kind, value)` | **2 / 2**                      |
| kinds lost                                                           | `ticket` ×2, `url` ×1          |
| binding documents that lose an entire kind under fair share          | **0 / 2**                      |

Both binding documents lose their issue reference. The 23-entity one projects `env_var:HOME` plus nine paths, and drops `ticket:#56` and `url:https://opencode.ai` — it keeps the single worst pivot available (`HOME` is linked to nearly everything) and discards the two that address exactly one thing. The bound is not the defect; ordering the bound by kind name is.

## What Changes

- **The `entities[]` projection is ordered by max-min fair share across the kinds present**, not by kind name: every kind linked to the memory gets one slot before any kind gets a second, and the surplus goes to the kinds that have more. Chosen over a kind-precedence tier because entity kinds admit no defensible precedence — the objection archived D2 raised, and which this change upholds rather than overturns (`ticket` does not outrank `path` the way `conflicts_with` outranks `related`). Fair share needs no precedence claim, is symmetric across kinds, and is the algorithm `services/entities.ts` already applies to the extraction budget for the same reason. Same rule, second bound.
- **Rarity ordering is rejected for now, not dismissed.** A rare identifier is the better pivot — `env_var:HOME` surviving while `ticket:#56` is dropped is exactly that failure — but ranking by link count needs a per-entity aggregate on a read path served on every `memory.search`. At a 0.7% binding rate that query is paid on every row to change ten entities on one row in 143. Fair share fixes the measured harm (2/2 → 0/2 kinds lost) at zero query cost. Recorded as D3 with the trigger for revisiting.
- **`ENTITIES_PROJECTION_CAP` stays 10, now with a measurement behind it** rather than an unanswered open question. p99 is 8, so the bound sits above the 99th percentile of production-shaped extraction; raising it to 25 would cover the observed maximum of 23 while adding nothing to 99.3% of rows.
- **No shipped distribution instrument is built.** `surface-entity-projection-total`'s open question asked for one; the measurement above answers it offline with the shipped extractor, against any corpus, without a permanent dashboard aggregate. A per-installation binding-rate figure on `/dashboard/entities` is a `dashboard` capability change and would earn its own proposal — and the reordering removes the harm that made the figure urgent. D4 records why it is not a prerequisite.
- **One helper returns the bounded list and its total together**, so a call site cannot project one without the other. `a01d051` had to repair exactly that class of bug: `fields: ['entities']` returned 10 of 27 entities and no count, breaking a guarantee published in the same branch. Three call sites × two coupled fields is the shape that produced it.
- No new MCP tool, no input-schema change, no request argument that raises the returned count, no migration, no derived-index invalidation, no `EXTRACTOR_VERSION` bump.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: "Memory-returning reads MUST expose the entities a memory is about" gains the ordering guarantee it explicitly withheld — the projection is specified as fair-shared across kinds and total, and as identical on all three surfaces. `entitiesTotal`'s exactness, scope isolation and no-companion-boolean rules are unchanged.
- `memory`: the `ENTITIES_PROJECTION_CAP` bullet of "Retrieval and lifecycle constants MUST be named and bounded in one place" states that the bound is applied to a fair-shared order rather than an arbitrary one, so the constant's value is reviewable against what it actually withholds.

## Impact

- `apps/server/src/services/entities.ts` — new exported projection helper (bounded list + exact total) beside the existing max-min fair-share budget allocator it reuses the rule from. No change to `extractEntities`, `EXTRACTOR_VERSION`, or `admit`.
- `apps/server/src/mcp/memory-tools.ts` — the three `ents.slice(0, ENTITIES_PROJECTION_CAP)` sites (`:992` `memory.search`, `:1058` batch `memory.get`, `:1110` single `memory.get`) call the helper instead. `ENTITIES_PROJECTION_CAP` keeps its name, value and location.
- `apps/server/src/db/repositories/entities-repository.ts` — **no change**. `findEntitiesForMemory` / `findEntitiesForMemories` keep `ORDER BY (kind, value)`; that clause is now the determinism guarantee the interleave's input depends on, and its doc comments say so.
- `apps/server/src/mcp/memory-tools.test.ts` — the existing `entitiesTotal` surface loop (`:353`) gains ordering assertions.
- `openspec/specs/{mcp-api,memory}/spec.md` — via delta.
- Not touched: `apps/plugin/` (no tool-schema or description change), `memory_entities` / `memory_entity_links` schema, the save-time rarity gate and `ENTITY_RARITY_THRESHOLD`, the entity-noise measurement, `/dashboard/entities`, the eval harness.
- Load-bearing invariants: none crossed. Append-only untouched (a read projection over unchanged rows), scope still resolved at the service layer, SQL still confined to `db/` — the reordering is deliberately not SQL, so no query plan changes.
