## Context

Since `server-v0.28.9`, `apps/web/src/lib/mcp-server.ts` routes MCP traffic in two legs:

- **2025 era**: `serveLegacy` holds a `legacySessions` map keyed by `mcp-session-id`, one SDK 1.x `McpServer` (from `packages/mcp`'s `createMcpServer`) per session, behind a v2 `WebStandardStreamableHTTPServerTransport`.
- **2026-07-28 era**: `createMcpHandler(..., { legacy: 'reject' })` with a factory that always throws; since #446 the route answers these requests with `-32022` so negotiating clients fall back.

The session leg exists because per-connection state hangs off `(tokenId, mcpSessionId)` in `SessionRouter` (`packages/core/src/server-context/session-router.ts`): `project.use` pins, roots discovery state and suggestions, and the Rembric session bound by `session_start`/`session_resume`. Mapping that state showed most of it is inert on the configuration every plugin uses:

- `resolveEffectiveScope` returns the URL project before touching the router (`packages/mcp/src/_shared.ts:36-37`), so on `/mcp/<slug>` roots discovery, `pendingSuggestedSlugs` and the project pin never run.
- The only router field live on `/mcp/<slug>` is `rembricSessionId`, and the only client that relies on it is Pi (`apps/plugin/.pi-plugin/index.ts:383-416`).
- Once roots is gone the server sends no server→client request or notification and never reads client capabilities or `clientInfo`.

The 2026-07-28 revision removes protocol sessions, requires cross-request state to be "referenced by an explicit identifier the client passes on each request" (basic/index), deprecates roots, and names tool parameters, resource URIs and server configuration as the replacements (changelog, SEP-2577). It also allows a dual-era server on one endpoint (basic/versioning).

`@modelcontextprotocol/server` 2.4.0 (published 2026-10-23, past the repo's `minimumReleaseAge`) is the latest v2. Its `createMcpHandler` serves 2025 traffic either `'stateless'` (default: fresh instance per request, `GET`/`DELETE` answer `405`) or `'reject'`. It ships no OAuth authorization-server router: only `requireBearerAuth`, `mcpAuthMetadataRouter`, `OAuthError` and the metadata types.

## Goals / Non-Goals

**Goals:**

- One MCP SDK in the repository: `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0. No `@modelcontextprotocol/sdk`.
- One request path for both eras, with no per-connection server state.
- Native 2026-07-28 service; 2025 clients keep working, including bridge and Pi builds already published.
- Delete the code the stateless model makes unreachable rather than keeping it behind flags.
- Keep core behaviour: `.rembric` scoping, path isolation, authentication and authorization, the HTTP session lifecycle, `memory.session_*` tools, explicit `sessionId` attachment, search and saves.

**Non-Goals:**

- Adopting the Tasks extension or `subscriptions/listen`. No Rembric tool is long-running, and the events work is not normative yet.
- Changing the HTTP API under `/api`, the dashboard, or the data model. No migration.
- A 1.0.0 release.

## Decisions

### D1. One stateless `createMcpHandler` for both eras

The handler's default `'stateless'` posture answers each 2025 request with a fresh server from the same factory, and 2026-07-28 requests natively. `serveLegacy`, `legacySessions`, `isInitializePost` and `modernEraRefusal` go.

- _Alternative: keep the sessionful 2025 leg routed with `isLegacyRequest` in front of a `'reject'` handler_ (the SDK's documented pattern). It preserves `404/-32001` and `DELETE`, but after D2–D4 nothing reads the session, so it would be two legs with identical behaviour.
- _Alternative: keep the #446 guard._ Cheapest, but leaves the SDK mix and never serves modern clients.

### D2. Remove project auto-detection instead of moving it

The roots path derives a slug from the first root's basename. The `projects` spec already records that a lost `roots/list` misfiles every row a connection writes, and memory is append-only with no reassignment verb. Moving the same guess into the bridge keeps the hazard, adds logic to the plugins, and adds a `project_not_found` case. Without it, a connection with no `.rembric` is a configuration problem the bridge reports, which matches the hooks: they already disable themselves without a slug.

- _Alternative: bridge-side detection from `PWD`._ Rejected for the reasons above.
- _Alternative: roots through `inputRequired`._ Possible in v2, but it reintroduces a deprecated feature as a new dependency and an extra round trip per call.

### D3. Remove `project.use` entirely

On `/mcp/<slug>`, `project.use` is either an idempotent no-op or `scope_locked`. Switching only works on path-less connections, and only by storing a pin on the transport, which 2026-07-28 does not have. Project creation through `autocreate` goes with it; projects are created from the dashboard. `memory.session_start({project})` keeps its argument as an assertion, so existing callers get a precise `scope_locked` instead of a schema refusal.

- _Alternative: `project.create({slug})`._ A clean, stateless replacement for creation. The owner rejected agent-side creation as implicit.
- _Alternative: keep `project.use` for 2025 sessions only._ That keeps the router and two behaviours by era.

### D4. Session attachment by explicit identifier

`SessionRouter` and `RequestContext.mcpSessionId` are removed. `resolveActiveSessionId`/`resolveSessionId` keep their existing chain minus the router: an explicit `sessionId` validated by `assertExplicitSessionOwned`, else `findActiveForTransport(tokenId, projectId)`, which returns a session only when exactly one is active and never guesses. Pi, the only client that bound the transport, injects `ctx.sessionManager.getSessionId()` as `sessionId` into every discovered tool whose input schema declares it. This is the SEP-2567 handle pattern with no new server mechanism.

- _Alternative: a `Rembric-Session-Id` header._ A new server mechanism, and the bridge does not know the host's session id.
- _Alternative: keep the router for 2025 only._ Same objection as D3.

### D5. OAuth authorization server on Web primitives

`oauth.ts` adapts the 1.x Express `mcpAuthRouter` to Next.js through request/response shims of about 190 lines. The endpoints are rewritten as fetch handlers over the existing `oauth-provider.ts` logic, using v2's `OAuthError` and metadata types. Before the rewrite, a characterization suite records status, the headers that matter and the body for every endpoint and error branch (metadata, DCR, authorize GET/POST, token for code and refresh with PKCE, revoke, CORS preflight, rate limit). The same suite must pass unchanged afterwards.

- _Alternative: keep `@modelcontextprotocol/sdk` for auth only._ Contradicts the single-SDK goal.
- _Alternative: a third-party OAuth server library._ Adds supply-chain surface for five endpoints whose logic already exists.

### D6. Tool registration on the v2 `McpServer`

`createMcpServer` builds a v2 `McpServer` and registers tools with `registerTool`; input schemas stay zod 4 (v2 depends on `zod ^4.2.0`, `packages/mcp` already uses `^4.6.5`). Tool names, descriptions, input and output schemas, annotations and error mapping must be byte-identical. The port is its own PR with no behaviour change, verified by the existing suite running against `@modelcontextprotocol/client` 2.4.0 and by the wire diff.

### D7. Evidence before and after

- PR 1 adds tests on the current code for the three behaviours only recorded in a manual smoke (`WWW-Authenticate` on a missing bearer, `406` without the required `Accept`, SSE keepalive), plus a differential harness that replays every existing request shape against a base build and a candidate build and compares status, relevant headers and body.
- Every difference the harness reports in PR 3 must map to a row of the proposal's "What is lost" table. Any other difference is a regression.
- New guards are mutation-checked with `scripts/mutate.mjs`.

### D8. Delivery and versioning

Four chained PRs registered with `gh stack`: (1) change + pins + harness; (2) tool-server port; (3) `feat(mcp)!` stateless handler and removals with bridge, Pi and specs; (4) OAuth rewrite and removal of `@modelcontextprotocol/sdk`. Behavioural commits use `!` with a `BREAKING CHANGE:` footer and touch `apps/web` or `apps/plugin`, so release-please attributes them. Both components use `bump-minor-pre-major`, giving server 0.31.0 and plugin 0.41.0.

## Risks / Trade-offs

- [Risk] A 2025 client that requires `Mcp-Session-Id` or a working `GET` stream breaks against a stateless server → Stateless 2025 serving is the SDK's own default posture, and both `405` answers are permitted by the 2025 transport. Before merge, the plugin e2e walkthrough runs all five clients plus the published bridge `0.40.0` and an old Pi build.
- [Risk] Writes from concurrent same-project sessions lose their session when the model omits `sessionId` → `findActiveForTransport` returns none rather than a wrong session; Pi injects `sessionId`; the bridge clients already inject it in their per-turn hints.
- [Risk] The OAuth rewrite subtly changes the authorization flow → Characterization suite first, identical afterwards; a security review of the diff; refresh-token rotation and reuse detection are kept in `oauth-provider.ts` and untouched.
- [Risk] Users relying on `project.use` or roots on path-less `/mcp` lose project selection → Documented in "What is lost", the bridge diagnostic names the fix, and the release is marked breaking.
- [Trade-off] Remote OAuth connectors need one URL per project → Accepted because the protocol offers no per-connection state to switch on, and cross-project reads still work for multi-project tokens.
- [Trade-off] A per-request server instance costs a construction per request → Accepted: tool registration is synchronous and in-process; PR 3 records the before/after `tools/call` latency with one named instrument.

## Migration Plan

1. Release server 0.31.0. Published plugins keep working: the bridge ignores a missing session id, Pi's bind loop skips without one, and neither depends on `roots/list` being requested.
2. Release plugin 0.41.0 with the bridge cleanup and Pi's explicit `sessionId`.
3. Users with path-less `/mcp` configurations add `.rembric` or switch to `/mcp/<slug>`; new projects are created in the dashboard.

Rollback is redeploying server 0.30.12. No data or schema changes in either direction.

## Open Questions

- Does the v2 stateless 2025 path keep answering `notifications/initialized` with `202` and `406` for a missing `Accept`, exactly as today? PR 1's pins answer this.
- The OAuth characterization suite (`apps/web/src/test/oauth-wire.test.ts`) pins six behaviours of the 1.x router that look like defects: malformed JSON at `/register` answers `500 internal_error`; `429` responses carry no `content-type` or `cache-control`; `response_type=token` answers `invalid_request` rather than RFC 6749's `unsupported_response_type`; `/token` with an unknown client omits `cache-control: no-store`; DCR responses omit `client_id_issued_at`; `/authorize` sends no CORS headers. PR 4 reproduces each one unless the owner decides to fix it, and a fix updates its snapshot in the same commit.
- The wire harness against a running server (`measurements/wire-diff/base-vs-candidate-pr1.txt`) sees `500 server_error` from `/token` for an unknown code, a reused code and refresh-token reuse, where the in-process suite sees `400 invalid_grant`. The likely cause is the bundled-chunk `instanceof DomainError` mismatch recorded in 8375c5d0; it is unverified. PR 4 must decide whether the rewrite keeps or fixes it, and the harness will show which.
- Does any published client version send `DELETE` on shutdown and log an error on `405`? Checked in the e2e walkthrough; if one does, it is a cosmetic diagnostic, not a failure.
