## 1. Schema (no migration — pivoted to global-unique id)

- [x] 1.1 ~~Add migration `0007_session_pk_composite.sql`~~ **PIVOTED**: keeping `sessions.id TEXT PRIMARY KEY` as today (cross-token collision detected at app layer instead of via composite PK; spares the `memory` table FK rebuild). No SQL migration in this change.
- [x] 1.2 ~~Update Drizzle schema for composite PK~~ **PIVOTED**: schema unchanged.
- [x] 1.3 ~~Add composite FK on memory~~ **PIVOTED**: existing FK `memory.session_id REFERENCES sessions(id)` remains valid.
- [x] 1.4 ~~Composite PK invariant test~~ **PIVOTED**: collision rejection covered by the service-layer unit test in 2.6.
- [x] 1.5 ~~`pnpm db:check`~~ **PIVOTED**: no schema drift introduced.

## 2. Service-layer changes

- [x] 2.1 ~~Extend `StartSessionInput` with optional `id?`~~ **PIVOTED**: added a new method `AgentSessionsService.ensure({id,...})` instead of changing `start()`. Avoids breaking ~16 existing callsites; cleaner separation between server-minted (start) and client-provided (ensure) paths.
- [x] 2.2 Implemented id validation against `^[A-Za-z0-9_-]{8,128}$` inside `ensure()`; rejects with `DomainError('invalid_input', ...)`.
- [x] 2.3 Lookup-then-insert in `ensure()`: SELECT by id; same token → return existing `{created:false}`; different token → throw `DomainError('id_collision', ...)`; not found → INSERT. (See pivot note in design.md decision 2.)
- [x] 2.4 `start()` (ULID minting) preserved unchanged for back-compat.
- [x] 2.5 ~~Update `handleSessionStart`~~ **NOT NEEDED**: `start()` signature is unchanged; the MCP tool path is untouched.
- [x] 2.6 Service tests added covering: fresh insert with id, idempotent same-token, cross-token id_collision, regex rejection (`x`, spaces, newlines, 129 chars, empty), and UUID/ULID/prefixed-id acceptance. All passing.

## 3. HTTP API router

- [x] 3.1 Created `src/server/api-router.ts` with `createApiRouter(deps)` returning `Hono<ApiEnv>`.
- [x] 3.2 `POST /:slug/sessions` calls `agentSessions.ensure({id, ...})`, validates id regex via Zod, returns `{ok, sessionId, scope, projectId, startedAt, created}`.
- [x] 3.3 `POST /:slug/sessions/:id/summary` validates `summary: z.string().min(1).max(20_000)`, blocks soft-deleted via shared `rejectIfDeleted` helper, returns `{ok, sessionId, endedAt}`.
- [x] 3.4 `POST /:slug/sessions/:id/end` no body, blocks soft-deleted, returns `{ok, sessionId, endedAt}`.
- [x] 3.5 Domain-error → HTTP status mapping centralized in `statusForCode()` (invalid*input→400, token*\*→401, forbidden/archived→403, not_found→404, already_ended/deleted/id_collision→409, internal→500).
- [x] 3.6 Path-less `/sessions` hits the catch-all and returns 404 `not_found`.
- [x] 3.7 Wired in `src/server/http.ts` between `/dashboard` and `/admin` via `honoApp.route('/api', createApiRouter(...))`. `startHttpServer` now takes `agentSessions` in opts (also wired in `bootstrap.ts`).
- [x] 3.8 E2E tests at `src/server/api-router.test.ts` — 18 scenarios covering auth (401/404/403), POST /sessions (create/idempotent/collision/malformed), summary (success/empty/not-found/wrong-token/already-ended/deleted), and end (success/double-end). All passing.
- [x] 3.9 Rate limiter is currently MCP-specific (`opts.rateLimiter` inside `handleMcpRequest`). Decision: leave it MCP-only for this change — the `/api/*` surface is low-volume (one call per session lifecycle event) and behind the same auth. Lifting it to shared Hono middleware is a follow-up if observability flags abuse.

## 4. Memory→session fallback resolution

- [x] 4.1 ~~Add `findMostRecentActive`~~ **REUSED**: `AgentSessionsService.findActiveForTransport({tokenId, projectId})` already existed and does exactly this. Wired into the fallback chain.
- [x] 4.2 Added `resolveActiveSessionId(deps, projectId)` helper in `src/mcp/tools.ts`. Precedence: (1) SessionRouter entry for `(tokenId, mcpSessionId)`, (2) `agentSessions.findActiveForTransport({tokenId, projectId})`, (3) null. Called from `handleSave` to thread `sessionId` into `SaveMemoryInput`.
- [x] 4.3 Test: `memory.save` after `agentSessions.ensure({id: 'sess-http-created-1', ...})` attaches `session_id = 'sess-http-created-1'`. Passing.
- [x] 4.4 Test: two active sessions under same `(token, project)` → save attaches to the more recent one (`sess-newer`). Plus a precedence test confirming SessionRouter overrides the DB fallback. All passing.

## 5. Plugin scripts

- [x] 5.1 Created `plugin/scripts/_api.sh` exposing `rembric_post`, `rembric_read_project_slug`, `rembric_session_id_from_stdin_json`, `rembric_cwd_from_stdin_json`, `rembric_json_escape`. Bash builtins for parsing (no jq dep); curl for the POST.
- [x] 5.2 Rewrote `plugin/scripts/session-start.sh`: reads `session_id` + `cwd` from stdin JSON, resolves slug from `.rembric`, POSTs `/api/<slug>/sessions`, then emits the existing nudge. 25 LOC excl. helper, with `trap 'exit 0' ERR`. Smoke-tested against `<repo>` (slug `rembric`).
- [x] 5.3 Created `plugin/scripts/pre-compact.sh`: reads stdin, POSTs the literal stdin payload as summary (truncated at 19_500 chars to stay under the server's 20k limit). No stdout.
- [x] 5.4 Created `plugin/scripts/session-stop.sh`: reads stdin, POSTs `/api/<slug>/sessions/<id>/end {}`. No stdout. Designed for `async: true`.
- [x] 5.5 Deleted `post-compact.sh`, `pre-compact-codex.sh`, `stop-codex.sh`.
- [x] 5.6 All new scripts are mode 755. (Shellcheck not in this repo's lint chain; manual review for `set -u`, `trap 'exit 0' ERR`, and POSIX-bash compatibility passed.)

## 6. Hook manifests

- [x] 6.1 `plugin/hooks/hooks.json` updated: PostCompact removed; PreCompact now `type: command` → `pre-compact.sh`; new `Stop` entry with `async: true` → `session-stop.sh`.
- [x] 6.2 `plugin/hooks/hooks.codex.json` updated: SessionStart/PreCompact/Stop all point at the SHARED scripts (`session-start.sh`, `pre-compact.sh`, `session-stop.sh`). No codex-specific scripts left.
- [x] 6.3 `git ls-files plugin/` after this change shows ONE copy of each shared script (the deleted codex-specific files will drop from the index on commit).

## 7. Spec sync and docs

- [x] 7.1 `openspec validate add-http-session-lifecycle --strict` passes.
- [x] 7.2 `plugin/README.md` updated: hook catalog reflects new HTTP-driven lifecycle; token-budget table replaces PostCompact with Stop.
- [x] 7.3 `CLAUDE.md` plugin development section gains a "Session lifecycle: HTTP, not MCP" subsection and updated per-client divergence rule.
- [x] 7.4 `docs/agents.md` Codex section updated to reflect that all four hooks share scripts and POST to `/api/...` directly; manual `config.toml` fallback note updated accordingly.

## 8. Smoke tests on real clients

- [ ] 8.1 Manual (deferred to user): install the plugin against a live Rembric dev server, open a Claude Code session in this repo, verify `/dashboard/sessions` shows the session within seconds of opening
- [ ] 8.2 Manual (deferred to user): trigger compaction (or simulate by running `pre-compact.sh` with a fixture stdin), verify the session row gets a non-null `summary` and `status='ended'`
- [ ] 8.3 Manual (deferred to user): close the Claude Code window, verify the session row transitions to `status='ended'` via the `Stop` hook (if no prior summary, `summary` remains null)
- [ ] 8.4 Manual (deferred to user): same matrix for Codex CLI
- [ ] 8.5 Manual (deferred to user): run the plugin against a stopped Rembric server, verify Claude Code starts cleanly and no error is shown to the user (only stderr diagnostics)

## 9. Archive

- [x] 9.1 `pnpm test` (314/314 passing), `pnpm typecheck` (clean), `pnpm lint` (clean).
- [x] 9.2 `plugin/CHANGELOG.md` entry added under `[0.2.0] — unreleased` describing the HTTP-driven lifecycle, PreCompact rework, PostCompact removal, and new Stop hook.
- [ ] 9.3 After merge, run `/opsx:archive add-http-session-lifecycle` to move the change to `openspec/changes/archive/`
