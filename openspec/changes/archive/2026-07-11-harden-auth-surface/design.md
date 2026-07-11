## Context

The authenticated HTTP surface (`/mcp`, `/api`, `/healthz`, `/admin`, `/dashboard/login`) all funnel bearer credentials through `authenticate()` → `TokensService.authenticate()`, which linearly scans every row in `tokens` and runs `scryptSync(N=16384, r=8)` per row until a hash matches (`apps/server/src/services/tokens.ts:111-178`). `scryptSync` is CPU-bound and synchronous, so it blocks the one Node event loop. The per-token `RateLimiter` (`apps/server/src/server/rate-limit.ts`) is consulted only _after_ auth succeeds and is keyed on `ctx.token.id` (`apps/server/src/server/http.ts:281-294`), so failed auth is never rate-limited and always pays full scan cost.

OAuth (opt-in via `REMBRIC_PUBLIC_URL`) mints access tokens whose scope is derived by `resolveGrantedScope()` to only ever be `'*'` or `'read:*'` (`apps/server/src/services/oauth.ts:301-307`); the synthetic `Token` carries `projectId: null` (`apps/server/src/server/auth.ts:131-142`). Project scoping is resolved per-request from the connector URL path, never bound to the token — so the consent screen's promise (`apps/server/src/dashboard/oauth-consent.ts:141-143`) is advisory. The static-token grammar already supports `project:<id>` / `read:project:<id>`; OAuth simply never emits it.

Constraints: single Node process, single synchronous better-sqlite3 connection; SQLite table-rebuild dance for schema changes (documented in CLAUDE.md); the MCP OAuth protocol surface is owned by the vetted SDK `mcpAuthRouter` (we own persistence + consent). Append-only and scope-at-service-layer invariants must hold.

## Goals / Non-Goals

**Goals:**

- Make failed authentication cheap and bounded so it cannot deny service (close #1).
- Give OAuth tokens the same project-confinement expressiveness static tokens already have, enforced at the token, not the URL (close #3).
- Close the cheaper hardening gaps (#4 Secure cookie, #5 revoke ownership, #6 redirect_uri, #7 body limits / transport origin / login oracle) in the same pass.

**Non-Goals:**

- Replacing scrypt or the token model for static tokens — the at-rest hashing is sound.
- Reworking the SDK-owned OAuth protocol endpoints (PKCE, DCR, metadata) — those stay in `mcpAuthRouter`.
- A background purge of expired OAuth rows — append-only growth is accepted; expiry is enforced at read time already.
- IP allow-listing / mTLS / WAF concerns — out of scope; the operator's reverse proxy owns those.

## Decisions

### D1 — Pre-auth throttling keyed on network identity, before the scrypt scan

Add a lightweight failure-lockout limiter consulted **before** `authenticate()` runs, keyed on a pre-auth identity: source IP, or a configured trusted proxy-forwarded header (`X-Forwarded-For` first hop) when behind a proxy. Successful auth resets the counter; repeated failures within a window return `429` without touching scrypt. This is a distinct limiter from the existing per-token bucket (which stays, for authenticated fair-use).

- **Alternative — reorder so the existing per-token limiter runs first:** rejected; the per-token key does not exist until after a successful resolve, so it cannot throttle _failed_ attempts.
- **Alternative — global concurrency cap on auth:** rejected as the primary control (harms legitimate bursts) but may complement.

### D2 — Bound the auth work per attempt so it cannot block the loop

Two independent mitigations, both worth doing:

1. **Offload scrypt** to `scrypt` (async, libuv threadpool) instead of `scryptSync`, so a single attempt does not block the event loop. `authenticate()` becomes async; callers already run in async handlers.
2. **Short-circuit the scan** — the scan cost scales with token count. Keep the constant-time property per candidate but avoid running scrypt against every row for an obviously-bogus token where possible (e.g. a fast-rejected length/shape pre-check does not help against random-but-well-formed input, so the real lever is D1 + async offload). Document that scan cost is O(tokens) and that D1 is the ceiling.

- **Alternative — cache verified plaintext→row:** rejected; caching plaintext secrets (even hashed keys) adds a new secret-handling surface for marginal gain at the target token counts (<100).
- **Trade-off:** making `authenticate()` async ripples into `/healthz`, `/api`, `/admin`, dashboard login. Accepted — mechanical and covered by existing tests.

### D3 — Bind OAuth grants to a project, carried end-to-end and persisted

At `authorize`, derive the consented project from the connector path (the client connects to `/mcp/<slug>` for the resource it wants) and thread it through the signed `AuthRequest` blob → consent → `issueCode` → token pair. Persist a nullable `project_id` on `oauth_authorization_codes` and `oauth_tokens`. `authenticateAccessToken()` returns the bound project, and the synthetic `Token` carries `projectId` + a scope narrowed to `project:<id>` / `read:project:<id>` when bound (falling back to `*` / `read:*` only for an explicitly global grant, e.g. a `/mcp` path-less connection the operator approved).

- **Alternative — keep tokens global, enforce project only from the live URL path (status quo / D7):** rejected as the default because a leaked or misbehaving OAuth token then reaches every project; the URL is chosen by the client, not enforced by the credential.
- **Alternative — encode the project in the OAuth scope string (`project:<id>`):** rejected; scope strings are echoed to and chosen by the client and validated against `scopesSupported`. Binding via the server-signed authorize hand-off is not client-forgeable.
- **Trade-off:** a per-connector OAuth token is now single-project like a static `project:<id>` token. A client that genuinely needs multiple projects registers/consents per connector — matching how the connector URL already works.

### D4 — Secure cookie gated on issuer scheme

Set `Secure` on `rembric_session` when `REMBRIC_PUBLIC_URL` is https (i.e. `config.oauth.issuer` https, or a dedicated `is-https` derivation), keeping the plain flag for http loopback dev. `SameSite=Lax` + `path=/dashboard` stay.

- **Alternative — always Secure:** rejected; breaks the http-loopback dev/first-run login.

### D5 — Revoke ownership + redirect_uri re-check (spec-conformance)

`revokeToken(_client, request)` looks up the token and revokes the family only when `token.clientId === client.client_id`; otherwise a silent no-op (per RFC 7009, revocation of an unowned/unknown token returns success without acting). `redeemCode` re-verifies `redirect_uri` whenever the code was issued with one — tighten `apps/server/src/services/oauth.ts:169-171` to require equality when `code.redirectUri` is set, regardless of whether the client re-sent it (OAuth 2.1 requires the client to re-send it).

### D6 — Body-size bound + transport origin checks

Bound `readJsonBody` (`apps/server/src/server/http.ts`) with a configurable max (default 4 MB) returning `413`. For the transport: the SDK's `enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins` options are marked `@deprecated` (the SDK now recommends external middleware), and the `Host` check is strict (exact match incl. port), so an always-on default would risk rejecting legitimate reverse-proxy setups. Decision: make it **opt-in** via `REMBRIC_MCP_ALLOWED_HOSTS` / `REMBRIC_MCP_ALLOWED_ORIGINS`; protection engages only when an allow-list is set. Default off — the mandatory bearer is the primary control, and the SDK's Origin check already only rejects a _present_ disallowed Origin (so non-browser MCP clients are never rejected).

- **Alternative — always-on with allow-lists derived from host/issuer:** rejected as default; too easy to lock out a valid proxy Host, and builds on a deprecated API.

### D7 — Uniform login response

`POST /dashboard/login` returns the same generic error for "invalid token" and "valid but non-admin" (single 401/403 with identical body/text), removing the validity oracle at `apps/server/src/server/dashboard-router.ts:126-139`.

## Risks / Trade-offs

- [Risk] Pre-auth IP limiter mis-throttles legitimate clients behind a shared NAT / proxy that presents one IP → Mitigation: window/threshold tuned for failures only (successful auth resets), configurable knobs, and honor a trusted-proxy forwarded identity when configured.
- [Risk] Making `authenticate()` async introduces a subtle ordering regression in a caller that assumed sync → Mitigation: it is called from already-async handlers; add tests asserting each surface (`/mcp`, `/api`, `/healthz`, `/admin`, login) still authenticates and still rejects revoked/expired.
- [Trade-off] OAuth tokens become single-project by default → Accepted because it matches the static-token least-privilege model and the connector-per-project UX; global OAuth grants remain possible via a path-less `/mcp` consent.
- [Trade-off] Legacy OAuth tokens (issued pre-migration) have `project_id = NULL` → Accepted: they are **invalidated on deploy** (the migration revokes all pre-existing `oauth_tokens` rows) so no unbound token remains globally privileged. Live connectors must re-consent once; this is the price of immediate, complete confinement (maintainer decision, 2026-07-11).
- [Trade-off] `enableDnsRebindingProtection` can reject valid setups if `allowedHosts` is under-configured → Accepted with a permissive default derived from configured host + issuer, documented.

## Migration Plan

1. Table-rebuild migration adds nullable `project_id` to `oauth_authorization_codes` and `oauth_tokens` (runner wraps FK-safety per CLAUDE.md). No backfill: existing rows keep `NULL`.
2. Deploy behavior for legacy OAuth tokens: **force re-consent** (maintainer decision). The migration sets `revoked_at` on every pre-existing `oauth_tokens` row (access + refresh) so no legacy token survives the deploy; clients re-run authorize/consent. After the migration, `project_id = NULL` unambiguously means a _new_ global grant (consented on a path-less `/mcp`), and `project_id = <id>` means a project-bound grant — the existing `revoked_at` check already rejects the legacy rows, so `authenticateAccessToken` needs no legacy-vs-new heuristic.
3. New config knobs (pre-auth lockout window/threshold, max body bytes, allowed origins) ship with safe defaults; rate-limit stays opt-in but the pre-auth failure lockout is on by default (it only ever triggers on repeated _failures_).
4. Rollback: the migration is additive (nullable column); reverting code leaves harmless unused columns. No data rewrite.

## Open Questions

- Pre-auth throttle identity when no trusted proxy is configured and `REMBRIC_HOST` is `0.0.0.0`: key on raw socket remote address — confirm it is reliably available through the Node `IncomingMessage` in the deployed proxy topology.
- Should the pre-auth failure lockout be always-on, or gated by the same `RATE_LIMIT_ENABLED` flag? (Leaning always-on, since it only penalizes failures.)
- ~~Legacy NULL-project OAuth tokens~~: RESOLVED (2026-07-11) — force re-consent; the migration revokes all pre-existing `oauth_tokens`.
