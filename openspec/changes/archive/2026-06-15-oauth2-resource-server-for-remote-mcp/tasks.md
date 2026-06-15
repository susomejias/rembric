## 1. Data model & migration

- [x] 1.1 Add `apps/server/src/db/schema/oauth.ts` with three tables — `oauth_clients` (client_id, redirect_uris JSON, token_endpoint_auth_method, created_at), `oauth_authorization_codes` (code hash, client_id, redirect_uri, code_challenge, scope, subject, expires_at, consumed_at), `oauth_tokens` (id, kind `access`|`refresh`, hash, client_id, family_id, scope, subject, expires_at, rotated_at, revoked_at, created_at) — exporting `$inferSelect`/`$inferInsert` types. No change to `tokens.ts` schema.
- [x] 1.2 Add an additive `CREATE TABLE` migration under `apps/server/src/db/migrations/` for the three tables + indexes (by hash, by family_id, by expires_at). Verify it needs no `tokens` rebuild and passes `pnpm vitest run apps/server/src/db` and the migration FK-safety invariant.
- [x] 1.3 Add `apps/server/src/db/repositories/oauth-repository.ts` with all SQL for the new tables (insert/find-by-hash/consume-code/rotate-refresh/revoke-family/find-client); register it in `repositories/index.ts`. Confirm no SQL leaks outside `db/` via the data-access-confinement invariant test.

## 2. Config & issuer gating

- [x] 2.1 Add config loading for `REMBRIC_PUBLIC_URL` (issuer), optional `REMBRIC_OAUTH_ACCESS_TTL` (default 3600s) and `REMBRIC_OAUTH_REFRESH_TTL` (default 30d). Expose an `oauthEnabled` boolean = issuer present.
- [x] 2.2 At startup, if `REMBRIC_PUBLIC_URL` is set, validate it is an absolute `https://` URL and refuse to start otherwise with a clear message; log the resolved issuer. Add a unit test for accept/reject cases.

## 3. OAuth core (service layer)

- [x] 3.1 Add an OAuth service (e.g. `apps/server/src/services/oauth.ts`) with PKCE `S256` verification (Node `crypto`), authorization-code issuance/lookup/single-use-consume bound to (challenge, redirect_uri, client_id, scope, subject), and helpers reusing `hashToken`/`verifyToken` from `tokens.ts` for code/token hashing. Unit-test happy path + tamper/missing/`plain` rejection + expiry + replay.
- [x] 3.2 Implement access+refresh issuance and refresh rotation with family reuse detection (consuming a rotated refresh token revokes the whole `family_id`). Unit-test rotation, reuse→family-revoke, expiry.
- [x] 3.3 Implement OAuth-scope ⇄ `TokenScope` mapping (full→`*`, read-only→`read:*`) reused by consent and validation. Unit-test the mapping including read-only-cannot-write.

## 4. Unified authentication

- [x] 4.1 Extend `TokensService.authenticate()` (or a thin wrapper consulted by `server/auth.ts`) to try the static `tokens` lookup first, then fall back to `oauth_tokens` access-token lookup, returning the same `{ token-like, scope }` shape. Preserve constant-time compare. Unit-test: static token unchanged, OAuth access token resolves, expired/revoked OAuth token → reject.
- [x] 4.2 Make the `/mcp` and `/mcp/<slug>` `401` emit `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"` only when `oauthEnabled`; byte-identical 401 (no header) when disabled. Unit-test both branches.

## 5. HTTP endpoints — MCP SDK authorization server (vetted) + our provider (design D10)

- [x] 5.0 Consult `npm-security-best-practices` skill re: relying on `@modelcontextprotocol/sdk/server/auth/*` (+ transitively-present `express`/`express-rate-limit`); decide whether a direct `package.json` dep declaration is needed and, if so, clear it through the skill's checklist.
- [x] 5.1 Implement the SDK `OAuthRegisteredClientsStore` over `oauth-repository.ts` (getClient / registerClient → public client, https+loopback redirect validation already in `services/oauth.ts`). Unit-test get/register + unregistered-redirect rejection.
- [x] 5.2 Implement the SDK `OAuthServerProvider` delegating to `services/oauth.ts`: `authorize()` (render consent + reuse dashboard session, redirect with code+state), `challengeForAuthorizationCode()`, `exchangeAuthorizationCode()` → `exchangeCode`, `exchangeRefreshToken()` → `refresh`, `verifyAccessToken()` → `authenticateAccessToken`, `revokeToken()`. Unit-test each provider method.
- [x] 5.3 Build the consent + single-user login screen used by `authorize()` (reuse dashboard session; bounce to `/dashboard/login` and back; consent form with CSRF). Unit-test login-redirect + approve/deny.
- [x] 5.4 Mount `mcpAuthRouter({ provider, issuerUrl, scopesSupported, resourceName })` (gated on `config.oauth.enabled`) and bridge the Express router into the node `http` server alongside `/mcp` and Hono; ensure reserved OAuth paths never shadow `/mcp/<slug>`. Route-collision test.
- [x] 5.5 Confirm `pnpm run typecheck` and `pnpm run lint` pass; SDK owns PKCE/CSRF/redirect/metadata/DCR/rate-limit per D10.

## 6. Invariant & regression coverage

- [x] 6.1 Add invariant assertions to `apps/server/src/test/invariants.test.ts`: static-token path behavior unchanged; OAuth SQL confined to `db/`; `oauth_*` writes do not touch memory append-only paths; reserved OAuth routes do not collide with `/mcp` path-scoping.
- [x] 6.2 Run the full existing `auth`/`tokens`/`mcp` suites and confirm green (no regression): `pnpm vitest run apps/server/src/services/tokens.test.ts apps/server/src/server apps/server/src/mcp`.

## 7. End-to-end smoke (both auth paths)

- [x] 7.1 Add an e2e smoke (under the `rembric-smoke-tests` pattern) that, against `pnpm run dev:docker:up` with `REMBRIC_PUBLIC_URL` set: (a) authenticates `/mcp` with a static bearer and runs `memory.save`+`memory.search`; (b) drives the full OAuth dance (register → authorize+consent → token) to mint an access token and runs the same MCP calls with it; (c) asserts the disabled-OAuth `401` has no `WWW-Authenticate`. Document any operator-only step.
- [x] 7.2 **Operator-only:** run the smoke locally against the live dev Docker stack and capture pass/fail; if blocked (no Docker), fall back to an in-process HTTP test exercising both auth paths against the Hono app without containers.

## 8. Docs

- [x] 8.1 Add a connector setup note (Developer Mode, set `REMBRIC_PUBLIC_URL`, TLS/public reachability, per-project = per-`/mcp/<slug>` connector) as manual fallback; do not alter the TUI installer canonical path. Update env reference if one exists.
