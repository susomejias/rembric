# Tasks — enforce-mcp-authorization

## 1. Shared gate primitives

- [x] 1.1 Move `resolveEffectiveProject` from `memory-tools.ts` to `_shared.ts` as `resolveEffectiveScope(deps)` returning `{ scope: Scope; project: { id; slug } | null }`, preserving the exact resolution order (ctx.project → path-slug short-circuit → `ensureRootsDiscoveryRun` → router). Re-export or adapt existing memory-tools callers; `pnpm vitest run apps/server/src/mcp/memory-tools.test.ts` stays green.
- [x] 1.2 Add `assertAuthorized(action: 'read' | 'write', scope: Scope): void` to `_shared.ts` reading `ctx.token.scope` and throwing `DomainError('forbidden', …)` via `isAuthorized`; add convenience `requireScope(deps, action): Promise<Scope>`.
- [x] 1.3 Delete `scopeFromContext` after all callers are migrated (tasks 2.x); grep confirms zero references.

## 2. Gate every handler

- [x] 2.1 `memory-tools.ts`: `handleContext`, `handleTimeline` use `requireScope(deps, 'read')`; save/search/get/confirm switch their existing `isAuthorized` calls to `assertAuthorized` (no behavior change — existing tests unchanged).
- [x] 2.2 `observability-tools.ts`: `handleStats`, `handleDoctor` → `requireScope('read')`; `handleCapturePassive` → `requireScope('write')` + `project_suggestion_pending` gate identical to `memory.save`.
- [x] 2.3 `prompt-tools.ts`: `handleSearchPrompts` → read; `handleSavePrompt` → write + suggestion gate.
- [x] 2.4 `session-tools.ts`: `handleSessionGet` → read; `handleSessionStart`/`handleSessionSummary`/`handleSessionEnd` → write; `handleSuggestTopicKey` → read.
- [x] 2.5 `project-tools.ts`: `project.use` asserts read on the REQUESTED project; `project.current` read; `project.list` filters rows to token-authorized projects (`*`/`read:*` all; `project:X`/`read:project:X` only X).
- [x] 2.6 `memory.about` untouched (exempt), documented in the handler with the one-line why.

## 3. judge/compare target scoping

- [x] 3.1 Add scope-parameterized lookups in `RelationsService` (service computes nothing itself from ctx; scope passed in): pending-judgment-by-id-in-scope and memory-pair-in-scope; SQL stays in `db/repositories/relations-repository.ts`.
- [x] 3.2 `handleJudge` (single + batch): `requireScope('write')`, resolve each judgment with that scope; out-of-scope → per-item `not_found` (batch) / call-level `not_found` (single).
- [x] 3.3 `handleCompare`: `requireScope('read')`, resolve both memories in scope; out-of-scope → `not_found`.

## 4. Tests

- [x] 4.1 Authorization-matrix unit tests in `apps/server/src/mcp/` covering: read token × each write tool → `forbidden`; `project:A` token × project-B read/write → `forbidden`; `read:project:A` on unscoped-global → `forbidden` then success after `project.use A`; `*` token → never `forbidden`.
- [x] 4.2 judge/compare cross-scope tests: pending judgment of project B judged from scope A → `not_found`, relation stays pending; compare across scopes → `not_found`.
- [x] 4.3 Integration test in `test/mcp-integration.test.ts`: first-call `memory.context` on an unscoped connection with discoverable root returns project scope (regression for the discovery race); `capture_passive` under `project_suggestion_pending` rejects.
- [x] 4.4 `project.list` filtering test per token scope.
- [x] 4.5 Full gate: `pnpm run typecheck && pnpm run lint && pnpm test` green.

## 5. Docs & spec hygiene

- [x] 5.1 Update tool descriptions in `mcp/server.ts` only where they promise ungated behavior (grep for "any token"); no description churn otherwise. (Grep found no such promises — no description churn needed.)
- [x] 5.2 `docs/agents.md`: token-provisioning table (which scope can call what; recommended scopes per client setup).
- [x] 5.3 `openspec validate enforce-mcp-authorization --strict` passes.
