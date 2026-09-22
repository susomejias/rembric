## 1. Specification and dependency

- [x] 1.1 Replace the direct `express-rate-limit` dependency with exact `rate-limiter-flexible@11.2.1` using the repository's lifecycle-script policy.
- [x] 1.2 Confirm the lockfile retains only the selected direct package change; SDK-owned transitive `express-rate-limit` entries may remain.
- [x] 1.3 Validate the `mcp-api` delta against direct `consume(tokenId)`, fixed-window points/duration, configuration bounds, ordering, OAuth identity, response contract, and fail-closed behavior.

## 2. Configuration and direct limiter

- [x] 2.1 Implement `apps/web/src/lib/rate-limit.ts` with preserved environment defaults/bounds, finite/safe derived-window validation, fractional duration, and the `2,147,483,647` ms timer ceiling.
- [x] 2.2 Construct one `RateLimiterMemory` per validated configuration using `points = burst` and the derived fractional `duration`.
- [x] 2.3 Call the direct `consume(tokenId)` API without a `Request`, `Response` shim, body access, or Express runtime types.
- [x] 2.4 Preserve legacy 429 JSON fields and derive `Retry-After` from `RateLimiterRes.msBeforeNext`; rethrow unexpected errors.

## 3. MCP route integration

- [x] 3.1 Invoke the limiter after successful `verifyMcpBearerToken`, keyed by `requestContext.token.id` and named with `requestContext.token.name`, before body inspection, session context, or transport dispatch.
- [x] 3.2 Keep `AuthLockout` unchanged and verify invalid credentials do not consume the post-auth quota.
- [x] 3.3 Keep the original Web request unchanged for the MCP surface and avoid body buffering or OAuth adapter reuse.

## 4. Regression tests

- [x] 4.1 Add direct-library unit coverage for defaults, enabled/disabled configuration, fractional duration, singleton reset, per-key isolation, malformed values, 429 JSON/retry metadata, and unexpected errors.
- [x] 4.2 Add MCP HTTP boundary coverage for valid/invalid authentication, disabled/enabled behavior, token and OAuth identity, unexpected-error 500, and transport reachability.
- [x] 4.3 Capture RED evidence after changing tests/spec expectations and before replacing the Express implementation; capture GREEN after direct integration.
- [x] 4.4 Run targeted mutation proof for each new guard using `scripts/mutate.mjs` with temporary restore, including derived-window bounds, fail-closed errors, route 429, and token identity assertions.

## 5. Verification

- [x] 5.1 Run `pnpm --filter @rembric/web exec vitest run src/test/mcp-http.test.ts src/test/rate-limit.test.ts`.
- [x] 5.2 Run `pnpm --filter @rembric/web run typecheck`.
- [x] 5.3 Run `git diff --check`.
