## 1. Pre-auth abuse resistance (#1, HIGH)

- [x] 1.1 Add a failure-lockout limiter keyed on pre-auth identity (source socket address, or configured trusted-proxy forwarded first hop) in `apps/server/src/server/rate-limit.ts` (`AuthLockout`); reset on successful auth.
- [x] 1.2 Consult the lockout limiter in `handleMcpRequest` (`apps/server/src/server/http.ts`) BEFORE `authenticate()`; return `429` with `Retry-After` on lockout. Wire the same guard into the `/api` `authMiddleware`, `/healthz`, `/admin` `adminAuth`, and `POST /dashboard/login`.
- [x] 1.3 Make `TokensService.authenticate()` non-blocking: replace `scryptSync` with async `scrypt` (libuv threadpool) in `apps/server/src/services/tokens.ts`; propagate `async` through `authenticate()` in `apps/server/src/server/auth.ts` and all call sites (`http.ts`, `api-router.ts`, `dashboard-router.ts`, `createHealthzHandler`, `adminAuth`).
- [x] 1.4 Add config knobs for the lockout window/threshold in `apps/server/src/config.ts` (safe defaults; lockout on by default).
- [x] 1.5 Tests: `AuthLockout` unit tests (lock at threshold, retry-after, reset on success, per-identity isolation) + end-to-end `429` on `/healthz` after repeated failures.

## 2. OAuth project-scope binding (#3, BREAKING)

- [x] 2.1 Add nullable `project_id` to `oauth_authorization_codes` and `oauth_tokens` in `apps/server/src/db/schema/oauth.ts`; migration `0017_oauth_project_binding.sql` (additive columns, no rebuild needed).
- [x] 2.2 Thread the consented project through the flow: derive it in `provider.authorize` from the RFC 8707 `resource` path, into the `AuthRequest` blob (`oauth-areq.ts`), through consent (`oauth-consent.ts`), into `issueCode` and the issued token pair (`oauth.ts`).
- [x] 2.3 Return the bound `projectId` from `authenticateAccessToken()`; `syntheticOAuthToken` (`auth.ts`) carries `projectId` and derives a project-restricted `TokenScope` (`project:<id>` / `read:project:<id>`) when bound, `*` / `read:*` when global.
- [x] 2.4 Repository reads/writes pick up the new column via schema-derived insert/select types.
- [x] 2.5 Force re-consent for legacy tokens: migration `0017` sets `revoked_at` on every pre-existing `oauth_tokens` row.
- [x] 2.6 Tests: project-bound token → `project:<id>` / `read:project:<id>`; path-less grant is global; binding survives refresh rotation; omitted `redirect_uri` rejected; migration `0017` revokes a pre-seeded legacy token and adds `project_id` (`migrations.test.ts`).

## 3. OAuth conformance fixes (#5, #6)

- [x] 3.1 `revokeToken` (`oauth-provider.ts`) verifies `token.clientId === client.client_id` before revoking; no-op-success otherwise (`revokeByToken(token, clientId)` in `oauth.ts`).
- [x] 3.2 `redeemCode` (`oauth.ts`) requires the request `redirect_uri` to equal the code's bound value, rejecting `invalid_grant` when absent/different.
- [x] 3.3 Tests: cross-client revoke is a no-op; omitted `redirect_uri` fails with `invalid_grant`.

## 4. Cookie, transport, and login hardening (#4, #7)

- [x] 4.1 Set `Secure` on the `rembric_session` cookie in `dashboard-router.ts` (login + logout) when the external origin is HTTPS (`secureCookies` wired in bootstrap from the https issuer).
- [x] 4.2 Collapse the `/dashboard/login` valid-non-admin (was 403) and invalid (401) responses into a single indistinguishable `401 "Invalid token."`.
- [x] 4.3 Bound `readJsonBody` in `http.ts` with a configurable max (`MAX_BODY_BYTES`, default 4 MB), returning `413`.
- [x] 4.4 Add opt-in DNS-rebinding protection on `StreamableHTTPServerTransport` (`transport.ts`) driven by `REMBRIC_MCP_ALLOWED_HOSTS` / `REMBRIC_MCP_ALLOWED_ORIGINS`; off by default (SDK options are `@deprecated`, strict Host check risks proxy breakage — see design D6).
- [x] 4.5 Real-server tests (`http-hardening.test.ts`): oversized body → `413`; disallowed `Origin` → `403` (raw HTTP, since `fetch` forbids `Origin`/`Host`); `Secure` on the session cookie for an HTTPS deployment; valid-non-admin vs invalid login are byte-identical `401`. (`429` lockout path covered by 1.5.)

## 5. Verification and docs

- [x] 5.1 `pnpm run typecheck` (0 errors), `pnpm run lint` (0 errors), `pnpm test` — 1030 pass / 1 skip. (One integration test, `mcp-integration.test.ts` roots-discovery, is flaky under full-suite parallel load; passes in isolation — pre-existing timing race, unrelated to this change.)
- [x] 5.2 Updated `oauth-provider.test.ts` / `oauth-http.test.ts` for the new `projects` dependency; `auth.test.ts` / `tokens.test.ts` for async `authenticate`; `migrations.test.ts` for the new migration.
- [x] 5.3 Documented the new config knobs (`AUTH_LOCKOUT_*`, `MAX_BODY_BYTES`, `REMBRIC_MCP_ALLOWED_HOSTS/ORIGINS`) and the OAuth project-confinement / forced-re-consent behavior in `README.md` (Security hardening section).
- [ ] 5.4 Smoke against `pnpm run dev:docker:up` per the `rembric-smoke-tests` skill: OAuth authorize→consent→token→`/mcp/<slug>` bound access, and a pre-auth lockout probe.
