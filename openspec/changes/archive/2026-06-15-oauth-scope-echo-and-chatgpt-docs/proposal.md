## Why

When an OAuth client (ChatGPT) connects, the `/token` response returns Rembric's **internal** `TokenScope` (`*` / `read:*`) as the `scope`, not the **advertised OAuth scope vocabulary** (`mcp` / `read`) the client requested. ChatGPT compares its requested scopes against the granted `scope` string, finds neither `mcp` nor `read`, and warns _"no se concedieron todos los permisos solicitados"_. The tools still work (the token carries `*` internally), but the warning is wrong and erodes trust.

The root cause: we conflated the **wire-protocol scope** (OAuth names, what the client speaks) with the **authorization scope** (`TokenScope`, what `isAuthorized()` consumes). `resolveGrantedScope` is a mapper from the former to the latter; the bug stored its _output_ instead of its _input_.

Separately, ChatGPT is now a validated OAuth client but is absent from the documented supported-agents surface, and the recommended "Rembric-as-memory" custom instruction only exists in Spanish.

## What Changes

- **Decouple OAuth scope from `TokenScope`.** Store the granted **OAuth scope string** (`mcp` / `read`, restricted to the advertised set) on the authorization code and token; echo it verbatim in the `/token` response so the client sees its requested scopes as granted. Derive the internal `TokenScope` at **authorization read time** via `resolveGrantedScope`. **Backward-compatible**: tokens already issued (0.21.16) that stored `*` / `read:*` still resolve correctly, because `resolveGrantedScope` maps those to themselves.
- Single-source the advertised scopes as `SUPPORTED_OAUTH_SCOPES` (used by both the metadata router and the grant filter).
- Update the consent screen to display the granted OAuth scope vocabulary.
- **Docs (same PR):** add ChatGPT to the supported clients (README + `docs/agents.md`), document the OAuth connector connection for ChatGPT, and add the recommended memory-first custom instruction **in English**.

No change to: the `/mcp` authorization path (`isAuthorized` still receives a real `TokenScope`), token hashing, PKCE (SDK-owned), the append-only / scope-at-service-layer invariants, or the `oauth_*` schema (the `scope` column stays `text`; only its stored vocabulary changes — no migration).

## Capabilities

### Modified Capabilities

- `mcp-oauth`: the scope-grammar requirement is refined — the `/token` response (and the stored grant) SHALL use the advertised OAuth scope vocabulary; the internal `TokenScope` is derived from it at authorization time. Fail-closed mapping is preserved.

## Impact

- **Code:** `apps/server/src/services/oauth.ts` (`IssueCodeInput`/`TokenPair` scope → `string`; `authenticateAccessToken` derives `TokenScope`; new `SUPPORTED_OAUTH_SCOPES` + `grantedOAuthScope`); `apps/server/src/dashboard/oauth-consent.ts` (store + display granted OAuth scope); `apps/server/src/server/bootstrap.ts` (`scopesSupported` from the single source).
- **Tests:** update `oauth-consent.test.ts` (granted scope is now an OAuth string); add `grantedOAuthScope` unit tests + a `/token`-echoes-`mcp`/`read` assertion in `oauth-http.test.ts`. `auth.test.ts` / `oauth-e2e.test.ts` unaffected (verified: `*`/`read:*` map to themselves).
- **Docs:** `README.md` (supported-agents table + config note), `docs/agents.md` (ChatGPT connection + English recommended instruction).
- **Spec:** delta to `openspec/specs/mcp-oauth/spec.md`.
- **No migration**, no new dependency.
