## Context

`AgentSessionsService` today exposes three lifecycle verbs:

- `end(id, {tokenId?})` — graceful close. Requires `title + summary` non-empty, flips `status` to `'ended'`, writes `ended_at`, sets `title_final`. Called by the agent via `memory.session_end` (MCP) and `POST /api/<slug>/sessions/:id/end` (HTTP).
- `abandonStale({olderThanMs})` — bulk reconciliation. Flips every `status='active'` row whose `started_at` predates the cutoff to `status='abandoned'` with `ended_at = now()`. Called once at server startup by the bootstrap routine and on-demand by the scheduler.
- `softDelete(id, {tokenId?, adminBypass?})` / `undelete(id, {adminBypass?})` — orthogonal to the FSM; toggles the `deleted_at` tombstone column. Available to the dashboard.

The gap: there is no per-id imperative for the operator to flip a single `active` row to `abandoned`. The dashboard surfaces `Delete` (soft-delete) and `Undelete` for sessions, but no FSM transition. When an agent process dies and leaves an open session, the operator has to either wait for the next server restart's `abandonStale` pass or hard-restart. Neither matches the agentic dashboard model where every other lifecycle action is one click away.

This change fills that gap by adding a per-id verb to the service and surfacing it on the dashboard. The shape is deliberately narrow: a single `[Abandon]` action that records the loss-of-graceful-close. Curated close (operator-typed `title + summary`) is left to the agent path and considered separately if needed.

## Goals / Non-Goals

**Goals:**

- Give operators a one-click way to terminate a stuck `active` session from the dashboard.
- Keep the service-layer verb idempotent and consistent with `softDelete` / `undelete` (`adminBypass` opt-in, `DomainError` on illegal transitions).
- Make the new action visually consistent with the existing destructive-action language: confirmation modal, `data-confirm-tone="warn"`, copy that names the count and the consequence shape.
- Preserve the append-only invariant: this is a `status` flip plus a single `ended_at` write, both already declared mutable in the existing sessions spec.

**Non-Goals:**

- Operator-typed `title + summary` on close. The `end()` verb requiring non-empty summary stays agent-only for now. If demand appears, a follow-up change can add `[End with summary…]` on the detail page; the data shape already supports it (`title_final` and `summary_final` precedence).
- Reverting an `abandoned` session back to `active`. The FSM keeps `ended | abandoned` terminal; the operator's escape hatch is `softDelete` (and eventual maintenance purge) for rows that shouldn't be there.
- Bulk-abandon UI. The scheduler's startup `abandonStale` covers the bulk case; if a per-list bulk button becomes useful, it would be a separate change with its own confirmation copy (count is much larger).
- New HTTP API endpoint (`POST /api/<slug>/sessions/:id/abandon`). The service method is sufficient for the dashboard surface; exposing it on the HTTP API would invite agent-driven abandonment, which conflicts with the "always close gracefully" guidance.

## Decisions

### Decision 1: Abandon, not End — the dashboard verb is loss-of-graceful-close, not curated close

The semantic distinction matters. `end()` is "the conversation reached a clean handoff: title + summary written, the row is the curated record." `markAbandoned()` is "the conversation was interrupted and will not receive a graceful close — record that state so the row no longer pretends to be ongoing." Mapping the dashboard button to `end()` would force the operator to invent a summary they don't have, and locking that summary (`summary_final = true` via `end()`) would pre-empt any future curation by a real agent. Mapping to `markAbandoned` records the truth — the agent never came back — and leaves `summary` NULL so the maintenance purge predicate (`summary IS NULL AND title_final = false AND ...`) is satisfied and the row can later be reaped if appropriate.

**Alternative considered:** expose both. Rejected for v1 — the curated-close case is rare in practice (operators don't write agent-quality summaries), and the surface area cost (two buttons, two confirmations, two service methods to test) is not justified by the use case. Reopen if demand appears.

### Decision 2: `markAbandoned(id)` is per-id; `abandonStale` is bulk; they stay separate

Tempting to fold them into one — `markAbandoned({id?, olderThanMs?})` switching on which is set. Rejected because:

- The bulk verb's caller is the scheduler. It does not care about `tokenId` and runs at boot for hygiene.
- The per-id verb's caller is the dashboard. It cares about `tokenId` (or `adminBypass`), idempotency, and surfacing `DomainError`s the same way `softDelete` / `undelete` do.

Forcing a single function makes the type signature ugly (`{id, tokenId?, adminBypass?} | {olderThanMs}`) and conflates two distinct call sites. Keep them as siblings. The shared logic (the `UPDATE` clause) is one line — duplication is fine.

**Alternative considered:** make `markAbandoned` call into `abandonStale` internally by passing `olderThanMs: 0`. Rejected — the bulk verb has no per-id error semantics; it doesn't throw, it counts. The dashboard needs to know whether the row existed, whether it was already terminal, and whether the token check passed.

### Decision 3: Tone is `warn`, not `danger`

The existing dashboard spec defines `warn` for "destructive but reversible through an existing UI path" and `danger` for "cannot be unwound through the UI." Abandoning a session is permanent at the FSM level (no `abandoned → active` transition), so a literal reading would call it `danger`. But two facts pull it back to `warn`:

1. **Data is intact.** Memories anchored to the session retain their `session_id` foreign-key reference and stay queryable from the listing and from `memory.search`. Nothing is destroyed.
2. **Operator can still `softDelete` the row** if abandonment was mistaken — and that path is reversible (`undelete`). The operator never loses the ability to make the row invisible-but-recoverable.

`warn` reflects the operator's mental model: "I'm acknowledging a state change in metadata, not destroying anything." `danger` would inflate the language for an action with no data loss.

### Decision 4: Per-id token-check matches `softDelete`'s shape exactly

`markAbandoned(id, {tokenId?, adminBypass?})` mirrors `softDelete(id, {tokenId?, adminBypass?})` byte-for-byte in signature. This keeps the call-site pattern in `src/dashboard/sessions.ts` uniform — all three sessions actions read identical:

```ts
deps.agentSessions.softDelete(id, { adminBypass: true });
deps.agentSessions.undelete(id, { adminBypass: true });
deps.agentSessions.markAbandoned(id, { adminBypass: true });
```

A future contributor reading any of those lines knows the contract without context-switching. The cost is zero — the `adminBypass` branch is one `if`.

### Decision 5: `[Abandon]` button is conditional on `status === 'active'`

Rendering the button on `ended` / `abandoned` rows would only ever produce idempotent no-ops or `session_already_ended` errors. Hiding the button at render time keeps the action area honest — every visible action does something — and avoids the modal-with-no-effect anti-pattern. The CSRF action token `'session.abandon'` is still issued only on rows where the form is rendered, so a forged POST against a non-active row falls back to the service-layer error path (404 / 400).

### Decision 6: Confirmation copy names the memory count

The modal copy reads "Mark this session as abandoned? Its `<N>` memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard." — explicit count (already computed per-row via `countRows[r.id]`), explicit "memories stay queryable" (reassurance — the operator might think abandoning hides data), explicit "not reversible from the dashboard" (sets the right expectation; the dashboard intentionally has no `Reopen` path).

**Alternative considered:** terse copy ("Mark this session as abandoned?"). Rejected — at 11pm an operator looking at a row labelled `ACTIVE · 12 memories` deserves enough modal copy to think for two seconds before clicking through.

## Risks / Trade-offs

- **[A fast-fingered operator could abandon a session that the agent is still actively writing to]** → Mitigation: the modal forces an explicit second click and names the memory count, so the operator sees how active the session is. Worst case, the next `memory.save` from the agent hits the `session_id` and lands fine (foreign-key intact; the row exists with `status='abandoned'`). The agent does NOT auto-reactivate the row — that would invalidate the FSM. The agent's next `memory.session_start` would mint a fresh session id.
- **[Race between the dashboard `[Abandon]` and the scheduler's `abandonStale`]** → Mitigation: both operations are idempotent on already-abandoned rows. The dashboard call wins on timing (synchronous), the scheduler skip-counts the row on its next pass. No data loss either way.
- **[The new `markAbandoned` joins the list of methods that may emit `UPDATE agent_sessions SET status='abandoned'`]** → Mitigation: the invariant test in `src/test/invariants.test.ts` already allows only `agent-sessions.ts` to write FSM transitions; the new method lives in that same file, so no allow-list edit is needed. The test continues to assert that the file actually contains the SQL — adding the new method keeps that assertion satisfied.

## Migration Plan

This change is non-destructive and requires no DB migration.

1. Merge the change. Drizzle schema is untouched.
2. Operators see the new `[Abandon]` button on `/dashboard/sessions` for active rows immediately on the first request after deploy. The CSRF token mint includes the new action verb on those forms.
3. No client / agent / plugin update needed — the surface is dashboard-only.

**Rollback:** `git revert` of the merge commit. The new method is unreferenced outside this commit's files; removing the route and the button leaves the service in a state where `markAbandoned` is dead code, removed in the same revert.

## Open Questions

None — all decisions confirmed during the explore-mode session that produced this proposal.
