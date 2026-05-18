## Why

The dashboard exposes `Delete` (soft-delete) and `Undelete` actions for sessions but offers no way to flip a stuck `active` session into a terminal state from the operator surface. When an agent crashes mid-session — or the operator simply observes that a session has gone idle and will never receive a graceful `memory.session_end` — the only way today to move the row out of `active` is to wait for the startup reconciliation pass (`abandonStale` against `SESSION_ABANDON_AFTER_MS`, 24h by default) or to bounce the server. Both are awkward: the row stays in `ACTIVE SESSIONS` counters and in the default listing, and the maintenance purge predicate (which requires `status ∈ {ended, abandoned}`) cannot fire.

The service layer already has the bulk verb (`abandonStale({olderThanMs})` used by the scheduler) but not a per-id one, and there is no dashboard action wired to it. This change adds the missing pair: a per-id `markAbandoned(id, {tokenId?, adminBypass?})` service method and an `[Abandon]` button on `/dashboard/sessions` and `/dashboard/sessions/:id`, with the canonical confirmation modal (`data-confirm-tone="warn"`, copy stating the consequence and reversibility shape).

Closing-with-curated-summary (the `end()` verb requiring `title + summary`) is out of scope here — operators who want to write a summary still have the agent path. This change covers the "the agent died, mark this zombie" case only.

## What Changes

- **Add `AgentSessionsService.markAbandoned(id, {tokenId?, adminBypass?})`** at `src/services/agent-sessions.ts`. Behaviour:
  - Looks up the row by `id`.
  - If not found → `DomainError('session_not_found', …)`.
  - If `status === 'active'` → `UPDATE` to `status = 'abandoned'`, `ended_at = now()`. Returns the updated row.
  - If `status === 'abandoned'` → idempotent no-op. Returns the existing row.
  - If `status === 'ended'` → `DomainError('session_already_ended', …)`. The `ended → abandoned` reverse transition is not allowed.
  - Without `adminBypass`, the caller's `tokenId` SHALL match the row's `token_id`; mismatches SHALL be rejected with `DomainError('forbidden', …)`.
  - With `adminBypass: true`, the `tokenId` check SHALL be skipped (matching the existing pattern used by `softDelete` / `undelete`).

- **Add a `POST /dashboard/sessions/:id/abandon` route** in `src/dashboard/sessions.ts`:
  - CSRF-protected with action token `'session.abandon'`.
  - Calls `agentSessions.markAbandoned(id, {adminBypass: true})`.
  - On success, redirects to `/dashboard/sessions?abandoned=<id>`.
  - On `DomainError('session_not_found')`, returns the standard sessions-list error page with 404; on any other `DomainError`, 400 with the message.

- **Surface a flash banner** for `?abandoned=<id>` on `/dashboard/sessions` analogous to the existing `?deleted=` / `?restored=` banners ("Session <code>X</code> marked as abandoned. <a>View</a>.").

- **Render an `[Abandon]` button** in both the list-view actions cell and the detail-view action block — but only when `row.status === 'active'` AND `row.deletedAt === null`. For non-active rows, the existing `[Delete]` / `[Undelete]` buttons are the only actions. The `[Abandon]` form SHALL carry:
  - `data-confirm="Mark this session as abandoned? Its <N> memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard."` (count from `countRows[r.id] ?? 0`).
  - `data-confirm-label="ABANDON SESSION"`.
  - `data-confirm-tone="warn"` — the underlying memory rows survive untouched; only the session's FSM state changes (consistent with the spec's tone rule: `warn` for "destructive but reversible-through-UI-or-data-intact", `danger` for "unwinds nothing").

- **Add `'session.abandon'` to the set of recognised CSRF action tokens** for the dashboard's session forms.

- **Tests**:
  - `src/services/agent-sessions.test.ts` — new cases: `markAbandoned` flips active to abandoned, is idempotent on already-abandoned, rejects ended, rejects cross-token without adminBypass, accepts cross-token with adminBypass.
  - `src/test/dashboard-e2e.test.ts` (or co-located) — POSTing the abandon form on an active session returns 302 to the listing with `?abandoned=<id>`, the row's `status` flips to `abandoned`, the row's `ended_at` is non-null.

## Capabilities

### New Capabilities

<!-- none — this extends two existing capabilities -->

### Modified Capabilities

- `dashboard`: Adds one requirement covering the new operator-facing `[Abandon]` action (button placement, form attributes, route, redirect target, CSRF action token, conditional rendering on `status === 'active'`).
- `sessions`: Adds one requirement covering the new `AgentSessionsService.markAbandoned(id, {tokenId?, adminBypass?})` method (signature, state transitions, idempotency, `adminBypass` behaviour). The existing requirement defining the FSM (`active → ended | abandoned`) is unchanged.

## Impact

- **Affected code**: `src/services/agent-sessions.ts` (new method), `src/services/agent-sessions.test.ts` (new tests), `src/dashboard/sessions.ts` (new route, new button, new flash banner). No DB migration. No new schema column.
- **Unaffected**: DB schema, Drizzle migrations, MCP tools, HTTP API (`/api/<slug>/sessions/...`), plugin manifests, scheduler (`abandonStale` keeps doing its bulk job), `softDelete` / `undelete`, append-only invariants.
- **Externally visible**: A new POST endpoint under `/dashboard/sessions/:id/abandon` that requires the dashboard session cookie + CSRF. No public-facing API surface added.
- **Operator workflow**: The 95% case ("an agent crashed and left a session in `active`") becomes a one-click action with a confirmation modal, instead of waiting up to 24h for the scheduler's reconciliation pass or restarting the server.
- **Tests**: 5 new test cases. Typecheck and full `pnpm test` pass.
