## Why

`plugin.ts` exports only `RembricPlugin` — the V1 shape, an async function returning `{ config, event, 'chat.message', 'experimental.session.compacting' }`.

opencode 2.x resolves a **default** export carrying `{ id, setup }` and drives it through its `ctx` domains. A module whose only export is a V1 function registers nothing, silently: the MCP tool surface keeps answering, so the memory system looks healthy while no session is ever captured.

Measured on opencode 2.0.23 with the published plugin installed: the plugin never appears in `GET /api/plugin`, and no session row is created for the project. 2.x does **not** invoke named exports, so the V1 export is inert rather than harmful there.

The shared core is harness-agnostic and needs no change.

## What Changes

- **Add a default export** — `{ id: 'rembric.lifecycle', setup }` on the same `createSessionProtocol` core. `RembricPlugin` and every V1 hook stay as they are. The V2 object is not a named export, because 1.x invokes every named export as a plugin function and a V2 object reached that way dereferences `ctx.location`.
- **Map the lifecycle onto 2.x.** Prompts arrive through `ctx.session.hook('prompt')`; tool use through `ctx.tool.hook('execute.before')`; `session.created`, `session.deleted`, `session.compaction.ended`, `session.idle` and `session.execution.succeeded` through `ctx.event.subscribe()`.
- **Deliver nudges as transient system text.** 2.x has no user-message part array, so recall and session-opening nudges ride the `context` hook's `system` array and never enter the persisted turn.
- **Cache the injected block per session.** A 2.x system part lives for exactly one model request, so the block is re-pushed on every request, rebuilt from the server on a cache miss, and dropped on `session.compaction.ended`.
- **Capture the assistant transcript from `session.text.ended`**, which carries `{ sessionID, assistantMessageID, ordinal, text }`. 2.x does not deliver assistant text as message parts.
- **Scope events and requests to the plugin's directory.** 2.x events carry no project scope, and the check is applied on the `context` hook as well as on `session.created` — otherwise a foreign session receives injected context.
- **Wire the plugin suite into CI.** No `include` pattern matched `apps/plugin/.opencode-plugin/*.test.ts`, so its tests — 69 before this change — never ran.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-plugin`: ADDED requirement "The plugin module SHALL also export an opencode 2.x default plugin" — the default-export shape, the hook mapping, the transient-system-text rule, the per-session cache with rehydration and compaction invalidation, the `session.text.ended` assistant capture, and directory scoping on both the event and request paths.

## Impact

- `apps/plugin/.opencode-plugin/plugin.ts` — a V2 section and `export default`; the V1 export and the header invariants are untouched.
- `apps/plugin/.opencode-plugin/plugin.test.ts` — a V2 `describe` block.
- `apps/plugin/.opencode-plugin/README.md` — documents the two entry points.
- `apps/web/vitest.config.ts` — adds the `.opencode-plugin` include pattern.
- No dependency is added: the V2 types are declared structurally, as the V1 types already are, so `@opencode/plugin` stays out of the repository's dependencies.
- No migration and no schema change. A 2.x host that loaded nothing starts capturing sessions once the plugin file is refreshed; a 1.x host is unchanged.
