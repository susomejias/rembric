## Context

Rembric's MCP surface resolves the active project from three sources, in order of precedence (documented in `CLAUDE.md`):

1. `ctx.project` — populated when the connection is path-scoped (`/mcp/<slug>`).
2. `SessionRouter.get(tokenId, mcpSessionId).projectId` — populated by `project.use` or by roots-based discovery for path-less connections.
3. Global scope, when neither source resolves a project.

This precedence is implemented in three places:

- `src/mcp/tools.ts::resolveEffectiveProject(deps)` — used by `memory.{save,search,get,confirm}`.
- `src/mcp/sessions-tools.ts::handleSessionStart` (inline) — used by `memory.session_start`.
- `src/mcp/project-tools.ts::handleCurrent` (inline) — used by `project.current`.

It is silently missing from a fourth place: `src/mcp/sessions-tools.ts::scopeFromContext()`, which is the helper used by every other session-tool handler.

### Current implementation

```ts
function scopeFromContext(): Scope {
  const ctx = getRequestContext();
  return ctx.project ? projectScope(ctx.project.id) : SCOPE_GLOBAL;
}
```

It checks `ctx.project` and falls through to `SCOPE_GLOBAL`. For path-less `/mcp` connections, `ctx.project` is always null — so every session-tool handler returns global scope regardless of what `project.use` wrote to the router.

### Observed failure

```
Agent over path-less /mcp:
  → project.use({slug: 'rembric', create: true})
      ← { projectId: '01KRM…', created: false, switched: false }   ✓ pinned
  → memory.context()
      ← { scope: 'global', recentMemories: [] }                    ✗ should be project:01KRM…
```

`memory.search` for the same session returns the project's memories correctly because it goes through `resolveEffectiveProject`, which consults the router. Only the session-tool surface is broken.

### Affected tools

Every handler in `sessions-tools.ts` that calls `scopeFromContext()`:

| Tool                     | Call site                      |
| ------------------------ | ------------------------------ |
| `memory.context`         | `handleContext` (line ~319)    |
| `memory.timeline`        | `handleTimeline` (line ~401)   |
| `memory.stats`           | `handleStats` (line ~490)      |
| `memory.doctor`          | `handleDoctor` (line ~523)     |
| `memory.save_prompt`     | `handleSavePrompt` (line ~120) |
| `memory.session_end`     | indirectly via summary path    |
| `memory.session_summary` | indirectly via summary path    |
| `memory.capture_passive` | direct call                    |

Each handler already has `deps` in scope (via `.bind(null, deps)` from `buildSessionsHandlers`), so passing `deps` to `scopeFromContext` is a no-op refactor at the call sites.

## Design

### The fix

```ts
function scopeFromContext(deps: Pick<SessionsToolDeps, 'router'>): Scope {
  const ctx = getRequestContext();
  if (ctx.project) return projectScope(ctx.project.id);

  // Path-scoped connections: ctx.requestedSlug is set and ctx.project would
  // have been resolved during auth if the slug pointed to an existing
  // project. If it's set but project is null, the slug doesn't exist —
  // return global rather than silently switching to whatever the router
  // might have. This matches resolveEffectiveProject in tools.ts.
  if (ctx.requestedSlug !== null) return SCOPE_GLOBAL;

  // Path-less /mcp: fall back to the router. This is the missing branch.
  if (ctx.mcpSessionId) {
    const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
    if (entry?.projectId) return projectScope(entry.projectId);
  }
  return SCOPE_GLOBAL;
}
```

Call sites change from `scopeFromContext()` to `scopeFromContext(deps)`. The `deps` argument is already passed to each handler via `.bind(null, deps)`, so no signatures further up the chain change.

### Why not factor `resolveEffectiveProject` into a shared module?

`resolveEffectiveProject` is async and runs `ensureRootsDiscoveryRun` before consulting the router. That makes sense for the tools in `tools.ts` because they are the entry point for memory operations and discovery should fire there if it hasn't already.

For session-tool handlers, by the time any of them is called, either:

- The connection is path-scoped → `ctx.project` set, no router lookup needed.
- A `project.use` call has already populated the router → the fallback below picks it up.
- Roots discovery has already fired from `handleSessionStart` or any earlier `memory.{save,search,get,confirm}` call → the router is populated.
- None of the above → the router is empty, global scope is correct.

Triggering another discovery pass from each session-tool call would (a) be redundant, (b) add latency to a hot path, (c) make the helper async and force every call site to `await`. The simpler synchronous router-only fallback covers every case session tools see in practice.

If a future change moves more discovery-aware logic into session tools, factoring `resolveEffectiveProject` into a shared helper is the right move at that time.

### Test plan

Add an invariant-style test alongside the existing `sessions-tools.test.ts` (or under `src/mcp/__tests__/invariants/`):

```ts
it('memory.context honors router-pinned project on path-less /mcp', async () => {
  // 1. Set up a token, a project 'foo', a memory in 'foo' scope.
  // 2. Open a path-less request context (ctx.requestedSlug === null).
  // 3. Write {projectId: foo.id} to the router for (tokenId, mcpSessionId).
  // 4. Call memory.context.
  // 5. Assert scope === `project:${foo.id}` and the memory is in recentMemories.
});
```

A second test covers the negative case: empty router → global scope with no leakage from other tokens.

A third test covers the path-scoped + non-existent slug branch: `ctx.requestedSlug` set but `ctx.project` null → global, NOT falling through to a router entry that might exist from a previous session.

## Risks

- **Behavior change visible to clients.** Currently a client doing `project.use` + `memory.context` sees `scope: 'global'`. After the fix it will see `scope: 'project:<id>'` with the project's memories. This is a correctness improvement, not a breaking change — the prior behavior was a bug. No client should be depending on the broken behavior, but the change should be noted in the release notes.
- **No risk to path-scoped connections.** Those already resolve via `ctx.project` and the new branches don't execute.
- **No risk to roots discovery.** This change does not alter how slugs are derived or how `ensureRootsDiscoveryRun` fires.
