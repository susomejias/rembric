## MODIFIED Requirements

### Requirement: Memory browsing MUST support filters and pagination

The `/dashboard/memories` view SHALL support filtering by project, type, status, **review state**, and free-text search, and SHALL paginate results. All filtering SHALL be performed server-side; the form SHALL be progressively enhanced with HTMX so it updates without a full page reload.

The view SHALL render review state in a dedicated `review` column (separate from `status`, because review is an orthogonal axis — a freshness signal, not a lifecycle value): each `active` row whose derived `reviewState = 'needs_review'` (derivation per the `memory` capability) SHALL show a `needs_review` badge in that column; all other rows SHALL show a neutral placeholder. The badge SHALL use the existing `.pill` atom and the locked palette — no new design token is introduced. The filter form SHALL include a `review` control with values `(any)` (default) and `needs_review`; when `review = needs_review` the list SHALL show only `active` memories deriving `needs_review`, computed server-side with the per-type TTL pushed into SQL so pagination is correct, respecting the current project filter and preserving all active filters across HTMX swaps.

The view header SHALL render a `TOTAL` meta chip whose value is the true count of rows matching the **current filter set** (the combined scope/status/type/review/search filters), independent of pagination — NOT the count of rows on the current page. The header SHALL also render a `SHOWING N ROWS` indicator carrying the page-slice count. The true count SHALL be computed by a dashboard-only, `admin*`-prefixed repository read so that no counting SQL leaves the `src/db/` layer. For the FTS-search branch the count SHALL be the number of rows matching the search expression (not the page slice); for the `needs_review`-only branch it SHALL be the number of active rows deriving `needs_review` for the active project filter.

For the single combination of `review = needs_review` AND a non-empty free-text query — where review state is derived after the page slice rather than in SQL — the `TOTAL` chip SHALL render the page-slice count suffixed with `+` (a "at least N" lower bound) rather than an inexact exact-looking number.

#### Scenario: Filtering by status

- **WHEN** the operator selects `status = 'archived'` in the filter form
- **THEN** the resulting page SHALL show only memories with `status = 'archived'`, respecting the current project filter

#### Scenario: Filtering by review state

- **WHEN** the operator selects `review = needs_review` in the filter form
- **THEN** the resulting page SHALL show only `active` memories whose derived `reviewState = 'needs_review'`, respecting the current project filter, and SHALL paginate correctly (each page honors `limit`)

#### Scenario: A stale active row shows the needs_review badge

- **GIVEN** an `active` memory whose derived `reviewState = 'needs_review'`
- **WHEN** the operator views it on `/dashboard/memories` (under any filter that includes it)
- **THEN** its row SHALL render a `needs_review` badge in the `review` column (distinct from the `status` column)
- **AND** a `fresh`, `superseded`, `archived`, or no-TTL-type row SHALL show the neutral placeholder, not the badge

#### Scenario: Badge and filter agree

- **GIVEN** a row that renders the `needs_review` badge
- **WHEN** the operator applies `review = needs_review`
- **THEN** that row SHALL appear in the filtered result

#### Scenario: Pagination

- **WHEN** the operator clicks "next page"
- **THEN** the page SHALL reload with the next `limit` rows offset, preserving all active filters (including `review`)

#### Scenario: TOTAL reflects the true filtered count, not the page slice

- **GIVEN** a filter set matching 248 memories with the page size at 10
- **WHEN** the operator opens `/dashboard/memories` under that filter set
- **THEN** the header `TOTAL` chip SHALL read `248`
- **AND** the `SHOWING` indicator SHALL read `10 ROWS`

#### Scenario: TOTAL counts all FTS matches, not just the page

- **GIVEN** 53 memories match the free-text query `q` with the page size at 10
- **WHEN** the operator submits that query on `/dashboard/memories`
- **THEN** the header `TOTAL` chip SHALL read `53`
- **AND** the `SHOWING` indicator SHALL read `10 ROWS`

#### Scenario: needs_review combined with search renders a lower-bound total

- **GIVEN** `review = needs_review` AND a non-empty free-text query, and the current page is full (10 rows after the in-process review filter)
- **WHEN** the operator views `/dashboard/memories` under that combination
- **THEN** the header `TOTAL` chip SHALL render the page-slice count suffixed with `+` (e.g. `10+`)
- **AND** it SHALL NOT render an exact-looking number that under- or over-states the match set

## ADDED Requirements

### Requirement: Dashboard list headers MUST report the true filtered total

Every paginated dashboard list view SHALL render a header total chip whose value equals the true number of rows matching the view's current filter set, computed independently of pagination — NOT the count of rows present on the current page. The page-slice count SHALL remain available as a distinct `SHOWING N ROWS` indicator (in the header meta and/or the pager footer). This requirement applies to the memories (`/dashboard/memories`), sessions (`/dashboard/sessions`), judgments (`/dashboard/judgments`), and consolidation-runs (`/dashboard/consolidation`) list views.

The true count SHALL be produced by an `admin*`-prefixed repository read that applies the SAME filter conditions as the view's corresponding `admin*List*` query and omits `LIMIT`/`OFFSET`/`ORDER BY`. All such counting SQL SHALL live under `apps/server/src/db/repositories/` and SHALL be invoked only from `apps/server/src/dashboard/`, satisfying the data-access and admin-method confinement invariants. No new MCP tool, HTTP route, DB migration, or design token SHALL be introduced.

The tokens list (`/dashboard/tokens`) already reports the true count because its source list is unpaginated; it is the reference pattern and is exempt from any change under this requirement.

#### Scenario: Sessions list total counts all non-deleted sessions

- **GIVEN** 37 non-deleted agent sessions with the page size at 10
- **WHEN** the operator opens `/dashboard/sessions`
- **THEN** the header total chip SHALL read `37`, not the count of rows on the current page

#### Scenario: Judgments list total counts all rows for the active filter

- **GIVEN** 64 `memory_relations` rows with `status = 'pending'` and the page size at 10
- **WHEN** the operator opens `/dashboard/judgments?status=pending`
- **THEN** the header SHALL render a total chip reading `64`
- **AND** the `SHOWING N ROWS` indicator SHALL reflect only the page slice

#### Scenario: Consolidation runs total counts all runs

- **GIVEN** 25 `consolidation_runs` rows with the page size at 10
- **WHEN** the operator opens `/dashboard/consolidation`
- **THEN** the header total chip SHALL read `25`, not the page-slice count

#### Scenario: Counting SQL stays in the repository layer

- **WHEN** a contributor inspects the dashboard handlers and runs the data-access confinement invariant test
- **THEN** all counting SQL for these totals SHALL reside under `apps/server/src/db/repositories/`
- **AND** every count method SHALL carry the `admin*` prefix and be called only from `apps/server/src/dashboard/`

#### Scenario: Tokens list is unchanged

- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the header total chip SHALL continue to reflect the full, unpaginated token count with no behavioural change
