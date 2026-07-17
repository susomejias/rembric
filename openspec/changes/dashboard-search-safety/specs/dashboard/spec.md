## ADDED Requirements

### Requirement: User-supplied text rendered outside the Markdown pipeline MUST be HTML-escaped

Any dashboard template that interpolates user- or agent-supplied text via the `raw()` helper (i.e. outside the Markdown-rendering pipeline covered by the Markdown-escaping requirement) SHALL escape that text with `escape()` first. This applies in particular to prompt tags (agent-supplied via `memory.save_prompt`, rendered on the session detail and prompts list views) and project slugs (operator-supplied at project creation; legacy slugs may predate the current slug validation regex and are not guaranteed to be free of HTML metacharacters).

#### Scenario: A prompt tag containing HTML metacharacters renders as literal text

- **GIVEN** a prompt anchored to a session, with a tag containing `<` or `>` characters
- **WHEN** the operator opens the session detail view or the prompts list view
- **THEN** the tag SHALL render as escaped literal text
- **AND** SHALL NOT be interpreted as HTML or execute as script in the operator's browser

#### Scenario: A legacy project slug containing HTML metacharacters renders as literal text

- **GIVEN** a project whose `slug` predates the current slug-validation regex and contains HTML metacharacters
- **WHEN** the operator opens a dashboard view that renders that slug (e.g. the sessions list)
- **THEN** the slug SHALL render as escaped literal text
- **AND** SHALL NOT be interpreted as HTML or execute as script in the operator's browser

## MODIFIED Requirements

### Requirement: Memory browsing MUST support filters and pagination

The `/dashboard/memories` view SHALL support filtering by project, type, status, **review state**, and free-text search, and SHALL paginate results. All filtering SHALL be performed server-side; the form SHALL be progressively enhanced with HTMX so it updates without a full page reload.

The view SHALL render review state in a dedicated `review` column (separate from `status`, because review is an orthogonal axis — a freshness signal, not a lifecycle value): each `active` row whose derived `reviewState = 'needs_review'` (derivation per the `memory` capability) SHALL show a `needs_review` badge in that column; all other rows SHALL show a neutral placeholder. The badge SHALL use the existing `.pill` atom and the locked palette — no new design token is introduced. The filter form SHALL include a `review` control with values `(any)` (default) and `needs_review`; when `review = needs_review` the list SHALL show only `active` memories deriving `needs_review`, computed server-side with the per-type TTL pushed into SQL so pagination is correct, respecting the current project filter and preserving all active filters across HTMX swaps.

The view header SHALL render a `TOTAL` meta chip whose value is the true count of rows matching the **current filter set** (the combined scope/status/type/review/search filters), independent of pagination — NOT the count of rows on the current page. The header SHALL also render a `SHOWING N ROWS` indicator carrying the page-slice count. The true count SHALL be computed by a dashboard-only, `admin*`-prefixed repository read so that no counting SQL leaves the `src/db/` layer. For the FTS-search branch the count SHALL be the number of rows matching the search expression **within the current scope/status/type filter** — mirroring the client-side filter the list applies to the FTS page — not the raw match count (which would over-report by including superseded/out-of-scope rows the list drops) and not the page slice; for the `needs_review`-only branch it SHALL be the number of active rows deriving `needs_review` for the active project filter.

For the single combination of `review = needs_review` AND a non-empty free-text query — where review state is derived after the page slice rather than in SQL — the `TOTAL` chip SHALL render the page-slice count suffixed with `+` (a "at least N" lower bound) rather than an inexact exact-looking number.

**The free-text query SHALL be sanitized before it reaches the `memory_fts` `MATCH` expression**, using the same sanitizer as `memory.search`'s hybrid retrieval, so that ordinary punctuation (an apostrophe, a stray quote, a hyphenated word) degrades to no lexical match rather than raising an FTS5 syntax error. The search input SHALL redisplay the operator's original, unsanitized text — not the transformed match expression.

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

#### Scenario: TOTAL counts FTS matches within the active filter set, not just the page

- **GIVEN** 53 `active` memories match the free-text query `q` with the page size at 10, plus additional superseded/archived (or out-of-scope) rows that also match `q`
- **WHEN** the operator submits that query on `/dashboard/memories` under the default `status = active` filter
- **THEN** the header `TOTAL` chip SHALL read `53` — the FTS matches within the current scope/status/type filter, mirroring the rows the list shows — and SHALL NOT read the raw match count that includes the superseded/out-of-scope rows
- **AND** the `SHOWING` indicator SHALL read `10 ROWS`

#### Scenario: needs_review combined with search renders a lower-bound total

- **GIVEN** `review = needs_review` AND a non-empty free-text query, and the current page is full (10 rows after the in-process review filter)
- **WHEN** the operator views `/dashboard/memories` under that combination
- **THEN** the header `TOTAL` chip SHALL render the page-slice count suffixed with `+` (e.g. `10+`)
- **AND** it SHALL NOT render an exact-looking number that under- or over-states the match set

#### Scenario: A search query containing FTS5 metacharacters does not crash the page

- **GIVEN** the operator types `docker-compose?` or `what's the deploy plan` into the memories search box
- **WHEN** the query is submitted
- **THEN** the page SHALL render normally (no 500), showing matches for the sanitized terms
- **AND** the search input SHALL redisplay exactly what the operator typed, not the sanitized match expression

### Requirement: The dashboard MUST surface a prompts list view at `/dashboard/prompts`

A logged-in dashboard user SHALL see a list of curated user prompts for the active project (or globally when no project is selected). The list SHALL include columns for title (cascade `title → content[truncated to 80 chars] → shortId`), project slug, session short id (link to session detail when present), agent, tags (comma-separated), and created_at. The list SHALL NOT include a prompt id column.

The view SHALL paginate at 50 rows per page (`PAGE_SIZE` shared constant). The view SHALL support a free-text query box that submits as the `q` query parameter; when non-empty, the server-side handler SHALL use the FTS5 `prompts_fts` index (matching against `content` + `tags`). The view SHALL support filters by `project_slug`, `session_id` (shortId match), and `agent`.

**The free-text query SHALL be sanitized before it reaches the `prompts_fts` `MATCH` expression**, using the same sanitizer as `memory.search`'s hybrid retrieval, so that ordinary punctuation degrades to no lexical match rather than raising an FTS5 syntax error. The search input SHALL redisplay the operator's original, unsanitized text — not the transformed match expression.

#### Scenario: A search query containing an apostrophe or question mark does not crash the page

- **GIVEN** the operator types `what's the plan?` into the prompts search box
- **WHEN** the query is submitted
- **THEN** the page SHALL render normally (no 500), showing matches for the sanitized terms
- **AND** the search input SHALL redisplay exactly what the operator typed, not the sanitized match expression
