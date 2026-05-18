## ADDED Requirements

### Requirement: The dashboard MUST surface a maintenance view at `/dashboard/maintenance`

The dashboard SHALL serve `GET /dashboard/maintenance` as a top-level page that aggregates physically destructive operations. The page SHALL be reachable only by dashboard sessions whose underlying token has scope `*` (global admin). For dashboard sessions backed by a project-scoped token, the route SHALL respond with `403 forbidden` and a small HTML body explaining the requirement; the sidebar link to `/dashboard/maintenance` SHALL be hidden entirely for those sessions.

The page SHALL contain three regions:

1. **DB breakdown.** A summary card showing the SQLite file size (computed as `page_count × page_size`), the freelist size (`freelist_count × page_size`), and a per-table breakdown of allocated bytes (computed via `dbstat` aggregated by name) sorted descending by size.
2. **Empty sessions card.** A card titled "Purge empty sessions" with the current count of rows matching the predicate in the sessions spec's "Sessions MAY be physically purged when empty" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No empty sessions to purge."
3. **Disconnected archived memories card.** A card titled "Purge disconnected archived memories" with the current count of rows matching the predicate in the memory spec's "Memories MAY be physically purged when archived and disconnected" requirement. When the count is zero, the action button SHALL be disabled and copy SHALL read "No disconnected archived memories to purge."

Both action buttons SHALL use the existing `data-confirm` modal pattern (no new JS) with `data-confirm-tone="danger"`, a `data-confirm-label` that names the count and the action verb (e.g. `PURGE 12 SESSIONS`), and a `data-confirm` copy that explicitly states the action is irreversible.

#### Scenario: An admin-scope session opens the maintenance page

- **GIVEN** a dashboard session backed by a token with `scope = '*'`
- **WHEN** the session navigates to `/dashboard/maintenance`
- **THEN** the response SHALL be `200 OK`
- **AND** the page SHALL render the DB breakdown and the two cards with their pre-flight counts

#### Scenario: A project-scope session opens the maintenance page

- **GIVEN** a dashboard session backed by a token with `scope = 'project:<id>'`
- **WHEN** the session navigates to `/dashboard/maintenance`
- **THEN** the response SHALL be `403 forbidden`
- **AND** the response body SHALL contain copy explaining that maintenance requires an admin-scoped token

#### Scenario: A project-scope session views the sidebar

- **GIVEN** a dashboard session backed by a token with `scope = 'project:<id>'`
- **WHEN** the session renders any dashboard page
- **THEN** the sidebar SHALL NOT contain a link to `/dashboard/maintenance`

### Requirement: The maintenance page MUST expose admin-only purge actions

The dashboard SHALL expose `POST /dashboard/maintenance/purge-sessions` and `POST /dashboard/maintenance/purge-archived-memories`. Both routes SHALL:

1. Validate the CSRF token using the existing `csrfInput` / `csrfCheck` mechanism. Missing or invalid CSRF SHALL return `403`.
2. Assert the dashboard session's underlying token has `scope = '*'`. Mismatch SHALL return `403`.
3. Call the corresponding service method with `adminBypass: true`.
4. Redirect with `303 See Other` to `/dashboard/maintenance?purged-sessions=N` (or `?purged-memories=N`) where `N` is the count actually deleted by the service call.
5. On the subsequent GET, the page SHALL render a flash banner showing the count and the timestamp of the purge.

#### Scenario: An admin-scope session triggers a sessions purge

- **GIVEN** a dashboard session with `scope = '*'`, 12 eligible empty sessions, and a valid CSRF token
- **WHEN** the session POSTs to `/dashboard/maintenance/purge-sessions`
- **THEN** the response SHALL be `303 See Other` with `Location: /dashboard/maintenance?purged-sessions=12`
- **AND** the 12 session rows SHALL no longer exist in `sessions`
- **AND** a `consolidation_ops` row with `op_type='session_purge'` and `affected_ids` of length 12 SHALL exist

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
- **WHEN** the session POSTs to either purge endpoint
- **THEN** the response SHALL be `303 See Other` with `?purged-sessions=0` or `?purged-memories=0`
- **AND** no `consolidation_ops` row SHALL be written

### Requirement: The maintenance page MUST refresh counts on every GET

The pre-flight counts on `/dashboard/maintenance` SHALL be queried fresh from the database on every GET response. There SHALL NOT be a caching layer between the route handler and SQLite for these counts.

The POST handler SHALL re-run the predicate inside the same transaction as the `DELETE`. If the count visible on the page is stale because rows became eligible between page render and POST, the POST SHALL delete the actually-eligible rows (which may be more or fewer than the displayed count). The redirect query string SHALL reflect the actual deleted count, not the count that was displayed at render time.

#### Scenario: Counts grow between render and click

- **GIVEN** the page renders with `purgeable empty sessions = 12`
- **AND** between render and the operator's click, 2 more sessions become eligible
- **WHEN** the POST handler runs
- **THEN** all 14 eligible sessions SHALL be deleted
- **AND** the redirect SHALL include `?purged-sessions=14`
