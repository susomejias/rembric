## ADDED Requirements

### Requirement: Token deletion tombstones
Tokens SHALL carry a nullable deleted_at timestamp introduced by a generated Drizzle migration. Removal SHALL conditionally set that timestamp only where the immutable ID matches, revoked_at is non-null, and deleted_at is null. No token, project membership, dashboard session, agent session, or memory history row SHALL be physically deleted by this operation. Existing rows SHALL migrate with a null deletion timestamp.

#### Scenario: Persist removal without losing provenance
- **WHEN** a revoked token with project memberships and session history is removed
- **THEN** only its deletion timestamp changes and all historical associations remain intact

#### Scenario: Conditional update protection
- **WHEN** the repository receives an active, already deleted, or missing token ID
- **THEN** it changes zero rows

#### Scenario: Upgrade existing database
- **WHEN** the migration runs on an existing database
- **THEN** existing tokens remain undeleted and their associations are preserved
