## MODIFIED Requirements

### Requirement: Memory-returning reads MUST expose the entities a memory is about

An agent that receives a memory SHALL be able to see what it is about, so it can pivot to related knowledge without guessing a query. The three primary memory-returning reads — `memory.search` result rows, batch `memory.get`, and single-id `memory.get` — SHALL include an `entities[]` field listing the entities linked to each memory, each with its kind. The list SHALL be bounded per memory so a content-heavy row cannot inflate a response.

**Scoped to those three deliberately.** `memory.search`'s relation-expansion rows (`expanded[]`) are a fourth surface that returns whole memories and carries no `entities[]` today. The previous wording said "memory-returning reads" without qualification and therefore overclaimed: the shipped repo has never satisfied it for `expanded[]`. The requirement is narrowed to what is true rather than left asserting what is not, and extending the projection to `expanded[]` — which would add a per-turn repository read for up to `RELATION_EXPANSION_CAP` rows on the hottest path — is a scoped decision, not a wording fix. `memory.context` is out of scope for a different reason: it projects no per-memory entity list at all, only an `entities.backlog` diagnostics counter.

**When the bound binds** (`entitiesTotal` exceeds it), the bound SHALL be applied to an order that reflects the memory's own entity composition, not the spelling of a kind name: max-min fair share across the kinds linked to the memory, so every kind present contributes one entity before any kind contributes a second, and the remaining slots fall to the kinds that have more. Consequently a kind linked to the memory SHALL NOT be absent from the projection while another kind occupies two or more slots.

**When the bound does not bind, the projection SHALL be the repository's `(kind, value)` order, unchanged.** This is the case on the overwhelming majority of rows (measured: the bound binds on 2 of 285 production-shaped documents), nothing is withheld, so there is no selection to make fair — and re-interleaving a complete list would change what every existing caller sees to no end. The two paths therefore differ in ORDER, not in membership, and only above the bound.

No kind SHALL be declared to outrank another. The ordering carries no precedence claim: which entity is the better pivot depends on the question being asked and that question is not in the row. Note the one residue this does not remove — when equal-sized kinds compete for a surplus slot, the slot goes to the kind whose name sorts first, so `path` beats `url` at identical counts. That is inherited from the extraction budget's allocator, is reachable with as few as three kinds, and is a far smaller effect than the whole-kind eviction this requirement fixes; it is recorded rather than claimed away.

Within a kind the entities SHALL be ordered by value, and the whole order SHALL be total: two identical reads over unchanged data SHALL return the same entities in the same order. `(kind, value)` is unique per memory, so no tie can be left to scan order.

The bound's effect SHALL be reported as a COUNT, not as an indication that it was hit. Each memory carrying `entities[]` SHALL also carry `entitiesTotal: number` — how many entities are linked to that memory in scope, taken before the bound is applied. It SHALL be present whether or not the bound was reached, so a caller never has to distinguish "nothing was cut" from "the field was omitted", and it SHALL NOT be the returned array's length restated. The count SHALL be unaffected by the ordering: reordering the projection changes which entities are returned, never how many exist.

No companion boolean SHALL be returned: truncation is `entitiesTotal > entities.length`, and a flag beside the number is duplicated state that can disagree with itself. This mirrors the relation-annotation total (see "`memory.get` and `memory.search` MUST report how many relation annotations exist"), deliberately, so the two projections describe their bounds the same way.

The count SHALL be exact rather than a lower bound, because the reads behind the projection apply no `LIMIT` and no pool bounds them upstream — the array the bound is applied to already holds every linked entity in scope. It therefore differs from the save-time detected count, which is specified as a floor precisely because its channels scan a bounded pool.

No request argument SHALL raise the number of entities returned, and no tool description SHALL name one. The remedy for a truncated list is the exact-address read the entity index already provides — `memory.search` with an `entity` filter, which is complete within scope — not a wider projection on an unrelated read.

Cross-scope entities SHALL NOT be counted: `entitiesTotal` obeys the same scope isolation as the list it describes.

#### Scenario: A returned memory carries its entities

- **GIVEN** a memory linked to two file paths and a ticket reference
- **WHEN** it is returned by `memory.get` or `memory.search`
- **THEN** its `entities[]` SHALL list those three with their kinds

#### Scenario: The entity list is bounded

- **GIVEN** a memory linked to more entities than the per-memory bound
- **WHEN** it is returned
- **THEN** `entities[]` SHALL hold exactly the bound, and `entitiesTotal` SHALL be the larger true count rather than a flag indicating that the bound was hit

#### Scenario: An untruncated list still carries the count

- **GIVEN** a memory linked to fewer entities than the bound
- **WHEN** it is returned
- **THEN** `entitiesTotal` SHALL equal `entities.length`

#### Scenario: A memory with no entities reports zero

- **WHEN** a memory with no linked entities is returned
- **THEN** `entities[]` SHALL be empty and `entitiesTotal` SHALL be 0

#### Scenario: No companion truncation flag is returned

- **WHEN** any memory-returning response is inspected
- **THEN** it SHALL NOT contain a boolean reporting whether the entity list was truncated

#### Scenario: The count is reported on every memory-returning surface

- **WHEN** a memory is returned by `memory.search`, by a batch `memory.get`, or by a single-id `memory.get`
- **THEN** each SHALL carry `entitiesTotal` on the same terms; a surface that omits it SHALL be treated as a defect

#### Scenario: The count respects scope

- **GIVEN** another project holding entities with the same values
- **WHEN** a memory is returned in scope `project:'A'`
- **THEN** `entitiesTotal` SHALL count only entities linked to that memory within its own scope

#### Scenario: A minority kind is not evicted by a dominant one

- **GIVEN** a memory linked to 21 paths, one ticket, one URL and one environment variable, and a bound of 10
- **WHEN** it is returned
- **THEN** the ticket, the URL and the environment variable SHALL each appear in `entities[]`, the remaining slots SHALL hold paths, and `entitiesTotal` SHALL be 24

#### Scenario: The dominant kind loses the surplus slots, not the whole list

- **GIVEN** the same memory
- **WHEN** it is returned
- **THEN** `entities[]` SHALL still contain paths — a kind SHALL NOT be reduced to zero slots while the bound is not yet filled

#### Scenario: A kind that sorts last alphabetically is still projected

- **GIVEN** a memory linked to more entities than the bound, whose only `uuid` sorts after every other kind present by kind name
- **WHEN** it is returned
- **THEN** that `uuid` SHALL appear in `entities[]`

#### Scenario: The projection is repeatable

- **GIVEN** a memory linked to more entities than the bound
- **WHEN** it is returned twice with no intervening write
- **THEN** both responses SHALL contain the same entities in the same order

#### Scenario: All three surfaces project the same order

- **GIVEN** one memory linked to more entities than the bound
- **WHEN** it is returned by `memory.search`, by a batch `memory.get`, and by a single-id `memory.get`
- **THEN** all three SHALL return the same entities in the same order

#### Scenario: A field projection keeps the order, the bound and the count

- **GIVEN** a memory linked to more entities than the bound
- **WHEN** `memory.search` is called with `fields` including `entities`
- **THEN** `entities[]` SHALL carry the same bounded, fair-shared list as an unprojected read, and `entitiesTotal` SHALL be present with the same value

#### Scenario: More distinct kinds than the bound

- **GIVEN** a memory linked to more distinct entity kinds than the bound allows slots for
- **WHEN** it is returned
- **THEN** `entities[]` SHALL hold one entity from each of the first kinds in ascending kind-name order, the remaining kinds SHALL be absent, and `entitiesTotal` SHALL still report every linked entity
