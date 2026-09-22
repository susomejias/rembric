## Context

The former MCP HTTP surface applied a per-token limiter after authentication. The Next.js route owns a Web Fetch boundary, so the replacement must use a direct rate-limiter API and must not adapt or pass the request body through a framework middleware surface.

## Goals

- Restore authenticated MCP rate limiting with the smallest direct integration.
- Keep the pre-auth lockout independent from post-auth quota enforcement.
- Preserve environment names, defaults, validation bounds, legacy 429 JSON, and request ordering.
- Make unexpected limiter failures explicit and fail closed.

## Non-Goals

- No rate limiting for `/api`, OAuth endpoints, dashboard routes, or unauthenticated requests.
- No Express middleware adapter, Express runtime import, compatibility layer, or custom bucket implementation.
- No new storage backend, OAuth adapter, or change to token resolution.

## Decisions

### D1 — Use the direct `rate-limiter-flexible@11.2.1` memory API

The exact direct dependency supplies the required per-key fixed-window counter without a request/response framework contract. The integration constructs `RateLimiterMemory({ points: burst, duration })` and calls `consume(tokenId)`. A rejected `RateLimiterRes` becomes the legacy Web response; any other error is rethrown to the route's fail-closed handler.

### D2 — Preserve fractional fixed-window configuration

`RATE_LIMIT_ENABLED` remains `false` by default. `RATE_LIMIT_RPS` remains a positive number through `10,000`, and `RATE_LIMIT_BURST` remains an integer from `1` through `10,000`. The derived window is `ceil(burst * 1000 / ratePerSecond)` milliseconds, passed to the library as that value divided by `1000` seconds. This keeps sub-second durations such as `0.05` seconds while enforcing a minimum of 1 ms and a maximum of `2,147,483,647` ms.

### D3 — Keep one limiter per process/configuration

The limiter is cached on `globalThis` by validated configuration signature so module re-evaluation under global HMR does not create a second counter store. Disabled configuration returns `null` and creates no limiter. The test reset deletes only this singleton.

### D4 — Preserve the response contract from `RateLimiterRes`

For a rejected `RateLimiterRes`, `Retry-After` is `ceil(msBeforeNext / 1000)`, clamped to at least one second. The response body is safely serialized by `Response.json` and retains `{ ok: false, code: 'rate_limited', message, retryAfterSeconds }`.

### D5 — Invoke only after authentication

The route calls `applyMcpRateLimit(token.id, token.name)` only after bearer verification succeeds. It does not pass a `Request`, read the body, or resolve session/transport state before the limiter. Allowed requests continue with the original Web request unchanged.

### D6 — Fail closed on unexpected errors

Only `RateLimiterRes` is treated as quota exhaustion. Unexpected errors, including malformed keys or store failures, are rethrown and converted by the route to the generic 500 response; the MCP transport is not dispatched.

## Dependency security review

- Selected package: `rate-limiter-flexible@11.2.1`, exact version, ISC license, one maintainer, no production runtime dependencies, no links, and no lifecycle requirement for this repository.
- The actual tarball probe matched integrity and contained 44 entries with no links; it exposed `types.d.ts` and a CommonJS entrypoint. Node 22.23.0 direct probes passed the memory limiter, key isolation, fractional duration, reset/delete, malformed-key error, and CJS/dynamic-ESM import checks.
- The exact-version OSV query returned `{}`. npm signatures were present; no attestation was reported. These observations are evidence for this adoption, not a claim of provenance attestation.
- No npmrc/workspace allowlist change is required. The existing direct `express@5.2.1` remains for OAuth; any SDK transitive `express-rate-limit` entries are not direct adoption.

## Migration and rollback

No database migration is required. With `RATE_LIMIT_ENABLED=false`, behavior remains disabled by default. Rollback removes the direct dependency, direct limiter calls, tests, and delta artifacts while leaving pre-auth lockout unchanged.
