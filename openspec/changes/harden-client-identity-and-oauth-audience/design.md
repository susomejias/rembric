## Context

Three requirements that are already published are not met by the code (see proposal.md). Each fix reuses something the stack already ships: the MCP SDK's metadata and body helpers, and Next.js's own `X-Forwarded-For` fill. No dependency is added.

## Goals / Non-Goals

**Goals:** a client cannot choose its own rate-limit or lockout bucket; a standard MCP client's grant on `/mcp/<slug>` is bound to that project; every `/api` body is bounded.

**Non-Goals:** binding path-less `/mcp` grants (the spec keeps them unbound); re-binding tokens issued before the upgrade; a CIDR allow-list of proxies; rate limiting in `next dev`.

## Decisions

### D1. Normalize `X-Forwarded-For` in the launcher, count trusted hops

Next.js 16 copies the socket address into `X-Forwarded-For` only when the header is absent, and route handlers have no other access to the peer address, so the only place that sees both is the HTTP server the standalone build creates. `apps/web/server.js` wraps `http.createServer` before importing it and rewrites the header to one value: the entry `REMBRIC_TRUSTED_PROXY_HOPS` positions from the right of the forwarded chain followed by the socket address. With the default `0` that is the socket address; with `1` it is the address the one trusted proxy appended. Every consumer then reads one helper.

- _Alternative: a proxy CIDR allow-list._ More precise, more configuration; the documented deployments are direct exposure or one reverse proxy, which a hop count describes.
- _Alternative: keep trusting the left-most hop by default._ Rejected: it is the defect, and the `auth` spec already names the socket address as the default identity.
- _Consequence:_ `next dev` keeps the header as sent; it is not a production entry point.

### D2. One protected-resource document per connector

`oauthMetadataResponse` serves one document per `resourceServerUrl`, and SDK clients send the document's `resource` as their RFC 8707 `resource`. Serving `/.well-known/oauth-protected-resource/mcp/<slug>` with `resource = <issuer>/mcp/<slug>`, and pointing the `/mcp/<slug>` challenge at it, makes the existing binding (`boundProjectId`, formerly `projectIdFromResource`) fire for standard clients with no change to token storage. The root document stays for path-less `/mcp`, whose grants remain unbound as specified.

`/authorize` accepts a `resource` only on this issuer's origin with no credentials, query or fragment and a path of `/`, `/mcp` or `/mcp/<existing slug>`; anything else (an unknown slug, a sub-path that used to bind to its first segment) gets an `invalid_target` error redirect instead of a silently unbound or mis-bound token. The consent screen states the project the grant is bound to, or that it is unbound.

### D3. Bound `/api` bodies with the SDK reader

`readJson` reads through `readRequestBody` with the same `MAX_BODY_BYTES` that `/mcp` passes to `createMcpHandler`, cancels the stream when it is over, and the route answers `413 payload_too_large` in the `/api` error shape.

## Risks / Trade-offs

- [Risk] Operators behind a reverse proxy who do not set the variable share one bucket → documented in the README and `docs/docker.md`, and listed as breaking.
- [Trade-off] Existing unbound tokens stay unbound until re-authorized → stated in proposal.md; revoking a connector's tokens forces it.
