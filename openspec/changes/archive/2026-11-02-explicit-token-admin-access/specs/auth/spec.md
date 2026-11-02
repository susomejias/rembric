## ADDED Requirements

### Requirement: Explicit promotion of active static tokens MUST preserve credential identity

An explicit administrator operation SHALL be able to promote one existing active static token by immutable ID. It SHALL refuse blank or unknown IDs, deleted or revoked tokens, expiry at or before the current time, unresolved project bindings and memberless project-set grants. An active administrator target SHALL be an idempotent no-op. Promotion SHALL NOT repair inert credentials, renew expired credentials or affect OAuth grants.

The service SHALL transactionally set `scope='*'` and `project_id=NULL` and remove the token's current `token_projects` memberships. The UPDATE SHALL require an undeleted, unrevoked and unexpired row; failed updates or membership cleanup SHALL roll back the whole operation. No other token field, secret/hash, identity, name, creation/expiry timestamp or historical session/provenance row SHALL change. Other tokens SHALL remain unchanged.

Subsequent authentication of the same secret SHALL resolve administrator scope, including a warmed credential cache. The same secret SHALL become valid for dashboard admin login and subsequent authenticated MCP requests without resetting the selected project or rewriting existing OAuth grants.

#### Scenario: Promotion preserves the secret and history

- **GIVEN** an active non-administrator token with an existing secret and project binding or memberships
- **WHEN** an administrator explicitly promotes it
- **THEN** authentication of that same secret SHALL return scope `*`, null binding and no memberships
- **AND** all fields except scope/binding and current memberships, historical rows and other tokens SHALL remain unchanged

#### Scenario: Inactive targets are refused without partial changes

- **WHEN** promotion targets a missing, deleted, revoked, expired, unresolved-project or memberless-set credential
- **THEN** it SHALL fail and leave grants and memberships unchanged

#### Scenario: Failed cleanup rolls back the grant

- **WHEN** membership cleanup fails after a promotion UPDATE
- **THEN** the original scope, binding and memberships SHALL be restored by transaction rollback

#### Scenario: Existing credentials gain current authority on the next request

- **GIVEN** a static credential authenticated before promotion
- **WHEN** it is promoted and then reused for authentication, dashboard login or an authenticated MCP request
- **THEN** the current administrator grant SHALL be applied without replacing the secret
- **AND** existing OAuth grants SHALL retain their originally issued authority

### Requirement: Token rotation MUST invalidate the previous secret and derived credentials atomically

An administrator operation SHALL rotate one active static token by immutable ID, including administrator tokens. Blank/missing IDs, deleted, revoked, expired-at-now, unresolved-project and memberless-set tokens SHALL be refused without mutation. Rotation SHALL generate a fresh cryptographically random secret and salted scrypt hash; only the hash of the static token row SHALL change. Identity, name, scope, binding, memberships, creation and expiration timestamps, memory/session provenance and unrelated credentials SHALL be retained.

Hash replacement, invalidation of every linked dashboard session, and invalidation of all OAuth authorization codes and access/refresh credentials with this token as subject SHALL form one atomic service-owned transaction. Hash replacement SHALL condition on the expected current hash and live lifecycle state; any failure SHALL roll back the operation. Revoked authorization codes or refresh credentials SHALL NOT mint surviving descendants, including when redemption overlaps rotation. No deployment signing secret SHALL change.

Authentication SHALL bind warmed cache entries to the verified persisted hash and recheck current state after asynchronous verification. Subsequent authentication with the previous static secret or invalidated descendants SHALL fail across service instances. Already-admitted operations need not be cancelled. A new static secret SHALL preserve MCP token identity and project routing.

#### Scenario: Rotation preserves grants but invalidates old credentials

- **GIVEN** an active token, warmed authentication in multiple instances, linked dashboard sessions and OAuth authorization codes/access/refresh credentials
- **WHEN** an administrator rotates it
- **THEN** only the static token hash SHALL change, and the new secret SHALL authenticate with the same grant
- **AND** the old secret and every linked descendant credential SHALL be refused, while unrelated credentials remain valid

#### Scenario: Rotation races with authentication or OAuth issuance

- **WHEN** rotation completes while an earlier secret verification, code redemption or refresh is in progress
- **THEN** stale credential state SHALL NOT authorize a subsequent request or issue usable descendants

#### Scenario: Ineligible target or failed invalidation causes no partial change

- **WHEN** the target is ineligible, the conditional hash update fails, or any descendant invalidation fails
- **THEN** the token and all descendant state SHALL remain unchanged

## MODIFIED Requirements

### Requirement: A token whose project binding does not resolve MUST authorize nothing and MUST NOT be repaired

Such a token SHALL continue to authorize nothing, on every connection and every endpoint. No migration, boot-time repair, or lazy fix-up SHALL rewrite its `scope` or populate its `project_id`. Rewriting it would fail **open**: it would activate a credential the operator has never observed working, with no revocation event and no audit trail.

Tokens created before the producer was corrected carry a scope string naming a project by slug and `project_id IS NULL`. Because the scope segment is compared against a project id, such a token is denied everywhere — it fails **closed**.

The server SHALL NOT resolve a project-scoped token's segment by slug as a fallback. The segment has exactly one reading — a project id — and a fallback would give the string two valid readings, which is the condition that produced the defect. Legacy project slugs are not shape-distinguishable from other values (see `projects` — "A legacy slug continues to function"), so no heuristic can safely separate them.

#### Scenario: A pre-existing malformed token is still denied after upgrade

- **GIVEN** a token row created before this change, with `scope = 'project:<slug-of-alpha>'` and `project_id IS NULL`
- **WHEN** the server is upgraded and the token is used against project `alpha`
- **THEN** the request SHALL be rejected with code `forbidden`, exactly as before the upgrade
- **AND** an admin `*` token SHALL succeed against the same endpoint

#### Scenario: The upgrade does not rewrite the row

- **GIVEN** a token row with `scope = 'project:<slug-of-alpha>'` and `project_id IS NULL`
- **WHEN** the server boots after the upgrade
- **THEN** every column of that row SHALL be byte-for-byte unchanged

