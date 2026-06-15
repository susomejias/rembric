## Context

`resolveGrantedScope(requestedScope)` maps an OAuth scope string → `TokenScope`. The OAuth change stored its _output_ (`TokenScope`) on the code/token and echoed that in `/token`. So `scope_supported = [mcp, read]` is advertised, the client requests `mcp read`, and we reply `scope: "*"` — a vocabulary the client never asked for → ChatGPT's "not all permissions granted" warning. Authorization itself is fine (`*` is a valid `TokenScope`); only the wire echo is wrong.

## Goals / Non-Goals

**Goals:**

- The `/token` response echoes the granted scopes in the advertised OAuth vocabulary, so the client's requested-vs-granted comparison passes.
- Internal authorization is unchanged: `isAuthorized()` still receives a real `TokenScope`.
- Zero migration; backward-compatible with tokens already issued in prod.
- Single source of truth for the advertised scope list.

**Non-Goals:**

- Per-scope tool gating, richer scopes, RFC 8707 audience binding (out of scope; deferred).
- Any change to the static-token path, PKCE (SDK-owned), or the consent/login flow beyond the displayed scope text.

## Decisions

### D1 — Store the OAuth scope string; derive `TokenScope` at read time

The code/token `scope` column holds the **granted OAuth scope string** (advertised vocabulary). `authenticateAccessToken` returns `resolveGrantedScope(token.scope)` as the authz `TokenScope`. `/token` echoes the stored string.

- _Why:_ puts the protocol vocabulary on the wire (what the client expects) while keeping `resolveGrantedScope` as the single authz mapper — just moved from write-time to read-time.
- _Alternative considered:_ add a second column (`oauth_scope` + `token_scope`). Rejected: needs a migration for no benefit — one column + a read-time map is sufficient and `resolveGrantedScope` is pure.

### D2 — Backward compatibility is free

`resolveGrantedScope` is idempotent on the values prod already stored: `resolveGrantedScope("*") === "*"` and `resolveGrantedScope("read:*") === "read:*"` (neither matches the write-trigger set beyond `*` itself). So existing access/refresh tokens keep authorizing exactly as before; no backfill, no migration.

```
old token.scope="*"      → authenticateAccessToken → resolveGrantedScope("*")       → "*"      (unchanged)
old token.scope="read:*" → authenticateAccessToken → resolveGrantedScope("read:*")  → "read:*" (unchanged)
new token.scope="mcp read" → authenticateAccessToken → resolveGrantedScope("mcp read") → "*"   (write)
new token.scope="read"     → authenticateAccessToken → resolveGrantedScope("read")     → "read:*"
```

### D3 — `grantedOAuthScope` filters to the advertised set, fail-closed

The granted OAuth string = requested scopes ∩ `SUPPORTED_OAUTH_SCOPES`, joined; empty → `read` (least privilege). `SUPPORTED_OAUTH_SCOPES = ['mcp','read']` is exported and consumed by both `mcpAuthRouter({scopesSupported})` and the grant filter, so the advertised set and the grantable set cannot drift.

## Risks / Trade-offs

- **[Risk] An existing test asserts the old vocabulary** → `oauth-consent.test.ts` checks `redeemCode(...).scope === '*'` while consenting `scope: 'mcp'`. → Mitigation: update it to assert `resolveGrantedScope(pair.scope) === '*'` (authz scope) — the only test that changes; `auth.test.ts` / `oauth-http.test.ts` / `oauth-e2e.test.ts` were verified to pass unchanged because they exercise `*`/`read:*` which round-trip.
- **[Trade-off] The `scope` column's stored vocabulary now differs between pre- and post-fix rows** (`*` vs `mcp`) → Accepted: `resolveGrantedScope` normalizes both at read time, so the mix is invisible to authz. Documented in D2.
- **[Risk] Consent display showed `scope *`** → now shows the OAuth scope (`mcp read`); the human-readable access label (`Read & write` / `Read-only`) still derives from `resolveGrantedScope`.

## Open Questions

- None. Scope is intentionally narrow.
