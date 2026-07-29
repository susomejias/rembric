## MODIFIED Requirements

### Requirement: Memory-returning reads MUST expose the entities a memory is about

An agent that receives a memory SHALL be able to see what it is about, so it can pivot to related knowledge without guessing a query. Memory-returning reads SHALL include an `entities[]` field listing the entities linked to each memory, each with its kind. The list SHALL be bounded per memory so a content-heavy row cannot inflate a response.

The bound's effect SHALL be reported as a COUNT, not as an indication that it was hit. Each memory carrying `entities[]` SHALL also carry `entitiesTotal: number` — how many entities are linked to that memory in scope, taken before the bound is applied. It SHALL be present whether or not the bound was reached, so a caller never has to distinguish "nothing was cut" from "the field was omitted", and it SHALL NOT be the returned array's length restated.

No companion boolean SHALL be returned: truncation is `entitiesTotal > entities.length`, and a flag beside the number is duplicated state that can disagree with itself. This mirrors the relation-annotation total (see "`memory.get` and `memory.search` MUST report how many relation annotations exist"), deliberately, so the two projections describe their bounds the same way.

The count SHALL be exact rather than a lower bound, because the reads behind the projection apply no `LIMIT` and no pool bounds them upstream — the array the bound is applied to already holds every linked entity in scope. It therefore differs from the save-time detected count, which is specified as a floor precisely because its channels scan a bounded pool.

No request argument SHALL raise the number of entities returned, and no tool description SHALL name one. The remedy for a truncated list is the exact-address read the entity index already provides — `memory.search` with an `entity` filter, which is complete within scope — not a wider projection on an unrelated read.

Cross-scope entities SHALL NOT be counted: `entitiesTotal` obeys the same scope isolation as the list it describes.

#### Scenario: A returned memory carries its entities

- **GIVEN** a memory linked to two file paths and a package name
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
