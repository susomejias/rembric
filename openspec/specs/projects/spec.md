# projects Specification

## Purpose

Defines project identity and scope resolution for Rembric, including path-based scoping for MCP requests, and project lifecycle (rename, archive).

## Requirements

### Requirement: Projects MUST be uniquely identified by their slug

The `projects` table SHALL store the canonical identifier of each project in a column named `slug` (renamed from `path` in this change). `slug` SHALL be `TEXT NOT NULL UNIQUE`. A migration SHALL rename the column atomically; no value normalization SHALL occur during the rename — legacy values continue to function for read and write.

Projects SHALL be created from the dashboard, or by an admin token through the `project.create` MCP tool (see the `mcp-api` capability); no other MCP tool, argument or resolution path SHALL create a project. For _new_ slugs created after this change, the value SHALL match the strict regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Paths SHALL NOT be persisted in the projects table and SHALL NOT be accepted by any tool argument.

#### Scenario: Renaming the column at migration time

- **GIVEN** a v0.1 database with a populated `projects.path` column
- **WHEN** migration `0003_sessions_and_slugs.sql` runs
- **THEN** the column SHALL be renamed to `slug` and all existing rows SHALL retain their values verbatim

#### Scenario: Creating a new project with a valid slug

- **WHEN** the operator creates a project with slug `rembric-api` from the dashboard, or an admin token calls `project.create({ slug: 'rembric-api' })`, and the slug does not exist
- **THEN** a new row SHALL be inserted with that slug

#### Scenario: No MCP tool creates a project

- **WHEN** an MCP client calls any registered tool other than `project.create` on a connection whose slug names no project, with any arguments
- **THEN** no `projects` row SHALL be inserted

#### Scenario: Creating a new project with an invalid slug

- **WHEN** a creation path receives a slug containing uppercase, leading hyphen, dots, underscores, or a length > 64
- **THEN** the call SHALL be rejected with code `invalid_slug` and SHALL NOT insert a row

#### Scenario: A legacy slug continues to function

- **GIVEN** a pre-existing row with `slug = 'My.Project'` (created under v0.1's looser rules)
- **WHEN** any tool resolves project scope to that slug
- **THEN** the row SHALL be returned and the request SHALL proceed normally

### Requirement: Projects MUST support archive and rename

The dashboard and CLI SHALL allow operators to rename a project (changing its display name without losing memory associations) and to archive a project (preventing new memories from being saved against it while preserving existing ones). The one exception is the default project, which SHALL NOT be archivable (see "The default project MUST NOT be archivable"); it remains renameable.

**A known divergence between this requirement and the shipped server is recorded rather than silently carried.** The scenario below states that an archived project's `memory.search` and `memory.get` continue to return its existing memories. Measured, that is false: authentication rejects an archived project before any authorization runs, so an archived project refuses even `initialize` with a 403 — for a full-access token too. The divergence is **pre-existing** and is NOT resolved by this change: reconciling it means deciding whether the archived-project refusal should move behind authorization or whether this sentence should be corrected, and that decision belongs to a change that owns archive semantics. It is not load-bearing here, because the default project cannot be archived, so no path-less connection can reach an archived scope. Recorded so the next reader finds the finding diagnosed rather than rediscovering it.

#### Scenario: Archiving a project

- **WHEN** the operator archives project `P`
- **THEN** subsequent `memory.save` calls scoped to `P` SHALL reject, but `memory.search` and `memory.get` SHALL continue to return its existing memories
- **AND** the shipped server currently refuses the whole connection instead; that divergence is recorded above and reconciled by a separate change

#### Scenario: The default project cannot be archived

- **WHEN** the operator attempts to archive the project holding `is_default = 1`
- **THEN** the attempt SHALL be refused and the row SHALL remain unarchived

### Requirement: The `projects` service MUST expose `findBySlug` and explicit `create`

The application-layer service that today provides `findOrCreate(path)` SHALL be replaced by two distinct methods: `findBySlug(slug)` (returns the row or `null`, never inserts) and `create({slug, displayName?})` (inserts after validating the strict slug regex, throws on conflict).

#### Scenario: A consumer migrating from `findOrCreate`

- **WHEN** a service that previously called `findOrCreate(path)` is updated
- **THEN** the new code SHALL call `findBySlug(slug)` and, only when the result is `null`, explicitly call `create({slug})` — auto-create on read is forbidden

#### Scenario: Concurrent `create` with the same slug

- **WHEN** two requests racing each call `create({slug: 'foo'})` simultaneously
- **THEN** the first commit SHALL succeed; the second SHALL fail with code `conflict` and SHALL NOT insert a row

### Requirement: Project resolution MUST surface deterministic suggestions on miss

When a resolution path returns `project_not_found`, the response SHALL include `suggestedSlugs: string[]` containing up to 3 existing slugs ranked by Levenshtein distance ≤ 3 from the input slug. The algorithm SHALL be deterministic (same input + database state → same suggestion list) and SHALL execute fully in-process without any LLM call.

#### Scenario: A near-miss produces a suggestion

- **WHEN** a scope-resolving tool is called on a connection at `/mcp/rembic` and projects `'rembric'` and `'rembric-api'` exist
- **THEN** the response SHALL be an error `project_not_found` with payload `{ suggestedSlugs: ['rembric', 'rembric-api'] }`

#### Scenario: Suggestions are never derived from the client's roots

- **WHEN** an MCP client advertising the `roots` capability connects and calls `project.current` or any scope-resolving tool
- **THEN** no response SHALL carry a slug derived from the client's roots, and the server SHALL NOT send `roots/list`

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

### Requirement: Exactly one project MUST be marked as the system default

The `projects` table SHALL carry a boolean `is_default` column, and exactly one row SHALL hold `is_default = 1` at all times. That row is the **default project**: the scope a path-less `/mcp` connection resolves to when nothing else named a project.

Beyond that single resolution rule the default project SHALL be an **ordinary project** in every respect. It SHALL be returned by `project.list` on the same authorization terms as any other project, reachable at `/mcp/<its slug>`, swept by consolidation, filterable on the dashboard, and authorized against by the same `isAuthorized` check. No read SHALL treat it as a wildcard, no read SHALL merge it with another project's rows, and no token SHALL gain reach through it.

**The default project SHALL ALWAYS be created as a NEW `projects` row by schema migration. The migration SHALL NEVER adopt, reuse or re-designate an existing project — not even a project whose slug is already `default`.** Two reasons, in order of severity:

1. **The merge would be irreversible.** Repointing the ex-global corpus into a project the operator created and populated merges two distinct populations, and because memory is append-only the rows survive while their `project_id` no longer records which population they came from. No later change can separate them again.
2. **It would re-admit two collision classes that are impossible ONLY when the destination is brand new.** Repointing changes a row's key under the active-`topic_key` UNIQUE index over `(scope, COALESCE(project_id, ''), topic_key)` and under the entity identity UNIQUE index over `(scope, project_id, kind, value)`. A freshly created project holds no rows, so neither key can already be occupied. A populated destination makes both a live UNIQUE violation, on real data, at boot.

**Its slug SHALL be chosen by probing the table for a free value at migration time, never guessed**: the first unused slug in the sequence `default`, `default-2`, `default-3`, … An operator may already own any of them, and `projects.slug` carries a UNIQUE index, so a taken slug is not a cosmetic problem — the `INSERT` fails, the migration aborts inside its transaction, and the server does not boot. Once chosen the slug SHALL NOT change: the slug is a project's cross-machine identity and no code path updates it. **The `is_default` column, not the slug, is therefore the default project's identity**, and no reader SHALL infer defaultness from a slug's spelling.

`display_name` SHALL be set to a legible value naming its role and SHALL remain renameable through the existing rename action.

**The default project SHALL be created even when no rows need repointing.** On an installation with nothing to migrate, it is still what a path-less connection resolves to.

#### Scenario: A pre-existing project named `default` is not adopted

- **GIVEN** a project with slug `default` that already holds a non-zero number of its own memories
- **WHEN** the migration is applied
- **THEN** a NEW `projects` row SHALL be created, and `is_default = 1` SHALL be set on that new row and NOT on the pre-existing `default` project
- **AND** the pre-existing project's memory count SHALL be unchanged and SHALL still be non-zero, so the assertion is not satisfied vacuously by an empty project
- **AND** every previously-global memory SHALL point at the newly created row, and none SHALL point at the pre-existing `default` project

#### Scenario: Exactly one default exists after migration

- **WHEN** the migration is applied to any database, populated or empty
- **THEN** exactly one `projects` row SHALL hold `is_default = 1`

#### Scenario: The migration body is idempotent

- **WHEN** the migration body is executed a second time against a database it has already migrated
- **THEN** exactly one `is_default` row SHALL still exist, no second project SHALL be created, and zero rows SHALL be repointed on the second pass

#### Scenario: A taken slug does not block creation

- **GIVEN** projects already occupying the slugs `default`, `global`, `personal`, `default-2` and `default-3`
- **WHEN** the migration runs
- **THEN** it SHALL create the default project under a free slug, SHALL NOT fail on the slug UNIQUE index, and SHALL NOT rename any existing project

#### Scenario: An empty installation still gets a default project

- **GIVEN** a database with no rows requiring repointing
- **WHEN** the migration runs
- **THEN** the default project SHALL be created, and a path-less `/mcp` connection SHALL resolve to it

#### Scenario: The chosen slug and the repointed count are reported

- **WHEN** the server boots for the first time after the migration is applied
- **THEN** the boot output SHALL name the created default project's slug and the number of memory rows repointed into it
- **AND** a migration that moves rows SHALL NOT do so without reporting it

### Requirement: The operator surface MUST identify which project is the system default

Because the default project's slug is chosen by collision-avoidance rather than reserved, an installation may hold both an operator's own project named `default` and a system default named `default-2`. The operator SHALL be able to tell which one a path-less `/mcp` connection resolves to without inspecting the database.

The projects list SHALL render a `default` marker on the row holding `is_default = 1` and on no other row. That marker SHALL be driven by the boolean column, never by the slug's spelling: the slug is not the identity and cannot be changed, so a project spelled `default` is no evidence about which project is the default. `display_name` MAY additionally name the role, but is advisory only because an operator may rename it.

The marker SHALL be asserted by test rather than merely rendered, so a template change cannot quietly remove the only signal that disambiguates two similarly-named projects.

#### Scenario: The default marker distinguishes two similarly-named projects

- **GIVEN** an operator's own project with slug `default` and a system default with slug `default-2`
- **WHEN** the operator opens the projects list
- **THEN** exactly one row SHALL carry the `default` marker, and it SHALL be the row holding `is_default = 1`
- **AND** the operator's own `default` project SHALL NOT carry the marker

#### Scenario: The marker follows the column, not the slug

- **GIVEN** the system default has been renamed so its display name no longer mentions the word default
- **WHEN** the operator opens the projects list
- **THEN** the marker SHALL still be rendered on the row holding `is_default = 1`

### Requirement: The default project MUST NOT be archivable

Archiving the default project SHALL be refused. There is no fallback scope behind it, so an archived default leaves a path-less connection with no defined resolution — and archiving a project refuses writes against it, which would make the destination of every path-less write unreachable.

The refusal SHALL be enforced **at the service layer**, not only by hiding the control: the archive endpoint is reachable with a crafted request carrying a valid CSRF token, so a suppressed button is not a guard. The operator-facing archive control SHALL **also** be suppressed for that project, so no operator is offered an action that will be refused.

Renaming the default project SHALL remain permitted. Rename changes only the display name; the slug is immutable, so a rename cannot detach the row from anything.

#### Scenario: Archiving the default project is refused at the service layer

- **WHEN** an archive is requested for the project holding `is_default = 1`, by any caller including a full-access admin
- **THEN** the request SHALL be refused, the row's `archived_at` SHALL remain null, and a path-less connection SHALL continue to resolve to it

#### Scenario: The archive control is not offered for the default project

- **WHEN** an operator views the projects list and the default project's detail
- **THEN** no archive form or button SHALL be rendered for that project
- **AND** an archive control SHALL still be rendered for every other project

#### Scenario: Renaming the default project is permitted

- **WHEN** an operator renames the default project
- **THEN** the display name SHALL change, the slug SHALL be unchanged, `is_default` SHALL remain `1`, and a path-less connection SHALL continue to resolve to it

### Requirement: Project scope MUST be resolvable only from URL path or the default project

The server SHALL resolve an MCP request's project from exactly two sources: (a) the URL path `/mcp/<slug>`, and (b) on a path-less `/mcp` request, the default project. No tool call SHALL set, switch or pin a project, MCP `roots` SHALL NOT be consulted, and no per-connection state SHALL carry a project between requests. The `X-Rembric-Project` header SHALL no longer be consulted; servers SHALL ignore it and SHALL NOT use its value in scope resolution. The `X-Rembric-Repo-Fingerprint` header (see the `repository-binding` capability) SHALL NOT select a project either: the client resolves a fingerprint to a slug before it connects, and connects at `/mcp/<slug>`.

When the URL path carries no slug, the request SHALL resolve to the **default project** (see "Exactly one project MUST be marked as the system default"). There SHALL be exactly one scopeless state: a path-less request that carries the `X-Rembric-Repo-Fingerprint` header is **unbound**. It is authenticated, it resolves to no project, and every tool that resolves an effective scope SHALL be refused with structured code `project_unbound`; it SHALL NOT fall back to the default project. Every other request is either bound to the project its URL slug named or resolved to the default project.

A path slug that names no project is NOT resolved to the default project. An operator who typed a slug asked to be confined to it, and answering a typo with a different project would write into the wrong place silently; such a connection is refused instead.

#### Scenario: URL path sets the scope at connection time

- **WHEN** an MCP call arrives at `/mcp/rembric` and the slug exists
- **THEN** the request SHALL be scoped to project `rembric`, and so SHALL every later request at the same URL

#### Scenario: URL path slug does not exist

- **WHEN** an MCP call arrives at `/mcp/does-not-exist` and no project has that slug
- **THEN** the `initialize` SHALL succeed (path-scoping does not enforce existence pre-tools), BUT any tool call that resolves the scope into a `project_id` SHALL respond with `project_not_found`, SHALL NOT auto-create, and SHALL NOT fall back to the default project

#### Scenario: `X-Rembric-Project` header is sent

- **WHEN** an MCP call arrives with `X-Rembric-Project: rembric`, no path slug and no `X-Rembric-Repo-Fingerprint` header
- **THEN** the server SHALL ignore the header and SHALL resolve the request to the default project

#### Scenario: Neither path nor tool call has set scope

- **WHEN** the agent calls `memory.save` on a `/mcp` connection without an `X-Rembric-Repo-Fingerprint` header, where no tool call can set a project, whether or not its client advertises the `roots` capability
- **THEN** the call SHALL succeed against the default project
- **AND** it SHALL NOT be rejected with `project_required`, which is retired from the MCP surface entirely: no emitting site remains, because the paths that leave a connection unusable emit their own codes — `project_not_found` for an unresolvable slug, `project_archived` for an archived project and `project_unbound` for an unbound repository

#### Scenario: A path-less request carrying a fingerprint is unbound

- **GIVEN** a path-less `/mcp` connection whose requests carry `X-Rembric-Repo-Fingerprint: <fingerprint>`, and a token authorized to write the default project
- **WHEN** the agent calls `memory.save`
- **THEN** the call SHALL be refused with `project_unbound`
- **AND** no row SHALL be written to the default project or to any other project

#### Scenario: The fingerprint header never selects a project

- **GIVEN** fingerprint `F` bound to project `shop`, which the token may write
- **WHEN** a path-less `/mcp` request carries `X-Rembric-Repo-Fingerprint: F` and calls `memory.search`
- **THEN** the call SHALL be refused with `project_unbound`, not served from `shop`

### Requirement: Archiving a project MUST close its pending judgments in the same transaction

Archiving project `P` SHALL, in the same transaction as the `archived_at` write, transition every `memory_relations` row whose endpoints belong to `P` from `pending` to `orphaned` with `marked_by_kind = 'consolidator'`, journaled as an archive orphaning (see the `consolidation` capability). If any step fails, the project SHALL remain unarchived and every judgment SHALL keep its status. Judgments that are `judged` or already `orphaned` SHALL NOT be touched. No memory row SHALL be written. The refusals for the default project and for an already-archived project are unchanged and SHALL leave every judgment untouched.

#### Scenario: Archiving closes the open judgments

- **GIVEN** project `P` with two pending judgments and one judged judgment
- **WHEN** the operator archives `P`
- **THEN** `P` SHALL be archived
- **AND** the two pending judgments SHALL be `orphaned` and the judged one SHALL be unchanged

#### Scenario: A failed archive changes nothing

- **GIVEN** project `P` with pending judgments
- **WHEN** archiving `P` fails after the `archived_at` write but before the journal is complete
- **THEN** `P` SHALL remain unarchived and its judgments SHALL remain `pending`

#### Scenario: Other projects are untouched

- **GIVEN** projects `P` and `Q`, each with pending judgments
- **WHEN** the operator archives `P`
- **THEN** `Q`'s judgments SHALL remain `pending`

### Requirement: Unarchiving a project MUST restore the judgments its archiving closed

Unarchiving project `P` SHALL, in the same transaction as clearing `archived_at`, revert every non-reverted archive orphaning of `P`, whether written at archive time or by the boot reconciliation, under the existing `orphan_promote` undo rules:

- a relation that received a verdict after the orphaning SHALL keep it;
- a relation with an endpoint that is no longer `active` SHALL stay `orphaned`;
- every other relation SHALL return to `pending`, and its op SHALL be marked reverted.

Unarchiving a project with no such orphaning SHALL restore nothing and SHALL still succeed.

#### Scenario: Archive then unarchive leaves the queue as it was

- **GIVEN** project `P` with pending judgments `J1` and `J2`
- **WHEN** the operator archives `P` and then unarchives it
- **THEN** `J1` and `J2` SHALL be `pending`
- **AND** the archive orphan ops SHALL be marked reverted

#### Scenario: Judgments closed by the boot reconciliation are restored too

- **GIVEN** an archived project `Z` whose pending judgments were closed by the process-start reconciliation
- **WHEN** the operator unarchives `Z`
- **THEN** those judgments SHALL be `pending`

#### Scenario: An endpoint retired while archived keeps its judgment closed

- **GIVEN** archived project `P`, a judgment orphaned by its archiving, and one endpoint of that judgment archived from the dashboard since
- **WHEN** the operator unarchives `P`
- **THEN** that judgment SHALL remain `orphaned` and its op SHALL remain non-reverted
- **AND** every other archive orphaning of `P` SHALL be restored

#### Scenario: A second archive cycle only touches what is open

- **GIVEN** project `P` archived, unarchived, and then given a verdict on one restored judgment
- **WHEN** the operator archives `P` again
- **THEN** only the judgments that are `pending` at that moment SHALL be orphaned, in a new `maintenance` run
