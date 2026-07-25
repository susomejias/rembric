## MODIFIED Requirements

### Requirement: The dashboard MUST expose accumulated knowledge per entity

An operator cannot currently tell where a project's memory is dense and where it is blind. The dashboard SHALL provide an entity view listing entities with their linked-memory counts, filterable by entity kind and sorted by count, with each entity linking to the memories that reference it.

The view SHALL surface the inverse signal as well — the most-referenced entities are interesting, but entities referenced exactly once are the more actionable list, because they mark knowledge that never converged into a maintained topic.

The view SHALL be **cross-scope with an explicit scope label** rather than scope-isolated: every row carries the project slug it belongs to, or `global`. The dashboard is a single operator behind one admin token and `/dashboard/memories` already lists every scope on one page, so isolating this one view would be inconsistent with the surface it sits in and would hide exactly the cross-project density comparison the view exists to make. Scope isolation is an AGENT-facing guarantee, structurally held by `memory_entities_identity_idx` (see the `persistence` capability): the same literal string in two projects is two rows, so no cross-project join exists for an operator view to leak. A per-project filter remains a legitimate later request; it is not a missing part of this requirement.

#### Scenario: Entities are listed with their counts

- **WHEN** the operator opens the entity view
- **THEN** entities SHALL be listed with their linked-memory counts and their kinds

#### Scenario: An entity links to its memories

- **WHEN** the operator selects an entity
- **THEN** the memories linked to it SHALL be listed using the existing memories view and its filters

#### Scenario: Single-reference entities are reachable

- **WHEN** the operator filters for entities referenced exactly once
- **THEN** those entities SHALL be listed

#### Scenario: Every row names its scope

- **GIVEN** an entity present only in one project and an entity present only in the global scope
- **WHEN** the operator opens the entity view
- **THEN** both SHALL appear, each labelled with its project slug or with `global`
