## ADDED Requirements

### Requirement: The dashboard MUST surface a sessions list view at `/dashboard/sessions`

A logged-in dashboard user SHALL see a list of recent sessions for the active project (or globally when no project is selected). The list SHALL include columns for session id, agent, started_at, ended_at, status, and a memory count (number of `memory` rows with that `session_id`).

#### Scenario: A dashboard user navigates to `/dashboard/sessions`
- **WHEN** the user is authenticated with an admin token and visits `/dashboard/sessions`
- **THEN** the server SHALL return a paginated list of the 50 most recent sessions ordered by `started_at DESC`, with each row linking to `/dashboard/sessions/:id`

#### Scenario: A dashboard user opens a session detail page
- **WHEN** the user navigates to `/dashboard/sessions/:id` for an accessible session
- **THEN** the page SHALL display: the session metadata (agent, project, token name, started_at, ended_at, status), the verbatim `summary` text, and a table of memories whose `session_id` matches, linking to each memory's detail page

#### Scenario: A session was created by a now-revoked token
- **WHEN** the underlying token has been revoked but the session row still exists
- **THEN** the detail page SHALL still render and SHALL show the token name with a "(revoked)" suffix; the session SHALL not be hidden from the list

### Requirement: The dashboard home page MUST include a sessions counter

The `/dashboard` overview page SHALL surface a "Sessions (active)" stat card alongside the existing counters.

#### Scenario: The home page is rendered after sessions exist
- **WHEN** the user lands on `/dashboard` and one or more sessions have `status = 'active'`
- **THEN** the stat grid SHALL include a `Sessions (active)` card whose value is the count
