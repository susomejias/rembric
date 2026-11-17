## MODIFIED Requirements

### Requirement: A set-scoped token MUST NOT be able to create a project

A set names projects that exist. The only MCP tool that creates a project is `project.create`, and it requires admin authority — the literal token scope `*`, as "A token reaching every project MUST NOT be an admin token" defines it — so a `projects` or `read:projects` token SHALL have no path to create one: `project.create` SHALL refuse it with `admin_token_required` and insert no row, and a connection naming a slug outside its set SHALL NOT create the project it names. The same holds for every project-scoped token, whatever its access.

#### Scenario: A set token cannot create a project by naming it

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`, and no project with slug `brand-new`
- **WHEN** the token connects at `/mcp/brand-new` and calls `project.list`, `project.current` and every scope-resolving tool
- **THEN** every scope-resolving call SHALL be refused with `project_not_found`, and no `projects` row SHALL be created
- **AND** an admin `*` token making the same calls SHALL likewise create no project, which is the control that the absence of a row comes from resolution never creating one and not from the set

#### Scenario: A set token cannot create a project with `project.create`

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`, and no project with slug `brand-new`
- **WHEN** the token calls `project.create({ slug: 'brand-new' })`
- **THEN** the call SHALL be refused with `admin_token_required`, and no `projects` row SHALL be created
- **AND** an admin `*` token making the same call SHALL create `brand-new`, which is the control that the refusal comes from the admin check and not from the slug

#### Scenario: Autocreate is refused for a set token

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`
- **WHEN** the token calls `project.use({ slug: 'brand-new', autocreate: true })`
- **THEN** the call SHALL be refused because no tool named `project.use` is registered, and no `projects` row SHALL be created
- **AND** an admin `*` token making the same call SHALL be refused the same way, which is the control that the refusal comes from the removed tool and not from the set
