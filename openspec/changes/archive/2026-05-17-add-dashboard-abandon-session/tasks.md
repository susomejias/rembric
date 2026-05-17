## 1. Service layer: `markAbandoned(id, {tokenId?, adminBypass?})`

- [x] 1.1 In `src/services/agent-sessions.ts`, add a new public method `markAbandoned(sessionId: string, input?: { tokenId?: string; adminBypass?: boolean }): AgentSession` placed adjacent to `abandonStale` and styled like `softDelete` / `undelete`.
- [x] 1.2 Implementation: `SELECT` the row by `id`. If not found → throw `DomainError('session_not_found', \`session '<id>' not found\`)`. If `status === 'ended'`→ throw`DomainError('session_already_ended', \`session '<id>' is already ended\`)`. If `status === 'abandoned'`→ return the existing row unchanged (idempotent no-op). If`status === 'active'`: when `adminBypass`is not set, require`input?.tokenId === row.token_id`; on mismatch throw `DomainError('forbidden', ...)`. On the happy path, `UPDATE agent_sessions SET status='abandoned', ended_at = this.now() WHERE id = ?` and return the updated row.
- [x] 1.3 Add unit tests in `src/services/agent-sessions.test.ts` covering: active → abandoned, idempotent on abandoned, rejects ended, rejects cross-token without `adminBypass`, accepts cross-token with `adminBypass`, throws `session_not_found` for unknown id.
- [x] 1.4 Confirm `src/test/invariants.test.ts` still passes — the file-allow-list test should accept the new `UPDATE` because it lives in the already-allowed `agent-sessions.ts`.

## 2. Dashboard route: `POST /dashboard/sessions/:id/abandon`

- [x] 2.1 In `src/dashboard/sessions.ts::createSessionsRouter`, add a new handler `app.post('/:id/abandon', async (c) => { … })` mirroring the structure of the existing `delete` / `undelete` handlers.
- [x] 2.2 The handler SHALL: require a dashboard session (redirect to `/dashboard/login` otherwise), verify CSRF via `readFormAndVerifyCsrf(c, session.session, deps.sessions, 'session.abandon')`, call `deps.agentSessions.markAbandoned(id, { adminBypass: true })`, redirect to `/dashboard/sessions?abandoned=<encodeURIComponent(id)>` on success. On `DomainError`, render the standard error page (404 for `session_not_found`, 400 for everything else, mirroring the `softDelete` error mapping).
- [x] 2.3 Add `'session.abandon'` to the allowed CSRF action set used by the sessions surface (the action token is passed in step 2.2 — no central registry update is needed if `csrfInput` / `readFormAndVerifyCsrf` accept arbitrary strings; verify by reading `src/dashboard/csrf.ts`).

## 3. Dashboard UI: `[Abandon]` button on list + detail

- [x] 3.1 In `src/dashboard/sessions.ts::renderRow`, extend the actions cell so that when `!opts.deleted` AND `r.status === 'active'`, the cell renders the existing `[Delete]` form PLUS a new `[Abandon]` form. Form attributes: `action="/dashboard/sessions/<id>/abandon"`, `method="post"`, `class="inline"`, `data-confirm="Mark this session as abandoned? Its <N> memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard."` (`<N>` = `countRows[r.id] ?? 0`), `data-confirm-label="ABANDON SESSION"`, `data-confirm-tone="warn"`. CSRF input via `csrfInput(session.session, deps.sessions, 'session.abandon')`. Button class: `warn` (matches the `Delete` button's visual weight while staying within the warn tone).
- [x] 3.2 In the detail handler (`app.get('/:id', …)`), construct the action area similarly: when `!row.deletedAt` AND `row.status === 'active'`, render both `[Delete]` and `[Abandon]` forms side-by-side. When deleted, the existing `[Undelete]` is the only action. When not deleted but status is `ended` or `abandoned`, only `[Delete]` is shown.
- [x] 3.3 Compute `memoriesCount` for the detail view (`memories.length` is already in scope) so the abandon modal's `<N>` is accurate on the detail page too.

## 4. Dashboard UX: flash banner for `?abandoned=`

- [x] 4.1 In the list handler's URL parsing, read `const justAbandoned = url.searchParams.get('abandoned');` alongside the existing `justDeleted` / `justRestored`.
- [x] 4.2 Extend the `flash` ternary so that when `justAbandoned` is set, the banner reads: `Session <code>X</code> marked as abandoned. <a href="/dashboard/sessions/X">View</a>.` (class `flash success`).
- [x] 4.3 Verify the banner copy renders correctly when the row is also in `?include_deleted=1` mode (the two query params are orthogonal — the operator may have an abandoned row visible whether or not deleted rows are shown).

## 5. Tests

- [x] 5.1 Service test (in `src/services/agent-sessions.test.ts`) — `markAbandoned` active row: assert the returned row has `status === 'abandoned'` and `endedAt` is a `Date`.
- [x] 5.2 Service test — idempotent on already-abandoned: call `markAbandoned` twice on the same id, assert second call returns the same `endedAt` as the first (no second write).
- [x] 5.3 Service test — rejects ended: `end()` a session, then `markAbandoned()` it, assert `DomainError('session_already_ended')`.
- [x] 5.4 Service test — cross-token without `adminBypass`: assert `DomainError('forbidden')`.
- [x] 5.5 Service test — cross-token with `adminBypass: true`: assert success.
- [x] 5.6 Service test — unknown id: assert `DomainError('session_not_found')`.
- [x] 5.7 Integration / e2e test (co-located near the existing session-soft-delete tests): POST to `/dashboard/sessions/<id>/abandon` with a valid dashboard session cookie + CSRF token → 302 to `/dashboard/sessions?abandoned=<id>`; subsequent GET of `/dashboard/sessions` contains the flash banner; the row's status (read via service `findById` or via a re-GET that surfaces the status pill) is `abandoned`.
- [x] 5.8 Run `pnpm run typecheck` and `pnpm test` — both pass.

## 6. Documentation deltas in this change

- [x] 6.1 `proposal.md` — written
- [x] 6.2 `design.md` — written
- [x] 6.3 `specs/dashboard/spec.md` — delta with ADDED requirement covering the new `[Abandon]` action
- [x] 6.4 `specs/sessions/spec.md` — delta with ADDED requirement covering `markAbandoned`
- [x] 6.5 `tasks.md` — this file
- [x] 6.6 `openspec validate add-dashboard-abandon-session --strict` — run before merging
