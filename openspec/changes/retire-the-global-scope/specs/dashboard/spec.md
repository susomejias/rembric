## ADDED Requirements

### Requirement: No operator filter MAY offer a scope that does not exist

Every scope filter on the operator surface SHALL offer only `all scopes` plus one entry per project. The `global only` option and its `__global__` sentinel value SHALL be removed from every filter that carries them, and no view SHALL render a scope pill distinguishing `GLOBAL` from `PROJECT`, because after the retirement every row is a project row and the pill carries no information.

A filter option that selects nothing is worse than a missing one: an operator who picks it sees an empty table and cannot tell whether the scope is empty or the filter is broken. The default project appears in these filters under its own slug like any other project.

Where a session, prompt or entity row previously rendered a `global` label because it carried no project, it SHALL now render its project's slug, because every such row is repointed by migration.

#### Scenario: The scope filter offers no global option

- **WHEN** the operator opens the memories list or the sessions list
- **THEN** the project filter SHALL contain `all scopes` plus one option per project, and SHALL NOT contain a `global only` option or a `__global__` value

#### Scenario: The stale sentinel is not silently accepted

- **WHEN** a request arrives carrying `?project=__global__` from a bookmarked URL
- **THEN** the page SHALL render without error and SHALL NOT filter to an empty set on the strength of a scope that no longer exists

#### Scenario: No row renders a global scope label

- **WHEN** the memories list, a memory detail page, the sessions list, a session detail page, the prompts list and the entity view are rendered over a populated database
- **THEN** none SHALL render the text `GLOBAL` or a `— (global)` placeholder, and every row SHALL name a project slug

## MODIFIED Requirements

### Requirement: The dashboard MUST surface a sessions list view at `/dashboard/sessions`

A logged-in dashboard user SHALL see a list of recent sessions for the selected project, or across all projects when no project is selected. Every session belongs to a project, so the list SHALL render each row's project slug and SHALL NOT render a scope pill or a `— (global)` placeholder in place of one. The list SHALL include columns for title, agent, started_at, ended_at, status, a memory count (number of `memory` rows with that `session_id`), and a prompt count (number of `prompts` rows with that `session_id` AND `deleted_at IS NULL`). The list SHALL NOT include a session id column; the `title` cell carries the row's anchor to `/dashboard/sessions/:id`.

The list SHALL be ordered with `status = 'active'` rows first, then all remaining rows; within each group rows SHALL be ordered by `started_at DESC`. The ordering SHALL be applied in the SQL query (before `LIMIT`/`OFFSET`) so pagination respects it. The soft-deleted table shown under `?include_deleted=1` keeps plain `started_at DESC`.

The view SHALL provide a filter bar (matching the memories-list pattern) with controls for project, agent, and status. The project control SHALL offer `all scopes` plus one option per project and SHALL NOT offer a `global only` option (see "No operator filter MAY offer a scope that does not exist"). Filters SHALL be applied server-side in the repository query (affecting rows, pagination, and the header total alike) and SHALL apply to the non-deleted table only; the `include_deleted` toggle is unchanged. Each filter control SHALL have an associated `<label>`.

The `title` column SHALL render using the cascade `row.title ?? row.description ?? shortId(row.id)`. The cascade SHALL NOT short-circuit on placeholder titles (e.g. `'rembric · 22:14 UTC'`) — those count as real titles for the purpose of display, because they are still more informative than `shortId` alone. The cascade ensures legacy rows (where `title` is NULL because they predate the column migration) still get a sensible value.

The title column SHALL be the first visible content column and SHALL truncate with `text-overflow: ellipsis` past ~40 chars to keep the table compact. The full title SHALL be available as the cell's `title` attribute (HTML tooltip) so operators can hover to see the full string.

The memory count and the prompt count SHALL be rendered as two separate right-aligned columns (`memories`, `prompts`). The detail view at `/dashboard/sessions/:id` SHALL render BOTH a `Memories (N)` and a `Prompts (N)` table — memories first, prompts below.

#### Scenario: A dashboard user navigates to `/dashboard/sessions`

- **WHEN** the user is authenticated with an admin token and visits `/dashboard/sessions`
- **THEN** the server SHALL return a paginated list of 50 sessions ordered active-first then `started_at DESC`, with each row linking to `/dashboard/sessions/:id` via `data-href` and via the `title` cell's anchor
- **AND** each row SHALL include a `title` column rendered via the documented cascade
- **AND** each row SHALL include both a `memories` count column and a `prompts` count column
- **AND** each row's project cell SHALL name a project slug, never a scope pill
- **AND** the table header SHALL NOT contain a `<th>` labelled `id`

#### Scenario: Filtering sessions by agent and status

- **GIVEN** sessions from agents `claude-code` and `opencode` in statuses `active` and `ended`
- **WHEN** the operator applies `?agent=claude-code&status=ended`
- **THEN** the table SHALL contain only `claude-code`/`ended` rows, the pager SHALL paginate the filtered set, and the header total SHALL equal the filtered count

#### Scenario: Active sessions sort above ended ones regardless of age

- **GIVEN** an active session `A` started three days ago and an ended session `E` started one hour ago
- **WHEN** the operator navigates to `/dashboard/sessions`
- **THEN** `A`'s row SHALL appear before `E`'s row
- **AND** two active sessions SHALL order between themselves by `started_at DESC`

#### Scenario: Session with a model-authored title

- **GIVEN** a session whose `sessions.title = 'Fix Stop→SessionEnd bug'`
- **WHEN** the list view renders that row
- **THEN** the title cell SHALL display `'Fix Stop→SessionEnd bug'` (truncated with ellipsis past ~40 chars; full string in `title` attribute)

#### Scenario: Legacy session with no title

- **GIVEN** a session predating the `title` column migration, with `sessions.title = NULL` and `description = NULL`
- **WHEN** the list view renders that row
- **THEN** the title cell SHALL fall back to `shortId(row.id)`

#### Scenario: Session with description but no title

- **GIVEN** a session with `title = NULL` and `description = 'investigate auth bug'`
- **WHEN** the list view renders that row
- **THEN** the title cell SHALL display `'investigate auth bug'`

#### Scenario: A dashboard user opens a session detail page

- **WHEN** the user navigates to `/dashboard/sessions/:id` for an accessible session
- **THEN** the page SHALL display: the title as the `<h1>` (via the same cascade as the list view), the session metadata (agent, project, token name, started_at, ended_at, status), the verbatim `summary` text, a table of memories whose `session_id` matches, AND a table of prompts whose `session_id` matches AND `deleted_at IS NULL` rendered below the memories table
- **AND** the `Project` field SHALL name a project slug rather than a `— (global)` placeholder

#### Scenario: A session was created by a now-revoked token

- **WHEN** the underlying token has been revoked but the session row still exists
- **THEN** the detail page SHALL still render and SHALL show the token name with a "(revoked)" suffix; the session SHALL not be hidden from the list

#### Scenario: Prompts count column reflects non-deleted prompts only

- **GIVEN** session `S` has 5 prompts: 3 with `deleted_at IS NULL` and 2 with `deleted_at IS NOT NULL`
- **WHEN** the list view renders `S`'s row
- **THEN** the `prompts` column SHALL display `3`

### Requirement: The dashboard MUST surface a prompts list view at `/dashboard/prompts`

A logged-in dashboard user SHALL see a list of curated user prompts for the selected project, or across all projects when no project is selected. The list SHALL include columns for title (cascade `title → content[truncated to 80 chars] → shortId`), project slug, session short id (link to session detail when present), agent, tags (comma-separated), and created_at. The list SHALL NOT include a prompt id column. Every prompt belongs to a project, so the project-slug column SHALL always be populated.

The view SHALL paginate at 50 rows per page (`PAGE_SIZE` shared constant). The view SHALL support a free-text query box that submits as the `q` query parameter; when non-empty, the server-side handler SHALL use the FTS5 `prompts_fts` index (matching against `content` + `tags`). The view SHALL support filters by `project_slug`, `session_id` (shortId match), and `agent`.

**The free-text query SHALL be sanitized before it reaches the `prompts_fts` `MATCH` expression**, using the same sanitizer as `memory.search`'s hybrid retrieval, so that ordinary punctuation degrades to no lexical match rather than raising an FTS5 syntax error. The search input SHALL redisplay the operator's original, unsanitized text — not the transformed match expression.

Each row SHALL render a `Delete` form (soft-delete, `data-confirm-tone="warn"`, action `prompt.delete`). Rows shown under `?include_deleted=1` SHALL additionally render an `Undelete` form (action `prompt.undelete`). A row whose `replaces` is not NULL AND whose `deleted_at` is not NULL SHALL render a `REFINED` badge instead of the default `DELETED` indicator — the `replaces` link encodes that the deletion was the consequence of an agent-driven refine, not an operator action.

The view SHALL NOT include a detail page at `/dashboard/prompts/:id` in this revision; long contents SHALL be expandable inline via an HTMX `<details>` toggle.

#### Scenario: An operator opens the prompts list

- **WHEN** an authenticated admin operator navigates to `/dashboard/prompts`
- **THEN** the server SHALL return a paginated list of the 50 most recent prompts (active and not-deleted) ordered by `created_at DESC`
- **AND** each row SHALL include the documented columns, with a populated project slug
- **AND** the table header SHALL NOT contain a `<th>` labelled `id`
- **AND** each row SHALL include a `Delete` form using `data-confirm` modal attributes on the `<form>` element

#### Scenario: An operator searches prompts by content

- **GIVEN** prompts exist with content "deploy via Docker Compose" and "refactor the auth middleware"
- **WHEN** the operator submits `?q=deploy` on `/dashboard/prompts`
- **THEN** the server SHALL return only the first prompt
- **AND** the SQL query SHALL use a `JOIN` against `prompts_fts MATCH 'deploy'`

#### Scenario: An operator filters by session

- **GIVEN** session `S1` has 3 prompts and session `S2` has 1 prompt
- **WHEN** the operator submits `?session=<S1-shortId>`
- **THEN** the response SHALL contain exactly the 3 prompts whose `session_id = S1.id`

#### Scenario: Soft-deleted prompts are hidden by default

- **GIVEN** prompts `P1`, `P2` exist and `P2.deleted_at IS NOT NULL`
- **WHEN** the operator navigates to `/dashboard/prompts`
- **THEN** the response SHALL contain `P1` and SHALL NOT contain `P2`

#### Scenario: `?include_deleted=1` reveals deleted prompts with Undelete actions

- **GIVEN** prompts `P1`, `P2` exist and `P2.deleted_at IS NOT NULL`
- **WHEN** the operator navigates to `/dashboard/prompts?include_deleted=1`
- **THEN** the response SHALL contain both prompts
- **AND** `P2`'s row SHALL render an `Undelete` form using CSRF action `prompt.undelete`

#### Scenario: A refined prompt renders a REFINED badge

- **GIVEN** prompt `P1` was refined: its `deleted_at IS NOT NULL` and there exists a successor `P2` with `P2.replaces = ['<P1.id>']`
- **WHEN** the operator navigates to `/dashboard/prompts?include_deleted=1`
- **THEN** `P1`'s row SHALL render a `REFINED` badge (NOT the default `DELETED` indicator)

#### Scenario: Delete form opens the confirmation modal

- **GIVEN** an authenticated admin operator viewing the prompts list
- **WHEN** the operator clicks the `Delete` button of a row
- **THEN** the global `#rbr-confirm` dialog SHALL open with `data-confirm-tone="warn"` styling
- **AND** the form SHALL submit only after the operator confirms via the dialog

#### Scenario: A search query containing an apostrophe or question mark does not crash the page

- **GIVEN** the operator types `what's the plan?` into the prompts search box
- **WHEN** the query is submitted
- **THEN** the page SHALL render normally (no 500), showing matches for the sanitized terms
- **AND** the search input SHALL redisplay exactly what the operator typed, not the sanitized match expression

### Requirement: The dashboard MUST expose accumulated knowledge per entity

An operator cannot currently tell where a project's memory is dense and where it is blind. The dashboard SHALL provide an entity view listing entities with their linked-memory counts, filterable by entity kind and sorted by count, with each entity linking to the memories that reference it.

The view SHALL surface the inverse signal as well — the most-referenced entities are interesting, but entities referenced exactly once are the more actionable list, because they mark knowledge that never converged into a maintained topic.

The view SHALL be **cross-project with an explicit project label** rather than project-isolated: every row carries the project slug it belongs to. No row SHALL be labelled `global`, because every entity belongs to a project. The dashboard is a single operator behind one admin token and `/dashboard/memories` already lists every project on one page, so isolating this one view would be inconsistent with the surface it sits in and would hide exactly the cross-project density comparison the view exists to make. Project isolation is an AGENT-facing guarantee, structurally held by `memory_entities_identity_idx` (see the `persistence` capability): the same literal string in two projects is two rows, so no cross-project join exists for an operator view to leak. A per-project filter remains a legitimate later request; it is not a missing part of this requirement.

#### Scenario: Entities are listed with their counts

- **WHEN** the operator opens the entity view
- **THEN** entities SHALL be listed with their linked-memory counts and their kinds

#### Scenario: An entity links to its memories

- **WHEN** the operator selects an entity
- **THEN** the memories linked to it SHALL be listed using the existing memories view and its filters

#### Scenario: Single-reference entities are reachable

- **WHEN** the operator filters for entities referenced exactly once
- **THEN** those entities SHALL be listed

#### Scenario: Every row names its scope

- **GIVEN** an entity present only in one project and an entity present only in the default project
- **WHEN** the operator opens the entity view
- **THEN** both SHALL appear, each labelled with its own project slug
- **AND** no row SHALL be labelled `global`
