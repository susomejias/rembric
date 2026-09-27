## Why

The dashboard spec still mandates a *needs-review* badge on the Memories nav entry (`openspec/specs/dashboard/spec.md:1314-1328`), but the shipped dashboard no longer behaves that way, and the owner has decided it should not:

- The command-bar navigation (which replaced the sidebar shell) computes nav totals in `apps/web/src/app/dashboard/layout.tsx::navTotals()` as corpus counters. After the 2026-09-27 consistency fix (`f71e3b17`), the Memories badge reports `active` memories only — the owner's convention: **nav badges are totals excluding rows retired from the lifecycle** ("los contadores nuevos dijimos que iban a ser de totales, excluyendo eliminadas, archivadas etc").
- The owner explicitly decided the spec text mandating the needs-review badge must be violated in this case ("la spec se debe violar en este caso") and then asked to adjust the spec so it stops misleading ("ajustamos la spec si te parece para que no engañe").
- The mislead is user-visible: the old text makes a reader expect a review-backlog counter, while the UI shows a lifecycle total that reconciles with what the memories list view reports and paginates through (server-side pagination per `a044e514` and the spec's own "Paginated list views MUST surface the total page count" requirement).

Evidence trail: odd/tasks/dashboard-nav-datatable-consistency.md (audit of every nav section, owner decisions recorded), commits `97494e8f`, `a044e514`, `f71e3b17` on `main`.

## What Changes

- **MODIFY one dashboard requirement**: "The Memories sidebar entry MUST surface a needs-review count badge" becomes a lifecycle-total badge requirement — the `MEMORIES` nav entry reports the count of `active` memory rows (excluding `superseded` and `archived`), omitted when zero. The scenarios are updated: the badge reads the active count, not the needs-review count, and the mirroring reference to the judgments badge's pending-relation pattern is dropped (the judgments badge intentionally reports the pending+judged+orphaned total — a separate owner decision, out of scope here).
- **No code change.** The behaviour is already shipped on `main` (`f71e3b17`). This change aligns the contract with reality; it does not move it.
- **Nothing else in the dashboard spec is touched.** The stale sidebar-vs-command-bar shell wording elsewhere in the spec is noted as pre-existing drift and left for the pending dashboard spec formalisation (see `feat/dashboard-identity-redesign`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard`: one MODIFIED requirement — the Memories nav badge. The badge semantics change from needs-review backlog to lifecycle total (active rows), with rewritten scenarios.

## Impact

- Specs merged at archive time: `openspec/specs/dashboard/spec.md` (requirement at `:1314-1328`).
- Code: none — `apps/web/src/app/dashboard/layout.tsx` already implements the target behaviour.
- Tests: none required beyond what already covers `navTotals()`; the badge value is asserted indirectly by the dashboard suite. If the archive review finds a test pinning the needs-review badge, it is a stale assertion to update, not a behaviour regression.
- Existing installations: badge value changes only in deployments that still run a pre-`f71e3b17` build; no migration, no schema change, no MCP/HTTP contract impact.
