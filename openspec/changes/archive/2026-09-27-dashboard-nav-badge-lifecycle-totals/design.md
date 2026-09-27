## Context

The audit of the 2026-09-27 badge/datatable consistency work (`odd/tasks/dashboard-nav-datatable-consistency.md`) found the dashboard spec mandating a needs-review badge on the Memories nav entry while the shipped UI reports a corpus counter. Two prior conventions collided:

- `a5596f9` (2026-09-14) had made the old sidebar badges _adjudicable/backlog_ counters (judgments = pending adjudicable pairs, memories = needs-review count).
- The command-bar redesign dropped that logic; `navTotals()` recomputed raw corpus totals.

## Decisions

- **D1 — Badges are lifecycle totals, not backlog counters.** Owner, 2026-09-27: the new counters are "totales (excluyendo eliminadas, archivadas etc)". Applied per section: memories = `active` rows; sessions = non-deleted (already correct); judgments = pending+judged+orphaned (no lifecycle retirement exists for relations; explicit owner choice "Total + paginación"); entities/tokens = full corpus (no lifecycle concept). The needs-review figure stays in the memories list header and the `review` filter, which is where a backlog belongs.
- **D2 — The spec is corrected, not the code.** The owner asked to adjust the spec so it stops misleading. This change therefore ships no code; it replaces one requirement and its scenarios.
- **D3 — Out of scope.** The judgments badge requirement (if any residual text implies a pending-only badge) and the stale sidebar-vs-command-bar shell wording elsewhere in the dashboard spec are pre-existing drift, tracked for `feat/dashboard-identity-redesign`; this change touches exactly one requirement.
