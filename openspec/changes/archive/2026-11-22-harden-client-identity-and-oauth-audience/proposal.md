## Why

Testing the SDK v2 collapse against real clients surfaced three gaps that already exist on `main`, each where the code falls short of a published requirement:

- **Client identity is whatever the client says.** Rate limits and the authentication lockout key on the left-most `X-Forwarded-For` value, read in five places. Next.js 16 fills that header from the socket only when it is absent (`next/dist/server/base-server.js:612`, `??=`), so a direct client that sends its own value picks its own bucket: it can rotate past the `/register` limit and the dashboard-login lockout. `auth/spec.md` already requires the identity to be "the source socket address, or the configured trusted-proxy forwarded first hop", and no such configuration exists. `/mcp` also never records a failed bearer, so the lockout that requirement describes never engages there.
- **A grant made on `/mcp/<slug>` is not bound to that project.** `mcp-oauth/spec.md` requires the project of a `/mcp/<slug>` authorization to be carried into the code and tokens, but the protected-resource metadata advertises the server root as `resource` and the `401` challenge points every connection at that one document. MCP SDK clients (1.x and 2.x) send the advertised `resource`, so real clients always obtain unbound tokens that reach every project. A `resource` naming a slug that does not exist is also silently treated as unbound.
- **`/api` reads bodies without a bound.** `http-api/spec.md` requires `/api/<slug>/sessions*` to refuse an over-large body with `413` instead of buffering it; `readJson` calls `request.json()` unbounded and answers `400`.

## What Changes

- **BREAKING** The client identity used by every rate limiter and by the authentication lockout is the TCP peer address unless the operator declares trusted proxies with `REMBRIC_TRUSTED_PROXY_HOPS=<n>` (default `0`). The production launcher (`apps/web/server.js`) normalizes `X-Forwarded-For` to that single identity before Next.js sees the request, and one helper replaces the five copies that read it.
- `/mcp` records a failed bearer against the lockout, as `/api`, `/healthz` and the dashboard login already do.
- **BREAKING** OAuth discovery is per connector: `/mcp/<slug>` challenges point at `/.well-known/oauth-protected-resource/mcp/<slug>`, whose `resource` is `<issuer>/mcp/<slug>`, so a standard client's grant is bound to that project. The path-less `/mcp` keeps the root document and stays unbound, as specified. `/authorize` refuses a `resource` that names a project that does not exist or a URL that is not this server's `/`, `/mcp` or `/mcp/<slug>` (an `invalid_target` error redirect). The consent screen names the project a grant will be bound to.
- `/api/<slug>/sessions*` and the other `/api` routes that read a JSON body enforce `MAX_BODY_BYTES` (default 4 MiB) with the MCP SDK's `readRequestBody`, answering `413 { ok: false, code: 'payload_too_large' }`.

## What is lost

| #   | Working today                                                                                                             | Who notices                                                                                  | After this change                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Behind a reverse proxy, each client gets its own rate-limit and lockout bucket from the left-most `X-Forwarded-For` value | Operators who front Rembric with a reverse proxy                                             | Until `REMBRIC_TRUSTED_PROXY_HOPS` is set, every client shares the proxy's bucket, so one client's failures can lock the others out for the lockout window. The launcher logs the value at startup and warns once when forwarded requests arrive at `0`; `docs/updates.md` has the one-time upgrade steps |
| 2   | An MCP client that authorizes against `/mcp/<slug>` receives a token that can read and write every project                | OAuth connectors configured on a project URL                                                 | The token works on that project only; reaching another project needs another connector                                                                                                                                                                                                                    |
| 3   | `/authorize` accepts any `resource`                                                                                       | Clients that send a resource outside this server's `/mcp` surface, or a slug with no project | A redirect to the client's `redirect_uri` with `error=invalid_target` (RFC 6749 §4.1.2.1, RFC 8707 §2)                                                                                                                                                                                                    |
| 4   | An oversized `/api` body is answered `400 invalid_input` after being read whole                                           | None expected: the largest accepted field is 40,000 code points                              | `413 payload_too_large`, refused while reading                                                                                                                                                                                                                                                            |
| 5   | An MCP client retrying with a revoked or expired bearer is refused with `401` indefinitely                                | Hosts running several agents behind one address (all local clients share `127.0.0.1`)        | After `AUTH_LOCKOUT_MAX_FAILURES` failures in the window, that address is throttled for `AUTH_LOCKOUT_MS` on every authenticated surface, dashboard login included; a successful authentication resets the count                                                                                          |

Tokens issued before the upgrade keep the binding they were issued with; an operator who wants every connector bound re-authorizes it or revokes its tokens.

## Capabilities

### Modified Capabilities

- `auth`: the pre-auth identity is the socket address or the configured trusted-proxy hop, via `REMBRIC_TRUSTED_PROXY_HOPS`; `/mcp` records failures.
- `mcp-oauth`: per-connector protected-resource metadata and challenge; `resource` validation; the consent screen names the bound project.
- `http-api`: the body bound covers every `/api` route that reads a body, with its `413` shape.

## Impact

- **Server**: `apps/web/server.js`, a shared client-identity helper replacing `clientIdentity`/`networkIdentity`/`rateLimitIdentity` copies (`apps/web/src/lib/{api,oauth-rate-limit}.ts`, `apps/web/src/app/{mcp/[[...path]],healthz,dashboard/login/verify}/route.ts`), `apps/web/src/lib/mcp-auth.ts`, `apps/web/src/lib/oauth-{router,provider}.ts`, the consent page under `apps/web/src/app/dashboard/oauth-consent/`.
- **Docs**: `README.md` environment table, `docs/docker.md` reverse-proxy guidance.
- **Releases**: breaking for `server` only; no plugin changes.
