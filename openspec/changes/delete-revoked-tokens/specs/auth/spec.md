## ADDED Requirements

### Requirement: Revoked-token removal preserves authentication safety
The token service SHALL delete only existing, revoked, undeleted tokens by nonempty immutable ID. Missing or already deleted tokens SHALL return token_not_found; empty IDs and unrevoked tokens SHALL return invalid_input. Expiry alone SHALL NOT permit deletion. Deleted tokens SHALL remain revoked for warm and cold bearer authentication. All dashboard cookies linked to a deleted token SHALL fail resolution without affecting other tokens' cookies. Historical names SHALL remain reserved and token counts SHALL continue to prevent bootstrap recreation.

#### Scenario: Invalid deletion targets
- **WHEN** deletion targets an empty ID, missing ID, previously deleted ID, or an active or expired unrevoked token
- **THEN** the service returns the corresponding explicit error without modifying any token

#### Scenario: Bearer and dashboard access after deletion
- **WHEN** a revoked token is deleted
- **THEN** cold and warm bearer authentication reject it and every linked dashboard cookie fails resolution while unrelated cookies still resolve

#### Scenario: Name and bootstrap retention
- **WHEN** a deleted token's name is reused or bootstrap runs after the last visible token is deleted
- **THEN** name reuse is refused and no bootstrap administrator is created
