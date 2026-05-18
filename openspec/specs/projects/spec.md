# projects Specification

## Purpose

Defines project identity and scope resolution for Rembric, including `findOrCreate(path)` semantics, equivalent path-based and header-based scoping for MCP requests, and project lifecycle (rename, archive).

## Requirements

### Requirement: Projects MUST be uniquely identified by their slug

The `projects` table SHALL store the canonical identifier of each project in a column named `slug` (renamed from `path` in this change). `slug` SHALL be `TEXT NOT NULL UNIQUE`. A migration SHALL rename the column atomically; no value normalization SHALL occur during the rename — legacy values continue to function for read and write.

For _new_ slugs created after this change (via `project.use({slug, autocreate: true})` or via the dashboard), the value SHALL match the strict regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Paths SHALL NOT be persisted in the projects table and SHALL NOT be accepted by any tool argument.

#### Scenario: Renaming the column at migration time

- **GIVEN** a v0.1 database with a populated `projects.path` column
- **WHEN** migration `0003_sessions_and_slugs.sql` runs
- **THEN** the column SHALL be renamed to `slug` and all existing rows SHALL retain their values verbatim

#### Scenario: Creating a new project with a valid slug

- **WHEN** `project.use({slug: 'rembric-api', autocreate: true})` is called and the slug does not exist
- **THEN** a new row SHALL be inserted with that slug and the call SHALL return `{ slug, projectId, created: true, switched: false }`

#### Scenario: Creating a new project with an invalid slug

- **WHEN** a creation path receives a slug containing uppercase, leading hyphen, dots, underscores, or a length > 64
- **THEN** the call SHALL be rejected with code `invalid_slug` and SHALL NOT insert a row

#### Scenario: A legacy slug continues to function

- **GIVEN** a pre-existing row with `slug = 'My.Project'` (created under v0.1's looser rules)
- **WHEN** any tool resolves project scope to that slug
- **THEN** the row SHALL be returned and the request SHALL proceed normally

### Requirement: Project scope MUST be resolvable only from URL path or explicit tool call

The server SHALL accept two ways to set the active project for an MCP session: (a) the URL path `/mcp/<slug>` and (b) the `project.use({slug})` tool call. The `X-Rembric-Project` header SHALL no longer be consulted; servers SHALL ignore it and SHALL NOT use its value in scope resolution.

When neither mechanism has fired, the connection SHALL be in _global_ scope. The auto-detection via MCP `roots` MAY upgrade the scope on `/mcp` connections from global to a project, but only by activating an _existing_ slug (see the next requirement).

#### Scenario: URL path sets the scope at connection time

- **WHEN** an MCP call arrives at `/mcp/rembric` and the slug exists
- **THEN** the request SHALL be scoped to project `rembric` for the lifetime of the MCP transport session

#### Scenario: URL path slug does not exist

- **WHEN** an MCP call arrives at `/mcp/does-not-exist` and no project has that slug
- **THEN** the `initialize` SHALL succeed (path-scoping does not enforce existence pre-tools), BUT any tool call that resolves the scope into a `project_id` SHALL respond with `project_not_found` and SHALL NOT auto-create

#### Scenario: `X-Rembric-Project` header is sent

- **WHEN** an MCP call arrives with `X-Rembric-Project: rembric` and no path slug
- **THEN** the server SHALL ignore the header and SHALL treat the request as global-scope

#### Scenario: Neither path nor tool call has set scope

- **WHEN** the agent calls `memory.save({scope: 'project'})` on a `/mcp` connection without having called `project.use` and without `roots`-based discovery resolving to a project
- **THEN** the call SHALL be rejected with code `project_required` and a message instructing the caller to either open `/mcp/<slug>` or invoke `project.use({slug})`

### Requirement: Projects MUST support archive and rename

The dashboard and CLI SHALL allow operators to rename a project (changing its display name without losing memory associations) and to archive a project (preventing new memories from being saved against it while preserving existing ones).

#### Scenario: Archiving a project

- **WHEN** the operator archives project `P`
- **THEN** subsequent `memory.save` calls scoped to `P` SHALL reject, but `memory.search` and `memory.get` SHALL continue to return its existing memories

### Requirement: Project auto-detection via MCP `roots` MUST be read-only

When a client advertises `capabilities.roots` at `initialize` and the URL path is `/mcp` (no slug), the server SHALL call `roots/list` once after `initialized`, derive a candidate slug from the basename of the first root (lowercase ASCII, non-`[a-z0-9-]` characters replaced with `-`, trimmed of leading/trailing `-`), and activate an _existing_ project with that slug. Auto-detection SHALL NOT create new projects.

#### Scenario: Roots resolves to an existing slug

- **GIVEN** the client returns `[{uri: 'file:///home/me/rembric'}]` from `roots/list`
- **AND** a project with `slug = 'rembric'` exists
- **WHEN** the auto-detection step runs
- **THEN** the session SHALL be scoped to that project with `source = 'roots'`

#### Scenario: Roots resolves to a slug that does not exist

- **GIVEN** the client returns `[{uri: 'file:///tmp/quick-test'}]` from `roots/list`
- **AND** no project with `slug = 'quick-test'` exists
- **WHEN** the auto-detection step runs
- **THEN** the session SHALL remain global-scope and the derived `'quick-test'` SHALL appear in `project.current.suggestedSlugs`

#### Scenario: Client does not support roots

- **WHEN** the `initialize` request advertises no `roots` capability
- **THEN** the server SHALL NOT issue `roots/list` and the session SHALL remain global-scope until an explicit `project.use` call

#### Scenario: `roots/list` times out or errors

- **WHEN** the server's `roots/list` request does not return within 2 seconds, or returns a JSON-RPC error
- **THEN** the auto-detection SHALL silently fall through to global-scope; the connection SHALL NOT be failed

#### Scenario: Roots changes mid-session via `notifications/roots/list_changed`

- **GIVEN** a session has been auto-scoped to project `'rembric'` via the initial `roots/list`
- **WHEN** the client emits `notifications/roots/list_changed` with new roots resolving to slug `'api'`
- **THEN** the server SHALL update `project.current.suggestedSlugs` to `['api']` but SHALL NOT switch the active project; the agent must explicitly call `project.use({slug: 'api', confirmSwitch: true})` to switch (which itself requires the active session to be ended first per the sessions capability)

### Requirement: The `projects` service MUST expose `findBySlug` and explicit `create`

The application-layer service that today provides `findOrCreate(path)` SHALL be replaced by two distinct methods: `findBySlug(slug)` (returns the row or `null`, never inserts) and `create({slug, displayName?})` (inserts after validating the strict slug regex, throws on conflict).

#### Scenario: A consumer migrating from `findOrCreate`

- **WHEN** a service that previously called `findOrCreate(path)` is updated
- **THEN** the new code SHALL call `findBySlug(slug)` and, only when the result is `null`, explicitly call `create({slug})` — auto-create on read is forbidden

#### Scenario: Concurrent `create` with the same slug

- **WHEN** two requests racing each call `create({slug: 'foo'})` simultaneously
- **THEN** the first commit SHALL succeed; the second SHALL fail with code `conflict` and SHALL NOT insert a row

### Requirement: Project resolution MUST surface deterministic suggestions on miss

When a `project.use({slug})` or any other resolution path returns `project_not_found`, the response SHALL include `suggestedSlugs: string[]` containing up to 3 existing slugs ranked by Levenshtein distance ≤ 3 from the input slug. The algorithm SHALL be deterministic (same input + database state → same suggestion list) and SHALL execute fully in-process without any LLM call.

#### Scenario: A near-miss produces a suggestion

- **WHEN** `project.use({slug: 'rembic'})` is called and projects `'rembric'` and `'rembric-api'` exist
- **THEN** the response SHALL be an error `project_not_found` with payload `{ suggestedSlugs: ['rembric', 'rembric-api'] }`

#### Scenario: No near-misses found

- **WHEN** the input slug has no existing slug within Levenshtein distance 3
- **THEN** `suggestedSlugs` SHALL be an empty array, not omitted from the payload

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
