## MODIFIED Requirements

### Requirement: Revocation MUST take effect immediately

When a token is revoked, the server SHALL reject any further request using that token starting with the next request. The server MAY cache the mapping from a successfully-verified plaintext credential to its token id, so a repeat request from the same caller does not repeat the password-hash derivation — but SHALL NOT cache the authorization outcome (valid / revoked / expired) for any duration. Every authenticated request, whether or not it hits that lookup cache, SHALL re-read the token's current `revoked_at` / `expires_at` state from storage before authorizing it. A credential-lookup cache entry MAY persist indefinitely (bounded by capacity, not by time) precisely because it never substitutes for that fresh authorization check.

#### Scenario: Revoke and reuse

- **WHEN** an operator revokes a token at time T, and a client uses the token at T+1s
- **THEN** the client's request SHALL be rejected with `401 Unauthorized`

#### Scenario: Revoke and reuse with a warm credential-lookup cache

- **GIVEN** a token has been used successfully at least once, so its plaintext→id mapping may be cached
- **WHEN** an operator revokes that token, and the client immediately reuses the same plaintext
- **THEN** the client's request SHALL be rejected with `401 Unauthorized` — the cached lookup MUST NOT shortcut the revocation check
- **AND** this SHALL hold identically for expiry: a token that has since expired SHALL be rejected on its next use even if its lookup was cached before expiring
