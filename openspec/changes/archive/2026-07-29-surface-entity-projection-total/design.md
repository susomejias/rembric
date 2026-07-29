## D1 — A total, not a flag, and no both

`relationsTotal` settled this idiom hours ago and the reasoning transfers unchanged: a
boolean beside a freely-available count teaches the caller that the API reports the existence
of missing data rather than its extent, and a flag shipped _next to_ the total is duplicated
state that can disagree with itself.

The name is `entitiesTotal`, with the `Total` suffix, and unlike `candidatesDetected` that
suffix is correct here: the count is **exact**, not a floor. `findEntitiesForMemory` has no
`LIMIT` and no pool bound anywhere upstream, so the array being sliced holds every entity
linked to the memory in scope. `candidatesDetected` had to avoid the suffix precisely because
its channels scan a bounded pool; this one does not.

## D2 — What this change does NOT fix, stated so it is not assumed

`order-relation-annotations` paired its total with an ordering guarantee, because a bound
applied to an unordered set can hide the one annotation that mattered — a contradiction lost
behind nine `related` rows. **No equivalent guarantee is made for entities.** The order of
`entities[]` is whatever the join returns, and the retained 10 are not claimed to be the most
useful 10.

That is defensible and it is not the same situation: entity kinds do not carry a severity
ordering the way relation kinds do (a `conflicts_with` outranks a `related`; a `path` does not
outrank a `ticket`), and the remedy for a truncated entity list is a cheap exact-address
follow-up — `memory.search` with `entity:` — where a dropped conflict annotation has no such
route. But the asymmetry is real, and `entitiesTotal` makes it _visible_ rather than
resolving it: a caller that sees `entitiesTotal: 40` now knows to be suspicious of which 10 it
got. Publishing the count is what makes a future ordering change measurable. Deferred, not
denied.

## D3 — No `entities_limit` parameter

`relations_limit` exists because a deep read of one memory's judgments is a real workflow with
a per-surface default worth overriding. Entities have no such workflow: they are a pivot hint,
and the pivot itself (`memory.search entity:`) is unbounded-within-scope already. Adding a
limit parameter would be an input-schema change across four clients for a caller that has a
better tool one call away. The tool description therefore names no argument that raises the
returned count — the same rule the `memory.save` description follows.

## D4 — Removed, not deprecated

Both fields shipping together was considered and rejected. The `relationsTotal` requirement
forbids a companion boolean by name; adding `entitiesTotal` while keeping `entitiesTruncated`
would violate the requirement this change is modelled on, in the same response object. The
compatibility argument is empty in any case: grep finds zero consumers, and the field appears
in no published spec, so nothing can be relying on documented behaviour.

## Open question

Whether `ENTITIES_PROJECTION_CAP = 10` is the right bound at all. The published count is the
instrument needed to answer it — the distribution of `entitiesTotal` over real reads shows how
often the cap binds. Not decided here; this change makes the question answerable.
