## MODIFIED Requirements

### Requirement: Projects MUST be uniquely identified by their slug

The `projects` table SHALL store the canonical identifier of each project in a column named `slug` (renamed from `path` in this change). `slug` SHALL be `TEXT NOT NULL UNIQUE`. A migration SHALL rename the column atomically; no value normalization SHALL occur during the rename — legacy values continue to function for read and write.

Projects SHALL be created from the dashboard only; no MCP tool SHALL create a project. For _new_ slugs created after this change, the value SHALL match the strict regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`. Paths SHALL NOT be persisted in the projects table and SHALL NOT be accepted by any tool argument.

#### Scenario: Renaming the column at migration time

- **GIVEN** a v0.1 database with a populated `projects.path` column
- **WHEN** migration `0003_sessions_and_slugs.sql` runs
- **THEN** the column SHALL be renamed to `slug` and all existing rows SHALL retain their values verbatim

#### Scenario: Creating a new project with a valid slug

- **WHEN** the operator creates a project with slug `rembric-api` from the dashboard and the slug does not exist
- **THEN** a new row SHALL be inserted with that slug

#### Scenario: No MCP tool creates a project

- **WHEN** an MCP client calls any registered tool on a connection whose slug names no project, with any arguments
- **THEN** no `projects` row SHALL be inserted

#### Scenario: Creating a new project with an invalid slug

- **WHEN** a creation path receives a slug containing uppercase, leading hyphen, dots, underscores, or a length > 64
- **THEN** the call SHALL be rejected with code `invalid_slug` and SHALL NOT insert a row

#### Scenario: A legacy slug continues to function

- **GIVEN** a pre-existing row with `slug = 'My.Project'` (created under v0.1's looser rules)
- **WHEN** any tool resolves project scope to that slug
- **THEN** the row SHALL be returned and the request SHALL proceed normally

### Requirement: Project scope MUST be resolvable only from URL path or the default project

The server SHALL resolve an MCP request's project from exactly two sources: (a) the URL path `/mcp/<slug>`, and (b) on a path-less `/mcp` request, the default project. No tool call SHALL set, switch or pin a project, MCP `roots` SHALL NOT be consulted, and no per-connection state SHALL carry a project between requests. The `X-Rembric-Project` header SHALL no longer be consulted; servers SHALL ignore it and SHALL NOT use its value in scope resolution.

When the URL path carries no slug, the request SHALL resolve to the **default project** (see "Exactly one project MUST be marked as the system default"). There SHALL be no scopeless state: a request is either bound to the project its URL slug named or resolved to the default project.

A path slug that names no project is NOT resolved to the default project. An operator who typed a slug asked to be confined to it, and answering a typo with a different project would write into the wrong place silently; such a connection is refused instead.

#### Scenario: URL path sets the scope at connection time

- **WHEN** an MCP call arrives at `/mcp/rembric` and the slug exists
- **THEN** the request SHALL be scoped to project `rembric`, and so SHALL every later request at the same URL

#### Scenario: URL path slug does not exist

- **WHEN** an MCP call arrives at `/mcp/does-not-exist` and no project has that slug
- **THEN** the `initialize` SHALL succeed (path-scoping does not enforce existence pre-tools), BUT any tool call that resolves the scope into a `project_id` SHALL respond with `project_not_found`, SHALL NOT auto-create, and SHALL NOT fall back to the default project

#### Scenario: `X-Rembric-Project` header is sent

- **WHEN** an MCP call arrives with `X-Rembric-Project: rembric` and no path slug
- **THEN** the server SHALL ignore the header and SHALL resolve the request to the default project

#### Scenario: Neither path nor tool call has set scope

- **WHEN** the agent calls `memory.save` on a `/mcp` connection, where no tool call can set a project, whether or not its client advertises the `roots` capability
- **THEN** the call SHALL succeed against the default project
- **AND** it SHALL NOT be rejected with `project_required`, which is retired from the MCP surface entirely: no emitting site remains, because the two paths that leave a connection unusable emit their own codes — `project_not_found` for an unresolvable slug and `project_archived` for an archived project

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

## REMOVED Requirements

### Requirement: Project auto-detection via MCP `roots` MUST be read-only

**Reason**: The server no longer issues `roots/list`, so no project is derived from the basename of a client root. A lost or mismatched `roots/list` misfiled every row the connection wrote, and memory has no reassignment verb; the `2026-07-28` protocol revision also deprecates `roots` and removes the per-connection session the discovery state lived on.

**Migration**: A path-less `/mcp` connection resolves to the default project. To scope a connection to another project, connect at `/mcp/<slug>`; bridge clients do so by adding a `.rembric` file with `PROJECT_SLUG` or by setting `REMBRIC_PROJECT_SLUG`. Projects are created from the dashboard.

### Requirement: The `roots/list_changed` refresh MUST be per-transport, advisory, and delivered under a tool call

**Reason**: With roots discovery removed there is no roots-derived suggestion to refresh. The server ignores `notifications/roots/list_changed`, and `project.current` no longer carries `suggestedSlugs`.

**Migration**: None required. Change the connection's URL to `/mcp/<slug>` to change its project; a client that still sends `notifications/roots/list_changed` is unaffected.

## RENAMED Requirements

- FROM: `### Requirement: Project scope MUST be resolvable only from URL path or explicit tool call`
- TO: `### Requirement: Project scope MUST be resolvable only from URL path or the default project`
