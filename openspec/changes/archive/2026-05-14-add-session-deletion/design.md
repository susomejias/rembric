## Context

`agent_sessions` is the audit trail of every MCP agent connection: who connected (`token_id`), to which project, when, with what summary, and which memories that session produced (`memory.session_id` points back at the row). The current invariant ("never delete, never mutate identity columns") was a deliberate v0.1 choice — it gives us an unbeatable diff-after-the-fact reconstruction of agent behavior.

The operator pain is real, though. Test sessions, accidental opens, and abandoned-by-restart entries pile up in `/dashboard/sessions` and `rembric session list`. Operators have started filtering them out at the query level in their own dashboards — a sign that the audit trail is fighting the daily workflow.

Soft-delete keeps the row (and every `session_id` reference from memories) intact while hiding the row from default listings. The audit trail is preserved; the listings get clean. A small `--include-deleted` / `?include_deleted=1` switch surfaces hidden rows when needed.

## Goals / Non-Goals

**Goals:**

- Add an additive `deleted_at` column to `agent_sessions` and update every default-visible query to filter `WHERE deleted_at IS NULL`.
- Expose `softDelete` and `undelete` on `AgentSessionsService` with the same cross-token guard used by `end` and `summarize`.
- Surface "Delete" on the dashboard session row and `rembric session delete <id>` on the CLI.
- Preserve every `memory.session_id` reference verbatim; do NOT cascade.
- Reject `memory.session_end` and `memory.session_summary` against a soft-deleted session with structured code `session_deleted`.

**Non-Goals:**

- Hard-delete (physical row removal). The user explicitly chose soft-delete.
- Cascading delete onto memories. The audit trail is the point of the design.
- Bulk delete by query / age threshold. Out of scope for this change; can be revisited later if the soft-deleted backlog grows.
- Delete via the MCP surface. Agents are the wrong actor to retire sessions; only operator-facing surfaces (CLI / dashboard) get this control.
- Encryption / cryptographic-shred of deleted sessions. Same row content, just hidden.

## Decisions

### 1. Schema: a single nullable timestamp column

`ALTER TABLE agent_sessions ADD COLUMN deleted_at INTEGER`. SQLite stores it as ms-since-epoch (matches the existing `started_at` / `ended_at` convention via Drizzle's `timestamp_ms` mode). Default NULL means "visible". No partial index needed — the table is tiny relative to memory, and the equality check on NULL is cheap.

_Alternative considered:_ a fourth status value `deleted`. Rejected because it conflates "deletion intent" with the FSM (`active → ended | abandoned`), which encodes when the agent actually stopped. We want orthogonal axes.

### 2. Service API: softDelete + undelete

```ts
softDelete(sessionId: string, input: { tokenId?: string; adminBypass?: boolean }): AgentSession
undelete(sessionId: string, input: { adminBypass?: boolean }): AgentSession
```

`softDelete` enforces the same cross-token rule as `end` / `summarize` — the session's `token_id` must match the caller's, unless `adminBypass` is true (CLI and dashboard set this). Returns the updated row. Idempotent: a second call on an already-deleted row is a no-op that returns the existing row (instead of throwing) so the dashboard's "Delete" button can be safely re-clicked.

`undelete` clears the timestamp. It's admin-only — agents have no reason to undelete and exposing it on MCP just creates audit-trail-laundering risk.

### 3. Where the WHERE deleted_at IS NULL filter lives

Three default-visible call sites:

- `AgentSessionsService.list(...)` — adds the filter; opt out via `includeDeleted: true`.
- `AgentSessionsService.recentForContext(...)` — adds the filter unconditionally (memory.context callers don't want deleted sessions).
- `src/dashboard/sessions.ts` — list view uses the new flag from `?include_deleted=1`.

Detail-view `findById(...)` does **not** filter — opening `/dashboard/sessions/<id>` of a deleted row must still render so the operator can undelete or audit.

### 4. CLI surface

- `rembric session delete <id>` — soft-deletes with `adminBypass: true`. JSON output on success.
- `rembric session list` — keeps current shape; adds `--include-deleted` and shows deleted rows with a `deleted_at` column (rendered as `(deleted)` in `--table` mode).

No undelete on the CLI for now — the dashboard handles that. We can add `rembric session undelete <id>` later if the demand exists.

### 5. Dashboard

A single `<form>` per row in the Active table with action `/dashboard/sessions/<id>/delete`, CSRF-protected, redirecting to `/dashboard/sessions?deleted=<id>`. On the detail view, soft-deleted sessions get an `Undelete` button instead of `Delete`, and a "This session is deleted" flash on top.

The list view's `?include_deleted=1` query parameter renders the additional rows beneath the Active table, in a "Deleted" section (mirroring how `Archived` projects render).

### 6. MCP integration: `session_deleted` rejection

In `src/mcp/sessions-tools.ts`:

- `memory.session_end` and `memory.session_summary` resolve the target row first (cross-token check happens already); if `deletedAt` is non-null, throw an MCP error with `code: 'session_deleted'` and a message naming the deleted-at timestamp.
- `memory.session_start` is unaffected — every call opens a fresh row.

Agents that legitimately need to summarize a deleted session must ask the operator to undelete first. This is rare in practice; the common case is operators deleting sessions that were already ended.

### 7. Backwards compatibility

The column is additive and nullable. Existing rows materialize with `deleted_at = NULL` and stay visible. Pre-existing queries that didn't filter on `deleted_at` see the same data; the filter is only added to the default-visible call sites listed above. A grep for `from(agentSessions)` confirms there are no other consumers.

## Risks / Trade-offs

- **Operator confusion: "I deleted but the memories are still there"** → Mitigation: the design doc, the dashboard flash, and the CLI message all state explicitly that soft-delete does not cascade to memories. The `session_id` reference is preserved as audit metadata.
- **Soft-deleted rows pile up indefinitely** → Acceptable for v0.x given the low session-volume profile of self-hosted Rembric. If it becomes a problem we can add a later "purge older than N days" admin command without touching this surface.
- **Mis-clicks on the Delete button** → Mitigation: dashboard renders the button as `class="warn"`; the redirect carries a `deleted=<id>` flash with an inline `Undelete` link. Same pattern as `archive`.
- **Append-only invariant tests need updating** → `src/test/invariants.test.ts` asserts no row is ever deleted from `agent_sessions`; we narrow the assertion to "no row is ever physically deleted from `agent_sessions`" and add a new assertion that `deleted_at` is the only column that may transition from one non-null state back to null (via undelete).

## Migration Plan

- `0006_session_deleted_at.sql` adds the nullable column.
- No backfill needed; existing rows default to `NULL` and remain visible.
- Rollback: drop the column. Existing soft-deleted rows would re-appear in default listings, which is acceptable because every row remained physically present.

## Open Questions

None.
