# `/api` — session-lifecycle HTTP surface

This directory is the Next.js (App Router) counterpart of
`apps/server/src/server/api-router.ts`. It is **contract-identical**: the same
eight endpoints, the same request shapes, the same validation, the same service
calls, the same status codes and the same `{ ok: false, code, … }` bodies.

The surface exists because the plugin's `command`-type hooks (Claude Code's
`session-start.sh`, `pre-compact.sh`, `stop-sync.sh` and the Codex equivalents)
POST here directly, so sessions are tracked whether or not the agent remembers
to call `memory.session_start` over MCP.

| Method | Path                                   | Success body                                                                              |
| ------ | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| POST   | `/api/:slug/sessions`                  | `{ ok, sessionId, scope, projectId, startedAt, title, created }`                          |
| POST   | `/api/:slug/sessions/:id/summary`      | `{ ok, sessionId, summary, title, summaryFinal, titleFinal }`                             |
| POST   | `/api/:slug/sessions/:id/end`          | `{ ok, sessionId, endedAt, summary, title }`                                              |
| POST   | `/api/:slug/sessions/:id/resume`       | `{ ok, sessionId, status, startedAt, resumedAt, previousStatus, previousEndedAt, title }` |
| POST   | `/api/:slug/sessions/:id/turn`         | `{ ok, sessionId, lines }`                                                                |
| POST   | `/api/:slug/sessions/:id/recall-hints` | `{ ok, lines }`                                                                           |
| GET    | `/api/:slug/debug/counters`            | `{ ok, counters, recall }` — admin token only                                             |
| POST   | `/api/:slug/memory/recall`             | `{ ok, memories, formatted }`                                                             |

Auth is identical to `/mcp`: `Authorization: Bearer <token>`, the admin token or
a static project token, plus the OAuth access-token fallback when
`REMBRIC_PUBLIC_URL` is set. Project scope comes exclusively from the `:slug`
path segment — an unknown slug is `{ ok: false, code: 'project_not_found', slug }`
with a 404, never a fallback to another project.

## Transition and cutover

Both servers serve this surface at the same time, on different ports, during
the migration. `apps/server` keeps its Hono router untouched, and this one is
purely additive — no client has been repointed.

Cutover is therefore a client-side change only: point the clients' base URL at
the Next process and stop `apps/server`. Nothing in this directory needs to
change for that, and nothing here needs to be reverted if the cutover is
postponed.

## Where the behaviour lives

- `src/lib/api.ts` — the shared response bodies, `statusForCode`, the
  `DomainError` mapping and the auth/lockout request pipeline (the equivalent of
  the Hono router's `authMiddleware`).
- `src/lib/auth.ts` — bearer parsing and token resolution, a port of
  `apps/server/src/server/auth.ts`.
- `src/lib/auth-lockout.ts` — the pre-auth failed-attempt lockout, a port of
  `apps/server/src/server/rate-limit.ts`'s `AuthLockout`.
- `src/lib/validation.ts` — the request-body checks, transcribed from the
  router's `zod` schemas (zod is not a dependency of `apps/web`) including zod's
  exact message wording.
- `src/lib/services.ts` — the service wiring, the counterpart of
  `apps/server/src/server/bootstrap.ts` for the pieces these handlers call.

Every method a route does not declare is exported as the router's
`app.all('/*')` fallback, so an undeclared method on a declared path answers
`{ ok: false, code: 'not_found', path }` instead of Next's 405.

## Disclosed divergences

These are the only known behavioural differences from the Hono router, and each
one is a limit of the Next runtime or of this slice's scope:

- **Lockout identity.** `apps/server` keys the lockout on the socket's remote
  address; a Next route handler cannot reach it. The first `x-forwarded-for`
  hop is used instead, and a direct loopback request (no such header) shares a
  single `'unknown'` bucket. The lockout state itself is also per-process, so
  the two servers do not share counters.
- **Unhandled errors.** An unexpected (non-`DomainError`) failure inside an
  auth path, or inside `memory/recall`'s service call, answers this surface's
  JSON `internal_error` body with a 500, where the Hono app's default handler
  answers a plain-text 500. (`memory/recall` is the one handler the router
  leaves un-wrapped; every other handler there already funnels through the
  same `DomainError`-or-500 mapping this surface uses.)
- **Undeclared subpaths.** A path under `:slug/sessions|memory|debug` that
  matches no route answers `not_found` without consulting auth; the Hono
  router's path-pattern middleware returns 401 first for an unauthenticated
  caller. The eight declared routes are unaffected.
- **OAuth.** Only the access-token _lookup_ is ported (so `/api` accepts an
  OAuth-minted token exactly when the server would). The authorization-server
  endpoints are a later slice.
- **Background work.** This app wires no timers: no session reaper, no embedder
  drain worker and no admin-token bootstrap, because `apps/server` still owns
  those over the one shared database. The session-start consolidation sweep is
  wired (it is part of the create response's contract); the embedder behind
  `memory/recall`'s dense branch is loaded lazily on first use instead of at
  boot.
