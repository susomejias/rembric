## Why

The derived `review` axis (`add-memory-review-state`) gives agents a `needs_review` signal over MCP, but the **operator** has no way to see it. Judgments get a dedicated `/dashboard/judgments` view because `memory_relations` is a separate entity with a lifecycle; `reviewState` is **not** an entity — it is a derived attribute of `memory` rows. Its honest home is therefore the existing `/dashboard/memories` view, not a new page: a `needs_review` badge per row plus a filter, exactly mirroring how `status` is already shown and filtered.

This lets an operator answer "what is stale in this project and worth re-verifying?" for hygiene monitoring, reusing the same `deriveReviewState` helper the MCP layer already uses (single source of truth for the time math).

> Depends on `add-memory-review-state` (introduces `apps/server/src/services/review.ts` and `MemoryRepository.{latestConfirmationTsByIds,findNeedsReview}`). This change adds only the dashboard surface.

## What Changes

- `/dashboard/memories` list: a dedicated `review` column (separate from `status`, since review is an orthogonal freshness axis, not a lifecycle value) renders a `needs_review` badge for each `active` row whose derived `reviewState = 'needs_review'`, built from the existing `.pill` atom (no new design token); other rows show a neutral placeholder.
- `/dashboard/memories` filter form: add a `review` filter (`(any)` default · `needs_review`). When `review = needs_review`, the list SHALL show only `active` memories deriving `needs_review`, server-side, respecting the existing project filter and pagination, and preserving all other active filters across HTMX swaps.
- `/dashboard/memories/:id` detail: surface the derived `reviewState` and `reviewAfter` (when set) in the metadata block, alongside the existing status/confirmation-count fields.
- Derivation stays in the handler via the shared pure `deriveReviewState`; confirmation timestamps and the filtered id set come from new **`admin*`** (unscoped) repository reads — no SQL leaves `db/`.

## Capabilities

### New Capabilities

_None._ The change extends already-defined `dashboard` requirements.

### Modified Capabilities

- `dashboard`: the memory-browsing requirement gains a `review` filter and a `needs_review` row badge; the memory-detail requirement gains the derived `reviewState`/`reviewAfter` fields.

## Impact

Affected code:

- `apps/server/src/dashboard/memories.ts` — derive `reviewState` per listed row (batch confirmation lookup) for the badge; add the `review` filter to the form + the filtered query path; render `reviewState`/`reviewAfter` on the detail view.
- `apps/server/src/db/repositories/memory-repository.ts` — `adminLatestConfirmationTsByIds` (or reuse the existing by-id, scope-agnostic `latestConfirmationTsByIds`) and `adminFindNeedsReview` (unscoped variant of `findNeedsReview`) for the filter path. `admin*` prefix = dashboard-only, grep-enforced.
- `apps/server/src/dashboard/templates.ts` — a small `reviewPill` helper (or reuse `statusPill`'s pattern) if a dedicated badge renderer is warranted; otherwise inline via `.pill`.

Affected APIs: dashboard HTML only — no MCP/HTTP contract change.

Load-bearing invariants touched: **none.** Read-only dashboard additions; review state stays derived (no column, no mutation). Data-access confinement preserved (new reads carry the `admin*` prefix and live in `db/`).

Design-token contract: respected — the badge reuses the existing `.pill` atom and the locked brutalist palette; **no token change**, so no `dashboard`-spec token amendment is required beyond the two behavioural requirements above.
