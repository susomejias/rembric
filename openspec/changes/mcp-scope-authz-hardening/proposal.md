## Why

An audit of the MCP surface found three scope/authorization holes. Each contradicts a load-bearing invariant (scope enforced at the service layer; cross-scope reads return `not_found`) or the read/write authorization contract, and all three are reachable by an ordinary token today.

1. **`memory.compare` is classified `read` but performs writes.** The `mcp-api` spec's authorization requirement lists `memory.compare` under the _read_ classification, and `handleCompare` (`apps/server/src/mcp/relations-tools.ts:269`) accordingly calls `requireScope(deps, 'read')`. But `RelationsService.compareInScope` (`apps/server/src/services/relations.ts:238-267`) **always inserts a `memory_relations` row with `status='judged'`** and, for `relation='supersedes'`, runs `applySupersedesSideEffect` → `markSuperseded(targetId)`, flipping a memory's `status` to `superseded` and appending to the source's `replaces[]`. `memory.compare` is even registered with `IDEMPOTENT_WRITE` behavioral annotations (`mcp/server.ts`). So a read-only token (`read:*` / `read:project:<id>`) can mutate memory lifecycle state and write judged relations. `memory.judge`, the analogous verb, correctly requires `write`.

2. **An explicit `sessionId` on write-attaching tools is never validated.** `resolveActiveSessionId` (`apps/server/src/mcp/memory-tools.ts:421`) and `resolveSessionId` (`apps/server/src/mcp/_shared.ts:118`) both short-circuit with `if (explicit) return explicit;` — no ownership check, no project match, no soft-delete check. The schema is a bare `z.string().min(1)`. `memory.session_id` has no foreign key, so any string sticks. A caller can therefore attach its saved memory (or prompt / passive capture) to **another token's or another project's** session id (session ids are host UUIDs, not secrets), forging attribution — and model-hallucinated ids silently create dangling attachments, the exact failure the `sessionId` reinforcement clause warns against.

3. **`memory.timeline` neighbors are selected with no scope filter.** `MemoryRepository.sessionNeighbors` (`apps/server/src/db/repositories/memory-repository.ts:132-151`) filters **only** by `session_id`. The target memory passes the scope gate, but its session's other memories are returned with full `content` regardless of their `(scope, project_id)`. Because a single session can legitimately hold memories in different scopes (an unscoped `/mcp` connection can save one global memory and one project memory in the same session), and because hole #2 lets a foreign session id be attached, `memory.timeline` can return another scope's memory content — defeating the "cross-scope reads return `not_found`" invariant.

## What Changes

- **Reclassify `memory.compare` as a WRITE.** `handleCompare` requires `write`; the authorization-classification requirement moves `memory.compare` from the read list to the write list. Read-only tokens calling it are rejected with `forbidden` before any row is written.
- **Validate an explicit `sessionId` on the five write-attaching tools** (`memory.save`, `memory.save_prompt`, `memory.capture_passive`, `memory.session_summary`, `memory.session_end` — the tools covered by the `sessionId`-override requirement). When a `sessionId` is supplied, the server resolves the row and requires it to be owned by the caller's token, to belong to the caller's effective project, and to not be soft-deleted; otherwise the call is rejected (`session_not_found`, masking to avoid cross-token/cross-project existence disclosure, matching the session-lifecycle tools' existing contract). The transport/active-session fallback paths are unchanged.
- **Scope-filter `memory.timeline` neighbors.** `sessionNeighbors` takes the connection's effective scope and adds the `(scope, project_id)` predicate, so timeline never crosses a scope boundary even when a session spans scopes.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `mcp-api`:
  - The authorization-by-scope requirement reclassifies `memory.compare` as a write.
  - The "tools that attach a write to a session accept an explicit `sessionId` override" requirement now mandates validation of that override (ownership, project, soft-delete) before it is honored.
  - The `memory.timeline` neighbor contract is amended so session neighbors are filtered by the connection's effective scope.

## Impact

- **Touched paths (implementation)**: `apps/server/src/mcp/relations-tools.ts` (compare → write), `apps/server/src/mcp/memory-tools.ts` + `apps/server/src/mcp/_shared.ts` (validate explicit `sessionId`), `apps/server/src/db/repositories/memory-repository.ts` (`sessionNeighbors` scope clause) and its caller in `apps/server/src/services/memory.ts` (thread the scope through). No schema migration — no new column, no wire-shape change.
- **Behavioral change (intended)**: read-only tokens can no longer call `memory.compare`; an explicit `sessionId` that is foreign, cross-project, or soft-deleted is now rejected instead of silently honored; `memory.timeline` no longer returns cross-scope neighbors.
- **Back-compat**: the common path (no explicit `sessionId`, or the caller's own current session id) is unaffected; full-access (`*`) tokens calling `memory.compare` are unaffected.
- **Invariants**: reinforces "scope enforced at the service layer" and "cross-scope reads return `not_found`"; append-only memory is untouched (compare still only appends relations + flips `status`, now correctly gated).
- **Validation**: unit/authorization tests for compare-as-write (a `read:*` token is rejected); tests for the three `sessionId` rejection cases (foreign token, cross-project, soft-deleted) across the write-attaching tools; a `memory.timeline` cross-scope-neighbor test (target in project A, a same-session memory in global/project B is NOT returned). Plus the mandatory local e2e against `pnpm run dev:docker:up`.
