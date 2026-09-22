## Why

The Next.js MCP route preserves pre-auth `AuthLockout` but no longer applies the authenticated, per-token request limiter that existed on the former MCP HTTP surface. A valid bearer can therefore issue unlimited authenticated requests.

## What Changes

- Add an opt-in authenticated MCP limiter using the framework-agnostic `rate-limiter-flexible@11.2.1` direct API.
- Apply one library-owned fixed-window limiter after successful bearer verification and before body inspection, session resolution, or MCP transport dispatch.
- Key the limiter by the resolved token id. OAuth access-token refresh rotations use the stable synthetic `oauth:<clientId>` identity already produced by MCP authentication.
- Preserve `RATE_LIMIT_ENABLED` (default `false`), `RATE_LIMIT_RPS` (default `10`, positive and at most `10,000`) and `RATE_LIMIT_BURST` (default `30`, integer from `1` through `10,000`). When enabled, use `points = burst` and `duration = ceil(burst * 1000 / rps) / 1000` seconds, retaining fractional durations rather than rounding to whole seconds. Derived timers must be finite, safe integers, and no greater than `2,147,483,647` ms.
- Preserve the legacy JSON `rate_limited` response and `retryAfterSeconds` field. Set `Retry-After` to `ceil(msBeforeNext / 1000)`, clamped to at least one second.
- Keep authentication lockout separate and unchanged. Unexpected limiter errors fail closed through the route's generic 500 response.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-api`: authenticated MCP requests are subject to the documented opt-in per-token fixed-window policy after successful bearer verification.

## Impact

- Dependency: `apps/web/package.json` and `pnpm-lock.yaml` replace the direct `express-rate-limit` dependency with exact `rate-limiter-flexible@11.2.1`. The existing direct `express@5.2.1` remains required by OAuth; an SDK transitive `express-rate-limit` resolution may remain in the lockfile.
- Runtime: `apps/web/src/lib/rate-limit.ts` owns configuration parsing, the global-HMR singleton, direct `consume(tokenId)` calls, and Web `Response` formatting; the MCP route invokes it before body and transport work.
- Tests: unit tests cover the direct library contract and configuration; HTTP tests cover authentication ordering, token/OAuth identity, 429 metadata, unexpected errors, and transport body preservation.
- No Express middleware adapter, request/response shim, body buffering, database migration, or change to the pre-auth lockout.
