## 1. Decouple OAuth scope from TokenScope (services/oauth.ts)

- [x] 1.1 Change `IssueCodeInput.scope` and `TokenPair.scope` from `TokenScope` to `string` (the granted OAuth scope string); drop the `as TokenScope` casts in `redeemCode`/`refresh`/`issueTokenPair`/`insertToken`.
- [x] 1.2 In `authenticateAccessToken`, return `scope: resolveGrantedScope(token.scope)` (derive the authz `TokenScope` at read time). `ResolvedAccessToken.scope` stays `TokenScope`.
- [x] 1.3 Add `export const SUPPORTED_OAUTH_SCOPES = ['mcp','read'] as const` and `export function grantedOAuthScope(requested?: string): string` (requested ∩ supported, joined; empty → `read`).

## 2. Consent (dashboard/oauth-consent.ts)

- [x] 2.1 Store the granted OAuth scope string: `issueCode({ scope: grantedOAuthScope(areq.scope) })` instead of `resolveGrantedScope(...)`.
- [x] 2.2 Display the granted OAuth scope vocabulary (e.g. `mcp read`) in the consent grant box; keep the human label (`Read & write` / `Read-only`) derived via `resolveGrantedScope`.

## 3. Single-source the advertised scopes (server/bootstrap.ts)

- [x] 3.1 Pass `scopesSupported: SUPPORTED_OAUTH_SCOPES` to the http `oauth` block instead of the inline `['mcp','read']` literal.

## 4. Tests

- [x] 4.1 Update `oauth-consent.test.ts`: the approve flow stores an OAuth string — assert `resolveGrantedScope(pair.scope) === '*'` (authz scope) rather than `pair.scope === '*'`.
- [x] 4.2 Add `grantedOAuthScope` unit tests (mcp read → "mcp read"; read → "read"; unknown/empty → "read"; drops unsupported tokens) in `oauth.test.ts`.
- [x] 4.3 In `oauth-http.test.ts`, assert the `/token` response `scope` echoes `mcp` (the requested advertised vocabulary), not `*`.
- [x] 4.4 Confirm `auth.test.ts` and `oauth-e2e.test.ts` stay green unchanged (backward-compat: `*`/`read:*` round-trip).

## 5. Docs (same PR)

- [x] 5.1 Add ChatGPT to the supported clients in `README.md` (supported-agents table, as an MCP/OAuth connector — no native plugin).
- [x] 5.2 In `docs/agents.md`, extend the OAuth section with how to connect ChatGPT (custom connector, `/mcp/<slug>` URL, consent with admin token) and the recommended memory-first custom instruction **in English**.

## 6. Verify (no regression)

- [x] 6.1 `pnpm run typecheck` + `pnpm run lint` clean.
- [x] 6.2 Full server suite green: `pnpm --filter @rembric/server exec vitest run` (incl. invariants; backward-compat confirmed).
