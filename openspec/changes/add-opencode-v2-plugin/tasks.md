## 1. Read the contract and record the baseline

- [x] 1.1 Read `openspec/specs/opencode-plugin/spec.md`, in particular "Plugin module exports a Plugin function", before touching code — the V2 entry point is an addition to it, not a replacement.
- [x] 1.2 Confirm the V2 shape against the published types: `@opencode/plugin`'s `Plugin` is `{ id, setup }`, and `SessionHooks` is exactly `{ prompt: SessionPrompt; context: SessionContext }`.
- [x] 1.3 Record the baseline: the V1 suite's test count before the change, and `GET /api/plugin` on a 2.x host showing no `rembric` entry.

## 2. V2 entry point

- [x] 2.1 Add the V2 section to `plugin.ts` with structural types only — no `@opencode/plugin` dependency.
- [x] 2.2 Register `ctx.session.hook('prompt')`, `ctx.session.hook('context')` and `ctx.tool.hook('execute.before')`, and subscribe to `ctx.event.subscribe()`.
- [x] 2.3 Cache the injected block per session, re-push it on every request, rehydrate on a miss, and drop it on `session.compaction.ended`.
- [x] 2.4 Filter `session.created` to `ctx.location.directory`, and mark sub-agent sessions from `parentID`.
- [x] 2.5 Export the V2 object as the default only. It MUST NOT be a named export.
- [x] 2.6 Return a cleanup function that aborts the event stream and flushes pending work.

## 3. Tests

- [x] 3.1 Assert the default export is the V2 plugin and `RembricPlugin` stays a named export.
- [x] 3.2 Assert the three hooks register, and that nothing registers when credentials or the slug are missing.
- [x] 3.3 Assert the block is injected as system text and re-pushed unchanged on the next request.
- [x] 3.4 Assert `session.compaction.ended` drops the cached block.
- [x] 3.5 Assert a session from another directory is ignored.
- [x] 3.6 Wire the suite into a vitest project — it was not wired: no `include` pattern matched `apps/plugin/.opencode-plugin/*.test.ts`, so neither these tests nor the 69 existing ones ran in CI. The pattern is added to `apps/web/vitest.config.ts`.
- [x] 3.7 Assert the assistant transcript is captured from `session.text.ended`, and that a session from another directory receives no injected context on the `context` hook either.

## 4. Docs

- [x] 4.1 Document both entry points in `apps/plugin/.opencode-plugin/README.md`, including which opencode major each serves.
