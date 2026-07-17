## 1. Verified-credential cache (#266)

- [x] 1.1 `apps/server/src/services/tokens.ts`: add a bounded `verifiedCache` (sha256(plaintext) → token id); `authenticate` checks it before the linear scan, re-reading the row fresh and re-running the authorization check on a hit.
- [x] 1.2 Extract the shared revoked/expired check (`authorizeRow`) so the cache-hit and cold-scan paths run the identical authorization logic.
- [x] 1.3 Make the cache bound an injectable optional constructor parameter (test-only convenience).
- [x] 1.4 Update the class doc comment to explain the fixed-per-request-cost rationale and the lookup-vs-outcome caching distinction.
- [x] 1.5 Add tests: repeat auth skips the scan; revocation takes effect immediately despite a warm cache; expiry takes effect immediately despite a warm cache; a cache hit still resolves the correct token id/scope; oldest-entry eviction once the bound is exceeded (using an injected small bound to keep the test fast).

## 2. Validation

- [x] 2.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 2.2 `pnpm test` full suite green.
- [x] 2.3 `openspec validate auth-credential-cache --strict` passes.
- [x] 2.4 Update issue #266 with the outcome after merge.
