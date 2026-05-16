## MODIFIED Requirements

### Requirement: The dashboard MUST surface a sessions list view at `/dashboard/sessions`

A logged-in dashboard user SHALL see a list of recent sessions for the active project (or globally when no project is selected). The list SHALL include columns for title, session id (short form), agent, started_at, ended_at, status, and a memory count (number of `memory` rows with that `session_id`).

The `title` column SHALL render using the cascade `row.title ?? row.description ?? shortId(row.id)`. The cascade SHALL NOT short-circuit on placeholder titles (e.g. `'rembric · 22:14 UTC'`) — those count as real titles for the purpose of display, because they are still more informative than `shortId` alone. The cascade ensures legacy rows (where `title` is NULL because they predate the column migration) still get a sensible value.

The title column SHALL be the first visible content column (left of session id) and SHALL truncate with `text-overflow: ellipsis` past ~40 chars to keep the table compact. The full title SHALL be available as the cell's `title` attribute (HTML tooltip) so operators can hover to see the full string.

#### Scenario: A dashboard user navigates to `/dashboard/sessions`

- **WHEN** the user is authenticated with an admin token and visits `/dashboard/sessions`
- **THEN** the server SHALL return a paginated list of the 50 most recent sessions ordered by `started_at DESC`, with each row linking to `/dashboard/sessions/:id`
- **AND** each row SHALL include a `title` column rendered via the documented cascade

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
- **THEN** the page SHALL display: the title as the `<h1>` (via the same cascade as the list view), the session metadata (agent, project, token name, started_at, ended_at, status), the verbatim `summary` text, and a table of memories whose `session_id` matches, linking to each memory's detail page

#### Scenario: A session was created by a now-revoked token

- **WHEN** the underlying token has been revoked but the session row still exists
- **THEN** the detail page SHALL still render and SHALL show the token name with a "(revoked)" suffix; the session SHALL not be hidden from the list
