# dashboard Specification

## Purpose

Defines the server-rendered web dashboard that lets operators authenticate, browse memories, inspect consolidation runs, and manage tokens — without a frontend build pipeline.

## Requirements

### Requirement: The dashboard MUST be served at `/dashboard`

The server SHALL serve a server-side rendered dashboard at the `/dashboard` path of the same process and port as the MCP endpoint. The dashboard SHALL be an application surface of `apps/web` whose route components are React Server Components, and every asset it references SHALL be served from this same origin: the framework's content-hashed build output (stylesheets, scripts, fonts) under its own static-asset path, and the dashboard's images (logo, favicons) from the application's `public/` tree. **No CDN dependency at runtime.** The `/dashboard/assets/` path SHALL continue to resolve for the committed images, which are served from `public/dashboard/assets/**`; the hand-written CSS bundles, the enumerated third-party JavaScript files and the hand-written font URLs that path used to carry are retired with the stack that served them.

#### Scenario: Dashboard home is reachable

- **WHEN** an authenticated operator navigates to `/dashboard`
- **THEN** the server SHALL return an HTML page with the layout, stats summary, and navigation rendered server-side

#### Scenario: Every served asset comes from this origin

- **WHEN** any dashboard page is loaded
- **THEN** every stylesheet, script, font and image it references SHALL be served from this application's own origin, and the page SHALL issue no request to any third-party host

#### Scenario: The committed images keep their published path

- **WHEN** the login page renders the brand logo
- **THEN** its `src` SHALL resolve to `/dashboard/assets/logo-transparent.png`, served from the application's public tree with no route handler in between

### Requirement: Dashboard access MUST require authentication

The dashboard SHALL require a valid signed session cookie to access any route other than `/dashboard/login`. The login route SHALL accept the admin token submitted via a form, validate it against the `tokens` table, and on success SHALL set an httpOnly, SameSite=Lax, signed cookie referencing a row in `dashboard_sessions`.

#### Scenario: Unauthenticated access redirects to login

- **WHEN** an unauthenticated request hits `/dashboard/memories`
- **THEN** the server SHALL respond with a 302 redirect to `/dashboard/login`

#### Scenario: Login with admin token

- **WHEN** the operator submits the admin token at `/dashboard/login`
- **THEN** the server SHALL validate the token, create a `dashboard_sessions` row, set the signed cookie, and redirect to `/dashboard`

#### Scenario: Logout

- **WHEN** the operator triggers logout
- **THEN** the corresponding `dashboard_sessions` row SHALL be deleted and the cookie SHALL be cleared

### Requirement: Memory browsing MUST support filters and pagination

The `/dashboard/memories` view SHALL support filtering by project, type, status, **review state**, and free-text search, and SHALL paginate results. All filtering SHALL be performed server-side; the filter form SHALL submit as a GET whose query string encodes every active filter, so a filtered page is a shareable URL and the browser's back button is correct. A client component MAY enhance the free-text control with debounced incremental search, but the server SHALL remain the only place where filtering, ordering, pagination and counting happen.

The view SHALL render review state in a dedicated `review` column (separate from `status`, because review is an orthogonal axis — a freshness signal, not a lifecycle value): each `active` row whose derived `reviewState = 'needs_review'` (derivation per the `memory` capability) SHALL show a `needs_review` badge in that column; all other rows SHALL show a neutral placeholder. The badge SHALL be rendered by the dashboard's shared badge component using the theme's review-state tone — no ad-hoc colour value is introduced outside the theme tokens. The filter form SHALL include a `review` control with values `(any)` (default) and `needs_review`; when `review = needs_review` the list SHALL show only `active` memories deriving `needs_review`, computed server-side with the per-type TTL pushed into SQL so pagination is correct, respecting the current project filter and preserving all active filters across pagination and filter changes.

The view header SHALL render a `TOTAL` meta chip whose value is the true count of rows matching the **current filter set** (the combined scope/status/type/review/search filters), independent of pagination — NOT the count of rows on the current page. The header SHALL also render a `SHOWING N ROWS` indicator carrying the page-slice count. The true count SHALL be computed by a dashboard-only, `admin*`-prefixed repository read so that no counting SQL leaves the data layer. For the FTS-search branch the count SHALL be the number of rows matching the search expression **within the current scope/status/type filter** — mirroring the client-side filter the list applies to the FTS page — not the raw match count (which would over-report by including superseded/out-of-scope rows the list drops) and not the page slice; for the `needs_review`-only branch it SHALL be the number of active rows deriving `needs_review` for the active project filter.

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

### Requirement: Memory detail MUST display the history chain

The `/dashboard/memories/:id` view SHALL display the memory's title, content, status, tags, scope, project, source, current confirmation count, `last_seen_at` (rendered via the shared timestamp helper), and a visualization of the `replaces` chain showing all predecessors with their titles, content snapshots, and timestamps. The page heading SHALL be the memory's `title` (not its id); the id SHALL remain available as a secondary metadata chip. For an `active` head whose type has a review TTL, the view SHALL additionally display the derived `reviewState` and `reviewAfter` (the latter rendered via the shared timestamp helper); these fields SHALL be omitted when the head is not `active` or its type has no TTL. When the memory has been superseded (`status = 'superseded'`), the view SHALL additionally render a forward link to its successor (the memory that superseded it, resolved via the existing successor lookup) labelled "Superseded by", pointing to that memory's detail page; this link SHALL be omitted for memories that are not `superseded` or whose successor cannot be resolved.

#### Scenario: Viewing a merged memory

- **GIVEN** memory M was created by merging predecessors A and B via consolidation
- **WHEN** an operator opens `/dashboard/memories/M`
- **THEN** the page SHALL show M's title as its heading, M's content, M's predecessor ids with their titles and content snapshots ordered chronologically, and an "Archive" action

#### Scenario: An active memory needing review shows its review state

- **GIVEN** an `active` memory whose derived `reviewState = 'needs_review'`
- **WHEN** the operator opens its detail view
- **THEN** the metadata block SHALL show `reviewState = needs_review` and the `reviewAfter` timestamp (via the shared timestamp helper)

#### Scenario: A superseded memory links forward to its successor

- **GIVEN** memory M has `status = 'superseded'` and memory N is the row that superseded it
- **WHEN** an operator opens `/dashboard/memories/M`
- **THEN** the page SHALL render a "Superseded by" link pointing to `/dashboard/memories/N`

#### Scenario: An active memory shows no successor link

- **GIVEN** memory M has `status = 'active'`
- **WHEN** an operator opens `/dashboard/memories/M`
- **THEN** the page SHALL NOT render a "Superseded by" link

#### Scenario: last_seen_at is always shown

- **GIVEN** any memory regardless of status or type
- **WHEN** an operator opens its detail view
- **THEN** the metadata block SHALL show `last_seen_at` rendered via the shared timestamp helper

### Requirement: Memory and judgment views MUST display the title

Wherever the dashboard lists or links to a memory, it SHALL show that memory's `title` as the primary label: the `/dashboard/memories` list rows, the predecessor entries on the detail view, and the source/target memory references on the judgment-queue (`/dashboard/judgments`) and judgment detail views. These labels SHALL use the stored `title` rather than a truncated `content` snippet.

#### Scenario: The memories list shows titles

- **WHEN** the operator opens `/dashboard/memories`
- **THEN** each row SHALL display the memory's `title` as its primary label rather than a `content` truncation

#### Scenario: The judgment queue shows titles

- **WHEN** the operator opens `/dashboard/judgments` and a relation references a source and target memory
- **THEN** each referenced memory SHALL be labelled by its `title` rather than a `content` truncation

### Requirement: Consolidation runs MUST be inspectable and reversible from the dashboard

The dashboard SHALL list consolidation runs at `/dashboard/consolidation` and SHALL show per-run details at `/dashboard/consolidation/:id` including each op with its recorded reasoning. Each op SHALL have an "Undo" action; each run SHALL have an "Undo entire run" action. The run detail SHALL render sweep summaries (`{"archives":N,"orphaned":M}`) as legible text and SHALL fall back to the raw stored text for runs whose summary does not match that shape. Scope cells in the runs listing and the run detail SHALL render the project slug when the scope refers to an existing project, falling back to the raw scope string otherwise.

#### Scenario: Undoing an op from the dashboard

- **WHEN** the operator clicks "Undo" on a merge op
- **THEN** the server SHALL execute the undo, the page SHALL update to show the op as reverted, and the affected memories SHALL be visible at `/dashboard/memories` in their restored state

#### Scenario: Reverted run is marked

- **GIVEN** every op of a run has been undone
- **WHEN** the operator visits `/dashboard/consolidation`
- **THEN** the run SHALL be visually marked as reverted in the listing

#### Scenario: Sweep summary renders legibly

- **GIVEN** a run whose summary is `{"archives":2,"orphaned":1}`
- **WHEN** the operator opens its detail page
- **THEN** the summary SHALL render as legible text stating 2 archived and 1 orphaned, not raw JSON

#### Scenario: Run scope shows the project slug

- **GIVEN** a run that swept scope `project:<id>` for an existing project with slug `my-app`
- **WHEN** the operator views the runs listing or that run's detail
- **THEN** the scope SHALL display `my-app` rather than the raw `project:<ULID>` string

### Requirement: Tokens MUST be manageable from the dashboard

The `/dashboard/tokens` view SHALL list existing tokens (name, scope, project, created_at, revoked_at, expires_at) and SHALL allow creating a new token (shown in plaintext exactly once) and revoking an existing token (setting `revoked_at`).

**Reach and access SHALL compose.** The create form SHALL carry two independent controls: a `project` control that selects zero, one, or many projects (empty → all projects; otherwise the selected project slugs) and an `access` selector offering `write` and `read`, with `write` as the pre-selected option. Neither control SHALL void the other. `access` SHALL apply to the whole selection — the form SHALL NOT offer a per-project verb. The combinations SHALL map onto the arms of the token scope grammar exactly:

| `project` selection | `access` | minted scope        | `tokens.project_id` | `token_projects` rows     |
| ------------------- | -------- | ------------------- | ------------------- | ------------------------- |
| empty               | `write`  | `*`                 | `NULL`              | none                      |
| empty               | `read`   | `read:*`            | `NULL`              | none                      |
| exactly one slug    | `write`  | `project:<id>`      | `<id>`              | none                      |
| exactly one slug    | `read`   | `read:project:<id>` | `<id>`              | none                      |
| two or more slugs   | `write`  | `projects`          | `NULL`              | one row per selected slug |
| two or more slugs   | `read`   | `read:projects`     | `NULL`              | one row per selected slug |

A single-project selection SHALL continue to mint the single-project arm rather than a one-member set, so no existing token shape becomes unreachable from the form and the existing project binding stays FK-enforced for the common case.

A project selection SHALL NOT be discarded under any combination, and every arm of the grammar — including `read:project:<id>`, `projects` and `read:projects` — SHALL be mintable from the form.

**An unrecognized scope field SHALL be rejected, not ignored.** A create request carrying the retired `scope` form field SHALL be refused with a flash error naming the `access` field, rather than minting a token whose reach differs from the request. Silently dropping a submitted field is the failure this requirement exists to remove.

**An absent `access` SHALL be refused, not defaulted.** A create request whose `access` is missing, empty, or any value other than `write` or `read` SHALL be refused with a flash error and SHALL NOT create a token row. The `write` default is a property of the rendered form only; the handler SHALL NOT reinstate it, because defaulting an omitted `access` silently picks the more privileged verb, and with no project selected that verb is `*` — the only scope the dashboard login accepts.

**The minted scope SHALL be stated back to the operator.** The one-time-view component SHALL render, alongside the plaintext secret, the scope that was actually persisted and every project it reaches (or that it is bound to no project). For a set-scoped token that means every member slug, not a count. The operator SHALL be able to see what they were handed without querying the database.

**The list SHALL render the project as a slug.** The `project` column SHALL show the slug of the project named by `tokens.project_id`, resolved at render time, and SHALL NOT render a project id. For a set-scoped token the cell SHALL render the slug of **every** member project, in slug-ascending order, and SHALL NOT render a project id or a bare count. A token with no project binding and no membership rows SHALL render `—`. A project that has been archived SHALL still resolve to its slug.

**A token whose project binding does not resolve SHALL be marked distinctly.** A row whose scope names a project (`project:` or `read:project:`) that is not the id of an existing project authorizes nothing. Its state SHALL be rendered as its own value, distinct from both `active` and `revoked`, and its `project` cell SHALL render `—`.

**A set-scoped token with no members SHALL be marked distinctly from that state.** A `projects` or `read:projects` row with zero `token_projects` rows also authorizes nothing, but SHALL NOT be rendered as the unresolvable state, because the unresolvable state carries a contract that the row is never to be repaired while an empty set is repairable by the operator. Its state SHALL be its own value, distinct from `active`, `revoked` and the unresolvable state, and its `project` cell SHALL render `—`.

State precedence SHALL be `revoked`, then `expired`, then unresolvable, then empty-set, then `active`.

**Creating a project from this form is an operator action, not a token capability.** The form's handler runs under an admin dashboard session, so creating a project row here SHALL remain permitted. This does not grant the _minted_ token any authority to create projects; see `auth` — "A set-scoped token MUST NOT be able to create a project".

Creating a token is not a destructive action and SHALL NOT require the confirmation modal; the existing revoke action SHALL keep its `data-confirm` danger-tone modal. This requirement introduces no new design tokens: the multi-selection control SHALL be styled with the existing `:root` token set only.

#### Scenario: Creating a token

- **WHEN** the operator submits the new-token form
- **THEN** the server SHALL generate a token, store its hash in `tokens`, and render the plaintext token exactly once in a one-time-view component

#### Scenario: Revoking a token

- **WHEN** the operator clicks "Revoke" on a token
- **THEN** the corresponding row SHALL have `revoked_at` set; subsequent MCP requests using that token SHALL be rejected

#### Scenario: A project selection with default access mints a working project-scoped token

- **GIVEN** an authenticated operator and an existing project `alpha`
- **WHEN** the operator submits the form with `project = alpha` and `access = write`
- **THEN** the persisted row SHALL have `scope = 'project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** the returned plaintext SHALL be authorized against project `alpha`

#### Scenario: A project selection with read access mints `read:project:<id>`

- **GIVEN** an authenticated operator and an existing project `alpha`
- **WHEN** the operator submits the form with `project = alpha` and `access = read`
- **THEN** the persisted row SHALL have `scope = 'read:project:' || <id of alpha>` and `project_id = <id of alpha>`

#### Scenario: A project selection is never discarded by the access selector

- **GIVEN** an authenticated operator, an existing project `alpha`, and a second project `never-selected`
- **WHEN** the operator submits the form with `project = alpha` and `access = read`
- **THEN** the persisted scope SHALL name `alpha`
- **AND** the returned plaintext SHALL be rejected against `never-selected`

#### Scenario: No project selection mints a global token

- **WHEN** the operator submits the form with an empty `project` and `access = write`
- **THEN** the persisted row SHALL have `scope = '*'` and `project_id IS NULL`
- **AND** submitting an empty `project` with `access = read` SHALL persist `scope = 'read:*'` and `project_id IS NULL`

#### Scenario: Selecting several projects mints a set-scoped token

- **GIVEN** an authenticated operator and existing projects `alpha`, `beta`, `gamma`
- **WHEN** the operator submits the form selecting `alpha` and `gamma` with `access = write`
- **THEN** the persisted row SHALL have `scope = 'projects'` and `project_id IS NULL`
- **AND** `token_projects` SHALL contain exactly the ids of `alpha` and `gamma` for that token
- **AND** the returned plaintext SHALL be authorized against `alpha` and against `gamma`
- **AND** the returned plaintext SHALL be rejected against `beta`

#### Scenario: Selecting several projects with read access mints `read:projects`

- **GIVEN** an authenticated operator and existing projects `alpha`, `gamma`
- **WHEN** the operator submits the form selecting `alpha` and `gamma` with `access = read`
- **THEN** the persisted row SHALL have `scope = 'read:projects'` and `project_id IS NULL`
- **AND** the returned plaintext SHALL be authorized for a read-classified operation on `alpha` and refused a write-classified one on `alpha`

#### Scenario: A set-scoped token minted over every project is still not an admin token

- **GIVEN** an authenticated operator and exactly the projects `alpha`, `beta`, `gamma`
- **WHEN** the operator submits the form selecting all three with `access = write`
- **THEN** the persisted scope SHALL be `projects`, not `*`
- **AND** the returned plaintext SHALL be refused by `POST /dashboard/login`

#### Scenario: A single selection does not become a one-member set

- **GIVEN** an authenticated operator and an existing project `alpha`
- **WHEN** the operator submits the form selecting only `alpha` with `access = write`
- **THEN** the persisted row SHALL have `scope = 'project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** `token_projects` SHALL contain no row for that token

#### Scenario: The retired `scope` field is refused

- **WHEN** a create request arrives carrying a `scope` form field
- **THEN** the server SHALL respond with a flash error naming the `access` field and SHALL NOT create a token row

#### Scenario: An absent or unrecognized `access` is refused

- **WHEN** a create request arrives with no `access` field, an empty `access`, or a value other than `write` or `read`
- **THEN** the server SHALL respond with a flash error and SHALL NOT create a token row

#### Scenario: The one-time view states the minted scope

- **GIVEN** the operator has just created a token for project `alpha` with read access
- **THEN** the one-time-view component SHALL render the plaintext secret, the minted scope, and the slug `alpha`

#### Scenario: The one-time view enumerates every project of a set token

- **GIVEN** the operator has just created a token selecting `alpha` and `gamma`
- **THEN** the one-time-view component SHALL render the plaintext secret, the scope `projects`, and both slugs `alpha` and `gamma`

#### Scenario: The list shows the project slug, never the id

- **GIVEN** a token bound to a project whose slug is `alpha`
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the table SHALL contain a `project` header and a cell rendering `alpha`
- **AND** no cell SHALL render a project ULID

#### Scenario: The list enumerates every member of a set token

- **GIVEN** a set-scoped token whose members are the projects with slugs `alpha` and `gamma`
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** that row's `project` cell SHALL render both `alpha` and `gamma`, in that order
- **AND** the cell SHALL NOT render a project ULID
- **AND** the row's state SHALL render as `active`

#### Scenario: A token bound to an archived project still shows its slug

- **GIVEN** a token bound to a project that has since been archived
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the `project` cell SHALL render that project's slug rather than `—`

#### Scenario: A set token whose member has been archived still shows that slug

- **GIVEN** a set-scoped token whose members are `alpha` and `gamma`, where `gamma` has since been archived
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the `project` cell SHALL render both `alpha` and `gamma`

#### Scenario: An unresolvable project-scoped token is marked as neither active nor revoked

- **GIVEN** a token row with `scope = 'project:<a value that is not a project id>'` and `project_id IS NULL`, not revoked and not expired
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the row's state SHALL render as a value distinct from both `active` and `revoked`
- **AND** its `project` cell SHALL render `—`
- **AND** its `scope` cell SHALL still render the raw scope string

#### Scenario: A memberless set token is distinguished from an unresolvable one

- **GIVEN** a token row with `scope = 'projects'`, `project_id IS NULL` and zero `token_projects` rows, not revoked and not expired, alongside a token row with `scope = 'project:<a value that is not a project id>'`
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the two rows' states SHALL render as two different values, neither of which is `active` or `revoked`
- **AND** both rows' `project` cells SHALL render `—`

#### Scenario: Revocation outranks the unresolvable state

- **GIVEN** a revoked token row whose scope names a project that does not resolve
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the row's state SHALL render as `revoked`

#### Scenario: Revocation outranks the empty-set state

- **GIVEN** a revoked token row with `scope = 'projects'` and zero `token_projects` rows
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the row's state SHALL render as `revoked`

#### Scenario: An unknown project slug submitted to the create form

- **WHEN** a create request arrives with a `project` value that is not an existing project slug and that satisfies the strict slug regex
- **THEN** the server SHALL create the project row and bind the token to it
- **AND** a value that violates the slug regex SHALL be refused with a flash error and SHALL NOT create a token row

#### Scenario: One invalid slug in a multi-project submission refuses the whole request

- **GIVEN** an authenticated operator and an existing project `alpha`
- **WHEN** a create request arrives selecting `alpha` together with a value that violates the strict slug regex
- **THEN** the server SHALL respond with a flash error
- **AND** no token row SHALL be created
- **AND** no `token_projects` row SHALL be created

### Requirement: Mutating dashboard requests MUST be CSRF-protected

Every mutating dashboard interaction SHALL be protected against cross-site request forgery, and the server SHALL reject a mutating request whose protection check fails **before any service call**, leaving every row unchanged. The protection SHALL be the framework's own origin/host verification of Server Actions where that verification is demonstrated to refuse a cross-origin submission — and the dashboard's session-bound token checked inside the action boundary where it is not. Which of the two applies is a measured fact, not an assumption: this requirement describes the behaviour both must provide, and the implementation SHALL NOT claim the framework's protection until a probe has observed it refusing a cross-origin submission while a same-origin control succeeds. The retired mechanism is the string token minted into every form and checked by a route handler; a session-bound token kept inside the action boundary is a conforming implementation of this requirement.

#### Scenario: Missing CSRF token

- **WHEN** a `POST` reaches a dashboard mutation without the protection that applies to it — no valid session-bound token, or a request whose origin/host fails the framework's check
- **THEN** the server SHALL refuse it with `403 Forbidden`, SHALL NOT invoke the service, and SHALL NOT create or change any row

#### Scenario: A same-origin mutation still works

- **GIVEN** an authenticated dashboard session
- **WHEN** a same-origin form submission invokes a dashboard mutation with valid input
- **THEN** the mutation SHALL execute and no `403` SHALL be returned

#### Scenario: The protection is probed, not assumed

- **WHEN** the mutation protection mechanism is changed or the framework it depends on is upgraded
- **THEN** the suite SHALL contain a failing cross-origin case and a passing same-origin control, so a protection that has silently stopped protecting cannot pass

### Requirement: Destructive dashboard actions MUST gate submission with the confirmation modal

Every dashboard action whose submit triggers a destructive or hard-to-reverse server action — soft-delete, hard-delete/purge, revoke, archive, abandon, undo of a journaled op — SHALL be gated by the dashboard's confirmation dialog before its Server Action runs. The dialog SHALL be rendered once by the dashboard shell and opened by a client component; each call site SHALL declare three values to the action component:

- A **tone**: `warn` — for destructive actions the operator can revert through an existing UI path (e.g. soft-delete + undelete, archive + re-save, undo-of-undo); `danger` — for actions that cannot be unwound through the UI (e.g. hard-delete via maintenance purge, token revoke, hard undo of an op when the affected rows still exist but no further undo path exists).
- A **sentence**: a plain-language sentence ending in a question, naming the count (when applicable) and stating the consequence shape (reversible / irreversible / journaled).
- A **label**: the uppercase VERB + COUNT + NOUN ("PURGE 12 SESSIONS", "REVOKE TOKEN", "UNDO ENTIRE RUN") matching the action being taken, NOT a generic "OK".

The `data-confirm`, `data-confirm-label` and `data-confirm-tone` HTML attributes, the `form[data-confirm]` selector binding and the `htmx:afterSwap` rebind are retired with the stack that needed them; the three properties above are preserved as component props. A destructive control that declares no confirmation SHALL fail review.

The dialog is a client-side gate and SHALL NOT be the authorization boundary: the action SHALL remain safe when its form is submitted through the framework's no-JavaScript path, which means scope, admin gating, mutation protection and service-level preconditions SHALL be sufficient without it.

#### Scenario: A destructive form with attributes on the form opens the modal

- **GIVEN** a dashboard control whose action component declares a tone, a sentence and a label — the three declarations that replace the retired `data-confirm*` form attributes
- **WHEN** the operator triggers it
- **THEN** the confirmation dialog SHALL open with that sentence and label, and the Server Action SHALL run only after the operator confirms

#### Scenario: A destructive form with attributes only on the button submits without prompting (forbidden)

- **GIVEN** a destructive control that declares its confirmation somewhere no gate can read it — on the submit control rather than on the action — or that declares none at all
- **WHEN** the operator triggers it
- **THEN** the dialog SHALL NOT open and the action SHALL run immediately, which is a defect
- **AND** code review SHALL reject the pattern and move the declaration onto the action

#### Scenario: Tone selection matches undoability

- **WHEN** the form action is destructive but reversible through the UI (e.g. soft-delete via `deleted_at`)
- **THEN** the declared tone SHALL be `warn`
- **WHEN** the form action cannot be unwound through the UI (e.g. operator-purge via `/dashboard/maintenance`, token revoke)
- **THEN** the declared tone SHALL be `danger`

#### Scenario: A form-level rebind after an HTMX swap

- **WHEN** a destructive control is rendered after a client-side navigation or a partial re-render (the swap that used to inject new forms, and with them the re-binding step the retired attribute protocol needed)
- **THEN** the shell's dialog SHALL serve it with no re-binding step, so no rendered form can escape the gate by arriving late

#### Scenario: Authorization does not depend on the dialog

- **GIVEN** a destructive form submitted through the framework's no-JavaScript path
- **WHEN** the request reaches the action
- **THEN** the action's own scope, admin and mutation-protection checks SHALL decide the outcome, and the presence or absence of the dialog SHALL grant no authority

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

### Requirement: Dashboard timestamps MUST render in the viewer's local timezone

Every timestamp surfaced by the dashboard (memories list and detail, sessions list and detail, the soft-delete banner, prompts, consolidation runs and operations, projects, tokens, judgments, entities, maintenance, and the `replaces` chain on memory detail) SHALL be rendered through a single shared timestamp component that emits a `<time>` element with:

- A `datetime` attribute set to the ISO-8601 UTC representation (suffix `Z`) of the underlying timestamp.
- A `data-rembric-ts` attribute marking it as a Rembric-managed timestamp.
- A visible text content that, before any client script runs, equals the UTC string `YYYY-MM-DD HH:MM:SS UTC`.

A client component rendered by the dashboard shell SHALL upgrade every `<time data-rembric-ts>` element in place after hydration, replacing its `textContent` with a `Intl.DateTimeFormat`-formatted string using the browser's timezone and default locale. The previous inline script in the shell `<head>` and its re-run on every HTMX content swap are retired: a timestamp produced by a later client-side render SHALL be upgraded by the same component on mount, with no document-level rescan.

The SQLite storage, the service-layer `new Date()` writes, and the MCP serialization of timestamps SHALL remain UTC; only the rendered dashboard changes.

#### Scenario: SSR renders UTC fallback

- **WHEN** the dashboard returns an HTML page containing a timestamp
- **THEN** the response body SHALL contain a `<time datetime="…Z" data-rembric-ts>YYYY-MM-DD HH:MM:SS UTC</time>` element for that timestamp, with no JS execution required to produce the fallback text

#### Scenario: Client upgrades the visible text to local time

- **WHEN** a browser with `Intl.DateTimeFormat` support loads any dashboard page after the change
- **THEN** every `<time data-rembric-ts>` element's `textContent` SHALL be replaced with the formatted-local-time representation of its `datetime` attribute, using the browser's timezone

#### Scenario: HTMX swap re-applies the upgrade

- **WHEN** a dashboard surface re-renders a subtree and that subtree contains new `<time data-rembric-ts>` elements (the swap that used to inject them, now a client-side render)
- **THEN** the timestamp component SHALL upgrade the new elements on mount, without requiring a document-level rescan of the elements already rendered

#### Scenario: Null or invalid timestamp renders an em-dash

- **WHEN** a dashboard page calls the timestamp helper with `null`, `undefined`, or a value that does not parse to a valid date
- **THEN** the rendered output SHALL be the literal em-dash `—` and SHALL NOT contain a `<time>` element

#### Scenario: Dashboard layout includes the upgrader script exactly once

- **WHEN** any dashboard page is rendered through the shell
- **THEN** the shell SHALL mount exactly one component responsible for upgrading `<time data-rembric-ts>` elements, with no second upgrader and no document-level rescan

### Requirement: Dashboard CSS MUST be minified and content-hashed in production

The dashboard's production build SHALL emit minified, content-hashed CSS and SHALL serve it with `Cache-Control: public, max-age=31536000, immutable`. The dashboard no longer owns this pipeline itself: Tailwind v4 (through its PostCSS integration) produces the CSS, the framework's build minifies and content-hashes it, and the framework serves it. The retired machinery is the `lightningcss` build step, the `core.<hash>.css` + `views/<view>.<hash>.css` two-bundle contract and the `manifest.json` view registry. The requirement is the observable outcome: the stylesheet a production page references SHALL be content-hashed and minified, and its response SHALL carry the immutable cache directive. If the framework's default response for a deployed environment does not include that directive, the header SHALL be set explicitly rather than the promise dropped.

#### Scenario: Hashed files are served with immutable cache

- **WHEN** a production dashboard page requests the stylesheet it references
- **THEN** the response SHALL carry `Cache-Control: public, max-age=31536000, immutable`

#### Scenario: A CSS edit produces a new hash

- **WHEN** the contents of a theme token or a component's styles change and the production build runs again
- **THEN** the referenced stylesheet's path SHALL change, so no browser serves the stale stylesheet from cache

### Requirement: Dashboard fonts MUST be self-hosted

The dashboard SHALL serve Space Grotesk (weights 400, 500, 600, 700), Inter (weights 400, 500, 600), and JetBrains Mono (weights 400, 500, 600) as woff2 files committed inside the application, loaded through `next/font/local` and exposed as the theme's font variables. The dashboard SHALL NOT reference Google Fonts or any other font CDN at runtime, and SHALL NOT fetch a font at request time. The loader hashes, self-hosts and preloads the files from this origin, so the previous `@font-face` declarations in hand-written CSS, the fixed `/dashboard/assets/fonts/<family>-<weight>.woff2` URLs and the hand-written immutable-cache rule are retired; the observable outcome those stated — fonts served from this origin with long-lived immutable caching — is unchanged.

#### Scenario: No external font requests

- **WHEN** a browser loads any dashboard page
- **THEN** the page SHALL NOT trigger an HTTP request to `fonts.googleapis.com`, `fonts.gstatic.com`, or any host other than the Rembric server

#### Scenario: The three families resolve through the theme

- **WHEN** any dashboard page is rendered
- **THEN** the display, sans and mono font variables SHALL resolve to Space Grotesk, Inter and JetBrains Mono respectively, and the built output SHALL contain the hashed woff2 files served from this origin

#### Scenario: Every font weight is reachable

- **WHEN** a heading, a body paragraph and a code block are rendered
- **THEN** each family SHALL be loaded with the weights the previous contract declared, so no weight falls back to a synthesized variant

### Requirement: Dashboard navigation MUST use a sidebar with persisted collapse state

The dashboard SHALL render its primary navigation as a left-hand vertical sidebar listing the routes Overview, Memories, Sessions, Prompts, Judgments, Consolidation, Projects, Tokens, Maintenance. The sidebar SHALL be built from the adopted collapsible sidebar block — its provider, trigger, inset, nav-group, nav-item and badge primitives — rather than from hand-written layout CSS, and SHALL support a collapsed mode (icons only, narrower fixed width) on desktop viewports with a toggle control. That block's provider SHALL also own the narrow-viewport behaviour, replacing the custom mobile bar: below the tablet breakpoint the navigation SHALL be reachable through the provider's mobile sheet, and the separate `☰ MENU` drawer implementation and its inline script are retired.

The collapse state SHALL be persisted in an HTTP cookie named `rbr-sb-collapsed` (value `1` collapsed, `0` or absent expanded), scoped to `Path=/dashboard`, with `SameSite=Lax`. The server SHALL read this cookie when rendering any dashboard page and SHALL render the sidebar's initial state from it, so the server-rendered HTML matches the persisted state on first paint.

The toggle SHALL work without client JavaScript: it SHALL submit a Server Action that flips the cookie and returns to the page the control was used on. A client component MAY additionally apply the collapsed state optimistically so the width transition plays.

#### Scenario: Collapsed state survives reload

- **GIVEN** the operator has collapsed the sidebar
- **WHEN** the operator reloads any dashboard page
- **THEN** the server-rendered HTML SHALL reflect the collapsed state, and no client script SHALL be required to apply it

#### Scenario: Toggle works without JavaScript

- **WHEN** the operator activates the toggle with JavaScript disabled
- **THEN** the server SHALL flip the `rbr-sb-collapsed` cookie and return the operator to the page the control was used on

#### Scenario: CSRF protection on toggle

- **WHEN** the toggle submission fails the dashboard's mutation protection
- **THEN** the server SHALL refuse it with `403 Forbidden` and SHALL NOT flip the cookie

#### Scenario: The narrow-viewport navigation comes from the sidebar block

- **WHEN** any dashboard page is loaded at a viewport width of 980 px or less
- **THEN** the navigation SHALL be reachable through the sidebar block's mobile sheet, and no separate mobile-bar component or drawer script SHALL exist in the application

#### Scenario: Prompts entry appears in the sidebar between Sessions and Judgments

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar's MAIN group SHALL list, in order: Overview, Memories, Sessions, Prompts, Judgments, Consolidation

### Requirement: Dashboard MUST be fully responsive across desktop, tablet, and phone viewports

Every dashboard route SHALL render correctly and remain fully usable from a viewport width of 320 px upwards. The responsive system SHALL honour the following bands, expressed through the utility engine's responsive variants and the adopted components' own breakpoints:

- **≥1281 px (full desktop)**: full-width expanded sidebar; dense stat grids at their maximum column count.
- **≤1280 px (compact desktop)**: reduced main padding; dense stat grids reflow to a reduced column count.
- **≤980 px (tablet / narrow)**: the sidebar's mobile sheet becomes the navigation; multi-column grids stack to 2-3 columns; paired and tripled columns collapse to a single column; data tables remain horizontally scrollable inside their own container; filter rows become one control per row; action bars wrap.
- **≤640 px (phone)**: dense stat grids show 2 columns; two-column key/value grids show 2 columns; the login stage keeps both panes stacked vertically (it does not hide the identity pane); view-head headings reduce in size; table minimum widths drop.

At every viewport, the page SHALL NOT introduce horizontal page-level scrolling (only a table's own scroll container and code/preformatted blocks may scroll horizontally). Interactive controls (buttons, pager items, sidebar items, form fields) SHALL have a touch target of at least 44 × 44 CSS pixels at viewports ≤980 px.

#### Scenario: Sidebar becomes a mobile drawer at ≤980 px

- **WHEN** any dashboard page is loaded at a viewport width of 980 px or less
- **THEN** the desktop sidebar SHALL be hidden by default and tapping the sidebar block's mobile trigger SHALL open the navigation sheet

#### Scenario: No horizontal page scroll at any breakpoint

- **WHEN** any dashboard page is loaded at viewport widths 1440, 1100, 768, 540, or 360 px
- **THEN** the document element's horizontal overflow SHALL be `hidden` or the rendered content SHALL fit within the viewport, with the only horizontally-scrollable elements being a table's scroll container and any explicit code/preformatted block

#### Scenario: Stat grids reflow at narrow widths

- **WHEN** any page containing a dense stat grid is rendered at a viewport width of 640 px or less
- **THEN** the grid SHALL show exactly 2 columns and SHALL preserve its internal border lines between cards

#### Scenario: Tables stay reachable on phone widths

- **WHEN** a table wider than the viewport is rendered at ≤640 px
- **THEN** the table SHALL scroll horizontally within its own container without expanding the page width

### Requirement: The dashboard MUST surface a maintenance view at `/dashboard/maintenance`

The page SHALL contain five regions:

1. **DB breakdown.** A summary card showing the SQLite file size (computed as `page_count × page_size`), the freelist size (`freelist_count × page_size`), and a per-table breakdown of allocated bytes (computed via `dbstat` aggregated by name) sorted descending by size.
2. **Empty sessions card.** A card titled "Purge empty sessions" with the current count of rows matching the predicate in the sessions spec's "Sessions MAY be physically purged when empty" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No empty sessions to purge."
3. **Disconnected archived memories card.** A card titled "Purge disconnected archived memories" with the current count of rows matching the predicate in the memory spec's "Memories MAY be physically purged when archived and disconnected" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No disconnected archived memories to purge."
4. **Deleted prompts card.** A card titled "Purge deleted prompts" with the current count of `prompts` rows whose `deleted_at IS NOT NULL`. When the count is zero, the action button SHALL be disabled and copy SHALL read "No deleted prompts to purge."
5. **Backup card.** A card titled "Backup database" with a single admin-gated action that triggers an online, WAL-safe snapshot of the SQLite file (reusing the same `VACUUM INTO` mechanism already used internally by the self-update flow) to a timestamped file under the server's data directory, then offers it as an authenticated download. The action SHALL be a form protected by the dashboard's `data-confirm` modal with `data-confirm-tone="warn"` (reversible — it only reads and writes a new file, it never mutates existing data). The card SHALL display the timestamp and size of the most recent on-demand backup, if one exists.

#### Scenario: An operator triggers an on-demand backup

- **WHEN** an admin-scoped operator submits the "Backup database" form
- **THEN** the server SHALL produce a consistent snapshot of the current database via the existing online-backup mechanism
- **AND** the response SHALL offer the resulting file for authenticated download
- **AND** the maintenance page SHALL subsequently show the new backup's timestamp and size

#### Scenario: A non-admin token cannot trigger a backup

- **GIVEN** a dashboard session authenticated with a non-admin-scoped token
- **WHEN** that session requests `/dashboard/maintenance`
- **THEN** the backup card SHALL NOT be rendered, consistent with the existing admin-only gating of the other three action cards

### Requirement: The maintenance page MUST expose admin-only purge actions

The dashboard SHALL expose `POST /dashboard/maintenance/purge-sessions`, `POST /dashboard/maintenance/purge-archived-memories`, AND `POST /dashboard/maintenance/purge-prompts`. All three routes SHALL:

1. Validate the CSRF token using the existing `csrfInput` / `csrfCheck` mechanism. Missing or invalid CSRF SHALL return `403`.
2. Assert the dashboard session's underlying token has `scope = '*'`. Mismatch SHALL return `403`.
3. Call the corresponding service method with `adminBypass: true`.
4. Redirect with `303 See Other` to `/dashboard/maintenance?purged-sessions=N`, `?purged-memories=N`, or `?purged-prompts=N` where `N` is the count actually deleted by the service call.
5. On the subsequent GET, the page SHALL render a flash banner showing the count and the timestamp of the purge.

#### Scenario: An admin-scope session triggers a sessions purge

- **GIVEN** a dashboard session with `scope = '*'`, 12 eligible empty sessions, and a valid CSRF token
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-sessions`
- **THEN** the response SHALL be `303 See Other` with `Location: /dashboard/maintenance?purged-sessions=12`
- **AND** the 12 session rows SHALL no longer exist in `sessions`
- **AND** a `consolidation_ops` row with `op_type='session_purge'` and `affected_ids` of length 12 SHALL exist

#### Scenario: An admin-scope session triggers a prompts purge

- **GIVEN** a dashboard session with `scope = '*'`, 4 deleted prompts, and a valid CSRF token
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-prompts`
- **THEN** the response SHALL be `303 See Other` with `Location: /dashboard/maintenance?purged-prompts=4`
- **AND** the 4 prompt rows SHALL no longer exist in `prompts`
- **AND** a `consolidation_ops` row with `op_type='prompt_purge'` and `affected_ids` of length 4 SHALL exist
- **AND** corresponding rows in `prompts_fts` SHALL be removed by the AFTER DELETE trigger

#### Scenario: A project-scope session attempts a sessions purge

- **GIVEN** a dashboard session with `scope = 'project:<id>'` and a valid CSRF token
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-sessions`
- **THEN** the response SHALL be `403 forbidden`
- **AND** zero rows SHALL be deleted from `sessions`

#### Scenario: A POST without CSRF is rejected before scope is checked

- **GIVEN** any dashboard session
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-archived-memories` WITHOUT a valid CSRF token
- **THEN** the response SHALL be `403 forbidden` and the body SHALL identify the missing CSRF token
- **AND** no service call SHALL have been issued

#### Scenario: A purge POST with count = 0 is a no-op

- **GIVEN** a dashboard session with `scope = '*'`, zero eligible rows, and a valid CSRF token
- **WHEN** the session POSTs to any of the three purge endpoints
- **THEN** the response SHALL be `303 See Other` with `?purged-sessions=0`, `?purged-memories=0`, or `?purged-prompts=0`
- **AND** no `consolidation_ops` row SHALL be written

### Requirement: The maintenance page MUST refresh counts on every GET

The pre-flight counts on `/dashboard/maintenance` SHALL be queried fresh from the database on every GET response. There SHALL NOT be a caching layer between the route handler and SQLite for these counts. This requirement applies to all three purge cards (empty sessions, disconnected archived memories, deleted prompts).

The POST handler SHALL re-run the predicate inside the same transaction as the `DELETE`. If the count visible on the page is stale because rows became eligible between page render and POST, the POST SHALL delete the actually-eligible rows (which may be more or fewer than the displayed count). The redirect query string SHALL reflect the actual deleted count, not the count that was displayed at render time.

#### Scenario: Counts grow between render and click

- **GIVEN** the page renders with `purgeable empty sessions = 12`
- **AND** between render and the operator's click, 2 more sessions become eligible
- **WHEN** the POST handler runs
- **THEN** all 14 eligible sessions SHALL be deleted
- **AND** the redirect SHALL include `?purged-sessions=14`

#### Scenario: Deleted prompts count grows between render and click

- **GIVEN** the page renders with `deleted prompts = 4`
- **AND** between render and the operator's click, 1 more prompt is soft-deleted
- **WHEN** the POST handler runs
- **THEN** all 5 deleted prompts SHALL be physically removed
- **AND** the redirect SHALL include `?purged-prompts=5`

### Requirement: The judgment-queue view MUST be served at `/dashboard/judgments`

The dashboard SHALL serve the operator-facing queue of memory-relation judgments at the URL `/dashboard/judgments`. The page SHALL list every row of `memory_relations` (status `pending`, `judged`, or `orphaned`), SHALL support filtering by status and verdict kind, and SHALL paginate results. The legacy path `/dashboard/relations` SHALL NOT respond; any request to it SHALL return the standard dashboard `404` body.

The page heading SHALL read `Rembric Judgments.` (with `Rembric` highlighted via `hl-lime`), the document `<title>` SHALL read `Judgments · Rembric`, the empty-state cell SHALL read `No judgments match this filter.`, the table column previously labelled `relation` SHALL be labelled `verdict`, and the orphan-not-found flash SHALL read `Judgment not found or already closed.`.

The list SHALL NOT render an `id` column. Each row SHALL carry `data-href="/dashboard/judgments/{id}"` (whole-row click navigation, consistent with the sessions/memories/consolidation lists), and the `created` cell SHALL contain the row's real `<a href="/dashboard/judgments/{id}">` anchor wrapping the `formatTs(created_at)` output. The whole-row click handler's interactive-element bail-out keeps the memory anchors in `source → target` and the `Mark orphaned` form working inside the clickable row.

The `source → target` column SHALL render each side as an `<a href="/dashboard/memories/{id}">` anchor whose visible text is the corresponding memory's `content` truncated to 60 characters (not the memory's short id). The two anchors SHALL be separated by the `→` arrow as before.

The `verdict` column SHALL render via the shared `verdictPill(relation)` helper. When `relation` is non-null the cell SHALL contain a `<span class="pill k-{relation}">{relation}</span>` element (matching the home overview's `RECENT JUDGMENTS` tile). When `relation` is null (pending or orphaned rows) the cell SHALL contain the muted em-dash `<span class="muted">—</span>`. No inline `pill k-…` HTML SHALL exist in the judgments page template.

#### Scenario: Operator opens the judgment queue

- **WHEN** an authenticated operator navigates to `/dashboard/judgments`
- **THEN** the server SHALL return a `200` HTML response whose heading reads `Rembric Judgments.` and whose table column header for the relation kind reads `verdict`
- **AND** the table header SHALL NOT contain a `<th>` labelled `id`

#### Scenario: Judgment rows are whole-row clickable

- **WHEN** an authenticated operator navigates to `/dashboard/judgments` with at least one row present
- **THEN** each row SHALL carry `data-href="/dashboard/judgments/{id}"` where `{id}` is that row's `memory_relations.id`
- **AND** the row's `created` cell SHALL contain an `<a href="/dashboard/judgments/{id}">` anchor wrapping the rendered timestamp

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

### Requirement: The dashboard MUST surface an Abandon action for active sessions

The list view at `/dashboard/sessions` SHALL render an inline `<form action="/dashboard/sessions/<id>/abandon" method="post">` per row whose `status === 'active'` AND `deleted_at IS NULL`, alongside the existing `Delete` form. The form SHALL include a CSRF input minted with the action token `'session.abandon'`, a `data-confirm` attribute reading `Mark this session as abandoned? Its <N> memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard.` (where `<N>` is the per-row memory count already computed for the row), a `data-confirm-label` of `ABANDON SESSION`, and a `data-confirm-tone` of `warn`.

The submit button SHALL be styled `class="warn"` (matching the existing `class="warn"` convention for soft-destructive actions) and SHALL read `Abandon`. Rows whose `status` is `'ended'` or `'abandoned'`, or whose `deleted_at` is set, SHALL NOT render the Abandon form — the action is meaningful only on currently-active rows.

The handler at `POST /dashboard/sessions/:id/abandon` SHALL verify CSRF with action token `'session.abandon'`, call `agentSessions.markAbandoned(id, { adminBypass: true })`, and on success redirect to `/dashboard/sessions?abandoned=<id>` (URL-encoded). On `DomainError`, the handler SHALL re-render the sessions list page with a `flash error` body and the appropriate status code: `404` for `session_not_found`, `400` for every other `DomainError` code surfaced by the service (e.g. `session_already_ended`). The handler SHALL not surface raw exceptions to the operator.

The list view SHALL recognise the `?abandoned=<id>` query parameter and render it as a `flash success` banner reading `Session <code><id></code> marked as abandoned. <a href="/dashboard/sessions/<id>">View</a>.` The banner SHALL appear in the same position and styling as the existing `?deleted=` / `?restored=` banners.

The detail view at `/dashboard/sessions/:id` SHALL render the Abandon form in the action area when the row's `status === 'active'` AND `deleted_at IS NULL`. The form attributes SHALL match those used in the list view, with `<N>` computed from the count of memories already loaded for the detail page.

#### Scenario: Operator abandons an active session from the list view

- **GIVEN** an authenticated admin session and an `active` Rembric session row with id `<S>` and 12 memories
- **WHEN** the operator submits the row's Abandon form (after confirming the modal)
- **THEN** the response SHALL be a 302 redirect to `/dashboard/sessions?abandoned=<S>`
- **AND** the row's `status` SHALL be `'abandoned'`
- **AND** the row's `ended_at` SHALL be non-NULL
- **AND** a subsequent GET of `/dashboard/sessions` SHALL render the flash banner referencing `<S>`

#### Scenario: Abandon button is hidden for non-active rows

- **WHEN** the list view renders a row whose `status` is `'ended'` or `'abandoned'`
- **THEN** the row's actions cell SHALL NOT contain an Abandon form

#### Scenario: Abandon button is hidden for soft-deleted rows

- **WHEN** the list view renders a soft-deleted row (`deleted_at IS NOT NULL`)
- **THEN** the row's actions cell SHALL contain only the Undelete form — no Abandon form

#### Scenario: Abandon confirmation modal names the memory count

- **GIVEN** an active session row with 12 memories
- **WHEN** the operator triggers the Abandon form's submit
- **THEN** the global `#rbr-confirm` dialog SHALL open with copy containing the substring `Its 12 memories stay queryable`
- **AND** the confirm button SHALL read `ABANDON SESSION`
- **AND** the dialog SHALL use the `warn` tone styling

#### Scenario: Abandon without CSRF is rejected

- **GIVEN** an authenticated admin session
- **WHEN** a POST to `/dashboard/sessions/<S>/abandon` arrives without the `csrf` field
- **THEN** the response SHALL be `403` with the standard `csrf_invalid` body

#### Scenario: Abandoning an already-ended session surfaces an error

- **GIVEN** a session row with `status = 'ended'`
- **WHEN** a POST to `/dashboard/sessions/<S>/abandon` is made (e.g. via a stale form replayed after the row transitioned)
- **THEN** the response SHALL be `400` with a `flash error` body describing the `session_already_ended` condition
- **AND** the row's `status` SHALL remain `'ended'`

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

### Requirement: The dashboard sidebar MUST include a `PROMPTS` entry

The primary dashboard navigation (`apps/server/src/dashboard/components.ts::NAV`) SHALL include an entry with `key: 'prompts'`, `num: '03b'`, label `PROMPTS`, `href: '/dashboard/prompts'`, group `MAIN`, placed between the `SESSIONS` entry and the `JUDGMENTS` entry. The `NavKey` union and `NAV_ICONS` table SHALL be extended accordingly.

#### Scenario: Sidebar lists PROMPTS in the MAIN group

- **WHEN** any authenticated dashboard page is rendered
- **THEN** the sidebar SHALL contain an `<a>` linking to `/dashboard/prompts` with the label `PROMPTS`
- **AND** the entry SHALL appear within the `MAIN` group, after `SESSIONS` and before `JUDGMENTS`

### Requirement: The session detail view MUST list anchored prompts below memories

The view at `/dashboard/sessions/:id` SHALL render a new `Prompts (N)` section AFTER the existing `Memories (N)` section. The section SHALL list every row of `prompts` whose `session_id` equals the URL id AND `deleted_at IS NULL`, ordered by `created_at ASC`, with columns: title (cascade), content (truncated to 120 chars), tags, created_at — no prompt id column. When the session has no prompts, the section SHALL render `<p class="muted">No prompts anchored to this session.</p>` and SHALL still be emitted (so the `<h2>` is visible).

#### Scenario: Session with prompts and memories renders both sections

- **GIVEN** session `S` with 3 anchored memories and 2 anchored non-deleted prompts
- **WHEN** the operator opens `/dashboard/sessions/<S.id>`
- **THEN** the response HTML SHALL contain a `<h2>Memories (3)</h2>` section BEFORE a `<h2>Prompts (2)</h2>` section

#### Scenario: Session with only memories shows an empty-state prompts section

- **GIVEN** session `S` with 1 anchored memory and 0 anchored prompts
- **WHEN** the operator opens `/dashboard/sessions/<S.id>`
- **THEN** the response HTML SHALL contain a `<h2>Prompts (0)</h2>` section
- **AND** the prompts area SHALL render `No prompts anchored to this session.`

#### Scenario: Soft-deleted prompts are excluded from the session detail count

- **GIVEN** session `S` has 3 prompts with `session_id = S.id` and one of them has `deleted_at IS NOT NULL`
- **WHEN** the operator opens `/dashboard/sessions/<S.id>`
- **THEN** the rendered `<h2>` SHALL read `Prompts (2)`
- **AND** the deleted prompt SHALL NOT appear in the table

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
- **THEN** the `RECENT JUDGMENTS` block SHALL NOT contain any element with class `acts` or any anchor whose href is `/dashboard/judgments` rendered _inside_ a row (the only `OPEN ALL ›` anchor SHALL be the one in the section header)

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

#### Scenario: Judgments list created cell links to the detail page

- **WHEN** the operator navigates to `/dashboard/judgments` with at least one row present
- **THEN** each row's `created` cell SHALL contain an `<a href="/dashboard/judgments/{id}">` anchor wrapping the rendered timestamp, where `{id}` is that row's `memory_relations.id`
- **AND** the list SHALL NOT render a standalone short-id cell for the judgment's own id

### Requirement: The dashboard brand block MUST display the running server version

The dashboard SHALL render the running server version (the `version` field of the server package, loaded at boot via `REMBRIC_VERSION` from `apps/web/src/lib/version.ts`) inside the brand block of the desktop sidebar (`.sb-brand`) and the mobile bar (`.mob-bar .brand`), as the line directly under `REMBRIC`. The version SHALL be rendered as a `<small>` element with the text `v<version>` (displayed uppercased by the brand's existing `text-transform`). The brand SHALL NOT render a `SELF-HOSTED` line — the version takes that row. The rendering SHALL reuse the existing `.label-stack small` styles and SHALL NOT introduce new CSS rules.

`REMBRIC_VERSION` resolves from the release manifest `apps/web/package.json` — the file the `server` component's release-please updater bumps and tags `server-v<version>` — falling back to the compose `REMBRIC_VERSION` env pin and finally to the `0.0.0` sentinel.

#### Scenario: Sidebar brand shows the version

- **WHEN** an authenticated operator loads any dashboard page at a desktop viewport with the sidebar expanded
- **THEN** the sidebar brand block SHALL contain, in order, the lines `REMBRIC` and `v<version>` where `<version>` equals the server package version, and SHALL NOT contain the text `SELF-HOSTED`

#### Scenario: Mobile bar brand shows the version inline

- **WHEN** an authenticated operator loads any dashboard page at a viewport ≤980 px
- **THEN** the `.mob-bar` brand SHALL render `REMBRIC` and `v<version>` inline, with the existing `·` separator applied before the `<small>` by the established `.mob-bar .brand .label-stack small::before` rule

#### Scenario: Collapsed sidebar hides the version with the rest of the label stack

- **WHEN** the sidebar is in collapsed mode
- **THEN** the version SHALL be hidden along with the entire `.label-stack` (existing collapse behavior, unchanged)

### Requirement: The dashboard MUST surface update availability as a badge in the brand block

When the update check reports a newer version, the dashboard SHALL render an update badge adjacent to the running-version line in the brand block (sidebar, mobile bar) showing the latest available version. The badge SHALL persist across visits until the deployment runs the newer version and SHALL NOT be affected by modal dismissal.

When no newer version is known and the update check is enabled, the same brand-block slot SHALL render a quiet link (muted styling, no lime accent) to `/dashboard/update`, so the update page is always reachable from the shell. When the update check is disabled (`REMBRIC_UPDATE_CHECK=off`), the slot SHALL render nothing.

#### Scenario: Update available

- **WHEN** an authenticated operator loads any dashboard page while a newer version is known
- **THEN** the brand block SHALL show an update badge with the latest version next to the running version

#### Scenario: No update known, check enabled

- **WHEN** an authenticated operator loads any dashboard page while no newer version is known and the update check is enabled
- **THEN** the brand-block slot SHALL render a quiet link to `/dashboard/update` in place of the badge

#### Scenario: Check disabled

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set
- **THEN** the brand-block slot SHALL render neither a badge nor a quiet link

### Requirement: The dashboard MUST present a per-version dismissable update modal with the release changelog

When a newer version is known and the operator has not dismissed that specific version, the dashboard SHALL present an update modal showing: current version → new version, the release publication time (via the shared timestamp component), the release changelog body rendered from the GitHub Release, and a link to the release on GitHub. A "Later" action SHALL dismiss the modal for that version only (client-side persistence); the next newer release SHALL re-trigger it. The modal SHALL NOT offer an in-application update trigger — the served application does not replace itself — so its action area SHALL depend on the deployment's capability state:

- `pinned` — an explanation that the image tag is pinned and how to unpin it.
- every other state, including a deployment that could be upgraded — a copy-to-clipboard upgrade command and a link to `docs/updates.md`, so the operator performs the swap at the deployment layer. This is the branch the previous contract called `available`, whose in-app trigger is retired with the orchestrator.

#### Scenario: First visit after a release

- **WHEN** an operator opens the dashboard and a newer, undismissed version exists
- **THEN** the update modal SHALL appear with the version diff, the changelog, and the capability-appropriate action

#### Scenario: Dismissed version stays dismissed

- **WHEN** the operator chose "Later" for `0.22.0` and reloads the dashboard
- **THEN** the modal SHALL NOT reappear for `0.22.0`

#### Scenario: Manual quadrant

- **WHEN** the modal renders under any capability state
- **THEN** it SHALL NOT contain a control that updates the running deployment, and it SHALL show either the pinned-tag explanation or the copy-paste upgrade command with the docs link

### Requirement: List tables MUST NOT spend a column on row ids

Dashboard list tables SHALL NOT render a dedicated `id` column. Row identity is carried by the row's semantic cell (title, content, or timestamp), and navigation to a detail page — where one exists — is provided by exactly one real `<a>`/`<Link>` anchor hosted on that semantic cell, so cmd-click / middle-click / keyboard navigation keep working. The whole-row `data-href` attribute and the inline click handler that consumed it are retired with the hand-written dashboard; the row is not the link.

Concretely:

- Sessions list: the `title` cell carries the anchor to `/dashboard/sessions/{id}`.
- Memories list, session detail → Memories, memory detail → Predecessors: the `content` cell carries the anchor to `/dashboard/memories/{id}`.
- Consolidation runs list: the `started` cell carries the anchor to `/dashboard/consolidation/{id}`.
- Judgments list: the `created` cell carries the anchor to `/dashboard/judgments/{id}`.
- Projects (active + archived), prompts list, session detail → Prompts, consolidation run detail → Ops: the id column is removed with no replacement anchor — these rows have no detail page. Memory shortId anchors inside the ops table's `affected` / `created` cells are retained: they are cross-navigation, not row identity.

`shortId(...)` rendering remains in use outside list-table columns (detail-page headings such as `Rembric Memory {shortId}.`, ops `affected`/`created` cells, prompt session links).

#### Scenario: A navigable list row keeps exactly one real anchor

- **WHEN** an authenticated operator renders any list whose rows have a detail page (sessions, memories, consolidation runs, judgments, predecessors, session-detail memories)
- **THEN** each row SHALL contain exactly one anchor pointing at its detail URL, hosted on the row's semantic cell
- **AND** no `<th>` labelled `id` SHALL be present in the table header

#### Scenario: Tables without detail pages drop the id column with no replacement

- **WHEN** an authenticated operator renders the projects, prompts, session-detail prompts, or run-detail ops tables
- **THEN** no `<th>` labelled `id` SHALL be present and no cell SHALL render the row's own short id
- **AND** row action controls SHALL keep functioning (their actions carry the full id)

#### Scenario: Row navigation requires no click handler

- **WHEN** a list row with a detail page is rendered
- **THEN** it SHALL NOT rely on a row-level click handler or a `data-href` attribute to navigate, and keyboard activation of the semantic cell's anchor SHALL reach the detail page

### Requirement: The update page MUST offer a manual check with an honest outcome

The up-to-date state of `/dashboard/update` SHALL render a CSRF-protected form that triggers the manual release check and, when a check has run in the current process lifetime, a last-checked timestamp rendered via `formatTs`. After the manual check: if a newer version was found, the page SHALL render the existing update-available view; if no newer version is known, the page SHALL show a flash stating the deployment is still up to date; if the check could not reach the GitHub API, the page SHALL show an error flash that names the failure (distinct from "up to date") and notes this is expected on air-gapped hosts. The manual-check form SHALL NOT render when the update check is disabled; a disabled note naming `REMBRIC_UPDATE_CHECK=off` SHALL render instead, and the page SHALL NOT claim the deployment is up to date (the server never checks, so it cannot know). The manual check action SHALL NOT require a `data-confirm` modal (read-only, reversible).

#### Scenario: Manual check finds an update

- **WHEN** the operator triggers the manual check and a newer release exists
- **THEN** `/dashboard/update` SHALL render the update-available view (version diff, changelog, capability-appropriate action) and the brand-block badge SHALL appear on subsequent page loads

#### Scenario: Manual check, still up to date

- **WHEN** the operator triggers the manual check and no newer release exists
- **THEN** `/dashboard/update` SHALL show a flash stating no newer version is known and remain on the up-to-date state

#### Scenario: Manual check fails

- **WHEN** the operator triggers the manual check and the GitHub API is unreachable
- **THEN** `/dashboard/update` SHALL show an error flash that distinguishes the failure from being up to date

#### Scenario: Check disabled hides the action

- **WHEN** `REMBRIC_UPDATE_CHECK=off` is set and the operator opens `/dashboard/update`
- **THEN** the page SHALL NOT render the manual-check form

### Requirement: The home consolidation-health section MUST describe the lazy sweep truthfully

The dashboard home SHALL describe the consolidation trigger model as it exists — lazy sweep on session start, throttled per scope, with a manual trigger — and SHALL NOT render scheduling or model information sourced from removed configuration (`CONSOLIDATION_CRON`) or from always-null columns. Threshold copy for pending-relation aging SHALL be derived from the configured `JUDGMENT_ORPHAN_AFTER_MS` and `JUDGMENT_ORPHAN_DEADLINE_MS` values, not hardcoded literals. The last-run scope SHALL be rendered as the project slug when the scope refers to an existing project.

#### Scenario: No cron or model copy on the home

- **WHEN** the operator views the dashboard home after at least one sweep run
- **THEN** the consolidation-health section SHALL NOT contain a next-run schedule time nor an LLM model cell, and SHALL state that the sweep triggers on session start

#### Scenario: Orphaning thresholds reflect configuration

- **GIVEN** `JUDGMENT_ORPHAN_DEADLINE_MS` configured to a non-default value
- **WHEN** the operator views the dashboard home
- **THEN** the orphaned-pendings caption SHALL reflect the configured deadline, not a stale literal

#### Scenario: Last-run scope shows the project slug

- **GIVEN** the most recent run swept scope `project:<id>` for an existing project with slug `my-app`
- **WHEN** the operator views the dashboard home
- **THEN** the last-run cell SHALL display `my-app` rather than the raw `project:<ULID>` string

### Requirement: A manual sweep trigger MUST be available from the consolidation view

The dashboard SHALL provide a manual sweep trigger at `/dashboard/consolidation` that posts to a dashboard route gated by the dashboard session and CSRF verification, executes a forced sweep across all scopes, and returns to the consolidation listing. The form SHALL use the confirmation modal with `warn` tone (the sweep's ops are journaled and reversible). The admin endpoint `POST /admin/consolidation/run` SHALL remain unchanged as the automation surface.

#### Scenario: Operator forces a sweep from the dashboard

- **WHEN** the operator confirms the manual sweep action at `/dashboard/consolidation`
- **THEN** the server SHALL execute a forced sweep (bypassing the throttle), a new `consolidation_runs` row SHALL exist per swept scope, and the operator SHALL land back on the runs listing showing them

#### Scenario: Manual sweep requires CSRF

- **WHEN** a POST to the dashboard sweep route arrives without a valid CSRF token
- **THEN** the server SHALL reject the request and no sweep SHALL run

#### Scenario: Manual sweep requires a dashboard session

- **WHEN** an unauthenticated POST hits the dashboard sweep route
- **THEN** the server SHALL redirect to the login page and no sweep SHALL run

### Requirement: Long text content on detail views MUST be rendered as Markdown

On detail views, the dashboard SHALL render long text `content` fields as Markdown using an in-process parser, rather than displaying the raw Markdown source inside an escaped `<pre>` block. This applies to: memory detail content (`/dashboard/memories/:id`), session description (seed goal) and **curated** session summary (`/dashboard/sessions/:id`), the expanded prompt content cell (`/dashboard/prompts`), and the Source and Target memory content on the judgment detail view (`/dashboard/judgments/:id`).

**Session summaries SHALL be Markdown-rendered ONLY when curated (`summary_final = 1`).** When a session has a summary with `summary_final = 0` (a raw transcript sync from a client hook/provider, never confirmed by the model), the detail view SHALL instead render it as escaped preformatted text (monospace, inside its own `overflow-x: auto` container — the pattern the judgment Evidence block uses), and SHALL display an "RAW" (uncurated) badge adjacent to the Summary heading, using the shared badge component — no ad-hoc colour value. Rationale: raw transcripts frequently contain Markdown-looking framework text (tables, headers, tool documentation); rendering them as formatted Markdown makes an uncurated dump visually indistinguishable from a model-authored summary, which misled operators in practice. The session description (seed goal) is operator/agent-provided, never raw-synced, and SHALL remain Markdown-rendered unconditionally.

Fields that are NOT free-form Markdown content SHALL NOT be Markdown-rendered: the judgment Reason SHALL remain a plain (escaped) paragraph, and the judgment Evidence SHALL remain a `<pre>` block because it is pretty-printed JSON.

The Markdown parser SHALL be configured to **disable raw HTML passthrough** (`html: false`): any HTML tags present in the source SHALL be rendered as escaped text, never as live markup. The parser SHALL reject dangerous URL schemes (e.g. `javascript:`, `vbscript:`, `data:`) in links, leaving the affected link inert. No separate HTML sanitizer SHALL be required for safety. The rendered HTML SHALL be the **only** value passed to an unescaped rendering boundary in the entire dashboard — the Markdown component's `dangerouslySetInnerHTML`. User-supplied content SHALL never bypass escaping anywhere else.

The rendering SHALL be performed entirely server-side and in-process; no CDN, network call, or client-side JavaScript SHALL be required to display formatted content. Rendering SHALL use the theme's tokens and the self-hosted font variables, SHALL NOT introduce an ad-hoc colour or font value outside them, and fenced/inline code SHALL remain monospace.

Each rendered Markdown block SHALL provide an icon-only control that copies the verbatim Markdown source to the clipboard, so the raw source remains recoverable behind the render. The source SHALL be carried in the page (not re-fetched) such that copying yields the original source — including the literal `**`, backticks, and fences — rather than the rendered HTML. The control SHALL function in non-secure (plain-HTTP) deployments via a clipboard fallback. This control is a progressive enhancement implemented as a client component; the formatted content itself SHALL still render with JavaScript disabled. (The uncurated-summary `<pre>` block needs no copy control: its visible text IS the verbatim source.)

List and table views SHALL NOT render Markdown: truncated `content` snippets in list cells SHALL remain plain escaped text.

#### Scenario: Memory detail renders Markdown formatting

- **WHEN** an authenticated operator opens `/dashboard/memories/:id` for a memory whose content contains `**bold**`, inline `` `code` ``, a fenced code block, and a bulleted list
- **THEN** the page SHALL render the bold span, inline code, code block, and list as formatted HTML elements
- **AND** the literal characters `**`, `` ` ``, and ` ``` ` SHALL NOT appear as visible source text

#### Scenario: Raw HTML in content is rendered inert

- **WHEN** a memory's content contains `<script>alert(1)</script>` or any other raw HTML tag
- **THEN** the detail view SHALL display that text escaped (visible as literal characters), and SHALL NOT execute or inject it as live markup

#### Scenario: Dangerous link schemes are dropped

- **WHEN** a memory's content contains a Markdown link whose URL uses a `javascript:` (or other dangerous) scheme
- **THEN** the rendered output SHALL NOT produce a clickable link that navigates to that scheme

#### Scenario: Copy-raw control returns the verbatim source

- **WHEN** an operator activates the copy control on a rendered Markdown block
- **THEN** the verbatim Markdown source (including the original `**`, backticks, and fences) SHALL be copied to the clipboard, not the rendered HTML

#### Scenario: Session description and curated summary render Markdown

- **GIVEN** a session whose `summary_final = 1` (the model called `memory.session_summary`)
- **WHEN** an authenticated operator opens `/dashboard/sessions/:id` for that session with a Markdown-formatted description and summary
- **THEN** both the description (seed goal) and the summary SHALL be rendered as formatted HTML
- **AND** no RAW badge SHALL appear next to the Summary heading

#### Scenario: Uncurated session summary renders as raw preformatted text with a RAW badge

- **GIVEN** a session whose `summary` is a raw transcript sync and `summary_final = 0`
- **WHEN** an authenticated operator opens `/dashboard/sessions/:id`
- **THEN** the summary SHALL be displayed as escaped preformatted monospace text inside a horizontally-scrollable container, NOT as rendered Markdown
- **AND** a "RAW" (uncurated) badge SHALL appear adjacent to the Summary heading
- **AND** the description (seed goal), if present, SHALL still render as Markdown

#### Scenario: Judgment Source/Target render Markdown but Evidence stays JSON

- **WHEN** an authenticated operator opens `/dashboard/judgments/:id`
- **THEN** the Source and Target memory content SHALL be rendered as formatted Markdown
- **AND** the Evidence block SHALL remain a `<pre>` rendering of the pretty-printed JSON (not Markdown-rendered)

#### Scenario: List snippets remain plain text

- **WHEN** the operator views the `/dashboard/memories` list where a row's content contains `**bold**`
- **THEN** the truncated snippet cell SHALL display the raw characters as escaped plain text and SHALL NOT render Markdown formatting

#### Scenario: The unescaped boundary is exactly one

- **WHEN** the dashboard source is searched for an unescaped rendering boundary
- **THEN** the only occurrence SHALL be the Markdown component, and it SHALL pass the parser's output and nothing else

### Requirement: Dashboard list headers MUST report the true filtered total

Every paginated dashboard list view SHALL render a header total chip whose value equals the true number of rows matching the view's current filter set, computed independently of pagination — NOT the count of rows present on the current page. The page-slice count SHALL remain available as a distinct `SHOWING N ROWS` indicator (in the header meta and/or the pager footer), and the `SHOWING` value SHALL equal the number of rows actually rendered on the page (never including any pagination lookahead row). This requirement applies to the memories (`/dashboard/memories`), sessions (`/dashboard/sessions`), judgments (`/dashboard/judgments`), consolidation-runs (`/dashboard/consolidation`), and prompts (`/dashboard/prompts`) list views.

The true count SHALL be produced by an `admin*`-prefixed repository read that applies the SAME filter conditions as the view's corresponding `admin*List*` query and omits `LIMIT`/`OFFSET`/`ORDER BY`. All such counting SQL SHALL live under `packages/db/src/repositories/` and SHALL be invoked only from `apps/web/src/app/dashboard/`, satisfying the data-access and admin-method confinement invariants. No new MCP tool, HTTP route, DB migration, or design token SHALL be introduced.

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

#### Scenario: Prompts list total counts all rows for the active filter

- **GIVEN** 23 non-deleted `prompts` rows matching the active filter with the page size at 10
- **WHEN** the operator opens `/dashboard/prompts`
- **THEN** the header SHALL render a total chip reading `23` alongside the existing `SHOWING` indicator

#### Scenario: SHOWING never counts the pagination lookahead

- **GIVEN** a list view whose query fetches `PAGE_SIZE + 1` rows to detect a next page
- **WHEN** a full page renders
- **THEN** the `SHOWING` indicator SHALL read `PAGE_SIZE`, not `PAGE_SIZE + 1`

#### Scenario: Counting SQL stays in the repository layer

- **WHEN** a contributor inspects the dashboard handlers and runs the data-access confinement invariant test
- **THEN** all counting SQL for these totals SHALL reside under `packages/db/src/repositories/`
- **AND** every count method SHALL carry the `admin*` prefix and be called only from a call site the `data-access` allow-list names as a `(file, method)` pair — for these totals `apps/web/src/app/dashboard/` plus `apps/server/src/server/dashboard-router.ts`, which renders the operator overview directly

#### Scenario: Tokens list is unchanged

- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the header total chip SHALL continue to reflect the full, unpaginated token count with no behavioural change

### Requirement: The Memories sidebar entry MUST surface a needs-review count badge

The dashboard sidebar's `MEMORIES` navigation entry SHALL display a count badge showing the number of `active` memories in the operator's visible scope whose derived `reviewState = 'needs_review'`, mirroring the existing badge pattern on the `JUDGMENTS` sidebar entry (pending-relation count). The badge SHALL be omitted (not rendered as `0`) when the count is zero. This SHALL NOT introduce a new stat card on the `/dashboard` overview page — the overview's six-card stat strip and its deliberate exclusion of backlog-style counters (see "The dashboard home page MUST include a sessions counter") are unchanged.

#### Scenario: Sidebar badge reflects the needs-review count

- **GIVEN** 3 `active` memories in scope whose derived `reviewState = 'needs_review'`
- **WHEN** any authenticated operator loads any dashboard page
- **THEN** the sidebar's `MEMORIES` entry SHALL display a badge reading `3`

#### Scenario: Sidebar badge is omitted when there is nothing to review

- **GIVEN** zero `active` memories in scope with `reviewState = 'needs_review'`
- **WHEN** any authenticated operator loads any dashboard page
- **THEN** the sidebar's `MEMORIES` entry SHALL render with no badge

### Requirement: Paginated list views MUST surface the total page count

Every paginated dashboard list view (`/dashboard/memories`, `/dashboard/sessions`, `/dashboard/prompts`, `/dashboard/judgments`) SHALL render, alongside its existing PREV/NEXT pager controls, a "PAGE X OF Y" indicator computed from the view's existing true filtered total (see "Dashboard list headers MUST report the true filtered total") and the shared `PAGE_SIZE` constant. `Y` SHALL be `ceil(total / PAGE_SIZE)`, with a minimum of 1 even when `total` is 0.

#### Scenario: Page indicator reflects the filtered total

- **GIVEN** a filtered result set of 123 rows and `PAGE_SIZE = 50`
- **WHEN** an operator views page 2 of `/dashboard/memories` with that filter applied
- **THEN** the pager SHALL display "PAGE 2 OF 3"

#### Scenario: Empty result set still shows page 1 of 1

- **GIVEN** a filter that matches zero rows
- **WHEN** an operator views the resulting list
- **THEN** the pager SHALL display "PAGE 1 OF 1"

### Requirement: User-supplied text rendered outside the Markdown pipeline MUST be HTML-escaped

Any dashboard component that renders user- or agent-supplied text SHALL pass it as a React text child, which React escapes, or through the theme's components as a plain string prop. The dashboard SHALL NOT contain a general-purpose unescaped-rendering helper: the `raw()`, `SafeHtml` and `escape()` helpers of the hand-written dashboard are deleted, and the Markdown component's `dangerouslySetInnerHTML` is the single unescaped boundary in the application. This applies in particular to prompt tags (agent-supplied via `memory.save_prompt`, rendered on the session detail and prompts list views) and project slugs (operator-supplied at project creation; legacy slugs may predate the current slug validation regex and are not guaranteed to be free of HTML metacharacters).

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

#### Scenario: A second unescaped boundary fails the guard

- **WHEN** a component outside the Markdown component introduces an unescaped rendering boundary
- **THEN** the dashboard's guard test SHALL fail naming the file, so the boundary count cannot grow silently

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

### Requirement: Memory detail MUST list the judgments touching that memory, in decision-relevance order

The memory detail view (`/dashboard/memories/:id`) SHALL render a `Judgments` section listing every `memory_relations` row whose `source_id` or `target_id` is that memory, excluding rows whose `relation` is `not_conflict`. Each row SHALL render the verdict kind through the shared `verdictPill` helper, the relation `status` through `statusPill`, the counterpart memory's stored `title` as an `<a href="/dashboard/memories/{counterpartId}">`, and the row's `judged_at` (falling back to `created_at`) through the shared timestamp helper. Each row SHALL carry `data-href="/dashboard/judgments/{id}"` and the timestamp cell SHALL contain that same anchor. When no such row exists the section SHALL render the empty state `No judgments touch this memory.`

The rows SHALL be ordered by the annotation order the `memory` capability defines for relation annotations ("Search results MUST carry relation annotations"): kind tier — `conflicts_with`, `supersedes`, `superseded_by`, then `pending_conflict`, then `scoped`, `compatible`, `related` — then the relation's creation time descending, then its `judgment_id`. The dashboard SHALL apply that order through the single shared comparator exported by the relations service, NOT through a second ordering rule of its own, so the operator surface and every agent-facing annotation list rank the same memory's edges identically.

The order SHALL be applied over the fetched rows rather than as a database `ORDER BY`, because the kind tier is keyed on the relation's kind **from this memory's point of view** — `supersedes` and `superseded_by` are the same stored row seen from its two ends — and that point of view is not a column.

The section SHALL NOT be paginated and SHALL NOT be capped. The `memory` capability states that annotations withheld by the MCP annotation bound remain visible via the dashboard, and this section is the only per-memory judgment view the dashboard provides; a cap here would make that statement false.

The section heading SHALL report the memory's **degree**: the number of rows rendered. It SHALL NOT report a separate total, because with no cap applied a total would restate the rendered row count.

#### Scenario: A contradiction leads the section regardless of when it was judged

- **GIVEN** a memory touched by one judged `conflicts_with` relation created before twelve judged `related` relations
- **WHEN** an authenticated operator opens that memory's detail view
- **THEN** the first row of the `Judgments` section SHALL be the `conflicts_with` relation, and all thirteen rows SHALL be rendered

#### Scenario: A pending backlog does not displace a judged lifecycle edge

- **GIVEN** a memory touched by twenty `pending` relations and one judged `supersedes` relation
- **WHEN** the operator opens that memory's detail view
- **THEN** the `supersedes` row SHALL precede every pending row

#### Scenario: Repeated renders agree on a same-millisecond batch

- **GIVEN** a memory whose touching relations include several judged inside one transaction and therefore sharing a `created_at` millisecond
- **WHEN** the operator loads the detail view twice with no intervening write
- **THEN** the `Judgments` rows SHALL appear in the same order both times

#### Scenario: The section reports the degree

- **GIVEN** a memory touched by seven relations
- **WHEN** the operator opens its detail view
- **THEN** the `Judgments` heading SHALL report a degree of `7`

#### Scenario: A memory with no judgments

- **WHEN** the operator opens the detail view of a memory that no `memory_relations` row touches
- **THEN** the section SHALL render the text `No judgments touch this memory.` and SHALL report a degree of `0`

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

### Requirement: The dashboard login view MUST present a single canonical brand mark, headline, and a footer naming every bundled plugin client

The `/dashboard/login` page SHALL render a single brand block in the top-left of the left pane containing the transparent Rembric logo (`/dashboard/assets/logo-transparent.png`) at 56 × 56 px on desktop, 48 × 48 px at viewports ≤ 980 px, and 40 × 40 px at viewports ≤ 640 px, followed by two lines of mono text (`REMBRIC` and `v<version>`, where `<version>` is the running server package version loaded via `REMBRIC_VERSION` from `apps/web/src/lib/version.ts`). The main headline SHALL read `REMBRIC DASHBOARD.` with `REMBRIC` rendered via the `hl-lime` highlight pill and the trailing period rendered in `var(--lime)`. The headline `line-height` SHALL be at least `1.3` so the `hl-lime` background does not visually clip the next line.

A footer SHALL list **every** bundled plugin client, separated visually by lime square bullets, followed by a single generic `MCP CLIENTS` entry **last**. The order SHALL be `CLAUDE CODE`, `OPENCODE`, `CODEX CLI`, `PI`, `HERMES`, `MCP CLIENTS`.

The trailing position of `MCP CLIENTS` is normative and the reason is that it is a **rule a future client can follow**: the footer reads as the bundled clients, then the catch-all. Its previous position between `CODEX CLI` and `HERMES` was not a rule, and a sixth client would have had no way to know where to go. The order among the bundled clients is not derived from any ranking; it is the shipped order and is pinned so the list has one definition rather than drifting per edit.

Omitting a bundled client from this footer is a defect, not a stylistic lag: the login page is the first Rembric surface an operator sees, and a client absent from it reads as unsupported.

The right pane SHALL contain only the admin-token form (a labelled password input + a primary submit button) and SHALL NOT contain redundant section chips or security-disclosure copy that duplicates the `/tokens` documentation.

#### Scenario: Login renders the canonical brand mark

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the response HTML SHALL contain exactly one `<img>` with `src="/dashboard/assets/logo-transparent.png"` inside an element with class `login-brand`, placed before any `<form>` element

#### Scenario: Login brand shows the version instead of SELF-HOSTED

- **WHEN** an unauthenticated request hits `/dashboard/login`
- **THEN** the brand block SHALL contain the line `v<version>` directly under `REMBRIC` and SHALL NOT contain the text `SELF-HOSTED`

#### Scenario: Headline is REMBRIC DASHBOARD

- **WHEN** the login page is rendered
- **THEN** the `<h1>` SHALL contain the text `REMBRIC` wrapped in a `<span class="hl-lime">` followed by the text `DASHBOARD` and a period rendered in `var(--lime)`

#### Scenario: Footer names every bundled plugin client, then the generic MCP entry

- **WHEN** the login page is rendered at a viewport width greater than 640 px
- **THEN** the `.login-stage .clients` element SHALL contain, in order, exactly six labelled spans: `CLAUDE CODE`, `OPENCODE`, `CODEX CLI`, `PI`, `HERMES`, `MCP CLIENTS`
- **AND** `MCP CLIENTS` SHALL be the last span

#### Scenario: A test pins the footer list, and it is not vacuous

- **WHEN** the test suite asserts the footer's span list
- **THEN** it SHALL extract the spans from the rendered `/dashboard/login` HTML and compare them against a single canonical list declared once in the test file
- **AND** it SHALL first assert that the extracted list is **non-empty**, so a selector that silently matches nothing cannot pass the comparison
- **AND** deleting the `PI` span from `apps/server/src/server/dashboard-router.ts` SHALL make that test fail

#### Scenario: Login form has no redundant chips or disclosure block

- **WHEN** the login page is rendered
- **THEN** the response HTML SHALL NOT contain the strings `§ 00 / ACCESS`, `OPERATOR DASHBOARD`, `APPEND-ONLY`, `ADMIN-SCOPED TOKENS ONLY`, `STORED IN HTTPONLY COOKIE`, or `PLAINTEXT SHOWN ONLY ONCE IN /TOKENS`

### Requirement: Dashboard MUST follow the liquid-glass visual identity

The dashboard SHALL render the identity-A liquid-glass visual identity in both a dark mode and a light mode, expressed as CSS custom properties in the shadcn token slots rather than as values frozen in this specification. The theme SHALL be declared once, in `apps/web/src/app/globals.css`.

The token slots this identity occupies:

- **Semantic surface and text roles** — `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--muted`, `--muted-foreground`, `--border`, `--input`, `--ring`, `--radius`.
- **Brand role** — `--primary` (with its foreground pair) as the lime brand fill, carried over unchanged from the identity this one replaces.
- **Semantic state roles** — `--destructive` for irreversible actions, plus a warning role for reversible destructive ones; these are the two tones the confirmation contract distinguishes.
- **Light-surface text accent** — an olive-family token for text on light glass surfaces, distinct from the brand fill, so lime stays a fill and never becomes body text.
- **Typography roles** — `--font-sans`, `--font-display` and `--font-mono`, wired to the self-hosted families.
- **Glass roles** — a `--glass-*` group (surface tint, blur radius, saturation, specular edge, border) owned by the identity layer rather than by the semantic set, so glass surfaces can be retuned without touching component code.

The **exact values** of the glass group and of the light-surface accent are NOT fixed by this requirement: they are finalised at implementation against the design reference and recorded once, in `globals.css`. Freezing values here would lock in numbers nobody has chosen, which is the failure mode of the requirement this one replaces. The retired brutalist contract is its token list, its single `#0a0a0a` surface, its prohibition on a light theme, and its "changing any of these tokens SHALL require a new OpenSpec change" rule: changing a token value SHALL NOT require a spec change, as long as every role above remains occupied and both modes still render.

The dashboard SHALL support a dark mode and a light mode selected by the `.dark` class on the document element, defaulting to dark. A theme switcher or per-user theme setting is not required by this requirement and SHALL NOT be introduced by it.

#### Scenario: Tokens are declared once in core.css

- **WHEN** a contributor inspects the token declaration (the file the previous contract called `core/tokens.css`, now the `globals.css` theme block)
- **THEN** every role listed above SHALL be declared in a single `@theme`/`:root` block plus a `.dark` block, and no entry of the retired brutalist token list SHALL remain in the repository

#### Scenario: Both modes render

- **WHEN** the document element carries the `.dark` class the dark values SHALL apply, and when it does not the light values SHALL apply
- **THEN** text and surfaces in each mode SHALL be rendered from that mode's foreground and surface tokens, and no component SHALL fall back to a hardcoded colour that breaks in the other mode

#### Scenario: Changing a token value needs no spec change

- **WHEN** an implementation changes a token value in `globals.css`
- **THEN** no OpenSpec change SHALL be required, provided every role above stays occupied and both modes still render

#### Scenario: Glass surfaces are tunable independently

- **WHEN** a contributor changes a `--glass-*` value
- **THEN** every glass surface SHALL follow it without any component file being edited

### Requirement: The dashboard UI SHALL be built from shadcn/ui blocks and components over Tailwind v4

The dashboard SHALL be implemented with shadcn/ui over Tailwind v4, using its blocks and components to the maximum extent the design allows. shadcn components SHALL be copied into `apps/web/src/components/ui/` and owned by this repository — edited freely, upgraded deliberately — and SHALL NOT be consumed as a versioned runtime UI dependency. The supporting dependencies SHALL be limited to `tailwindcss` v4 with `@tailwindcss/postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, the `@radix-ui/*` packages the adopted components require, and `@tanstack/react-table` for the data-dense tables. Drag-and-drop toolkits and alternate icon sets SHALL NOT be adopted: the dashboard has no drag interaction, and `lucide-react` is the icon set every adopted component already uses.

The adopted blocks, and the views they serve:

- **`sidebar-07` (collapsible)** — the shell and navigation: provider, trigger, inset, nav-group/nav-item with badges, nav-user. Its provider's mobile sheet replaces the custom mobile bar and drawer script.
- **`dashboard-01`** — the home overview: section cards (the stat strip), the area chart (the activity sparkline), and the data table (the recents table).
- **`login-01`** — the login view: the split layout, with the Rembric brand mark in the identity pane.
- **The data-table composition and its primitives** (`table`, `badge`, `button`, `input`, `label`, `select`, `checkbox`, `dropdown-menu`, `tabs`, `toggle-group`, `separator`, `drawer`, `avatar`, `sheet`, `sonner`, `breadcrumb`, `chart`, `card`) — the list surfaces and the detail surfaces.
- **`alert-dialog`** (or the equivalent dialog primitive) — destructive confirmations.

A block SHALL NOT be adopted whole where doing so imports a dependency or an affordance the dashboard does not need: the composition is copied and pruned, and every pruned piece SHALL be named in `design.md` against the block it came from.

#### Scenario: Components are owned source, not a runtime dependency

- **WHEN** the dependency graph of `apps/web` is inspected
- **THEN** no component library SHALL appear as a runtime dependency, and every adopted component SHALL exist as a file under `apps/web/src/components/ui/`

#### Scenario: The stack's dependencies are the enumerated set

- **WHEN** `apps/web/package.json` is inspected
- **THEN** the UI-related dependencies SHALL be limited to the enumerated set, `@tanstack/react-table` SHALL be present, and no drag-and-drop toolkit and no alternate icon package SHALL be present

#### Scenario: A block is pruned, not imported wholesale

- **WHEN** a block is adopted for a view
- **THEN** the pieces the dashboard does not use SHALL be removed rather than shipped, and the remaining composition, together with the pruned pieces, SHALL be recorded against the view it serves

### Requirement: Dashboard styles MUST be organised as a three-layer system

The dashboard's styles SHALL be organised in exactly three layers:

- **Theme layer** — the design tokens, declared once in `apps/web/src/app/globals.css` in a Tailwind v4 `@theme` block together with the `:root` and `.dark` custom-property blocks. No other file SHALL declare a design token.
- **Component layer** — the owned shadcn components under `apps/web/src/components/ui/**`, styled with Tailwind utilities and `class-variance-authority` variants. A component's variants live in that component's own file, never in a separate stylesheet.
- **Identity layer** — the hand-authored liquid-glass utilities the visual-identity requirement defines, declared once above the component layer and consumed by it.

Tailwind v4 (CSS-first `@theme`) SHALL be the only utility engine. No per-route stylesheet SHALL exist: a route expresses its layout with the shared components, their variants and utility classes. No route, layout or component SHALL emit a `<style>` element in the response body — the built stylesheet is a linked, content-hashed asset.

#### Scenario: The theme is declared once

- **WHEN** a contributor inspects `apps/web/src/app/globals.css`
- **THEN** it SHALL contain the single declaration of the dashboard's design tokens, and no other file in the repository SHALL declare them

#### Scenario: The HTML body carries no `<style>` block

- **WHEN** any authenticated dashboard route returns HTML
- **THEN** the response body SHALL NOT contain a `<style>` element

#### Scenario: Adding a view requires no stylesheet

- **WHEN** a contributor adds a new dashboard route that needs view-specific presentation
- **THEN** they SHALL express it with the shared components, their variants and utility classes, and no new CSS file SHALL be required

### Requirement: Data-dense list views SHALL be built from one shared data-table composition

Every list surface with sorting, filtering and pagination — memories, sessions, prompts, judgments, projects, tokens, entities, consolidation runs, the maintenance breakdowns and the home recents table — SHALL be rendered from a single shared data-table composition (the shadcn table primitives driven by `@tanstack/react-table`), so column definitions, empty states, pagination controls and row linking are defined once. The composition SHALL accept a server-provided page of rows. A view whose contract places filtering, ordering and counting on the server — which is every paginated view — SHALL drive the composition's controls through the URL (requesting the next server page) rather than letting the client re-sort or re-filter the page it received; a view over a fully loaded in-memory set MAY use the composition's client-side transformations.

#### Scenario: Every list surface uses the one composition

- **WHEN** a contributor inspects the ported list views
- **THEN** each SHALL render through the shared data-table composition, and no view SHALL hand-roll its own table markup

#### Scenario: A server-paginated list is not re-sorted on the client

- **GIVEN** a server-paginated list view
- **WHEN** the operator renders it and then changes a sort or filter control
- **THEN** the rows SHALL be re-requested from the server with the change encoded in the URL, and the order SHALL be the server's order

#### Scenario: The empty state comes from the composition

- **WHEN** a list has no rows for the active filter
- **THEN** the composition SHALL render the view's declared empty message rather than a bare empty table

### Requirement: Dashboard mutations SHALL be Server Actions

Every dashboard mutation SHALL be a Server Action invoked from a React form or a client component, validated at the action boundary before any service call, executed against the same service method the hand-written route called, and followed by a revalidation of every path whose data it changed. A rejected mutation SHALL surface as form state rendered next to the control that caused it rather than as a separate error page; a mutation that returns to a list SHALL preserve the existing redirect-plus-query-parameter flash contract. An action SHALL NOT trust a client-supplied identifier: scope, project binding and admin gating SHALL be resolved inside the action from the session, exactly as the service layer requires. No dashboard mutation SHALL be invoked by a client-side `fetch()` to a dashboard URL — the HTTP routes the actions replace are deleted with the views they served.

**The OAuth consent decision is the one exception**: it SHALL remain a form `POST` to the protocol's authorization endpoint, because that endpoint is part of the OAuth protocol contract rather than a dashboard route, and the consent view SHALL therefore stay server-rendered with no client-side JavaScript requirement.

#### Scenario: A mutation runs through an action and revalidates

- **WHEN** an operator submits a dashboard form
- **THEN** the submission SHALL invoke a Server Action that validates its input, calls the service, revalidates the affected paths, and returns updated form state or a redirect

#### Scenario: An invalid submission changes nothing

- **WHEN** an action receives input that fails validation
- **THEN** it SHALL return an error to the form, SHALL NOT call the service, and SHALL NOT change any row

#### Scenario: No dashboard mutation is invoked by a client fetch

- **WHEN** the client-side code under `apps/web/src/**` is inspected
- **THEN** it SHALL contain no `fetch()` or equivalent call to a dashboard mutation URL

#### Scenario: The consent decision stays a protocol POST

- **WHEN** the OAuth consent view renders
- **THEN** its decision control SHALL submit a form `POST` to the authorization endpoint, and the view SHALL render and function without client-side JavaScript

### Requirement: Client-side data fetching SHALL be limited to scoped React Query islands

Server Components SHALL own the initial data for every dashboard route. `@tanstack/react-query` SHALL be used only inside client islands whose data changes after render: the update check's polling, incremental search, and optimistic action state. An island SHALL NOT become the source of truth for a list, a detail record, a filtered set or a total the server computes; those SHALL remain server-rendered reads. The dashboard SHALL NOT introduce a global client-side state store. An island's first render SHALL use the server-provided value, so hydration has nothing to disagree with.

#### Scenario: A ported list is server-rendered

- **WHEN** an operator opens any list view
- **THEN** its rows, filters and totals SHALL be rendered by the server, and no client-side query SHALL be required to display them

#### Scenario: Polling is an island, not the page

- **WHEN** the operator is on a surface that polls (the update check)
- **THEN** only that island SHALL fetch, and the rest of the page SHALL remain server-rendered

#### Scenario: No global client store

- **WHEN** the dependency graph of `apps/web` is inspected
- **THEN** no global state-management library SHALL be present

### Requirement: Dashboard UI mechanisms SHALL translate to the React stack rather than be ported

The port SHALL delete the mechanisms it replaces instead of re-implementing them. The translations are:

- `apps/server/src/dashboard/components.ts`'s HTML-string helpers → React components with typed props under `apps/web/src/components/dashboard/**`.
- `raw()`, `SafeHtml` and the `escape()` helper → React text children, which React escapes.
- The single unescaped boundary → the Markdown component's `dangerouslySetInnerHTML`.
- `minifyHtml()` and its `<pre>`/`<textarea>`/`<script>` carve-outs → nothing: JSX emits no inter-tag whitespace outside preformatted text.
- The six shell scripts (`TS_UPGRADER`, `MOB_TOGGLE`, `SB_COLLAPSE`, `ROW_LINK`, `CONFIRM`, `MD_COPY`) → the timestamp component, the sidebar block's mobile sheet, the sidebar cookie action, the semantic-cell link, the confirmation dialog and the copy-source control.
- The whole-row `data-href` click → a real link on the row's semantic cell.
- The two-CSS-link per-page delivery and the `views/<view>.css` registry → the component layer and utility classes.
- Stored form `action="/dashboard/..."` route strings → Server Actions, with the OAuth consent decision excepted (see the mutation requirement).

Preserved verbatim by the port: self-hosted fonts, the timestamp convention, the destructive-confirmation contract, the responsive bands, the data-access boundaries (server-side reads through the `@rembric/core` services, mutations through Server Actions), and DS1–DS6.

#### Scenario: A deleted mechanism is not re-implemented

- **WHEN** a contributor inspects the ported dashboard
- **THEN** `apps/web` SHALL contain no HTML-minifying step, no `data-href` row navigation, no inline first-party script in a shell, and no per-view stylesheet

#### Scenario: The preserved conventions still hold

- **WHEN** any ported view is rendered
- **THEN** its timestamps, fonts, destructive confirmations, responsive bands, data-access boundaries and data-safety behaviour SHALL match the pre-port contract

### Requirement: The dashboard application SHALL bootstrap through its framework instrumentation hook

The application's instrumentation hook SHALL be its single bootstrap path, executed once per process: open the database (migrations run inside the database factory), log the resolved absolute database path and whether the file already existed, bootstrap the admin token, start the session reaper, and drain the embedder. No second bootstrap path SHALL exist. The embedder SHALL remain lazily dynamically imported, and its model assets SHALL reach the process through the image's copy step rather than through module tracing.

#### Scenario: Bootstrap runs once per process

- **WHEN** the application starts
- **THEN** the database SHALL be opened and migrated, and the startup log SHALL name the resolved absolute database path together with whether the file pre-existed

#### Scenario: A missing migrations directory fails loudly

- **WHEN** the migrations directory cannot be read
- **THEN** startup SHALL fail with an error naming the path, and SHALL NOT continue against an empty or partially migrated database

#### Scenario: The embedder is not loaded at boot

- **WHEN** the process starts and no request has needed embeddings
- **THEN** the embedder SHALL NOT have been imported, and the model assets SHALL be present in the image by copy

### Requirement: The served dashboard application SHALL NOT host a scheduler or a self-upgrade orchestrator

The dashboard application SHALL NOT run a timer that performs consolidation or any other background mutation: the consolidation sweep SHALL remain a deterministic, throttled service call in the request path. No cron exists to port and none SHALL be introduced inside the served process; if a time-based sweep is ever required, it SHALL be a separate script driven by an OS scheduler rather than a duty hidden in the web process.

The self-upgrade orchestrator SHALL NOT live in the served application: a process that replaces itself while serving is not a supported path. The dashboard SHALL keep the version display, the update-availability check, the changelog modal and the manual check, and SHALL NOT offer an in-application update trigger, an update progress view, or a version-polling endpoint. Docker owns the swap by pulling the image; the installer owns it for non-Docker deployments; `docs/updates.md` is the operator-facing route.

#### Scenario: No background timer in the served process

- **WHEN** the application's startup code is inspected
- **THEN** no scheduler, interval or timer performing consolidation or any other background mutation SHALL be registered, and the sweep SHALL be reachable only through the request path

#### Scenario: The dashboard offers no in-app update trigger

- **WHEN** an operator views the update surface while a newer version is known
- **THEN** the surface SHALL show the deployment-layer upgrade path and SHALL NOT render a control that updates the running deployment

#### Scenario: The retired update routes are gone

- **WHEN** the application's routes are inspected
- **THEN** no update-progress or in-app upgrade route SHALL exist, and a request to one SHALL return the standard not-found response
