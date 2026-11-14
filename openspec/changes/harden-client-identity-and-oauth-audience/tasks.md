## 1. Client identity

- [x] 1.1 `apps/web/server.js` rewrites `X-Forwarded-For` to the identity chosen by `REMBRIC_TRUSTED_PROXY_HOPS` (default `0`), with tests for a spoofed header at `0` and one trusted proxy at `1`
- [x] 1.2 One client-identity helper replaces the five copies; the IPv6 /56 rate-limit grouping is unchanged
- [x] 1.3 `/mcp` records failed bearers against the authentication lockout
- [x] 1.4 README environment table and `docs/docker.md` reverse-proxy guidance

## 2. OAuth audience

- [x] 2.1 Per-connector protected-resource metadata at `/.well-known/oauth-protected-resource/mcp/<slug>` and a matching `/mcp/<slug>` challenge
- [x] 2.2 `/authorize` refuses an unknown-slug or foreign `resource` with `invalid_target`
- [x] 2.3 The consent screen names the bound project or states that the grant is unbound
- [x] 2.4 A real SDK client's `/mcp/<slug>` grant is bound and refused on another project; the path-less grant stays unbound

## 3. `/api` body bound

- [x] 3.1 `readJson` reads through `readRequestBody` with `MAX_BODY_BYTES` and routes answer `413 payload_too_large`

## 4. Verification

- [x] 4.1 Mutation checks for every new guard; OpenSpec delta gates and `openspec validate --strict`
- [x] 4.2 Independent security verification of the change
