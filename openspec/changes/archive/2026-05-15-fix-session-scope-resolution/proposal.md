## Why

`CLAUDE.md` documents an invariant for MCP tool scope resolution:

> Tools that need the effective project must consult BOTH sources. Precedence: `ctx.project` first, then `SessionRouter.get(...).projectId`.

This invariant is correctly implemented in `tools.ts` via `resolveEffectiveProject` (used by `memory.save`, `memory.search`, `memory.get`, `memory.confirm`) and inline in `handleSessionStart`. But `sessions-tools.ts` exposes a helper `scopeFromContext()` that **only consults `ctx.project`** and does not consult the router. Every session-tool handler that calls `scopeFromContext()` therefore violates the invariant:

- `memory.context`
- `memory.timeline`
- `memory.stats`
- `memory.doctor`
- `memory.save_prompt`
- `memory.session_end`
- `memory.session_summary`
- `memory.capture_passive`

Observed symptom (smoke-tested while bringing up the Claude Code plugin): an agent connecting over path-less `/mcp` calls `project.use({slug, create: true})` to pin a project. The call succeeds (`projectId` returned, `created: false` because the project already existed). Immediately afterwards `memory.context` returns `scope: "global"` with empty recent rows, even though `memory.search` for the same token+session correctly returns the project's memories. The agent and the user have no way to know the session-tool surface is silently scoped wrong.

This is a real correctness bug, independent of the plugin: any MCP client (Codex, Cursor, custom integrations) that uses path-less `/mcp` + `project.use` + a session-tool will hit it.

## What Changes

A single surgical fix to `src/mcp/sessions-tools.ts`:

- `scopeFromContext()` accepts a `deps` parameter exposing the `SessionRouter`.
- When `ctx.project` is null and `ctx.requestedSlug` is null (path-less `/mcp`), it consults `deps.router.get(ctx.token.id, ctx.mcpSessionId)` and returns the project scope if a router entry exists.
- All eight call sites pass the existing `deps` argument they already hold via `.bind(null, deps)`.
- A new regression test covers the path-less + `project.use` + `memory.context` flow, asserting that `memory.context` returns the pinned project's scope.

Out of scope:

- Changing `resolveEffectiveProject` in `tools.ts` (already correct).
- Changing `handleSessionStart`'s inline resolution (already correct).
- Changing `project-tools.ts` (`project.current`, `project.use`) — already correct.
- Changing the on-the-wire response shape of any tool. `memory.context` etc. still return `scope: "project:<id>"` or `scope: "global"`; the value is just resolved correctly now.
- Roots discovery behavior. The fix does not alter how slugs are derived from URIs; it only ensures that whatever the router resolves is honored by session tools.

## Capabilities

### Modified Capabilities

- `sessions`: session-tool handlers (`memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.save_prompt`, `memory.session_end`, `memory.session_summary`, `memory.capture_passive`) MUST honor the documented scope-resolution precedence, including the router fallback for path-less `/mcp` connections.

### New Capabilities

None.

## Impact

- **Server source change**: ~20 LOC across `src/mcp/sessions-tools.ts` (update `scopeFromContext()` signature, update 8 call sites). No public API changes; the wire contract is unchanged.
- **New invariant test** under `src/mcp/__tests__/invariants/` (or alongside `sessions-tools.test.ts`) that locks in the router-fallback behavior so future refactors do not regress.
- **No migrations, no schema changes**, no impact on persistence or consolidation.
- **Unblocks the Claude Code plugin** (`add-claude-code-plugin`): without this fix, the plugin's `/rembric:context`, `/rembric:summary`, and the `PreCompact` `memory.session_summary` hook silently operate on global scope even when `project.use` has been called.
- **Improves correctness for any external MCP client** that uses the same flow, regardless of the plugin.
