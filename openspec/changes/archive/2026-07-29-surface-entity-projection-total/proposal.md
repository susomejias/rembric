## Why

`entitiesTruncated` is a boolean sitting beside a total that is equally free. A caller learns
that entity information was withheld, but not how much — so it cannot tell "one more entity"
from "forty more", and has no basis for deciding whether to pivot with `memory.search
entity:`.

The count is already in hand at the moment of truncation. `findEntitiesForMemory` and
`findEntitiesForMemories` carry no `LIMIT`; the bound is applied in TypeScript
(`ents.slice(0, ENTITIES_PROJECTION_CAP)` at three sites in `mcp/memory-tools.ts`), over an
array that already holds every linked entity. This is the same property that made
`relationsTotal` cost nothing in `order-relation-annotations`, which shipped earlier today.

Deliberately excluded from that change (its design.md D4, task 7.3) because it touches a
different capability and three further call sites for no additional correctness on the
annotation-ordering defect that change fixed.

## What changes

- `entitiesTruncated: boolean` is retired in favour of `entitiesTotal: number`, on the same
  terms `relationsTotal` established: present whenever `entities` is present, bounded or not;
  the count before the bound, never the returned array's length restated; no companion
  boolean, because truncation is `entitiesTotal > entities.length`.
- Three response surfaces: `memory.search` rows, batch `memory.get`, single-id `memory.get`.
- The `memory` capability's constant list stops saying the cap's "exhaustion is reported" and
  says the pre-bound count is reported instead.

## What does NOT change

No input schema, so no client work: `git ls-files apps/plugin/` must be untouched. No SQL, no
repository, no migration — the reads already return everything. `ENTITIES_PROJECTION_CAP`
stays at 10; this change reports the bound's effect, it does not move the bound.

Unlike `relationsTotal`, there is no truncation DEFECT here to fix. The ordering of
`entities[]` is not being changed, and no claim is made that the retained 10 are the most
useful 10 — see design.md D2, which is the honest limitation of this change.

## Impact

Breaking for any consumer reading `entitiesTruncated`. Grep says there are none: zero
references outside `mcp/memory-tools.ts` itself — no test, no dashboard template, no plugin
file, and no published spec names the field. It is removed rather than deprecated alongside
the new field, because shipping both is exactly the duplicated state the `relationsTotal`
requirement forbids.
