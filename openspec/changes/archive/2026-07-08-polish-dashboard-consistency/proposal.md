# Polish dashboard consistency: cross-navigation, sessions filters, dedup, fixes

## Why

An exploration pass over `apps/server/src/dashboard/` surfaced one real bug, several consistency gaps between sibling list views, a missing spec-mandated field, missing cross-entity navigation, and heavy handler duplication. Concretely: the judgments list "SHOWING" chip counts the lookahead row (`rows.length` = 11 over a 10-row table, `judgments.ts:152`); the memory detail never renders `source` despite the dashboard spec requiring it, offers no Confirm action although `MemoryService.confirm` (single + batch) exists, and gives no way to jump to the memory's judgments or its anchoring session (the inverse links all exist); `/dashboard/sessions` is the only major list with no filter bar; `/dashboard/prompts` is the only list without a true TOTAL chip (its repo lacks an `adminCount`); four different empty-state markups coexist while the tested `tblEmpty` helper sits unused (as do `sel`/`inp`/`filtersBar`/`kv`/`kvGrid`); `getSession` is copied in 8 routers, `truncate` in 5, and the catch-DomainError→error-page pattern in 10+ places; and no filter control has an associated `<label>`.

## What Changes

- **FIX** judgments `SHOWING` chip uses the visible slice length.
- **MODIFIED** memory detail: render `source` (spec catch-up); add a "Judgments" section listing relations touching the memory (via the existing `listTouching` repo read) with links to `/dashboard/judgments/:id`; link the anchoring session; render `replaces` ids as links (predecessors already link); add a Confirm action (POST, CSRF-protected, non-destructive — refreshes the review TTL via the existing `confirm` service method), shown prominently when `reviewState = 'needs_review'`.
- **MODIFIED** `/dashboard/sessions`: filter bar (project, agent, status) matching the memories/prompts pattern; `adminList`/`adminCount` extended with those filters.
- **MODIFIED** `/dashboard/prompts`: true TOTAL chip via a new `adminCount` on the prompts repository (same filters as its list read).
- **REFACTOR** (behavior-preserving): shared `getSession`, `truncate`, and `domainErrorPage` helpers replacing the copies; `projectOptions` builder extracted (currently duplicated verbatim in memories/prompts); empty states unified on `tblEmpty`; filter bars adopt the existing tested helpers (`sel`/`inp`/`filtersBar`) or those helpers are deleted — one direction, no half-state; `kv`/`kvGrid` adopted or deleted likewise.
- **MODIFIED** accessibility: every filter control gets an associated `<label>` (visually styled as the current `span.k` chips — no visual change, tokens untouched).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dashboard`: memory-detail requirement gains source/judgments/session/confirm content; sessions-list requirement gains the filter bar; the true-filtered-total requirement extends to the prompts list.

## Impact

- `apps/server/src/dashboard/{memories,sessions,prompts,judgments,components}.ts`, other routers only where the shared helpers replace local copies (`projects,tokens,consolidation,maintenance}.ts`, `server/dashboard-router.ts`).
- `apps/server/src/db/repositories/{agent-sessions-repository,prompts-repository,relations-repository}.ts` (admin filter/count extensions; `listTouching` already exists).
- `apps/server/src/services/memory.ts` — no changes expected (`confirm` exists; called from the dashboard handler via the service as mutations must be).
- CSS: no token changes; any new styles go in `src/dashboard/styles/` per convention.
- Conventions honored: `formatTs` for timestamps, `data-confirm` NOT required (Confirm action is non-destructive; plain POST + flash), CSRF on all mutations, UI nomenclature stays "judgments".
