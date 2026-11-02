## MODIFIED Requirements

### Requirement: Tokens MUST be manageable from the dashboard

The `/dashboard/tokens` view SHALL list existing tokens (name, scope, project, created_at, revoked_at, expires_at) and SHALL allow creating a new token (shown in plaintext exactly once) and revoking an existing token (setting `revoked_at`). An administrator with a valid form-specific CSRF token SHALL also be able to explicitly promote an existing active non-administrator static token by immutable ID. The row action SHALL require a danger confirmation naming the token and warning that every holder of its unchanged secret gains full read/write access to every project and server/dashboard administration. Cancel SHALL make no request. Ineligible and already-administrator rows SHALL NOT offer promotion; forged requests SHALL be validated by the server. After success the list SHALL show an Admin badge and the description All projects · Server administration, without redisplaying a secret. This presentation SHALL be based strictly on `scope='*'`, independently of lifecycle state; global read-only and project-set grants SHALL NOT be labeled Admin. Raw scope and project metadata SHALL remain visible for non-admin tokens. No generic grant editor, bulk promotion or demotion is introduced.

**Rotation SHALL be explicit and admin-only.** Active rows, including administrators, SHALL offer Rotate token; inactive rows SHALL NOT. The action SHALL use immutable ID, an authenticated administrator session and rotation-specific CSRF. A danger confirmation SHALL name the target, warn that the old secret, linked dashboard sessions and OAuth authorizations will be invalidated, and require clients to authenticate again. Cancel SHALL send no mutation. The new secret SHALL appear only in the successful action response and transient client UI outside the menu, with copy and explicit dismissal; it SHALL NOT enter a URL, redirect, cookie, browser storage, log or persistent plaintext store. Closing or leaving this view SHALL discard the secret; refreshing SHALL NOT reveal it again. Pending submission SHALL prevent repeat clicks. Self-rotation SHALL allow copying the secret before navigation requires re-login. There SHALL be no reveal endpoint or bulk rotation.

#### Scenario: Administrator rotates a token

- **WHEN** an administrator confirms rotation with valid form-specific CSRF
- **THEN** the new secret SHALL be shown once with a warning to update clients and reauthenticate
- **AND** the list SHALL retain the token identity, grant and expiration

#### Scenario: Cancel, unauthorized or ineligible rotation

- **WHEN** rotation is cancelled, lacks an admin session or valid CSRF, or names an ineligible token
- **THEN** no secret or descendant credential SHALL change

#### Scenario: Self-rotation does not lose the new secret

- **WHEN** the operator rotates the token underlying their current dashboard session
- **THEN** they SHALL be able to copy the response's new secret before leaving the one-time view
- **AND** subsequent authenticated navigation SHALL require re-login with a valid administrator credential

**Administrator access SHALL be explicit.** The create form SHALL require `tokenType` with choices Project access (`projects`) and Administrator (`admin`), defaulting to Project access. Administrator SHALL display a warning describing full read/write access to every project and dashboard administration, hide project/access controls, and submit `access=write` with no projects. The handler SHALL reject missing or unrecognized token types and contradictory administrator submissions (read access or any project selection), without creating a token.

**Reach and access SHALL compose within Project access.** The `project` control SHALL select zero, one, or many projects and the `access` selector SHALL offer `write` and `read`, defaulting to `write`. Write access SHALL require at least one project; an empty selection SHALL NOT implicitly grant administrator access. Read access with no projects SHALL remain available, with guidance that it grants global read-only access without administration or dashboard login. `access` SHALL apply to the whole selection, not per project. All existing project-selection scenarios below use `tokenType=projects`. The combinations SHALL map onto the existing token scope grammar exactly:

| `project` selection | `access` | minted scope        | `tokens.project_id` | `token_projects` rows     |
| ------------------- | -------- | ------------------- | ------------------- | ------------------------- |
| empty (Administrator only) | `write` | `*` | `NULL` | none |
| empty (Project access) | `write` | refused | no row | none |
| empty               | `read`   | `read:*`            | `NULL`              | none                      |
| exactly one slug    | `write`  | `project:<id>`      | `<id>`              | none                      |
| exactly one slug    | `read`   | `read:project:<id>` | `<id>`              | none                      |
| two or more slugs   | `write`  | `projects`          | `NULL`              | one row per selected slug |
| two or more slugs   | `read`   | `read:projects`     | `NULL`              | one row per selected slug |

A single-project selection SHALL continue to mint the single-project arm rather than a one-member set, so no existing token shape becomes unreachable from the form and the existing project binding stays FK-enforced for the common case.

Within Project access, a project selection SHALL NOT be discarded under any combination, and every arm of the grammar — including `read:project:<id>`, `projects` and `read:projects` — SHALL be mintable from the form.

**An unrecognized scope field SHALL be rejected, not ignored.** A create request carrying the retired `scope` form field SHALL be refused with a flash error naming the `access` field, rather than minting a token whose reach differs from the request. Silently dropping a submitted field is the failure this requirement exists to remove.

**An absent `access` SHALL be refused, not defaulted.** A create request whose `access` is missing, empty, or any value other than `write` or `read` SHALL be refused with a flash error and SHALL NOT create a token row. The `write` default is a property of the rendered form only; the handler SHALL NOT reinstate it, because defaulting an omitted `access` silently picks the more privileged verb, and privileged access must never be inferred from an omitted field.

**The minted scope SHALL be stated back to the operator.** The one-time-view component SHALL render, alongside the plaintext secret, the scope that was actually persisted and every project it reaches (or that it is bound to no project). For a set-scoped token that means every member slug, not a count. The operator SHALL be able to see what they were handed without querying the database.

**The list SHALL render the project as a slug.** The `project` column SHALL show the slug of the project named by `tokens.project_id`, resolved at render time, and SHALL NOT render a project id. For a set-scoped token the cell SHALL render the slug of **every** member project, in slug-ascending order, and SHALL NOT render a project id or a bare count. A non-admin token with no project binding and no membership rows SHALL render `—`; administrator rows SHALL instead describe their all-projects and server-administration reach. A project that has been archived SHALL still resolve to its slug.

**A token whose project binding does not resolve SHALL be marked distinctly.** A row whose scope names a project (`project:` or `read:project:`) that is not the id of an existing project authorizes nothing. Its state SHALL be rendered as its own value, distinct from both `active` and `revoked`, and its `project` cell SHALL render `—`.

**A set-scoped token with no members SHALL be marked distinctly from that state.** A `projects` or `read:projects` row with zero `token_projects` rows also authorizes nothing, but SHALL NOT be rendered as the unresolvable state, because the unresolvable state carries a contract that the row is never to be repaired while an empty set is repairable by the operator. Its state SHALL be its own value, distinct from `active`, `revoked` and the unresolvable state, and its `project` cell SHALL render `—`.

State precedence SHALL be `revoked`, then `expired`, then unresolvable, then empty-set, then `active`.

**Creating a project from this form is an operator action, not a token capability.** The form's handler runs under an admin dashboard session, so creating a project row here SHALL remain permitted. This does not grant the _minted_ token any authority to create projects; see `auth` — "A set-scoped token MUST NOT be able to create a project".

Creating a token is not a destructive action and SHALL NOT require the confirmation modal; the existing revoke action SHALL keep its `data-confirm` danger-tone modal. This requirement introduces no new design tokens: the multi-selection control SHALL be styled with the existing `:root` token set only.

#### Scenario: Confirmed promotion of an active token

- **GIVEN** an active project-scoped token and an administrator session
- **WHEN** the operator confirms the promotion action
- **THEN** the existing token SHALL become administrator without changing its secret
- **AND** its list row SHALL show an Admin badge and All projects · Server administration

#### Scenario: Cancel or unauthorized promotion does not mutate

- **WHEN** the operator cancels the dialog, or a promotion submission lacks an admin session or valid promotion-specific CSRF
- **THEN** no grant SHALL change

#### Scenario: Ineligible tokens do not expose promotion

- **WHEN** the list contains revoked, expired, deleted, inert, memberless-set or already-administrator tokens
- **THEN** none of those rows SHALL offer promotion
- **AND** forged requests for inactive targets SHALL be refused without changes

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

#### Scenario: Administrator issuance is explicit

- **WHEN** the operator submits `tokenType=admin`, no projects and `access=write`
- **THEN** the persisted row SHALL have `scope='*'` and `project_id IS NULL`

#### Scenario: Project access never implicitly mints administrator

- **WHEN** the operator submits `tokenType=projects`, no projects and `access=write`
- **THEN** the handler SHALL return an error and SHALL NOT create a token

#### Scenario: Global read-only access remains available

- **WHEN** the operator submits `tokenType=projects`, no projects and `access=read`
- **THEN** the persisted scope SHALL be `read:*` with no project binding
- **AND** the form SHALL describe that combination as read-only, not administrator

#### Scenario: Invalid or conflicting token types are refused

- **WHEN** a submission omits `tokenType`, supplies an unknown type, or combines `admin` with projects or read access
- **THEN** the handler SHALL return an error and SHALL NOT create a token

#### Scenario: The form defaults to non-administrator access

- **WHEN** the operator opens the new-token form
- **THEN** Project access SHALL be selected by default
- **AND** choosing Administrator SHALL show the warning before submission

#### Scenario: Selecting several projects mints a set-scoped token

- **GIVEN** an authenticated operator and existing projects `alpha`, `beta`, `gamma`
- **WHEN** the operator submits the form selecting `alpha` and `gamma` with `access = write`
- **THEN** the persisted row SHALL have `scope = 'projects'` and `project_id IS NULL`
- **AND** `token_projects` SHALL contain exactly the ids of `alpha` and `gamma` for that token
- **AND** the returned plaintext SHALL be authorized against `alpha` and against `gamma`
- **AND** the returned plaintext SHALL be rejected against `beta`

#### Scenario: Selecting several projects with read access mints `read:projects`

- **GIVEN** an authenticated operator and existing projects `alpha`, `gamma`
- **WHEN** the operator submits the form selecting `alpha` and `gamma` with `access = read`
- **THEN** the persisted row SHALL have `scope = 'read:projects'` and `project_id IS NULL`
- **AND** the returned plaintext SHALL be authorized for a read-classified operation on `alpha` and refused a write-classified one on `alpha`

#### Scenario: A set-scoped token minted over every project is still not an admin token

- **GIVEN** an authenticated operator and exactly the projects `alpha`, `beta`, `gamma`
- **WHEN** the operator submits the form selecting all three with `access = write`
- **THEN** the persisted scope SHALL be `projects`, not `*`
- **AND** the returned plaintext SHALL be refused by `POST /dashboard/login`

#### Scenario: A single selection does not become a one-member set

- **GIVEN** an authenticated operator and an existing project `alpha`
- **WHEN** the operator submits the form selecting only `alpha` with `access = write`
- **THEN** the persisted row SHALL have `scope = 'project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** `token_projects` SHALL contain no row for that token

#### Scenario: The retired `scope` field is refused

- **WHEN** a create request arrives carrying a `scope` form field
- **THEN** the server SHALL respond with a flash error naming the `access` field and SHALL NOT create a token row

#### Scenario: An absent or unrecognized `access` is refused

- **WHEN** a create request arrives with no `access` field, an empty `access`, or a value other than `write` or `read`
- **THEN** the server SHALL respond with a flash error and SHALL NOT create a token row

#### Scenario: The one-time view states the minted scope

- **GIVEN** the operator has just created a token for project `alpha` with read access
- **THEN** the one-time-view component SHALL render the plaintext secret, the minted scope, and the slug `alpha`

#### Scenario: The one-time view enumerates every project of a set token

- **GIVEN** the operator has just created a token selecting `alpha` and `gamma`
- **THEN** the one-time-view component SHALL render the plaintext secret, the scope `projects`, and both slugs `alpha` and `gamma`

#### Scenario: The list shows the project slug, never the id

- **GIVEN** a token bound to a project whose slug is `alpha`
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the table SHALL contain a `project` header and a cell rendering `alpha`
- **AND** no cell SHALL render a project ULID

#### Scenario: The list enumerates every member of a set token

- **GIVEN** a set-scoped token whose members are the projects with slugs `alpha` and `gamma`
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** that row's `project` cell SHALL render both `alpha` and `gamma`, in that order
- **AND** the cell SHALL NOT render a project ULID
- **AND** the row's state SHALL render as `active`

#### Scenario: A token bound to an archived project still shows its slug

- **GIVEN** a token bound to a project that has since been archived
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the `project` cell SHALL render that project's slug rather than `—`

#### Scenario: A set token whose member has been archived still shows that slug

- **GIVEN** a set-scoped token whose members are `alpha` and `gamma`, where `gamma` has since been archived
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the `project` cell SHALL render both `alpha` and `gamma`

#### Scenario: An unresolvable project-scoped token is marked as neither active nor revoked

- **GIVEN** a token row with `scope = 'project:<a value that is not a project id>'` and `project_id IS NULL`, not revoked and not expired
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the row's state SHALL render as a value distinct from both `active` and `revoked`
- **AND** its `project` cell SHALL render `—`
- **AND** its `scope` cell SHALL still render the raw scope string

#### Scenario: A memberless set token is distinguished from an unresolvable one

- **GIVEN** a token row with `scope = 'projects'`, `project_id IS NULL` and zero `token_projects` rows, not revoked and not expired, alongside a token row with `scope = 'project:<a value that is not a project id>'`
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the two rows' states SHALL render as two different values, neither of which is `active` or `revoked`
- **AND** both rows' `project` cells SHALL render `—`

#### Scenario: Revocation outranks the unresolvable state

- **GIVEN** a revoked token row whose scope names a project that does not resolve
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the row's state SHALL render as `revoked`

#### Scenario: Revocation outranks the empty-set state

- **GIVEN** a revoked token row with `scope = 'projects'` and zero `token_projects` rows
- **WHEN** the operator opens `/dashboard/tokens`
- **THEN** the row's state SHALL render as `revoked`

#### Scenario: An unknown project slug submitted to the create form

- **WHEN** a create request arrives with a `project` value that is not an existing project slug and that satisfies the strict slug regex
- **THEN** the server SHALL create the project row and bind the token to it
- **AND** a value that violates the slug regex SHALL be refused with a flash error and SHALL NOT create a token row

#### Scenario: One invalid slug in a multi-project submission refuses the whole request

- **GIVEN** an authenticated operator and an existing project `alpha`
- **WHEN** a create request arrives selecting `alpha` together with a value that violates the strict slug regex
- **THEN** the server SHALL respond with a flash error
- **AND** no token row SHALL be created
- **AND** no `token_projects` row SHALL be created

[1357 more lines in file. Use offset=380 to continue.]
