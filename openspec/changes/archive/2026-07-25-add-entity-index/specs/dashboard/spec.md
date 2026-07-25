## ADDED Requirements

### Requirement: The dashboard MUST expose accumulated knowledge per entity

An operator cannot currently tell where a project's memory is dense and where it is blind. The dashboard SHALL provide an entity view listing entities in the selected scope with their linked-memory counts, filterable by entity kind and sorted by count, with each entity linking to the memories that reference it.

The view SHALL surface the inverse signal as well — the most-referenced entities are interesting, but entities referenced exactly once are the more actionable list, because they mark knowledge that never converged into a maintained topic.

#### Scenario: Entities are listed with their counts

- **WHEN** the operator opens the entity view for a project
- **THEN** entities in that project SHALL be listed with their linked-memory counts and their kinds

#### Scenario: An entity links to its memories

- **WHEN** the operator selects an entity
- **THEN** the memories linked to it SHALL be listed using the existing memories view and its filters

#### Scenario: Single-reference entities are reachable

- **WHEN** the operator filters for entities referenced exactly once
- **THEN** those entities SHALL be listed

#### Scenario: The view is scope-isolated

- **WHEN** the operator views entities for one project
- **THEN** no entity belonging solely to another project SHALL appear
