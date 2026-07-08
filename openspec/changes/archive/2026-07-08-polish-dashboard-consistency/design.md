# Design — polish-dashboard-consistency

## Context

The dashboard is SSR (Hono) + HTMX, one router module per view under `apps/server/src/dashboard/`, shared pieces in `components.ts`/`templates.ts`. Reads go through `admin*` repository methods (dashboard-only, grep-enforced); mutations go through services. Several shared helpers (`sel`, `inp`, `filtersBar`, `tblEmpty`, `kv`, `kvGrid`) were built and tested but never adopted; each view hand-rolls its own markup instead.

## Goals / Non-Goals

**Goals:** every list view behaves identically (filters, TOTAL, SHOWING, empty state); memory detail becomes a hub with links to everything that references it; handler boilerplate exists once.

**Non-Goals:**

- Bulk actions (multi-select confirm/delete) — real feature work with UX surface; deliberately out of scope here.
- Any visual/token change; the brutalist identity and CSS layer rules are locked.
- Renaming judgments/relations (decided and closed).
- New MCP/HTTP surface.

## Decisions

### D1: Adopt the existing helpers, don't rebuild them

`sel`/`inp`/`filtersBar`/`tblEmpty`/`kv`/`kvGrid` are already written and unit-tested. Views migrate to them; if a helper proves unfit during implementation (signature mismatch with real usage), it is FIXED in `components.ts` (with its test) rather than bypassed. If any helper still has no adopter after the migration, it is deleted — the end state has zero exported-but-unused helpers. Alternative — deleting them all and keeping hand-rolled markup — rejected: the hand-rolled copies are the divergence source (four empty-state variants today).

### D2: Shared handler utilities live in `components.ts`

`getSession(c)`, `truncate(s, n)`, and `domainErrorPage(c, sessions, err, view)` move to `components.ts` (already the shared-code home; no new module). `domainErrorPage` reproduces the current per-view flash-error rendering; handlers keep their try/catch but the body is one call. Behavior-preserving: same status codes, same flash copy mechanism.

### D3: Memory detail Confirm is a plain CSRF POST, no modal

`memory.confirm` is additive (appends a confirmation event, refreshes review TTL) — not destructive, so `data-confirm` is NOT used (the modal is reserved for destructive tones per convention). Button posts to `/dashboard/memories/:id/confirm`, handler calls `MemoryService.confirm(id, scope, 'dashboard-operator')` — mutation via service, scope resolved from the memory's own scope tuple via the admin read that fetched it (pattern already used by the existing archive action). Flash confirms success.

### D4: Sessions filters mirror the memories pattern exactly

Same query-param names, same form markup (via the adopted helpers), same "filters apply to the non-deleted table only" rule as memories; `include_deleted` toggle unchanged. `adminList`/`adminCount` gain `{ projectId?, agent?, status? }` — filter SQL in the repository, dashboard passes params through.

### D5: Judgments section on memory detail reuses `listTouching`

`relations-repository.listTouching(memoryId)` already returns relations where the memory is source or target. The detail section lists kind, status, counterpart memory (title-linked), judged/created timestamp (via `formatTs`), linking each row to the judgment detail. No new SQL shape — if `listTouching` lacks the admin prefix for dashboard use, add an `admin*` wrapper per the confinement rule.

## Risks / Trade-offs

- [Risk] Helper adoption churns many templates in one PR. → Mitigation: behavior-preserving tasks are separated from feature tasks in tasks.md; dashboard e2e suite plus per-view HTML assertions run per task group.
- [Risk] `domainErrorPage` subtly changes an error status code somewhere. → Mitigation: inventory the 10+ catch sites first (task 1.1) and assert current codes in tests before swapping.
- [Trade-off] Confirm-from-dashboard writes a confirmation event attributed to the operator, mixing operator affirmations with agent ones. → Accepted: the event source field distinguishes them (`'dashboard-operator'`), and re-affirming from the operator seat is precisely the review workflow's intent.

## Migration Plan

Server release only. No schema change (repo methods are additive).

## Open Questions

(none)
