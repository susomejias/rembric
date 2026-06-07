## 1. Code rename (MCP layer only)

- [x] 1.1 `apps/server/src/mcp/sessions-tools.ts`: rename `getSessionSchema` → `sessionGetSchema`, `handleGetSession` → `handleSessionGet`, and the `buildSessionsHandlers` key `getSession` → `sessionGet`. Do NOT touch any `getSession(c: Context)` (that symbol lives only in `src/dashboard/*`, not this file).
- [x] 1.2 `apps/server/src/mcp/server.ts`: change the registered tool name string `'memory.get_session'` → `'memory.session_get'`; update the import `getSessionSchema` → `sessionGetSchema`, `inputSchema: sessionGetSchema`, and the handler ref `sessions.getSession` → `sessions.sessionGet`.

## 2. Tests

- [x] 2.1 `apps/server/src/test/mcp-integration.test.ts`: replace every `name: 'memory.get_session'` with `'memory.session_get'` (4 call sites) and update the `it(...)` titles / comments that say `get_session`.

## 3. Spec & doc-comments

- [ ] 3.1 (Synced at archive) `openspec/specs/sessions/spec.md` — the REMOVED+ADDED delta renames the requirement to `memory.session_get`.
- [x] 3.2 `apps/server/src/db/migrations/0012_drop_summary_length_check.sql` and `apps/server/src/db/schema/agent-sessions.ts`: update the doc-comment references `memory.get_session` → `memory.session_get`.

## 4. Docs

- [x] 4.1 `README.md`: the tool-box row `memory.get_session` → `memory.session_get` (both 18 chars — confirm the line stays length 76 / box aligned).
- [x] 4.2 `docs/agents.md`: the _Reading prior context_ section reference `memory.get_session({ sessionId })` → `memory.session_get({ sessionId })`.
- [x] 4.3 `openspec/changes/archive/2026-06-07-rich-session-summaries-for-handoff/{proposal,design,specs/sessions/spec,tasks}.md`: realign `memory.get_session` / `get_session` → `memory.session_get` / `session_get` for record consistency. Do NOT edit `apps/server/CHANGELOG.md` (0.21.7 is historical).

## 5. Verification

- [x] 5.1 `grep -rn "get_session" apps openspec README.md docs` returns ZERO matches except the historical `apps/server/CHANGELOG.md`; and `grep -rn "getSession" apps/server/src/dashboard` is UNCHANGED (the cookie-session resolver was not touched).
- [x] 5.2 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 5.3 `pnpm test` (full suite) green — especially `mcp-integration.test.ts` (`memory.session_get` happy path + cross-scope/soft-deleted `not_found`).
- [x] 5.4 `pnpm run build` succeeds.
- [x] 5.5 `openspec validate rename-session-get-tool --strict` passes.
