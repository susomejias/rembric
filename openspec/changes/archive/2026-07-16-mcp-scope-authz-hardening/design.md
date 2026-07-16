## Context

Three independent findings, all on the MCP surface, all cheap to fix, all touching the scope/authz contract. They are bundled because they share the same review lens (scope enforcement) and the same test file surface (`authorization.test.ts`, session-scope-resolution tests, timeline tests). None requires a DB migration.

The relevant existing contracts:

- `mcp-api` "Every MCP tool call MUST be authorized against the token's scope" — the read/write classification lists.
- `mcp-api` "Tools that attach a write to a session MUST accept an explicit `sessionId` override" — precedence but no validation.
- `mcp-api` "The MCP server MUST expose three research tools" — the `memory.timeline` neighbor contract.
- `mcp-api` "Session-lifecycle MCP tools MUST reject soft-deleted sessions" and the cross-token scenario returning `session_not_found` — the precedent this change mirrors for the write-attaching tools.

## Goals / Non-Goals

**Goals**

- Gate `memory.compare` as the write it is.
- Make an explicit `sessionId` trustworthy: honored only when owned + in-project + live.
- Guarantee `memory.timeline` never crosses a scope boundary.

**Non-Goals**

- No change to the transport/active-session fallback resolution order.
- No new error codes beyond reusing `forbidden` / `session_not_found` / `session_deleted`.
- No change to `memory.compare`'s data effects (it still appends a judged relation and flips `status`); only its authorization action changes.
- Not touching the other audit findings (rate-limit parity on `/api`, transport lifecycle leaks, consolidation-undo convergence) — separate changes.

## Decisions

### Decision 1 — `memory.compare` is a WRITE; fix the spec classification, not just the code

`compareInScope` unconditionally writes (`insert(... status:'judged')`) and, for `supersedes`, mutates a memory's lifecycle. That is a write by every definition the codebase already uses (`memory.judge`, also a relation-writing verb, is `write`). The current `requireScope('read')` faithfully implements a **wrong spec line**, so the fix is a one-line code change _plus_ moving `memory.compare` from the read list to the write list in the authorization requirement. The scope-target-validation requirement ("`memory.judge` and `memory.compare` MUST validate their targets…", returning `not_found`) is unchanged — that is orthogonal to the read/write action and still applies.

Alternative considered: leave it read, arguing "it's idempotent". Rejected — idempotence is captured by the `IDEMPOTENT_WRITE` annotation; it does not make a lifecycle mutation safe for a `read:*` token.

### Decision 2 — Reject an invalid explicit `sessionId`, masking with `session_not_found`

When `sessionId` is supplied to a write-attaching tool, load the row via `AgentSessionsService.getById` and require: `row && row.tokenId === ctx.token.id && row.projectId === effectiveProjectId && !row.deletedAt`. On any failure, reject.

- **Reject vs. silently fall through.** Falling through (ignore a bad id, resolve via router/active) would keep forged attributions from landing but would silently mis-attribute to a _different_ session than the caller named — surprising, and it hides model hallucination. Rejecting surfaces the mistake. This mirrors the session-lifecycle tools, which already reject a foreign/soft-deleted `sessionId`.
- **Error code.** Use `session_not_found` for the foreign-token and cross-project cases (masking, so a caller cannot probe which session ids exist in other scopes — consistent with the existing cross-token scenario). Use `session_deleted` for a self-owned, in-project, soft-deleted row (consistent with the soft-deleted-session requirement). Project match is checked against the caller's already-resolved effective scope, so the check composes with path-scoping without a second resolver.
- **Scope of application.** The five tools named by the `sessionId`-override requirement. `memory.session_summary`/`memory.session_end` already run a cross-token check inside the service; this change makes `memory.save`/`memory.save_prompt`/`memory.capture_passive` — which attach via `resolveActiveSessionId`/`resolveSessionId` — do the same at the resolver, the single choke point, so both resolvers gain one validation branch rather than each tool.
- **Null projectId.** A global-scope save (`projectId === null`) requires the named session to also have `projectId === null`; a session belongs to exactly one scope, so this is the correct equality (both sides null).

### Decision 3 — Push the effective scope into `sessionNeighbors`

`sessionNeighbors` currently takes only `sessionId`. Add the caller's `MemoryScope` (the same value `MemoryService.search`/timeline already resolves) and AND a `(scope, project_id)` predicate onto the query, exactly as `windowNeighbors` (the time-window fallback) already does. `MemoryService`'s timeline method threads its resolved scope down; no new resolver call. This is defense-in-depth that becomes load-bearing the moment a session legitimately spans scopes (unscoped `/mcp`: one global + one project memory, same session) — so it is correct independent of Decision 2, and the two together close the leak from both ends.

Alternative considered: validate at write-time only (Decision 2) and trust single-scope sessions. Rejected — nothing enforces single-scope sessions (no FK, unscoped connections span scopes), so the read path must filter too.

## Risks / Trade-offs

- **A caller passing a stale-but-own ended session id.** An `ended` (not soft-deleted) session is still a valid attachment target (append-only allows memories after end); only `deleted_at` rejects. So the change does not break the resumed/ended-session flows.
- **Behavioral break for read-only tokens using `memory.compare`.** Intended and desirable; documented in the changelog. If any internal caller relied on it, it was a latent privilege bug.
- **Extra `getById` read per explicit-`sessionId` write.** One indexed point lookup on the single synchronous connection; negligible, and only when `sessionId` is explicitly passed.

## Migration Plan

Pure code + spec-delta change; no data migration, no version-carrier bump beyond the normal `server` release. Ship behind the standard test gates; no feature flag (the behavior changes are security fixes that should apply immediately).

## Open Questions

- Should `memory.timeline` additionally re-check each neighbor's `status` against the request (defense against derived-index drift)? Out of scope here; noted as a separate hardening opportunity in the audit.
