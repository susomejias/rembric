## Why

ChatGPT (and a growing set of remote MCP clients) will only attach to an authenticated MCP server through an OAuth 2.1 flow that conforms to the MCP authorization spec — they mint and carry the bearer token themselves and **cannot** accept a pasted static API key. Rembric today authenticates `/mcp` exclusively with operator-issued static bearer tokens (`TokensService`), so it cannot be added as a ChatGPT custom connector at all. More broadly, OAuth 2.1 is becoming the standard auth handshake for remote MCP across clients; adding it is worthwhile on its own merits, with the ChatGPT connector as the first concrete consumer.

This change adds OAuth as a **self-contained, in-process authorization server** alongside the existing static-token path — both converge on the same bearer validation — scoped to **single-tenant private use** (no multi-tenant SaaS, no marketplace submission). It deliberately does NOT pursue the public ChatGPT app directory, which would force a hosted multi-tenant pivot that breaks the single-SQLite / operator-token invariants.

## What Changes

- Add an embedded **OAuth 2.1 authorization server** to the existing HTTP surface (Hono), with endpoints:
  - `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` — metadata discovery (absolute URLs derived from the issuer).
  - `POST /register` — Dynamic Client Registration (ChatGPT runs this once per connector).
  - `GET /authorize` — Authorization Code flow with **PKCE** (`S256`), gated by a single-user login + a one-screen consent.
  - `POST /token` — authorization-code exchange and **refresh-token rotation**; issues short-lived access tokens.
- Extend the token model to carry OAuth access/refresh tokens (a `kind` discriminator on the `tokens` aggregate, or a sibling table) with short expiries, while leaving the **static operator-token path unchanged**. Both kinds resolve through the existing `authenticate()` and the existing scope grammar (`*`, `project:<id>`, `read:*`) is reused as OAuth scopes.
- Make the `/mcp` (and `/mcp/<slug>`) `401` advertise `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"` so OAuth clients can discover the authorization server. This is **additive** — static-token clients ignore the header.
- Add one required env, `REMBRIC_PUBLIC_URL` (the OAuth issuer / external base URL); reuse `REMBRIC_SESSION_SECRET` (via `deriveSessionKey`) for OAuth artifact signing and reuse `REMBRIC_ADMIN_TOKEN` as the single-user login credential at `/authorize`. Access/refresh TTLs are env-tunable with sane defaults.
- Heavy test coverage: unit tests for the full flow (DCR, PKCE happy-path + tamper/replay, code single-use, refresh rotation, expiry, revoke, scope mapping), invariant tests proving the static-token path and append-only memory are untouched, and an e2e smoke validating **both** auth paths (static bearer + OAuth-minted token) against the dev Docker stack.

This does NOT change the append-only memory invariant, the scope-at-service-layer invariant, `topic_key` convergence, or judgment freshness. The `/mcp` vs `/mcp/<slug>` path-scoping contract is preserved verbatim.

## Capabilities

### New Capabilities

- `mcp-oauth`: The OAuth 2.1 authorization-server + protected-resource surface — metadata discovery, Dynamic Client Registration, Authorization Code + PKCE with single-user login/consent, token issuance and refresh rotation, and the `WWW-Authenticate` challenge on protected MCP routes.

### Modified Capabilities

- `auth`: The token model gains an OAuth dimension — access/refresh tokens are issued by the authorization server (not the operator dashboard), are short-lived, carry the same scope grammar, and are revocable on the same immediate-effect contract. The static operator-token requirements are unchanged; new requirements describe how OAuth-minted tokens coexist and how they are stored and hashed at rest.
- `mcp-api`: The MCP endpoint MUST accept OAuth-minted bearer tokens on the same validation path as static tokens, and MUST emit the `WWW-Authenticate` resource-metadata challenge on `401`. The Streamable-HTTP transport and path-scoping contracts are unchanged.

## Impact

- **New code**: an OAuth module under `apps/server/src/server/` (e.g. `oauth/` — authorization-server handlers, metadata documents, PKCE + code/refresh logic, consent/login views) wired into the Hono app in `apps/server/src/server/http.ts` / `api-router.ts`.
- **Modified code**:
  - `apps/server/src/services/tokens.ts` — issue/validate OAuth access & refresh tokens, refresh rotation, scope mapping; `authenticate()` accepts both kinds.
  - `apps/server/src/server/auth.ts` — `401` paths emit `WWW-Authenticate`.
  - `apps/server/src/db/schema/tokens.ts` + a new migration — `kind` discriminator (or sibling table) for OAuth tokens, OAuth client registrations, and pending authorization codes; table-rebuild dance if a `CHECK`/NOT NULL is involved.
  - `apps/server/src/db/repositories/` — repository methods for the new rows (all SQL stays here).
  - Config/env loading — `REMBRIC_PUBLIC_URL`, optional `REMBRIC_OAUTH_ACCESS_TTL` / `REMBRIC_OAUTH_REFRESH_TTL`.
- **Tests**: new co-located `*.test.ts` for the OAuth module + `tokens.ts`; additions to `apps/server/src/test/invariants.test.ts` (static path unchanged, data-access confinement for new SQL); an e2e smoke under the `rembric-smoke-tests` pattern exercising both auth paths against `pnpm run dev:docker:up`.
- **Docs**: a connector setup note (Developer Mode + `REMBRIC_PUBLIC_URL` + TLS reachability) as manual fallback; no change to the TUI installer's canonical path.
- **Dependencies**: prefer zero new deps (Node `crypto` covers PKCE/signing). Any candidate dep MUST route through the `npm-security-best-practices` skill.
- **Invariants referenced**: append-only memory (untouched), scope-at-service-layer (OAuth scopes resolve to the same `Scope`), path-scoping contract (`/mcp` vs `/mcp/<slug>`, preserved).
