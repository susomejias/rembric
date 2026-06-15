## Context

Rembric authenticates `/mcp` with operator-issued static bearer tokens (`TokensService`, `apps/server/src/services/tokens.ts`): a high-entropy secret, scrypt-hashed at rest, resolved by linear scan + constant-time compare into a `{ token, scope }`. Scope grammar is `*` | `read:*` | `project:<id>` | `read:project:<id>`. The HTTP surface is Hono (`apps/server/src/server/http.ts` + `api-router.ts`); the MCP transport is Streamable HTTP behind `authenticate()` in `apps/server/src/server/auth.ts`.

ChatGPT custom connectors (and the broader remote-MCP client ecosystem) will not accept a pasted static token — they require an OAuth 2.1 Authorization Code + PKCE handshake per the MCP authorization spec, after which ChatGPT itself mints and carries the access token as `Authorization: Bearer`. To be reachable as a connector, Rembric must speak that handshake while remaining a single self-hosted process backed by one SQLite file. This design is scoped to **single-tenant private use**: one operator, their own instance. Multi-tenant SaaS and public-directory submission are explicitly out.

## Goals / Non-Goals

**Goals:**

- Speak OAuth 2.1 (Authorization Code + PKCE `S256`, Dynamic Client Registration, refresh rotation, metadata discovery) well enough for a ChatGPT custom connector to attach.
- Keep the static operator-token path **byte-for-byte unchanged** in behavior; OAuth is purely additive.
- Stay self-contained: in-process, same SQLite, **zero new runtime services and ideally zero new dependencies** (Node `crypto` covers PKCE, randomness, hashing, HMAC signing).
- Preserve all load-bearing invariants: append-only memory, scope-at-service-layer, `topic_key`, judgment freshness, and the `/mcp` vs `/mcp/<slug>` path-scoping contract.
- Honor the existing `auth` spec's hard requirements: tokens hashed at rest, **immediate revocation** (no TTL cache), no plaintext in logs.

**Non-Goals:**

- Multi-tenant accounts / user management / signup / password reset.
- Public ChatGPT app-directory submission (would force a hosted multi-tenant pivot).
- Apps SDK UI widgets / embedded HTML components.
- Machine-to-machine grants (client_credentials), confidential clients with secrets, mTLS — ChatGPT does not use them and single-tenant does not need them.

## Decisions

### D1 — Opaque, hashed, DB-validated access tokens (NOT JWT)

OAuth access & refresh tokens are high-entropy random secrets, scrypt-hashed at rest exactly like static tokens, and validated by DB lookup.

- _Why:_ The `auth` spec mandates **immediate revocation with no TTL cache**. Self-contained JWTs cannot be revoked before expiry without a denylist — which is just a DB lookup, so JWT buys nothing and adds a JWKS endpoint + signing-key rotation surface. Opaque tokens give the immediate-revocation guarantee for free.
- **Hashing scheme — deterministic SHA-256, NOT salted scrypt.** OAuth secrets (codes, access/refresh tokens) are hashed with a single-pass SHA-256 stored in an _indexed_ column, enabling O(1) lookup by token value. This differs from the static `tokens` table (salted scrypt + linear scan): (a) static tokens are few (<100) so a scan is fine, but OAuth issues a fresh pair on every refresh, so a salted-scrypt linear scan over many short-lived rows would be both slow and (with per-row random salts) impossible to index; (b) scrypt/argon stretching exists to defend _low-entropy_ operator-chosen secrets — it adds nothing to a 256-bit random token, for which SHA-256 is the standard, sufficient at-rest hash (this is how mainstream OAuth servers store opaque tokens). The `auth` spec's "hashed at rest, never plaintext" requirement is fully satisfied.
- _Alternative considered:_ Signed JWT access tokens with a JWKS endpoint. Rejected: revocation complexity, key management, larger attack surface, no benefit for a single resource server validating its own tokens.
- _Alternative considered:_ Reuse salted-scrypt `hashToken`/`verifyToken` for OAuth too. Rejected: precludes indexed lookup and imposes a deliberately-expensive KDF on a hot path that gains no security for high-entropy secrets.

### D2 — Sibling tables, static `tokens` table untouched

Add `oauth_clients`, `oauth_authorization_codes`, and `oauth_tokens` (access + refresh discriminated by a `kind` column) as **new tables**. The existing `tokens` table and its rows are not altered.

- _Why:_ Static operator tokens are few, long-lived, uniquely named, and surfaced in the dashboard token list. OAuth tokens are many, short-lived, anonymous, and machine-minted — mixing them would pollute the operator UI and collide with the `name` uniqueness constraint. Separate tables keep the static path literally unchanged and mean the migration is **additive `CREATE TABLE` only** — no `tokens` rebuild, so no FK-drop dance.
- _Validation stays unified:_ `authenticate()` tries the static `tokens` path first (unchanged), then falls back to `oauth_tokens` access-token lookup. Both return the same `{ token-like, scope }` shape so everything downstream is identical.
- _Alternative considered:_ One `tokens` table + a `kind` column. Rejected: forces a table rebuild (CHECK/NOT NULL via the SQLite rebuild dance, FK-drop risk), pollutes the operator dashboard, and risks regressing the static path the change promises to leave alone.

### D3 — OAuth is opt-in via `REMBRIC_PUBLIC_URL`; absent ⇒ feature fully dark

The authorization server is enabled **iff** `REMBRIC_PUBLIC_URL` is set (it is the OAuth `issuer` and the base for all absolute metadata URLs). When unset: no `/.well-known/*`, no `/authorize`, no `/token`, no `/register`, and the `/mcp` `401` does **not** emit `WWW-Authenticate` — i.e. existing operators see zero behavior change.

- _Why:_ OAuth metadata requires an absolute, externally-correct issuer URL that the server cannot infer behind a proxy/tunnel from `HOST:PORT`. Gating on its presence makes the feature strictly opt-in and keeps the blast radius zero for current deployments.
- _Alternative considered:_ Always-on, infer issuer from `Host` header. Rejected: `Host` is attacker-controllable and unreliable behind proxies; a wrong issuer silently breaks the handshake and is a known OAuth footgun.

### D4 — Single-user login reuses the dashboard session; consent is one screen

`/authorize` authenticates the human by **reusing the existing signed, revocable dashboard session** (`dashboard_sessions`). If the operator is not logged in, they are bounced to `/dashboard/login` (existing flow) and returned. Once authenticated, a single consent screen shows the requesting client + requested scope and lets the operator confirm and pick the granted scope.

- _Why:_ The dashboard session is already signed, httpOnly, and revocable per the `auth` spec — reusing it means **no new credential, no new login surface**. Consent is a genuine OAuth requirement and a one-screen form.
- _Alternative considered:_ A dedicated login form accepting `REMBRIC_ADMIN_TOKEN`. Kept as a documented fallback only; the dashboard session is primary because it already satisfies the spec's signing/revocation requirements.
- **Login identity ≠ granted scope.** The credential the operator authenticates _with_ (dashboard session or the `*`-scoped admin token) only proves they are the operator and therefore may grant _any_ scope. It does NOT propagate its own scope into the minted token: the access token issued to the client carries the scope chosen at consent (D7), which can be narrower (`read:*`, `project:<id>`) than the admin's `*`. The admin token never reaches the client.

### D5 — PKCE `S256` mandatory; public client; DCR with `token_endpoint_auth_method: none`

`/authorize` rejects requests without a `code_challenge`; only `S256` is accepted (`plain` rejected). `/register` issues a public `client_id` with no secret. Authorization codes are single-use, short-TTL (~60s), bound to the `code_challenge`, redirect URI, and granted scope.

- _Why:_ ChatGPT is a public client and uses PKCE; `S256`-only and single-use codes close the interception/replay vectors. No client secret to store or leak.
- _Alternative considered:_ Allow `plain` PKCE / confidential clients. Rejected: weaker, unnecessary for the target client.

### D6 — Refresh-token rotation with reuse detection

`/token` with `grant_type=refresh_token` issues a new access token **and a new refresh token**, marking the presented refresh token consumed (`rotatedAt`). Presenting an already-rotated refresh token is treated as compromise: the token family is revoked.

- _Why:_ Rotation + reuse detection is the OAuth 2.1 BCP for public clients; a stolen-and-replayed refresh token gets the whole family killed.
- _Trade-off:_ A client that races two refreshes can self-revoke. Accepted — ChatGPT serializes refreshes; the safety property is worth the rare edge.

### D7 — OAuth scope ⇄ existing `TokenScope` grammar; path-scoping unchanged

Requested OAuth scope strings map to the existing grammar at consent time: a full-access grant → `*`, a read-only grant → `read:*`. Project restriction continues to come from the connector's request **path** (`/mcp/<slug>`) via the existing path-scoping contract — the OAuth token's scope is layered on top exactly as a static token's scope is today.

- _Why:_ Reuses `isAuthorized()` verbatim; no second authorization model. The protected-resource metadata is served for both `/mcp` and `/mcp/<slug>` so a path-scoped connector discovers the same issuer.
- **Per-project in practice = one connector per project.** ChatGPT's `server_url` may include a path, so a connector pointed at `/mcp/<slug>` is confined to that project by the path-scoping contract regardless of the token's scope (an `*`-scoped OAuth token on `/mcp/foo` still only touches `foo`). The clean per-project story is therefore one ChatGPT connector per `/mcp/<slug>`, each running its own OAuth and receiving its own access token.
- _Alternative considered:_ Encoding the project into the OAuth scope (`project:<id>`). Deferred: the path already carries it and is the canonical source; duplicating it invites drift. Left as a future extension if a client needs project selection at consent.

## Risks / Trade-offs

- **[Risk] OAuth is the most security-critical surface in the repo; a subtle bug is a breach (PKCE bypass, non-rotating refresh, code replay).** → Exhaustive negative tests are first-class deliverables, not afterthoughts: tampered/missing `code_verifier`, `plain` challenge rejection, code single-use, expired code, refresh reuse → family revoke, expired/revoked access token, cross-client code use. Opaque-token + DB-validation design keeps the surface small and reuses audited `crypto` primitives.
- **[Risk] Regressing the static-token path while adding the OAuth fork in `authenticate()`.** → Sibling-table design (D2) means the static path is not edited, only fronted; an invariant test asserts a static token still authenticates and an OAuth/static token cannot be confused. The full existing `auth`/`tokens` test suite must stay green.
- **[Risk] Wrong issuer URL silently breaks the handshake (proxy/tunnel mismatch).** → `REMBRIC_PUBLIC_URL` is explicit and required to enable OAuth (D3); metadata is generated from it; a startup log line echoes the resolved issuer; docs call out TLS/reachability.
- **[Risk] New routes collide with `/mcp` path-scoping or dashboard routes.** → OAuth routes live at fixed, reserved paths (`/.well-known/oauth-*`, `/authorize`, `/token`, `/register`); a routing test asserts `/mcp` and `/mcp/<slug>` behavior is unchanged and that `<slug>` cannot shadow a reserved path.
- **[Trade-off] Maintaining an OAuth AS tracks the evolving MCP authorization spec and ChatGPT's expectations.** → Accepted because OAuth 2.1 on remote MCP is an emerging cross-client standard worth owning; scope is held to single-tenant to cap the surface.
- **[Trade-off] Expired OAuth rows accumulate (no append-only purge applies to `oauth_*` tables).** → Accepted; a lightweight prune of expired/rotated rows is optional and out of scope for this change. Rejection is by `expiresAt`/`rotatedAt` check, so stale rows are inert.

## Migration Plan

1. Additive migration: `CREATE TABLE oauth_clients`, `oauth_authorization_codes`, `oauth_tokens` (+ indexes). No change to `tokens`, so no FK-drop dance.
2. Ship behind the `REMBRIC_PUBLIC_URL` gate (D3) — deploying the new image with the env unset is a no-op for existing operators.
3. Rollback: unset `REMBRIC_PUBLIC_URL` to disable the surface immediately; the new tables are inert when empty. A full revert drops the additive tables (safe — no parent FKs into them from existing data).

### D8 — Endpoint-phase security requirements (from the security review)

The service layer uses only standard primitives (CSPRNG, SHA-256, `timingSafeEqual`, RFC 7636 S256) and was independently audited; the issues found there were fixed (scope now fails _closed_ to `read:*`; `redirect_uri` registration restricted to https + loopback per RFC 8252; schema hashing docstring corrected). The remaining risk lives in the HTTP endpoints (group 5), which MUST implement:

- **/authorize**: reject `code_challenge_method != S256` and any missing/empty `code_challenge`; validate `code_verifier`/`code_challenge` length+charset (RFC 7636 §4.1, 43–128 unreserved); **exact-match** `redirect_uri` against the registered set; **never** redirect an error to an unvalidated `redirect_uri`; round-trip the client `state` parameter (client CSRF); the consent form itself MUST carry its own CSRF token tied to the dashboard session.
- **/token & /authorize**: never log `code`, `code_verifier`, or tokens.
- **/register & /token**: apply the existing per-token rate limiter (open DCR + token endpoint are abuse surfaces).
- Consider consuming/invalidating the authorization code on a PKCE-failed exchange (defense-in-depth; weigh against an attacker-burns-code DoS — PKCE already protects confidentiality, so this is optional).

### D9 — Audience/resource binding (RFC 8707) — explicit decision

OAuth tokens are NOT audience-bound to a specific resource; project restriction comes from the connector path (`/mcp/<slug>`, D7), so a token minted for one connector is technically usable on any `/mcp/<slug>` the bearer reaches. For a **single-tenant self-hosted** server with one operator this is an accepted trade-off (there is only one resource and one principal). This is **non-standard for multi-resource MCP** and is recorded here as a deliberate decision, NOT an oversight. If Rembric ever moves toward multi-tenant/hosted (the rejected Camino A), add a `resource`/audience column, accept the `resource` parameter at `/authorize` + `/token`, and validate the audience at MCP dispatch.

### D10 — Endpoint layer = MCP SDK's OAuth authorization server (vetted), backed by our audited core

Per operator decision (2026-06-15), the HTTP endpoint layer is NOT hand-rolled. We use the OAuth authorization server already shipped in `@modelcontextprotocol/sdk@1.29.0` (an existing direct dependency): `mcpAuthRouter` + its `authorize`/`token`/`register`/`metadata`/`revoke` handlers + `bearerAuth` middleware + built-in rate limiting. We implement the SDK's `OAuthServerProvider` (+ `OAuthRegisteredClientsStore`) interface, delegating to the already-audited `services/oauth.ts` + `oauth-repository.ts`. This means:

- The protocol-correctness surface most prone to OAuth hacks (PKCE validation, `state`/CSRF, `redirect_uri` exact-match + error-redirect handling, metadata document shape, DCR, RFC 8707 `resource` plumbing, rate limiting) is owned by the **vetted, MCP-purpose-built** SDK, not by us. This directly satisfies the "no home-cooked auth" requirement.
- Our hand-rolled core is repurposed, not discarded: it becomes the provider's storage/logic backing (`issueCode`→authorize, `exchangeCode`→`exchangeAuthorizationCode`, `refresh`→`exchangeRefreshToken`, `authenticateAccessToken`→`verifyAccessToken`, the repo as `clientsStore`). The SDK can perform PKCE validation itself (via `challengeForAuthorizationCode`), making our `verifyPkceS256` redundant on the endpoint path (kept only if still used internally).
- **Supply chain:** `express@5.2.1` + `express-rate-limit` are already present transitively under the SDK, so this adds no new download. Before any `package.json` edit (if we choose to declare a direct dep), route through the `npm-security-best-practices` skill per the repo contract.
- **Wiring:** `mcpAuthRouter` is an Express router; the existing node `http` server already path-routes (`/mcp*` → MCP transport, else → Hono). Add a third branch: the reserved OAuth paths → the Express auth router. The `/mcp` resource-server bearer check stays our unified `authenticate()` (it must also accept static tokens); the SDK's `verifyAccessToken` provider method maps to `oauth.authenticateAccessToken`.

The consent + single-user login (D4) is implemented inside the provider's `authorize(client, params, res)` — the SDK hands us the validated request and we render the consent / reuse the dashboard session, then redirect with code+state as the interface requires.

## Open Questions

- Should the consent screen allow choosing a **project scope** at grant time (vs relying solely on the connector path)? Deferred per D7; revisit if a client needs it.
- Token TTL defaults: proposed access ~1h, refresh ~30d. Confirm against ChatGPT's refresh cadence during e2e.
- Hand-roll the remaining endpoints vs adopt a vetted OAuth library (adds a dependency → npm-security review) vs front with an external IdP (breaks self-contained). The service core is hand-rolled but small and audited; the endpoint layer is where a library would most reduce surface. **Operator decision pending.**
