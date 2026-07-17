## Why

`TokensService.authenticate` runs scrypt (N=16384, measured ~20ms) against every stored token row on every authenticated request — every MCP tool call and every `/api` request re-authenticates fresh. This is a fixed per-request cost independent of token count: even the common single-token deployment pays ~20ms of threadpool CPU on every tool call. The fix adds a bounded, in-memory verified-credential cache that skips the KDF on a repeat request from the same already-verified secret, while never caching the authorization outcome itself — revocation and expiry are re-checked against a fresh row read on every use, cached or not.

## What Changes

- **Verified-credential cache in `TokensService`.** A bounded (default 64-entry) map from `sha256(plaintext)` to token id, populated after a successful scrypt verify. On a cache hit, `authenticate` re-reads the token row fresh by id and re-runs the exact same revoked/expired checks as the cold path before authorizing — the cache only ever skips the scrypt step, never the authorization decision. The bound is injectable via a new optional constructor parameter (test-only convenience — avoids needing dozens of real scrypt verifies to exercise eviction).

No breaking changes. No change to what gets persisted or how tokens are hashed at rest.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `auth`: MODIFY the "Revocation MUST take effect immediately" requirement. Its current text ("There SHALL be no in-memory token cache with a TTL longer than a few seconds") is a coarse constraint that predates this change; refined to be mechanism-precise — caching the plaintext→token-id _lookup_ is permitted, but the authorization _outcome_ (revoked/expired) MUST always be re-derived from a fresh read, so revocation still takes effect on the very next request regardless of cache state. The underlying guarantee (revoke now, rejected on the next request) is unchanged and is proven by a new test reproducing the exact "revoke while cache is warm" scenario.

## Impact

- `apps/server/src/services/tokens.ts` — `authenticate` gains the cache-hit fast path; `create`/other methods unchanged.
- `apps/server/src/services/tokens.test.ts` — new tests: cache skips the scan on repeat auth, revocation/expiry take effect immediately despite a warm cache, cache resolves the correct token, oldest-entry eviction.
- Issues: #266.
