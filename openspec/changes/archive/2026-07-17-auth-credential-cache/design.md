## Context

`TokensService`'s own doc comment stated a deliberate prior decision: "For realistic deployments (< 100 tokens) this is fast and avoids any caching subtlety." That framing addresses O(tokens) scan cost, not the fixed ~20ms KDF cost per verify — measured, that fixed cost dominates: even a single-token deployment pays it on every request. Separately, `auth/spec.md`'s "Revocation MUST take effect immediately" requirement contains a blanket constraint — "no in-memory token cache with a TTL longer than a few seconds" — written before this change, which needed to be resolved precisely rather than either ignored or treated as an automatic blocker.

## Goals / Non-Goals

**Goals:**

- Eliminate the fixed per-request scrypt cost for a repeat caller without weakening the immediate-revocation guarantee.
- Resolve the tension with the existing spec text explicitly, by refining what it constrains (the authorization _outcome_) versus what it now explicitly permits (a credential _lookup_).

**Non-Goals:**

- Not changing how tokens are hashed at rest, or the token creation/plaintext-exposure contract.
- Not addressing the O(tokens) linear-scan cost itself for the _cold_ path (a token-id-prefixed credential format, noted as a follow-up opportunity in the original issue, is out of scope here).

## Decisions

### D1. Cache the lookup, never the authorization decision

The cache stores `sha256(plaintext) → tokenId`, nothing else. `authenticate`'s cache-hit branch re-reads the row by id and runs the _exact same_ `authorizeRow` check (revoked/expired) the cold path runs — there is only one authorization code path, reached from two different discovery mechanisms (cache hit vs. linear scan). This structurally guarantees the two paths can't drift: a future change to the revocation/expiry logic automatically applies to both.

**Why this satisfies the spec's intent despite the literal old wording:** the old sentence conflated "a cache exists" with "authorization can go stale." My design keeps the _lookup_ cached indefinitely (bounded only by capacity) while making the _authorization check_ always fresh — so the "reject starting with the next request" guarantee holds exactly as before. Verified directly: a test revokes a token immediately after a cache-warming successful auth, and the very next `authenticate()` call throws `token_revoked`.

### D2. Injectable cache bound, for testability

`VERIFIED_CACHE_MAX` (default 64) is exposed as an optional 3rd constructor parameter. Exercising the eviction policy with the real default (64) would require 65 real tokens and enough authenticate() calls to trigger O(n²) scrypt verifies during the scan phase — tens of seconds, risking the suite's 15s per-test timeout. Injecting a small bound (e.g. 2) in the test lets eviction be proven with 3 tokens instead, in well under a second, without changing production behavior (the default is unchanged for every real caller).

## Risks / Trade-offs

- **[A future contributor misreads "cache exists" as safe to extend to caching the authorization outcome too]** → the updated spec text and the code comment both explicitly call out the outcome/lookup distinction as the load-bearing invariant.
- **[Memory growth from the cache]** → bounded at 64 entries of two short strings each; negligible, and unconditionally capped regardless of token count.

## Migration Plan

No migration — code-only, no schema or data change. Rollback is a plain revert.
