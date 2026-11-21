## MODIFIED Requirements

### Requirement: Dashboard access MUST require authentication

The dashboard SHALL require a valid signed session cookie to access any route other than `/dashboard/login`. The login route SHALL accept a static token submitted via a form and validate it against the `tokens` table, and SHALL succeed only when that token has administrative capability: its owner's role is `admin` and its scope is `*` (see the `auth` capability). Any other token SHALL be refused with the same response as an invalid one. On success it SHALL set an httpOnly, SameSite=Lax, signed cookie referencing a row in `dashboard_sessions`.

#### Scenario: Unauthenticated access redirects to login

- **WHEN** an unauthenticated request hits `/dashboard/memories`
- **THEN** the server SHALL respond with a 302 redirect to `/dashboard/login`

#### Scenario: Login with admin token

- **WHEN** the operator submits the admin token at `/dashboard/login`
- **THEN** the server SHALL validate the token, create a `dashboard_sessions` row, set the signed cookie, and redirect to `/dashboard`

#### Scenario: Logout

- **WHEN** the operator triggers logout
- **THEN** the corresponding `dashboard_sessions` row SHALL be deleted and the cookie SHALL be cleared

#### Scenario: Login requires the administrator role

- **GIVEN** a token with scope `*` owned by a user whose role is `member`, and a token of scope `project:<id>` owned by a user whose role is `admin`
- **WHEN** each is submitted at `/dashboard/login`
- **THEN** each SHALL be refused with the same response as an invalid token, and no `dashboard_sessions` row SHALL be created
- **AND** a token with scope `*` owned by a user whose role is `admin` SHALL succeed, which is the control that the refusals come from the capability
