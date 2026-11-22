## ADDED Requirements

### Requirement: The drain MUST orphan pending pairs that fall in the low confidence band

The drain SHALL orphan a pending pair whose confidence band is `low`, because the save path no longer records a row for such a pair. It SHALL derive the band with `classifyCandidateBand`, the single shared classification function, and SHALL NOT restate the band thresholds. Its inputs are:

- the pair's cosine, read from stored vectors with the embedding model never loaded;
- whether the lexical channel admits the pair;
- whether the pair shares an entity, using the drain's conservative union of stored links and a fresh extraction.

A pair with an unknown cosine (a missing vector, or a vector index that is not current) SHALL be kept, as it is without bands. A pair with an unknown entity verdict SHALL be kept. A lexically admitted pair SHALL NEVER be drained as low. A pair no channel admits SHALL keep draining under the existing rules reason.

The journal reasoning of a low-band drain SHALL start with `low confidence band: ` and SHALL name the cosine and whether an entity was shared, so an operator can tell it from a rules drain.

#### Scenario: An entity-only pair with a low cosine is drained

- **GIVEN** a pending pair that shares an entity and has a known cosine of 0.65
- **WHEN** the drain examines it
- **THEN** the relation SHALL become `orphaned` and its journal reasoning SHALL start with `orphaned: low confidence band: `

#### Scenario: A vector-only pair just above the vector threshold is drained

- **GIVEN** a pending pair with a cosine of 0.72, no shared entity and no lexical admission
- **WHEN** the drain examines it
- **THEN** the relation SHALL be orphaned with the low confidence band reasoning

#### Scenario: A vector-only pair at the low-band ceiling or above is kept

- **GIVEN** a pending pair with a cosine of 0.76 and no shared entity
- **WHEN** the drain examines it
- **THEN** the relation SHALL stay `pending`

#### Scenario: An entity pair with an unknown cosine is kept

- **GIVEN** a pending pair that shares an entity and has no stored vector for one endpoint
- **WHEN** the drain examines it
- **THEN** the relation SHALL stay `pending`

#### Scenario: An entity pair that is also dense is kept

- **GIVEN** a pending pair that shares an entity and has a cosine of 0.72
- **WHEN** the drain examines it
- **THEN** the relation SHALL stay `pending`, because the pair is in the middle band
