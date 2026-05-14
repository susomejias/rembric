## ADDED Requirements

### Requirement: Projects MUST be creatable from a dedicated CLI subcommand

The `rembric` CLI SHALL expose `rembric project create <slug>` and `rembric project list` subcommands. `project create` SHALL mint a new project by delegating to `ProjectsService.create`, accept an optional `--name <displayName>` flag for the cosmetic display name, and print the created row as JSON to stdout. `project list` SHALL print active projects as JSON by default, accept `--all` to include archived rows and `--table` to switch to a column-aligned text rendering, mirroring the existing `session list` conventions.

The CLI SHALL NOT introduce a new validation path; it SHALL surface the existing `DomainError` codes verbatim:

- `invalid_slug` (slug fails `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`) SHALL exit with code `2` and a stderr message naming the slug.
- a duplicate slug SHALL exit with code `1` and a stderr message stating that the project already exists.
- success SHALL exit with code `0`.

#### Scenario: Creating a project with a valid slug

- **GIVEN** a Rembric database where slug `analytics-pipeline` does not yet exist
- **WHEN** the operator runs `rembric project create analytics-pipeline --name "Analytics Pipeline"`
- **THEN** the command SHALL exit `0` and print a JSON object with fields `id`, `slug='analytics-pipeline'`, `displayName='Analytics Pipeline'`, and `createdAt`

#### Scenario: Creating a project with an invalid slug

- **WHEN** the operator runs `rembric project create "INVALID Slug!"`
- **THEN** the command SHALL exit `2` and stderr SHALL contain a message referencing the slug regex

#### Scenario: Creating a project that already exists

- **GIVEN** a Rembric database where slug `analytics-pipeline` already exists
- **WHEN** the operator runs `rembric project create analytics-pipeline`
- **THEN** the command SHALL exit `1` and stderr SHALL contain `"already exists"`

#### Scenario: Listing projects as JSON

- **WHEN** the operator runs `rembric project list`
- **THEN** stdout SHALL contain a JSON object `{ projects: [...] }` with one entry per active project, ordered by `createdAt` ascending

### Requirement: The dashboard `/dashboard/projects` page MUST surface an always-visible creation form

The page rendered by `createProjectsRouter` SHALL include a CSRF-protected `<form action="/dashboard/projects/create" method="post">` block positioned between the introductory description and the "Active" table. The block SHALL be rendered on every visit (no toggle, no modal). The form SHALL include:

- a required text input named `slug` with the HTML `pattern` attribute equal to the canonical slug regex, so the browser blocks obviously malformed submissions client-side;
- an optional text input named `displayName`;
- the standard CSRF hidden input issued by `csrfInput(session.session, sessions, 'project.create')`;
- a submit button labeled `Create project`.

`POST /dashboard/projects/create` SHALL:

- verify the CSRF token via `readFormAndVerifyCsrf`;
- read `slug` and `displayName` from the form body, treating an empty `displayName` as `null`;
- call `ProjectsService.create({ slug, displayName })`;
- on success, redirect to `/dashboard/projects?created=<slug>`;
- on `DomainError` (invalid_slug or conflict), redirect to `/dashboard/projects?error=<message>` where `<message>` is the DomainError's message URL-encoded.

The GET handler SHALL read `?created` and `?error` query parameters and render them via the existing `flash success` / `flash error` template classes.

#### Scenario: Creating a project from the dashboard form

- **GIVEN** an authenticated admin session
- **WHEN** the operator submits the form with `slug='dash-created'` and `displayName='Dash Created'` and a valid CSRF token
- **THEN** the response SHALL be a 302 redirect to `/dashboard/projects?created=dash-created`
- **AND** a subsequent GET of `/dashboard/projects` SHALL display the slug `dash-created` and the display name `Dash Created` in the Active table

#### Scenario: Form rejects an invalid slug with a flash error

- **GIVEN** an authenticated admin session
- **WHEN** the operator submits the form with `slug='INVALID Slug!'` and a valid CSRF token
- **THEN** the response SHALL be a 302 redirect whose `Location` header matches `/dashboard/projects?error=`

#### Scenario: Form submission without a CSRF token is rejected

- **GIVEN** an authenticated admin session
- **WHEN** a POST to `/dashboard/projects/create` arrives without the `csrf` field
- **THEN** the response SHALL be `403` with the standard `csrf_invalid` body
