## ADDED Requirements

### Requirement: The dashboard home page MUST surface a recent-judgments block

The `/dashboard` overview page SHALL render a `RECENT JUDGMENTS` block as the left tile of its `.row-2` strip (the position previously occupied by the `PENDING JUDGMENTS` inline list). The block SHALL load the four most recently judged rows of `memory_relations` ordered by `judged_at DESC`, restricted to `status = 'judged'`. The block SHALL NOT include rows whose status is `pending` or `orphaned`.

Each row SHALL render, in order:

- A verdict pill produced by the shared `verdictPill(relation)` helper exported from `apps/server/src/dashboard/templates.ts`, which renders `<span class="pill k-{relation}">{relation}</span>` using the existing relation-kind classes (`k-supersedes`, `k-conflicts_with`, `k-related`, `k-compatible`, `k-scoped`, `k-not_conflict`). The same helper SHALL be used by every other dashboard surface that displays a verdict — no inline `pill k-…` HTML in templates. The pill itself SHALL NOT be wrapped in an anchor (to avoid click conflicts with the memory anchors inside the row); a dedicated `VIEW →` button (`btn({variant:'primary', size:'sm', href:'/dashboard/judgments/{id}'})`) in the row's `.acts` slot SHALL be the operator's path to the judgment detail view.
- The `judged_at` timestamp rendered as a relative-time string (e.g. `3M AGO`, `2H AGO`) consistent with the adjacent `RECENT SESSIONS` tile, and the `marked_by_kind` value (one of `agent`, `agent_topic_key`, `consolidator`, `system`) — when present — rendered in dim text. The row SHALL NOT render the judgment's short id as standalone text on the meta line; the only way to identify the judgment from the home tile is the linked verdict pill described above.
- One source memory line: the source memory's `content` truncated to 70 characters, wrapped in an `<a class="txt" href="/dashboard/memories/{sourceId}">` element. The short id is NOT rendered alongside (the link target carries it). The anchor SHALL be rendered in the brand lime accent (`color: var(--lime)`) via a scoped CSS rule in `styles/views/home.css`, with an underline on hover, so it reads as a link at a glance.
- One target memory line, prefixed with the existing `↳` arrow span: the target memory's `content` truncated to 70 characters, wrapped in an `<a class="txt" href="/dashboard/memories/{targetId}">` element, styled identically (lime + hover-underline).
- A right-aligned `.acts` slot containing a single `VIEW →` button — an `<a class="btn primary sm" href="/dashboard/judgments/{id}">` produced by the shared `btn` helper — that takes the operator to the judgment detail page.

The block SHALL NOT render any per-row action button (no `JUDGE` button or equivalent affordance) — every row is a closed verdict.

The block's section header SHALL read `RECENT JUDGMENTS` with the meta `NEWEST FIRST`, and SHALL include an `OPEN ALL ›` anchor whose `href` is `/dashboard/judgments` (the unfiltered default view).

When no judged rows exist for the active scope, the block SHALL render the empty-state cell `NO JUDGMENTS YET`.

#### Scenario: Operator sees recent judgments on the home overview

- **WHEN** an authenticated operator navigates to `/dashboard` and at least one `memory_relations` row exists with `status='judged'`
- **THEN** the response HTML SHALL contain a section header reading `RECENT JUDGMENTS` followed by between 1 and 4 rows, each containing a `pill k-{relation}` element matching that row's `relation`, two `<a href="/dashboard/memories/{id}">` anchors (one per source / target memory) wrapping the truncated content, and a relative-time string for `judged_at` matching `/^(NOW|\d+(M|H|D|MO) AGO)$/`

#### Scenario: Empty home overview renders the new empty-state copy

- **WHEN** an authenticated operator navigates to `/dashboard` and no `memory_relations` rows exist with `status='judged'`
- **THEN** the response HTML SHALL contain the literal string `NO JUDGMENTS YET` inside an element with class `tbl-empty`, and SHALL NOT contain the legacy string `NO PENDING JUDGMENTS YET`

#### Scenario: Recent-judgments block excludes pending and orphaned

- **WHEN** the home overview is rendered with a mix of `pending`, `judged`, and `orphaned` rows in `memory_relations`
- **THEN** the rendered `RECENT JUDGMENTS` block SHALL contain only rows whose `status='judged'`; the rendered output SHALL NOT contain any `pill k-pending` element inside the block

#### Scenario: Recent-judgments block has no per-row JUDGE button

- **WHEN** the home overview is rendered with at least one judged row
- **THEN** the `RECENT JUDGMENTS` block SHALL NOT contain any element with class `acts` or any anchor whose href is `/dashboard/judgments` rendered *inside* a row (the only `OPEN ALL ›` anchor SHALL be the one in the section header)

### Requirement: The dashboard MUST surface a judgment detail view at `/dashboard/judgments/:id`

The dashboard SHALL serve a per-row detail page at `/dashboard/judgments/:id` (where `:id` is the `memory_relations.id` primary key). The page SHALL load the judgment row alongside the source and target memory contents (JOIN over `memory` twice) and SHALL render:

- A `viewHead` whose title is `Rembric Judgment {shortId}.` with `Rembric` highlighted via `hl-lime`, and whose meta strip exposes `STATUS` and `VERDICT`.
- A `BACK TO JUDGMENTS` back-link to `/dashboard/judgments`.
- A stat grid with six cards: Status (rendered via `statusPill`), Verdict (rendered via `verdictPill`), Confidence, Marked by (`marked_by_kind` + `marked_by_actor`), Created (`formatTs(created_at)`), Judged (`formatTs(judged_at)` or em-dash when null).
- A `Source` section with the source memory's short id rendered as an anchor to `/dashboard/memories/{sourceId}` followed by a `<pre>` block with the full untruncated source content.
- A `Target` section structured identically for the target memory.
- A `Reason` section showing the verbatim `reason` text or an em-dash when null.
- An `Evidence` section showing the `evidence` JSON pretty-printed inside a `<pre>` block, or an em-dash when null.
- A `Judgment id` section showing the opaque `judgment_id` token in mono.
- An `Actions` section: when `status='pending'` the section SHALL render the existing `judgment.orphan` form (CSRF-protected, `data-confirm-tone="danger"`); otherwise it SHALL render a muted "No actions available — this judgment is closed." line.

When the `:id` does not match any row, the page SHALL respond with `404 Not Found` and a `Judgment not found.` flash, using the standard dashboard shell.

#### Scenario: Operator opens a judgment detail page

- **WHEN** an authenticated operator navigates to `/dashboard/judgments/{id}` where `id` matches an existing `memory_relations.id`
- **THEN** the server SHALL return a `200` HTML response whose heading reads `Rembric Judgment {shortId}.`, and whose body contains the source memory's full content inside a `<pre>` block, the target memory's full content inside a `<pre>` block, anchors to both `/dashboard/memories/{sourceId}` and `/dashboard/memories/{targetId}`, and the verdict pill rendered via `verdictPill`

#### Scenario: Judgment detail returns 404 for unknown ids

- **WHEN** an authenticated operator navigates to `/dashboard/judgments/non-existent-id`
- **THEN** the server SHALL respond with `404 Not Found` and the response body SHALL contain the flash text `Judgment not found.`

#### Scenario: Recent-judgments tile exposes a VIEW button to the detail page

- **WHEN** the home overview is rendered with at least one judged row
- **THEN** each row SHALL contain a `.btn.primary.sm` anchor labelled `VIEW →` inside the row's `.acts` slot, whose `href` is `/dashboard/judgments/{id}` (where `{id}` is the corresponding `memory_relations.id`)
- **AND** the verdict pill itself SHALL NOT be wrapped in an anchor (no click conflict with the memory links in the row)

#### Scenario: Judgments list id column links to the detail page

- **WHEN** the operator navigates to `/dashboard/judgments` with at least one row present
- **THEN** each row's leftmost `id` cell SHALL contain an `<a href="/dashboard/judgments/{id}">` anchor wrapping the short id, where `{id}` is that row's `memory_relations.id`

## MODIFIED Requirements

### Requirement: The judgment-queue view MUST be served at `/dashboard/judgments`

The dashboard SHALL serve the operator-facing queue of memory-relation judgments at the URL `/dashboard/judgments`. The page SHALL list every row of `memory_relations` (status `pending`, `judged`, or `orphaned`), SHALL support filtering by status and verdict kind, and SHALL paginate results. The legacy path `/dashboard/relations` SHALL NOT respond; any request to it SHALL return the standard dashboard `404` body.

The page heading SHALL read `Rembric Judgments.` (with `Rembric` highlighted via `hl-lime`), the document `<title>` SHALL read `Judgments · Rembric`, the empty-state cell SHALL read `No judgments match this filter.`, the table column previously labelled `relation` SHALL be labelled `verdict`, and the orphan-not-found flash SHALL read `Judgment not found or already closed.`.

The `source → target` column SHALL render each side as an `<a href="/dashboard/memories/{id}">` anchor whose visible text is the corresponding memory's `content` truncated to 60 characters (not the memory's short id). The two anchors SHALL be separated by the `→` arrow as before. Short-id-only rendering is retained ONLY for the leftmost `id` column (the judgment's own id) and for any other surface that pre-dates this change.

The `verdict` column SHALL render via the shared `verdictPill(relation)` helper. When `relation` is non-null the cell SHALL contain a `<span class="pill k-{relation}">{relation}</span>` element (matching the home overview's `RECENT JUDGMENTS` tile). When `relation` is null (pending or orphaned rows) the cell SHALL contain the muted em-dash `<span class="muted">—</span>`. No inline `pill k-…` HTML SHALL exist in the judgments page template.

#### Scenario: Operator opens the judgment queue

- **WHEN** an authenticated operator navigates to `/dashboard/judgments`
- **THEN** the server SHALL return a `200` HTML response whose heading reads `Rembric Judgments.` and whose table column header for the relation kind reads `verdict`

#### Scenario: Legacy `/dashboard/relations` returns 404

- **WHEN** any authenticated request reaches `/dashboard/relations`
- **THEN** the server SHALL respond with `404 Not Found` (no redirect)

#### Scenario: Sidebar and home links to the judgments view

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar nav item labelled `JUDGMENTS` SHALL have `href="/dashboard/judgments"`
- **AND** the home overview `RECENT JUDGMENTS` section header `OPEN ALL ›` anchor SHALL link to `/dashboard/judgments` (the unfiltered default view)
- **AND** the home overview stat strip SHALL NOT include a `PENDING JUDGMENTS` stat card; pending counts are surfaced only via the sidebar badge on the `JUDGMENTS` nav entry

#### Scenario: CSRF action token uses the judgment vocabulary

- **WHEN** the operator submits the "mark this judgment as orphaned" form on the judgments page
- **THEN** the CSRF token issued by the form and the action verified by the server SHALL both be the string `judgment.orphan`

### Requirement: The dashboard home page MUST include a sessions counter

The `/dashboard` overview page SHALL surface a "Sessions (active)" stat card alongside the existing counters. The stat strip SHALL render exactly six cards in this order — `TOTAL`, `ACTIVE`, `SUPERSEDED`, `ARCHIVED`, `PROJECTS`, `ACTIVE SESSIONS` — inside a `.grid-6` container. The previously-rendered `PENDING JUDGMENTS` card has been removed: the LLM now resolves pending candidates inline via `memory.judge`, so an operator-facing counter adds visual noise without an actionable workflow. Pending counts remain accessible via the `JUDGMENTS` sidebar badge.

#### Scenario: The home page is rendered after sessions exist

- **WHEN** the user lands on `/dashboard` and one or more sessions have `status = 'active'`
- **THEN** the stat grid SHALL include a `Sessions (active)` card whose value is the count

#### Scenario: The home stat strip omits the PENDING JUDGMENTS card

- **WHEN** any authenticated operator navigates to `/dashboard`
- **THEN** the response HTML SHALL contain a `.grid-6` stat strip with exactly six `.stat` cards, and SHALL NOT contain a stat card labelled `PENDING JUDGMENTS`

#### Scenario: source → target column shows truncated memory content as links

- **WHEN** an authenticated operator navigates to `/dashboard/judgments` with at least one row present
- **THEN** each row's `source → target` column SHALL contain two `<a href="/dashboard/memories/{id}">` anchors whose visible text is the corresponding memory's `content` truncated to 60 characters, and SHALL NOT contain the memory's short id rendered as standalone text in that column

#### Scenario: verdict column reuses the shared verdict-pill component

- **WHEN** an authenticated operator navigates to `/dashboard/judgments` with at least one judged row present (relation set)
- **THEN** that row's `verdict` cell SHALL contain a `<span class="pill k-{relation}">{relation}</span>` element identical to the rendering used by the home overview's `RECENT JUDGMENTS` tile
- **AND** any pending or orphaned row's `verdict` cell SHALL contain only a `<span class="muted">—</span>` element
