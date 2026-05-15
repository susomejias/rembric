## 1. Source change

- [x] 1.1 Update `scopeFromContext` in `src/mcp/sessions-tools.ts` to accept `deps: Pick<SessionsToolDeps, 'router'>` and consult `deps.router.get(ctx.token.id, ctx.mcpSessionId)` when `ctx.project` is null and `ctx.requestedSlug` is null.
- [x] 1.2 Update all five call sites in `sessions-tools.ts` to pass `deps`: `handleSavePrompt`, `handleContext`, `handleTimeline`, `handleStats`, `handleCapturePassive`. (Proposal originally said eight; on inspection `handleSessionEnd`, `handleSessionSummary`, and `handleDoctor` do not call `scopeFromContext` — they work with session-ids and direct DB queries.)
- [x] 1.3 Run `pnpm run typecheck` and resolve any TypeScript errors. **Result**: clean.

## 2. Tests

- [x] 2.1 Add a regression test to `src/mcp/session-scope-resolution.test.ts` covering the path-less `/mcp` + `project.use` + `memory.context` flow. Asserts `scope === "project:<id>"` and that project-scoped memories appear in `recentMemories`.
- [x] 2.2 Negative test: empty router + path-less request → `scope === "global"`. Cross-token isolation also covered.
- [x] 2.3 Path-scoped + non-existent slug test: `ctx.requestedSlug` set, `ctx.project` null, leftover router entry exists → result is `"global"`, no leakage. Also covers `ctx.project` overriding a competing router entry.
- [x] 2.4 Coverage of the other affected tools: `memory.timeline`, `memory.stats`, `memory.save_prompt`, `memory.capture_passive`. All five tools that call `scopeFromContext` are exercised.

## 3. Release notes and docs

- [x] 3.1 Note the fix in the next `CHANGELOG.md` entry under "Fixed". **Handled by release-please at commit time**: the commit applying this change uses `fix(mcp):` prefix and release-please will produce the entry automatically.
- [x] 3.2 Update `CLAUDE.md` "Scope resolution" section to add `sessions-tools.ts::scopeFromContext` to the list of helpers that perform the precedence resolution.

## 4. Verification

- [x] 4.1 Run `pnpm test` and confirm all suites pass. **Result**: 33 test files, 287 tests, all green.
- [x] 4.2 Manual smoke: path-less `/mcp` + `project.use` + `memory.context` returns the pinned project's scope. **Confirmed end-to-end via the Claude Code plugin** in the smoke session that motivated this fix.
- [x] 4.3 The Claude Code plugin (`add-claude-code-plugin`) was re-tested with this fix. **Note**: with the plugin's stdio bridge now path-scoping the URL, the plugin itself no longer relies on the router-fallback path, but the fix is still required for any other MCP client (Codex, Cursor, custom integrations) that uses path-less `/mcp`.
