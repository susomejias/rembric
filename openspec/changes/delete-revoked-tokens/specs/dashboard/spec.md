## ADDED Requirements

### Requirement: Confirmed removal of revoked tokens
The dashboard SHALL offer individual token deletion only for revoked tokens. Deletion SHALL require an explicit danger confirmation explaining that the token is removed from the list while session and memory history are retained. Cancel SHALL NOT mutate state. The server action SHALL require an authenticated administrator and valid form-bound CSRF before calling the service, and SHALL target an immutable token ID.

#### Scenario: Confirm removal
- **WHEN** an administrator confirms deletion of a revoked token
- **THEN** the token disappears from the token list and its history remains available

#### Scenario: Cancel removal
- **WHEN** the administrator opens the deletion dialog and cancels
- **THEN** no deletion is submitted and the token remains visible

#### Scenario: Unrevoked token
- **WHEN** a token is active or expired without revocation
- **THEN** its menu offers revocation rather than deletion

#### Scenario: Unauthorized form
- **WHEN** deletion is submitted anonymously, by a non-administrator, or without valid token.delete CSRF
- **THEN** the action refuses the request before invoking deletion
