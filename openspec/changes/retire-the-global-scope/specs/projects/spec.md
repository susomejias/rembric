## ADDED Requirements

### Requirement: Exactly one project MUST be marked as the system default

The `projects` table SHALL carry a boolean `is_default` column, and exactly one row SHALL hold `is_default = 1` at all times. That row is the **default project**: the scope a path-less `/mcp` connection resolves to when nothing else named a project.

Beyond that single resolution rule the default project SHALL be an **ordinary project** in every respect. It SHALL be returned by `project.list` on the same authorization terms as any other project, activatable by `project.use`, swept by consolidation, filterable on the dashboard, and authorized against by the same `isAuthorized` check. No read SHALL treat it as a wildcard, no read SHALL merge it with another project's rows, and no token SHALL gain reach through it.

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

## MODIFIED Requirements

### Requirement: Project scope MUST be resolvable only from URL path or explicit tool call

The server SHALL accept two ways to set the active project for an MCP session: (a) the URL path `/mcp/<slug>` and (b) the `project.use({slug})` tool call. The `X-Rembric-Project` header SHALL no longer be consulted; servers SHALL ignore it and SHALL NOT use its value in scope resolution.

When neither mechanism has fired, the connection SHALL resolve to the **default project** (see "Exactly one project MUST be marked as the system default"). There SHALL be no scopeless state: a connection is either bound to the project its URL slug named, bound to a project a tool call activated, or resolved to the default project. Auto-detection via MCP `roots` MAY replace the default with a project on `/mcp` connections, but only by activating an _existing_ slug (see the next requirement).

A path slug that names no project is NOT resolved to the default project. An operator who typed a slug asked to be confined to it, and answering a typo with a different project would write into the wrong place silently; such a connection is refused instead.

#### Scenario: URL path sets the scope at connection time

- **WHEN** an MCP call arrives at `/mcp/rembric` and the slug exists
- **THEN** the request SHALL be scoped to project `rembric` for the lifetime of the MCP transport session

#### Scenario: URL path slug does not exist

- **WHEN** an MCP call arrives at `/mcp/does-not-exist` and no project has that slug
- **THEN** the `initialize` SHALL succeed (path-scoping does not enforce existence pre-tools), BUT any tool call that resolves the scope into a `project_id` SHALL respond with `project_not_found`, SHALL NOT auto-create, and SHALL NOT fall back to the default project

#### Scenario: `X-Rembric-Project` header is sent

- **WHEN** an MCP call arrives with `X-Rembric-Project: rembric` and no path slug
- **THEN** the server SHALL ignore the header and SHALL resolve the request to the default project

#### Scenario: Neither path nor tool call has set scope

- **WHEN** the agent calls `memory.save` on a `/mcp` connection without having called `project.use` and without `roots`-based discovery resolving to a project
- **THEN** the call SHALL succeed against the default project
- **AND** it SHALL NOT be rejected with `project_required`, which survives only for the unresolvable-slug and archived-project paths

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
