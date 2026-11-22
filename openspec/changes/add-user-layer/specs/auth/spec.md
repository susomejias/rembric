## ADDED Requirements

### Requirement: Every static token MUST belong to a user, enforced by the database

The server SHALL keep a `users` table whose rows carry an immutable `id`, a unique `name`, a `role` that the database SHALL constrain to `admin` or `member`, and a `created_at` timestamp. Every `tokens` row SHALL reference exactly one `users` row through a `user_id` column that the database SHALL declare `NOT NULL` with a foreign key, so a token without an owner is unrepresentable rather than refused by service code. No operation SHALL delete a `users` row.

An OAuth grant SHALL belong to the user who owns the static token named by the grant's `subject`, which is the dashboard credential whose session consented it. The owner SHALL be resolved from that token row on every authentication, whether or not that token has since been revoked or soft-deleted. A grant whose `subject` names no token row SHALL have no owner: it SHALL keep the data reach its scope grants and SHALL have no administrative capability.

A token minted from the dashboard SHALL be owned by the user who owns the credential of the session that minted it.

#### Scenario: A token without an owner is unrepresentable

- **WHEN** a row is inserted into `tokens` with `user_id` NULL, or with a `user_id` that names no `users` row
- **THEN** the database SHALL reject the insert and no `tokens` row SHALL be created
- **AND** the same insert naming an existing user SHALL succeed, which is the control that the rejection comes from the ownership constraint

#### Scenario: A role outside the vocabulary is refused

- **WHEN** a `users` row is inserted or updated with a `role` other than `admin` or `member`
- **THEN** the database SHALL reject it

#### Scenario: An OAuth grant belongs to the owner of the consenting credential

- **GIVEN** an operator signed in to the dashboard with a static token `T` owned by user `U`
- **WHEN** the operator approves an OAuth consent and the client redeems the code
- **THEN** the authorization code and every token of the family SHALL carry `subject` `T`
- **AND** a request authenticated with the issued access token SHALL carry acting user `U` in its request context

#### Scenario: A grant whose subject names no token has no owner

- **GIVEN** a path-less write OAuth grant whose `subject` names no `tokens` row
- **WHEN** its access token calls `memory.save` on `/mcp` and then `project.create({ slug: 'orphan' })`
- **THEN** `memory.save` SHALL succeed
- **AND** `project.create` SHALL be refused with `admin_token_required`, and no `projects` row SHALL be created

### Requirement: Administrative capability MUST be the owner's admin role combined with the credential's own delegation

A credential SHALL have **administrative capability** if and only if all three hold: it has an owner; its owner's `role` is `admin`; and the credential itself delegates administration. A static token SHALL delegate administration exactly when its scope is the literal `*`. An OAuth grant SHALL delegate administration exactly when its derived scope is `*` and the operator granted administration at consent (see the `mcp-oauth` capability). Neither the owner's role alone nor the credential's delegation alone SHALL confer it, and no breadth of data reach, by any scope arm or membership set, SHALL confer it.

Administrative capability SHALL be the single authorization for every administrative surface: `project.create`, `project.bind_repository`, the dashboard login and every dashboard action gated on admin authority, every `/admin/*` route, and the debug surfaces. Wherever a capability's spec says "admin token", "admin authority" or "admin-scoped", it SHALL mean a credential with administrative capability. Data reach SHALL remain governed by the token scope grammar and `isAuthorized` alone; administrative capability SHALL NOT widen or narrow it.

The request context of every authenticated MCP and `/api` request, and the context of every dashboard session, SHALL carry the acting user (its `id` and `role`, or none for an ownerless grant) and whether the credential has administrative capability. Both SHALL be re-read from storage on every authenticated request, with the same freshness as revocation: a warm credential-lookup cache SHALL NOT carry a previous owner, role or delegation forward.

#### Scenario: An admin user's static admin token administers

- **GIVEN** a static token with scope `*` owned by a user whose role is `admin`
- **WHEN** it calls `project.create({ slug: 'acme' })`
- **THEN** the call SHALL succeed and a project `acme` SHALL exist

#### Scenario: An OAuth connector without administrative capability is refused project creation

- **GIVEN** a path-less write OAuth grant, derived scope `*`, consented by an administering session without granting administration
- **WHEN** its access token calls `project.create({ slug: 'acme' })`
- **THEN** the call SHALL be refused with `admin_token_required`, and no `projects` row SHALL be created
- **AND** `memory.save` with the same access token on the same connection SHALL succeed, which is the control that the refusal comes from the capability and not from data reach

#### Scenario: The owner's role alone does not administer

- **GIVEN** a user whose role is `admin` owning a token with scope `projects` whose membership set contains every existing project
- **WHEN** the token calls `project.create` or is submitted to `POST /dashboard/login`
- **THEN** both SHALL be refused

#### Scenario: Delegation alone does not administer

- **GIVEN** a token with scope `*` owned by a user whose role is `member`
- **WHEN** the token calls `project.create` or is submitted to `POST /dashboard/login`
- **THEN** both SHALL be refused
- **AND** `memory.save` with the same token on any existing project SHALL succeed, because data reach is unchanged

#### Scenario: Ownership and role are re-read on every request

- **GIVEN** a token with scope `*` owned by an `admin` user, whose plaintext has already been verified once so the credential-lookup cache is warm
- **WHEN** its owner's role is set to `member` in storage and the same plaintext calls `project.create`
- **THEN** the call SHALL be refused with `admin_token_required`
- **AND** after the role is set back to `admin`, the next call SHALL succeed

### Requirement: Existing tokens MUST be assigned to one bootstrap administrator without changing any credential's authority

The migration that introduces users SHALL, in one transaction: create the `users` table; insert exactly one user whose role is `admin` (the bootstrap administrator), whether or not any token exists; rebuild `tokens` so that every pre-existing row is copied with every existing column value unchanged (id, name, hash, scope, project binding, and the creation, expiry, revocation and deletion timestamps) and with `user_id` set to the bootstrap administrator; and pass the migration runner's `foreign_key_check` gate, so every `dashboard_sessions`, `sessions` and `token_projects` reference still resolves. Memberships SHALL be untouched. No `memory`, `sessions`, `consolidation_ops` or other append-only row SHALL be updated or deleted.

Because every pre-existing token keeps its scope and is owned by an `admin` user, every static credential SHALL have exactly the authority after the migration that it had before it. OAuth grants issued before the migration SHALL follow the `mcp-oauth` capability. Existing dashboard sessions SHALL keep resolving.

#### Scenario: An existing static admin token keeps working after the migration

- **GIVEN** a database at the previous schema with a static token `admin` of scope `*` and an active dashboard session linked to it
- **WHEN** the migration runs and the same plaintext is used afterwards
- **THEN** `POST /dashboard/login` SHALL succeed with it, the existing session cookie SHALL still resolve, and `project.create({ slug: 'after-upgrade' })` SHALL succeed

#### Scenario: A non-admin token stays non-admin

- **GIVEN** a database at the previous schema with a token of scope `project:<id>` and a token of scope `projects` with memberships
- **WHEN** the migration runs
- **THEN** both SHALL be owned by the bootstrap administrator and keep their scope, binding and memberships
- **AND** both SHALL be refused `project.create` with `admin_token_required` and refused `POST /dashboard/login`

#### Scenario: Every token row is copied verbatim

- **GIVEN** a populated database at the previous schema containing active, revoked, expired, soft-deleted and set-scoped tokens with dashboard sessions, agent sessions and memberships referencing them
- **WHEN** the migration runs
- **THEN** every token SHALL keep every previous column value, every `user_id` SHALL be the bootstrap administrator's id, and exactly one `users` row SHALL exist
- **AND** `PRAGMA foreign_key_check` SHALL return no row, and the `memory` and `sessions` rows SHALL be unchanged

## MODIFIED Requirements

### Requirement: The admin token MUST bootstrap from `REMBRIC_ADMIN_TOKEN`

On first startup, if no token row exists, the server SHALL require `REMBRIC_ADMIN_TOKEN` to be set, SHALL refuse to start otherwise, and SHALL create an `admin` token row with the hash of that value and scope `*`, owned by the oldest user whose role is `admin`, creating that user first when none exists, in one transaction. The bootstrap token therefore has administrative capability (see "Administrative capability MUST be the owner's admin role combined with the credential's own delegation"). Subsequent restarts SHALL NOT re-read `REMBRIC_ADMIN_TOKEN`.

#### Scenario: First start without admin token

- **GIVEN** the database has no token rows and `REMBRIC_ADMIN_TOKEN` is not set
- **WHEN** the server is started
- **THEN** the server SHALL exit with a non-zero code and a clear error message instructing the operator to set the env var

#### Scenario: Subsequent start with `REMBRIC_ADMIN_TOKEN` changed

- **GIVEN** the database already contains an admin token row
- **WHEN** the server is started with a different value of `REMBRIC_ADMIN_TOKEN`
- **THEN** the existing admin token row SHALL be preserved unchanged; the env var SHALL be ignored on this start

#### Scenario: First start creates an administering token

- **GIVEN** the database has no token rows and `REMBRIC_ADMIN_TOKEN` is set
- **WHEN** the server is started
- **THEN** exactly one token SHALL exist, with scope `*`, owned by a user whose role is `admin`
- **AND** that token SHALL succeed on `POST /dashboard/login` and on `project.create`

### Requirement: A token reaching every project MUST NOT be an admin token

Admin authority SHALL be administrative capability as "Administrative capability MUST be the owner's admin role combined with the credential's own delegation" defines it (the owning user's `admin` role combined with the credential's own delegation, which for a static token is the literal scope string `*`), and SHALL NOT be derived from the breadth of a membership set. A `projects` token whose set contains every existing project SHALL be refused the dashboard login, every `/admin/*` route, and every maintenance operation gated on admin authority.

Deriving admin from breadth would make creating a project a privilege-altering operation on unrelated tokens, and would make admin authority appear and disappear as the project table changes.

#### Scenario: A set token over every project is refused the dashboard login

- **GIVEN** a token with `scope = 'projects'` whose membership set contains the id of every existing project
- **WHEN** the token is submitted to `POST /dashboard/login`
- **THEN** the login SHALL be refused
- **AND** the same token SHALL be refused on every `/admin/*` route
- **AND** an administering token (scope `*`, owned by an `admin` user) SHALL succeed on both

#### Scenario: Creating a project does not escalate an existing set token

- **GIVEN** a token with `scope = 'projects'` whose set contains every existing project, and which is refused the dashboard login
- **WHEN** a new project is created and then archived
- **THEN** the token SHALL remain refused on `POST /dashboard/login` at every point
- **AND** the token SHALL be refused on the newly created project

### Requirement: A set-scoped token MUST NOT be able to create a project

A set names projects that exist. The only MCP tool that creates a project is `project.create`, and it requires administrative capability, as "Administrative capability MUST be the owner's admin role combined with the credential's own delegation" defines it, so a `projects` or `read:projects` token SHALL have no path to create one: `project.create` SHALL refuse it with `admin_token_required` and insert no row, and a connection naming a slug outside its set SHALL NOT create the project it names. The same holds for every project-scoped token, whatever its access.

#### Scenario: A set token cannot create a project by naming it

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`, and no project with slug `brand-new`
- **WHEN** the token connects at `/mcp/brand-new` and calls `project.list`, `project.current` and every scope-resolving tool
- **THEN** every scope-resolving call SHALL be refused with `project_not_found`, and no `projects` row SHALL be created
- **AND** an administering token (scope `*`, owned by an `admin` user) making the same calls SHALL likewise create no project, which is the control that the absence of a row comes from resolution never creating one and not from the set

#### Scenario: A set token cannot create a project with `project.create`

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`, and no project with slug `brand-new`
- **WHEN** the token calls `project.create({ slug: 'brand-new' })`
- **THEN** the call SHALL be refused with `admin_token_required`, and no `projects` row SHALL be created
- **AND** an administering token (scope `*`, owned by an `admin` user) making the same call SHALL create `brand-new`, which is the control that the refusal comes from the admin check and not from the slug

#### Scenario: Autocreate is refused for a set token

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`
- **WHEN** the token calls `project.use({ slug: 'brand-new', autocreate: true })`
- **THEN** the call SHALL be refused because no tool named `project.use` is registered, and no `projects` row SHALL be created
- **AND** an administering token (scope `*`, owned by an `admin` user) making the same call SHALL be refused the same way, which is the control that the refusal comes from the removed tool and not from the set

### Requirement: The widened search set MUST be the token's read reach, and reaching every project MUST NOT confer admin

The set of projects an authorized widening admits SHALL be exactly the projects for which `isAuthorized(token, 'read', { scope: 'project', projectId })` holds, evaluated once per candidate project against the live project list, excluding archived projects. It SHALL NOT be derived from a scope-string comparison, from a privilege class, or from any test other than the one that already governs every other read.

The consequences of that definition are the specification, not incidental outcomes:

- a `*` or `read:*` token widens to every project, which is the former "admin only" behaviour arriving as a special case rather than as a rule;
- a `projects` or `read:projects` token widens to its membership set;
- a `project:<id>` or `read:project:<id>` token widens to one project, so its widened search is identical to its narrow search.

**Widening SHALL confer no privilege whatsoever.** A token whose read reach happens to be every project SHALL remain non-admin: the administrative-capability gates that guard dashboard login and the `/admin/*` routes (see "Administrative capability MUST be the owner's admin role combined with the credential's own delegation") SHALL NOT consult the widened set, SHALL NOT consult `isAuthorized`, and SHALL NOT be reachable by breadth of reach. A rule of the form "reaches all N projects implies admin" would make creating a project a privilege operation on unrelated tokens.

Widening SHALL NOT change any action verb. A read-classified widening SHALL NOT authorize a write anywhere, and no write-classified operation SHALL accept a widened scope.

#### Scenario: A set token widens to exactly its members

- **GIVEN** projects A, B and C, and a token whose membership set is `{A, B}`
- **WHEN** it issues a widened search on a connection resolved to A
- **THEN** the projects searched SHALL be exactly A and B
- **AND** rows SHALL be returned from both, so the assertion is not satisfied by an empty set

#### Scenario: A full-access token widens to every project

- **GIVEN** projects A, B and C and a token with scope `*` or `read:*`
- **WHEN** it issues a widened search
- **THEN** all three projects SHALL be searched

#### Scenario: A project-pinned token's widened search is its narrow search

- **GIVEN** a token with scope `project:A` or `read:project:A`
- **WHEN** it issues a widened search on a connection resolved to A
- **THEN** the result SHALL be identical to the same search without the widening argument, and no other project SHALL be named among the projects searched

#### Scenario: Widening every project is still not admin

- **GIVEN** a token whose read reach is every existing project, by any scope arm
- **WHEN** it attempts `POST /dashboard/login` or any `/admin/*` route
- **THEN** every such request SHALL be refused exactly as it is today
- **AND** a control request with an actual administering dashboard credential (scope `*`, owned by an `admin` user) SHALL succeed, so the refusal is attributable to the gate rather than to a broken probe

#### Scenario: A read-only widening does not authorize a write

- **GIVEN** a token with scope `read:*` or `read:projects`
- **WHEN** it invokes any write-classified tool, with or without any widening argument present on any other tool
- **THEN** the call SHALL be rejected with code `forbidden` and nothing SHALL be persisted

### Requirement: Only an admin token MAY create a repository binding

Creating a repository binding SHALL require administrative capability, as "Administrative capability MUST be the owner's admin role combined with the credential's own delegation" defines it, on every surface that creates one: the `project.bind_repository` MCP tool and the dashboard, whose login already requires administrative capability. No other scope, membership set, project-scoped write grant or OAuth grant not granted administration at consent SHALL create a binding, including a `.rembric` reported by a non-admin token, which only records a pending suggestion for an admin to accept.

Moving or removing a binding SHALL be possible only from the dashboard.

Resolving a fingerprint to a bound project SHALL require only read authority on that project, so teammates whose tokens may read a project use its bindings without being able to create or change them.

A token whose scope does not authorize writing SHALL NOT create or refresh pending repository rows.

#### Scenario: A project-scoped writer records a suggestion, not a binding

- **GIVEN** a token with scope `project:<id of shop>` and a checkout whose root `.rembric` contains `PROJECT_SLUG=shop`, with an unbound fingerprint
- **WHEN** a session starts with that token
- **THEN** a pending suggestion for `(fingerprint, shop)` SHALL exist
- **AND** no binding SHALL exist for the fingerprint

#### Scenario: A teammate resolves an admin's binding with a read grant

- **GIVEN** fingerprint `F` bound to `shop` by an admin, and a teammate token with scope `read:project:<id of shop>`
- **WHEN** the teammate's client resolves `F`
- **THEN** it SHALL resolve to `shop`

#### Scenario: A connector without administration cannot bind

- **GIVEN** an unbound fingerprint `F`, an existing project `shop`, and a path-less write OAuth grant of derived scope `*` consented without administration
- **WHEN** its access token calls `project.bind_repository({ slug: 'shop' })` with `X-Rembric-Repo-Fingerprint: F`
- **THEN** the call SHALL be refused with `admin_token_required` and no binding SHALL exist for `F`
