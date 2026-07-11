## Why

A security review of the API / MCP / OAuth layers (2026-07-11) found one high-severity availability bug and a cluster of hardening gaps on the authenticated surface. The headline issue: authentication runs a **synchronous `scryptSync` linear scan over every token** on every request, and it runs **before** the per-token rate limiter — so an unauthenticated attacker with bogus bearer tokens both bypasses the limiter (it is keyed on `token.id`, which a failed auth never produces) and pins the single Node event loop. Because the server supports a remote / reverse-proxied topology and OAuth is only enabled on an internet-reachable `REMBRIC_PUBLIC_URL`, this is reachable in exactly the deployment where it matters most. The remaining findings (OAuth scope confinement, cookie `Secure` flag, revoke ownership, `redirect_uri` re-verification, body-size limits, transport origin checks) are lower-severity but cheap to close while the surface is being touched.

(The review's finding #2 — `project.use` autocreate gated on `read` instead of `write` — was already fixed by #223 and is out of scope here.)

## What Changes

- **Pre-auth abuse resistance (#1, HIGH).** Introduce a lockout/limiter that applies to authentication _attempts_ keyed on client identity available before token resolution (source IP / proxy-forwarded identity), so repeated failed bearers are throttled **before** the scrypt scan. Additionally bound the cost of a single auth attempt so it cannot scale unboundedly with token count and cannot block the event loop (e.g. cap the scan, or move scrypt off the main thread). Applies to every `authenticate()` caller: `/mcp`, `/api/<slug>/sessions*`, `/healthz`, `/admin/*`, and `POST /dashboard/login`.
- **OAuth project-scope confinement (#3).** Bind an OAuth grant to the project it was consented for (via the connector path at authorize time) and carry that binding on the minted access token, so an OAuth token can no longer read/write outside its consented scope by changing its connection URL. The consent screen's "project scope is bound by the connector path" statement becomes an enforced property of the token, not advisory. **BREAKING** for the OAuth token-to-scope mapping.
- **Dashboard cookie `Secure` flag (#4).** Set `Secure` on the `rembric_session` cookie when the deployment is HTTPS (OAuth-enabled / `REMBRIC_PUBLIC_URL` is https), with the loopback exemption.
- **OAuth revoke ownership (#5).** `revokeToken` MUST verify the requesting client owns the token (RFC 7009) instead of ignoring `_client`.
- **OAuth `redirect_uri` re-verification (#6).** `redeemCode` MUST re-verify `redirect_uri` against the code binding whenever the authorization request carried one, per OAuth 2.1.
- **Request body-size limits (#7).** Bound the raw body read on `/mcp` (and confirm the `/api` bound) so an authenticated client cannot exhaust memory with an unbounded POST.
- **MCP transport origin checks (#7).** Enable the SDK's DNS-rebinding / `allowedHosts` / `allowedOrigins` protection on the Streamable HTTP transport as defense-in-depth.
- **Login error uniformity (#7).** Collapse the `/dashboard/login` "valid-but-not-admin" (403) vs "invalid" (401) responses so a valid non-admin token is not distinguishable from an invalid one.
- **Expired OAuth secret handling (#7).** Document/confirm that expired authorization codes and tokens are inert at read time (already enforced) and note the append-only growth as accepted (no behavioral change required unless a purge is desired).

## Capabilities

### New Capabilities

<!-- None — every change hardens an existing capability. -->

### Modified Capabilities

- `auth`: adds an abuse-resistance requirement for authentication attempts (pre-auth throttling + bounded, non-blocking auth cost) and a `Secure`-cookie requirement for dashboard sessions on HTTPS deployments; tightens the login response to avoid a validity oracle.
- `mcp-oauth`: binds issued tokens to their consented project scope (modifies "Issued OAuth tokens MUST map to the existing scope grammar"); requires client-ownership verification on revoke and `redirect_uri` re-verification on code exchange.
- `http-api`: adds a request body-size bound requirement on the authenticated HTTP surface and a transport origin/host validation requirement.

## Impact

- **Code:**
  - `apps/server/src/server/http.ts` — reorder/insert pre-auth throttle; bound `readJsonBody`; transport origin config wiring.
  - `apps/server/src/services/tokens.ts` — bound/offload the `authenticate()` scrypt scan.
  - `apps/server/src/server/rate-limit.ts` — add an identity-before-auth limiter/lockout (or a sibling limiter).
  - `apps/server/src/server/auth.ts` — thread pre-auth identity; OAuth synthetic-token project binding.
  - `apps/server/src/services/oauth.ts` + `apps/server/src/services/oauth-areq.ts` — carry the consented project through authorize→consent→code→token; `redeemCode` redirect_uri re-check.
  - `apps/server/src/server/oauth-provider.ts` — `revokeToken` client-ownership check.
  - `apps/server/src/mcp/transport.ts` — `enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins`.
  - `apps/server/src/server/dashboard-router.ts` — `Secure` cookie flag; uniform login error.
  - `apps/server/src/db/schema/oauth.ts` + `apps/server/src/db/repositories/oauth-repository.ts` — persist the project binding on codes/tokens (table-rebuild migration).
  - `apps/server/src/config.ts` — any new limiter/lockout knobs.
- **Specs:** `openspec/specs/{auth,mcp-oauth,http-api}/spec.md`.
- **Invariants:** none of the append-only, scope-at-service-layer, `topic_key`, or judgment-freshness invariants are touched. The OAuth project-binding _strengthens_ the existing "scope enforced at the service layer" invariant for OAuth-authenticated connections.
- **Migration:** adding a `project_id` (nullable) column to `oauth_authorization_codes` / `oauth_tokens` uses the SQLite table-rebuild dance handled by the migration runner.
- **Backward compatibility:** existing static tokens are unaffected. Existing OAuth access/refresh tokens issued before this change carry no project binding; they SHALL be treated as global (their current behavior) or invalidated on deploy — decided in design.
