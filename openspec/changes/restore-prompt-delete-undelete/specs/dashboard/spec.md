## MODIFIED Requirements

### Requirement: The dashboard MUST surface a prompts list view at `/dashboard/prompts`

A logged-in dashboard user SHALL see a list of curated user prompts for the selected project, or across all projects when no project is selected. The list SHALL include columns for title (cascade `title → content[truncated to 80 chars] → shortId`), project slug, session short id (link to session detail when present), agent, tags (comma-separated), and created_at. The list SHALL NOT include a prompt id column. Every prompt belongs to a project, so the project-slug column SHALL always be populated.

The view SHALL paginate at 50 rows per page (`PAGE_SIZE` shared constant). The view SHALL support a free-text query box that submits as the `q` query parameter; when non-empty, the server-side handler SHALL use the FTS5 `prompts_fts` index (matching against `content` + `tags`). The view SHALL support filters by `project_slug`, `session_id` (shortId match), and `agent`.

**The free-text query SHALL be sanitized before it reaches the `prompts_fts` `MATCH` expression**, using the same sanitizer as `memory.search`'s hybrid retrieval, so that ordinary punctuation degrades to no lexical match rather than raising an FTS5 syntax error. The search input SHALL redisplay the operator's original, unsanitized text — not the transformed match expression.

Each row SHALL render an operator action: a live row SHALL render a `Delete` form (soft-delete, action `prompt.delete`) gated by the reversible-confirmation dialog with `warn` tone, the label `DELETE PROMPT`, and a sentence naming the consequence (hidden from default lists, `memory.context.recentPrompts` and `memory.search_prompts`; restorable via Undelete). A row whose `deleted_at` is NOT NULL, visible under `?include_deleted=1`, SHALL render an `Undelete` form (action `prompt.undelete`) instead of the `Delete` form; `Undelete` is reversible and SHALL NOT be confirmation-gated. Each form SHALL carry a CSRF field bound to its own form name and the row id, and each Server Action SHALL verify the dashboard session, the admin scope and that CSRF token before any service call, so a submission that fails any of the three SHALL leave the row untouched. A row whose `replaces` is not NULL AND whose `deleted_at` is not NULL SHALL render a `REFINED` badge instead of the default `DELETED` indicator — the `replaces` link encodes that the deletion was the consequence of an agent-driven refine, not an operator action.

The view SHALL NOT include a detail page at `/dashboard/prompts/:id` in this revision; long contents SHALL be expandable inline via an HTMX `<details>` toggle.

#### Scenario: An operator opens the prompts list

- **WHEN** an authenticated admin operator navigates to `/dashboard/prompts`
- **THEN** the server SHALL return a paginated list of the 50 most recent prompts (active and not-deleted) ordered by `created_at DESC`
- **AND** each row SHALL include the documented columns, with a populated project slug
- **AND** the table header SHALL NOT contain a `<th>` labelled `id`
- **AND** each row SHALL include a `Delete` form whose button opens the confirmation dialog

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
- **AND** `P2`'s row SHALL NOT render a `Delete` form

#### Scenario: A refined prompt renders a REFINED badge

- **GIVEN** prompt `P1` was refined: its `deleted_at IS NOT NULL` and there exists a successor `P2` with `P2.replaces = ['<P1.id>']`
- **WHEN** the operator navigates to `/dashboard/prompts?include_deleted=1`
- **THEN** `P1`'s row SHALL render a `REFINED` badge (NOT the default `DELETED` indicator)

#### Scenario: Delete form opens the confirmation modal

- **GIVEN** an authenticated admin operator viewing the prompts list
- **WHEN** the operator clicks the `Delete` button of a row
- **THEN** the row's confirmation dialog SHALL open with the reusable warn-tone confirmation and the `DELETE PROMPT` label
- **AND** the triggering control SHALL NOT submit the form on its own
- **AND** the form SHALL submit only after the operator confirms via the dialog

#### Scenario: A refused submission never reaches the service

- **GIVEN** a `prompt.delete` or `prompt.undelete` submission
- **WHEN** the submission carries no dashboard session, a session minted from a non-admin token, no CSRF token, or a CSRF token minted for the other prompts form
- **THEN** the action SHALL return the refusal instead of redirecting
- **AND** the target row's `deleted_at` SHALL be unchanged

#### Scenario: Soft-delete and restore round-trip through their flashes

- **GIVEN** an authenticated admin operator and a live prompt `P1`
- **WHEN** the operator confirms `Delete` on `P1` and then confirms nothing further
- **THEN** `P1.deleted_at` SHALL be set and the redirect SHALL land on `/dashboard/prompts?deleted=P1`
- **AND** the page SHALL flash `Prompt P1 soft-deleted.` with a link to `?include_deleted=1`
- **AND** undeleting `P1` SHALL clear `P1.deleted_at` and land on `/dashboard/prompts?undeleted=P1`, flashing `Prompt P1 restored.`

#### Scenario: Soft-delete and restore are idempotent

- **GIVEN** an authenticated admin operator and a prompt `P1`
- **WHEN** `prompt.delete` runs twice on `P1`, or `prompt.undelete` runs on a live `P1`
- **THEN** the second submission SHALL still redirect to its own flash query
- **AND** `P1.deleted_at` SHALL keep the value the first transition set

#### Scenario: A search query containing an apostrophe or question mark does not crash the page

- **GIVEN** the operator types `what's the plan?` into the prompts search box
- **WHEN** the query is submitted
- **THEN** the page SHALL render normally (no 500), showing matches for the sanitized terms
- **AND** the search input SHALL redisplay exactly what the operator typed, not the sanitized match expression
