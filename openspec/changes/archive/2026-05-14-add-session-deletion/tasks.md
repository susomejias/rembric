## 1. Schema + service

- [x] 1.1 Author `src/db/migrations/0006_session_deleted_at.sql` adding `ALTER TABLE agent_sessions ADD COLUMN deleted_at INTEGER;`
- [x] 1.2 Extend `src/db/schema/agent-sessions.ts` with `deletedAt: integer('deleted_at', { mode: 'timestamp_ms' })` (nullable)
- [x] 1.3 In `src/services/agent-sessions.ts`, add `softDelete(sessionId, {tokenId?, adminBypass?})` and `undelete(sessionId, {adminBypass?})`; `softDelete` MUST be idempotent (return the existing row when `deleted_at` is already set) and MUST enforce the cross-token rule when `adminBypass` is not set
- [x] 1.4 In `src/services/agent-sessions.ts`, update `list(...)` to accept `includeDeleted?: boolean` and apply `WHERE deleted_at IS NULL` by default; update `recentForContext(...)` to apply the same filter unconditionally; leave `findById(...)` unfiltered
- [x] 1.5 Add unit tests in `src/services/agent-sessions.test.ts`: softDelete sets the timestamp + hides from list; idempotent on double-call; undelete clears it; cross-token softDelete without adminBypass rejects with `forbidden`; recentForContext never returns deleted rows

## 2. CLI surface

- [x] 2.1 Extend `src/cli/session-cli.ts` with `runSessionDelete({id})` (uses `adminBypass: true`) and a `--include-deleted` flag on `runSessionList`; surface a `(deleted)` annotation in `--table` mode
- [x] 2.2 Register `rembric session delete <id>` in `src/cli.ts` and add `--include-deleted` to `rembric session list`
- [x] 2.3 Add CLI tests in `src/cli/cli.test.ts`: delete a session and confirm it disappears from list / appears in list with --include-deleted; delete an unknown id exits non-zero

## 3. Dashboard

- [x] 3.1 In `src/dashboard/sessions.ts`, in the list handler, read `?include_deleted=1` and `?deleted=<id>` query params; render the Delete form on each Active row; render a "Deleted" section beneath Active when `include_deleted=1`; render the flash from `?deleted=<id>` with an inline Undelete action
- [x] 3.2 Add `POST /dashboard/sessions/:id/delete` and `POST /dashboard/sessions/:id/undelete` handlers, both CSRF-protected, both calling the new service methods with `adminBypass: true`
- [x] 3.3 In the detail view, surface the `deleted_at` state with a `flash error` and swap Delete → Undelete when applicable
- [x] 3.4 Add E2E tests in `src/test/dashboard-e2e.test.ts`: (a) delete from list view → 302 with `?deleted=<id>` and row disappears, (b) include_deleted=1 surfaces the row, (c) undelete from detail view restores the row, (d) delete without CSRF returns 403

## 4. MCP integration

- [x] 4.1 In `src/mcp/sessions-tools.ts`, in the `memory.session_end` and `memory.session_summary` handlers, resolve the row first; after the existing cross-token check, if `deletedAt` is non-null, throw an MCP error with `code: 'session_deleted'` and a message naming the timestamp
- [x] 4.2 Confirm `memory.session_start` requires no changes; add an inline test that opening a new session never touches deleted rows
- [x] 4.3 Add MCP integration tests in `src/test/mcp-integration.test.ts`: (a) session_end on a soft-deleted row → `session_deleted`, (b) session_summary on a soft-deleted row → `session_deleted`, (c) cross-token call on a deleted row → `forbidden` (not `session_deleted`)

## 5. Invariants

- [x] 5.1 Update `src/test/invariants.test.ts` to (a) keep the assertion that no row is physically deleted, (b) explicitly allow `deleted_at` to round-trip between NULL and timestamp without flagging
- [x] 5.2 Add a schema-drift test entry asserting `agent_sessions.deleted_at` exists with the expected mode/nullability

## 6. Docs

- [x] 6.1 Add a short "Deleting sessions" subsection to `docs/agents.md` (or the dashboard README) explaining (a) soft-delete preserves the audit trail, (b) memory `session_id` references stay intact, (c) `session_deleted` is the agent-side rejection code
- [x] 6.2 Add a CHANGELOG entry naming the migration, the new CLI subcommand, and the new MCP error code

## 7. Validation

- [x] 7.1 `pnpm typecheck` clean
- [x] 7.2 `pnpm lint` clean
- [x] 7.3 `pnpm format:check` clean (or `pnpm format` applied)
- [x] 7.4 `pnpm test` — all suites green, including the new tests
- [x] 7.5 `pnpm build` clean
- [x] 7.6 `openspec validate add-session-deletion --strict` clean
