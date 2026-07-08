# Design — enforce-mcp-authorization

## Context

`isAuthorized(tokenScope, action, target)` exists in `apps/server/src/services/tokens.ts:185` and is correct, but only `memory.save`/`search`/`get`/`confirm` call it (`apps/server/src/mcp/memory-tools.ts:503,630,703,799`). `authenticate()` (`apps/server/src/server/auth.ts`) resolves any valid token for any `/mcp*` URL without cross-checking the slug, so per-tool checks are the ONLY isolation layer — and ~20 tools don't have one. Additionally, two scope resolvers coexist: the async `resolveEffectiveProject` (memory-tools; awaits roots discovery, honors the suggestion gate) and the sync `scopeFromContext` (`_shared.ts:27`; used by context/stats/prompt/session tools), which can mis-resolve to global at session start before discovery populates the router.

## Goals / Non-Goals

**Goals:**

- One authorization gate, applied by every tool handler, classified `read` | `write`.
- One scope resolution path (async, discovery-aware) for every scope-sensitive tool.
- `memory.judge`/`memory.compare` validate their targets against the connection's effective scope at the service layer.
- Existing path-scoping error contract preserved byte-for-byte (`scope_locked`, `project_required`, `project_not_found`, `project_suggestion_pending`).

**Non-Goals:**

- Connection-time slug↔token validation in `authenticate()` (per-tool enforcement is sufficient and keeps `/mcp` slug-less connections working; a connection-level check can't know the tool's action anyway).
- OAuth scope model changes (OAuth tokens already resolve to the same `TokenScope` shape).
- HTTP API (`api-router.ts`) authorization — already enforced there.
- Rate limiting / audit logging (separate concern).

## Decisions

### D1: Two composable primitives in `_shared.ts`, not a monolithic middleware

- `resolveEffectiveScope(deps): Promise<Scope>` — the generalized async resolver: `ctx.project` → path-slug short-circuit → `ensureRootsDiscoveryRun` + `SessionRouter`. This is today's `resolveEffectiveProject` (memory-tools.ts:386) moved to `_shared.ts` and returning a `Scope` (plus the project entity where handlers need slug/id).
- `assertAuthorized(action: 'read' | 'write', scope: Scope): void` — reads `ctx.token.scope`, calls `isAuthorized`, throws `DomainError('forbidden', 'token scope does not authorize this operation')`.
- Convenience `requireScope(deps, action): Promise<Scope>` = resolve + assert, used by handlers without a scope input param.

**Why not SDK-level middleware:** tools differ in how the _target_ scope is determined (`memory.save` takes a `scope` input; `judge` derives it from the stored relation). A middleware can authorize only the _connection_, not the _target_. Composable helpers let each handler authorize the actual target while sharing all machinery.

**Alternative considered:** wrapping `registerTool` with a declarative `{action}` option and auto-gating in the wrapper. Rejected: save/search/judge/compare need target-scope resolution inside the handler; a wrapper would double-resolve or under-authorize.

### D2: `scopeFromContext` is removed, not kept alongside

Every current caller migrates to the async resolver. Keeping the sync variant invites the next tool author to pick the wrong one. `_shared.ts` keeps only the async path. (The sync resolver's only "advantage" — no await — is worthless in async handlers.)

### D3: judge/compare validate targets via scoped service reads

`RelationsService` gains scope-aware lookups (scope passed as a parameter, per the scope-at-service-layer invariant). `handleJudge`/`handleCompare` first `requireScope(deps, 'write' | 'read')`, then resolve the judgment/memories WITH that scope; a target outside the scope yields `DomainError('not_found')` — never `forbidden` — matching the existing cross-scope-read invariant (existence must not leak).

**Alternative considered:** comparing `assertSameScope` output against the connection scope inside the MCP handler. Rejected: scope checks belong in the service layer (grep-enforced invariant), and handlers shouldn't reconstruct scope tuples from raw rows.

### D4: Action classification table (pinned here, mirrored in the spec delta)

| Tool                                                                                                          | Action                                       | Target scope                       |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------- |
| memory.save, save_prompt, capture_passive, confirm, judge, session_start, session_summary, session_end        | write                                        | resolved (input-driven for save)   |
| memory.search, get, context, timeline, stats, doctor, search_prompts, suggest_topic_key, session_get, compare | read                                         | resolved (input-driven for search) |
| project.use                                                                                                   | read (on the target project)                 | requested project                  |
| project.list                                                                                                  | read; result filtered to authorized projects | n/a (filtered)                     |
| project.current                                                                                               | read                                         | resolved                           |
| memory.about                                                                                                  | exempt (no data access, by spec)             | n/a                                |

### D5: Write tools on unscoped connections honor the suggestion gate

`capture_passive` and `save_prompt` currently bypass `project_suggestion_pending`. They adopt the same gate as `memory.save`: an unscoped connection with a pending project suggestion rejects the write until the agent confirms via `project.use`. This closes the silent-global-write hole with the same UX contract agents already know.

## Risks / Trade-offs

- [Risk] A legitimately-configured client with a narrow token starts receiving `forbidden` where calls used to succeed. → Mitigation: shipped plugins use `*` or matching `project:` tokens (verified in `docs/agents.md` setups); the error message names the required action+scope; CHANGELOG marks BREAKING.
- [Risk] Moving `resolveEffectiveProject` changes `memory.save` semantics accidentally. → Mitigation: move verbatim; the existing memory-tools tests (797 LOC) plus the path-scoping integration tests must pass unchanged.
- [Trade-off] `memory.stats`/`doctor` on an unscoped `/mcp` connection now require the token to cover GLOBAL scope (a `read:project:A` token gets `forbidden` until it path-scopes or `project.use`s A). → Accepted because succeeding with another scope's data is precisely the bug; the workaround (connect to `/mcp/<slug>`) is the documented path.
- [Risk] Roots discovery await on hot read tools adds latency at session start. → Mitigation: `ensureRootsDiscoveryRun` is memoized per (token, mcpSession); post-discovery calls are sync-fast.

## Migration Plan

No DB changes. Deploy = ship the image. Rollback = previous image. Token provisioning docs (`docs/agents.md`) gain a table of which scopes can call what.

## Open Questions

(none — all decisions pinned above)
