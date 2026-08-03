## MODIFIED Requirements

### Requirement: Tokens MUST be manageable from the dashboard

The `/dashboard/tokens` view SHALL list existing tokens (name, scope, project, created_at, revoked_at, expires_at) and SHALL allow creating a new token (shown in plaintext exactly once) and revoking an existing token (setting `revoked_at`).

**Reach and access SHALL compose.** The create form SHALL carry two independent controls: a `project` selector (empty → all projects; otherwise a project slug) and an `access` selector offering `write` and `read`, with `write` as the pre-selected option. Neither control SHALL void the other. The four combinations SHALL map onto the four arms of the token scope grammar exactly:

| `project` | `access` | minted scope        | `tokens.project_id` |
| --------- | -------- | ------------------- | ------------------- |
| empty     | `write`  | `*`                 | `NULL`              |
| empty     | `read`   | `read:*`            | `NULL`              |
| slug      | `write`  | `project:<id>`      | `<id>`              |
| slug      | `read`   | `read:project:<id>` | `<id>`              |

A project selection SHALL NOT be discarded under any combination, and every arm of the grammar — including `read:project:<id>` — SHALL be mintable from the form.

**An unrecognized scope field SHALL be rejected, not ignored.** A create request carrying the retired `scope` form field SHALL be refused with a flash error naming the `access` field, rather than minting a token whose reach differs from the request. Silently dropping a submitted field is the failure this requirement exists to remove.

**An absent `access` SHALL be refused, not defaulted.** A create request whose `access` is missing, empty, or any value other than `write` or `read` SHALL be refused with a flash error and SHALL NOT create a token row. The `write` default is a property of the rendered form only; the handler SHALL NOT reinstate it, because defaulting an omitted `access` silently picks the more privileged verb, and with no project selected that verb is `*` — the only scope the dashboard login accepts.

**The minted scope SHALL be stated back to the operator.** The one-time-view component SHALL render, alongside the plaintext secret, the scope that was actually persisted and the project it is bound to (or that it is bound to no project). The operator SHALL be able to see what they were handed without querying the database.

**The list SHALL render the project as a slug.** The `project` column SHALL show the slug of the project named by `tokens.project_id`, resolved at render time, and SHALL NOT render a project id. A token with no project binding SHALL render `—`. A project that has been archived SHALL still resolve to its slug.

**A token whose project binding does not resolve SHALL be marked distinctly.** A row whose scope names a project (`project:` or `read:project:`) that is not the id of an existing project authorizes nothing. Its state SHALL be rendered as its own value, distinct from both `active` and `revoked`, and its `project` cell SHALL render `—`. State precedence SHALL be `revoked`, then `expired`, then unresolvable, then `active`.

Creating a token is not a destructive action and SHALL NOT require the confirmation modal; the existing revoke action SHALL keep its `data-confirm` danger-tone modal. This requirement introduces no new design tokens.

#### Scenario: Creating a token

- **WHEN** the operator submits the new-token form
- **THEN** the server SHALL generate a token, store its hash in `tokens`, and render the plaintext token exactly once in a one-time-view component

#### Scenario: Revoking a token

- **WHEN** the operator clicks "Revoke" on a token
- **THEN** the corresponding row SHALL have `revoked_at` set; subsequent MCP requests using that token SHALL be rejected

#### Scenario: A project selection with default access mints a working project-scoped token

- **GIVEN** an authenticated operator and an existing project `alpha`
- **WHEN** the operator submits the form with `project = alpha` and `access = write`
- **THEN** the persisted row SHALL have `scope = 'project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** the returned plaintext SHALL be authorized against project `alpha`

#### Scenario: A project selection with read access mints `read:project:<id>`

- **GIVEN** an authenticated operator and an existing project `alpha`
- **WHEN** the operator submits the form with `project = alpha` and `access = read`
- **THEN** the persisted row SHALL have `scope = 'read:project:' || <id of alpha>` and `project_id = <id of alpha>`

#### Scenario: A project selection is never discarded by the access selector

- **GIVEN** an authenticated operator, an existing project `alpha`, and a second project `never-selected`
- **WHEN** the operator submits the form with `project = alpha` and `access = read`
- **THEN** the persisted scope SHALL name `alpha`
- **AND** the returned plaintext SHALL be rejected against `never-selected`

#### Scenario: No project selection mints a global token

- **WHEN** the operator submits the form with an empty `project` and `access = write`
- **THEN** the persisted row SHALL have `scope = '*'` and `project_id IS NULL`
- **AND** submitting an empty `project` with `access = read` SHALL persist `scope = 'read:*'` and `project_id IS NULL`

#### Scenario: The retired `scope` field is refused

- **WHEN** a create request arrives carrying a `scope` form field
- **THEN** the server SHALL respond with a flash error naming the `access` field and SHALL NOT create a token row

#### Scenario: An absent or unrecognized `access` is refused

- **WHEN** a create request arrives with no `access` field, an empty `access`, or a value other than `write` or `read`
- **THEN** the server SHALL respond with a flash error and SHALL NOT create a token row

#### Scenario: The one-time view states the minted scope

- **GIVEN** the operator has just created a token for project `alpha` with read access
- **THEN** the one-time-view component SHALL render the plaintext secret, the minted scope, and the slug `alpha`

#### Scenario: The list shows the project slug, never the id

- **GIVEN** a token bound to a project whose slug is `alpha`
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the table SHALL contain a `project` header and a cell rendering `alpha`
- **AND** no cell SHALL render a project ULID

#### Scenario: A token bound to an archived project still shows its slug

- **GIVEN** a token bound to a project that has since been archived
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the `project` cell SHALL render that project's slug rather than `—`

#### Scenario: An unresolvable project-scoped token is marked as neither active nor revoked

- **GIVEN** a token row with `scope = 'project:<a value that is not a project id>'` and `project_id IS NULL`, not revoked and not expired
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the row's state SHALL render as a value distinct from both `active` and `revoked`
- **AND** its `project` cell SHALL render `—`
- **AND** its `scope` cell SHALL still render the raw scope string

#### Scenario: Revocation outranks the unresolvable state

- **GIVEN** a revoked token row whose scope names a project that does not resolve
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the row's state SHALL render as `revoked`

#### Scenario: An unknown project slug submitted to the create form

- **WHEN** a create request arrives with a `project` value that is not an existing project slug and that satisfies the strict slug regex
- **THEN** the server SHALL create the project row and bind the token to it
- **AND** a value that violates the slug regex SHALL be refused with a flash error and SHALL NOT create a token row
