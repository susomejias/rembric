# Enforce token authorization uniformly across the MCP tool surface

## Why

`isAuthorized` (token-scope authorization) is enforced on only 4 of the ~24 MCP tools — `memory.save`, `memory.search`, `memory.get`, `memory.confirm` — while `authenticate()` accepts any valid token for any `/mcp` or `/mcp/<slug>` connection without checking that the token's scope covers the slug. The result is a real cross-scope authorization gap: a `read:project:A` token can call `memory.context`, `memory.timeline`, `memory.stats`, `memory.search_prompts`, or `memory.session_get` against project B (read leak), and can WRITE via `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, and `memory.judge` (which can even supersede memories). `memory.judge`/`memory.compare` additionally never validate that the judgment or memories belong to the connection's effective scope. The `auth` spec already states "The MCP middleware SHALL enforce these on every request" — the implementation does not honor that requirement today.

## What Changes

- **NEW** central authorization gate in `apps/server/src/mcp/`: one async helper that (1) resolves the connection's effective scope (path slug → roots discovery → `SessionRouter`, i.e. the semantics of today's `resolveEffectiveProject`) and (2) checks `isAuthorized(tokenScope, action, resolvedScope)`, throwing `DomainError('forbidden')` on failure. Every tool handler declares its action (`read` | `write`) and goes through the gate.
- **MODIFIED** all previously-ungated handlers now enforce authorization: `memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.search_prompts`, `memory.save_prompt`, `memory.capture_passive`, `memory.suggest_topic_key`, `memory.compare`, `memory.judge`, `memory.session_start`, `memory.session_get`, `memory.session_summary`, `memory.session_end`, `project.use`, `project.list`, `project.current`. (`memory.about` stays exempt: no data access by spec.)
- **MODIFIED** `memory.judge` / `memory.compare` resolve the target judgment/memories and reject with `not_found` when they fall outside the connection's effective scope (consistent with the existing cross-scope-read invariant: out-of-scope ids never leak existence), in addition to the `write`/`read` authorization check.
- **MODIFIED** `project.list` filters its result to the projects the token can read: `*`/`read:*` see all; `project:<id>`/`read:project:<id>` see only that project.
- **BREAKING** (behavioral, security-tightening): tool calls that previously succeeded with an insufficient token now fail with `forbidden`. A `read:*`/`read:project:` token can no longer write via the ungated tools; a `project:A`-restricted token can no longer read or write outside A. Correctly-scoped clients (the shipped plugins use `*` or matching `project:` tokens) are unaffected.
- Side effect of gate unification: the previously-sync-resolved read tools (`memory.context`, `memory.stats`, `memory.search_prompts`, `memory.timeline`, `memory.capture_passive`, `memory.save_prompt`) now resolve scope through the same async, roots-discovery-aware path as `memory.save`/`memory.search`, fixing the session-start race where `memory.context` on an unscoped `/mcp` connection returned GLOBAL context before roots discovery had populated the router, and write tools honor the same `project_suggestion_pending` gate as `memory.save`.

## Capabilities

### New Capabilities

(none — this actualizes requirements that already exist in `auth` and tightens `mcp-api`)

### Modified Capabilities

- `mcp-api`: adds a cross-cutting authorization requirement (every tool classified `read`/`write`, enforced against the resolved effective scope); modifies the `memory.doctor`/`memory.stats` read-only-token scenario to be scope-aware; adds judge/compare connection-scope requirements; adds the scope-resolution-parity requirement (async resolver + suggestion gate for all scope-sensitive tools).
- `auth`: the existing "MCP middleware SHALL enforce these on every request" requirement gains scenarios that pin per-tool enforcement semantics (read vs write actions, resolved-scope target, `forbidden` error code).

## Impact

- `apps/server/src/mcp/_shared.ts` — new `requireScopeAuthorized(deps, action)` helper (subsumes `scopeFromContext` for scope-sensitive tools); `scopeFromContext` retained only where a sync non-authorizing read is still correct (or removed if no callers remain).
- `apps/server/src/mcp/memory-tools.ts` — `resolveEffectiveProject` generalized/moved so all tool modules can use it; save/search/get/confirm switch to the shared gate (no behavior change for them).
- `apps/server/src/mcp/observability-tools.ts`, `prompt-tools.ts`, `session-tools.ts`, `relations-tools.ts`, `project-tools.ts` — every handler calls the gate; judge/compare add scope resolution of their targets.
- `apps/server/src/services/relations.ts` — scoped lookup support for judge/compare target validation (service-layer scope enforcement, per invariant).
- Tests: `apps/server/src/mcp/*.test.ts`, `apps/server/src/test/mcp-integration.test.ts` — new authorization matrix cases (read token × write tool, project token × foreign project, unscoped connection × project-restricted token).
- Specs: `openspec/specs/mcp-api/spec.md`, `openspec/specs/auth/spec.md`.
- Invariants touched: **scope enforced at the service layer** (strengthened, not violated); path-scoping contract unchanged (`scope_locked`, `project_required` behavior preserved).
