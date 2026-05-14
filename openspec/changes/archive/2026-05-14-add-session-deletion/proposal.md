## Why

The `agent_sessions` table is append-only by design — once a session is started it can only transition status (`active` → `ended` | `abandoned`) and the row stays forever. That has been the right default for an audit trail, but it leaves operators with no clean way to retire stale, accidental, or test-generated sessions from the dashboard and CLI listings. Today the only escape is editing the SQLite file by hand or filtering by status in every query, both of which hurt operator UX.

We want a first-class "delete this session" path on the CLI and dashboard without breaking the audit trail. A soft-delete column (`deleted_at`) hides the row from the default listings while preserving every memory's `session_id` link and the FSM history.

## What Changes

- **DB schema** _(non-breaking)_: add nullable column `agent_sessions.deleted_at TIMESTAMP` defaulting to `NULL`. A `WHERE deleted_at IS NULL` filter is added to default-visible queries.
- **AgentSessionsService**: new methods `softDelete(sessionId, {tokenId | adminBypass})` and `undelete(sessionId, {adminBypass})`. The same cross-token guard used by `end()` and `summarize()` applies — only the owning token (or an admin token) can soft-delete a session.
- **CLI**: new `rembric session delete <id>` subcommand (admin-token-protected since the CLI runs on the host). New `--include-deleted` flag on `rembric session list` to surface soft-deleted rows.
- **Dashboard**: an inline CSRF-protected "Delete" button on each row of `/dashboard/sessions`, redirecting back with a `?deleted=<id>` flash. The detail view (`/dashboard/sessions/:id`) renders soft-deleted sessions with an `Undelete` button. A `?include_deleted=1` query parameter on the list view exposes the hidden rows.
- **MCP**: `memory.session_summary` and `memory.session_end` against a soft-deleted session SHALL reject with structured code `session_deleted`. `memory.session_start` is unaffected (it always opens a fresh session).
- **Invariants**: the "Sessions MUST be append-only" requirement is narrowed to mean _identity columns and FSM history are append-only_; `deleted_at` is the only field that may transition (null → timestamp → null).

## Capabilities

### New Capabilities

_None._ This change extends existing capabilities.

### Modified Capabilities

- `sessions`: narrows the append-only requirement to identity + FSM fields, adds the new `deleted_at` column, and adds CLI / dashboard / MCP requirements covering soft-delete and undelete behavior.
- `mcp-api`: adds a `session_deleted` rejection for session-lifecycle tools that target a soft-deleted row.

## Impact

- **Code**: new migration `0006_session_deleted_at.sql`; `src/db/schema/agent-sessions.ts` gains a `deletedAt` column; `src/services/agent-sessions.ts` gains `softDelete` / `undelete`; `src/cli/session-cli.ts` gains `runSessionDelete` and a `--include-deleted` flag; new commander subcommand in `src/cli.ts`; `src/dashboard/sessions.ts` gains the delete button + POST handler; `src/mcp/sessions-tools.ts` checks `deletedAt` before allowing `session_end` / `session_summary`.
- **Schema / DB**: one additive migration. No data backfill required (default NULL = visible).
- **Tests**: new CLI test covering delete + list filtering; new dashboard E2E test for delete + undelete; new MCP integration test asserting `session_deleted` on summarize/end; updates to `src/test/invariants.test.ts` to cover the narrowed append-only rule.
- **Docs**: short note in `docs/agents.md` and the dashboard README section describing the new button and the audit-preservation guarantee.
