## MODIFIED Requirements

### Requirement: Every MCP tool call MUST be authorized against the token's scope for the resolved project

Every registered MCP tool except `memory.about` SHALL be classified as `read` or `write` and SHALL, before touching any data, resolve the connection's effective scope through the single async resolver (path slug → the default project) and check `isAuthorized(tokenScope, action, resolvedScope)`. A failed check SHALL be rejected with code `forbidden`. **A tool that accepts an input widening the result set past the resolved scope — `memory.search`'s cross-project argument is the only one — SHALL additionally authorize each project the widening would admit, after the resolved-scope check, and SHALL drop the projects that fail rather than reject the call** (see the `auth` capability). The path-scoping error contract (`scope_locked`, `project_not_found`) SHALL be preserved unchanged and SHALL be evaluated before the authorization check where it applies today.

Write classification: `memory.save`, `memory.save_prompt`, `memory.capture_passive`, `memory.confirm`, `memory.judge`, `memory.compare`, `memory.session_start`, `memory.session_summary`, `memory.session_end`. `memory.compare` is a write because it always persists a `memory_relations` row (`status='judged'`) and, for `relation='supersedes'`, flips the target memory's `status` to `superseded` and appends to the source's `replaces[]` — a lifecycle mutation, not a read. Read classification: `memory.search`, `memory.get`, `memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.search_prompts`, `memory.suggest_topic_key`, `memory.session_get`, `project.current`. `project.list` SHALL filter its result to the projects the token is authorized to read, using the same per-project predicate: `*` and `read:*` tokens see all projects; `project:<id>` and `read:project:<id>` tokens see only that project; a set-scoped token sees exactly its members. **That predicate and the one that builds the widened search set SHALL be the same expression, so `project.list` and a widened `memory.search` can never disagree about a token's reach.**

`project.create` is the only MCP tool that creates a project. It SHALL NOT go through the effective-scope resolver: the project it names does not exist before the call, and its authorization is the admin check, the literal token scope `*`, evaluated before any other validation (see "The MCP server MUST expose `project.create` to admin tokens"). No other tool call SHALL carry a project-creation authorization, including the one the retired `project.use({autocreate: true})` path carried.

#### Scenario: Read-restricted token attempts a formerly-ungated write

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, or `memory.judge`
- **THEN** the call SHALL be rejected with code `forbidden` and no row SHALL be written

#### Scenario: Read-restricted token attempts memory.compare

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.compare` with any two in-scope memories
- **THEN** the call SHALL be rejected with code `forbidden`, no `memory_relations` row SHALL be written, and no target memory's `status` SHALL change

#### Scenario: Project-restricted token reads another project's context

- **GIVEN** a token with scope `read:project:A` or `project:A`
- **WHEN** the token opens `/mcp/B` and calls `memory.context`, `memory.timeline`, `memory.stats`, `memory.search_prompts`, or `memory.session_get`
- **THEN** the call SHALL be rejected with code `forbidden` and no project-B data SHALL be returned

#### Scenario: Project-restricted token on an unscoped connection resolving global scope

The title predates this change: the scope a path-less connection resolves is the default project.

- **GIVEN** a token with scope `read:project:A` connected to `/mcp` with no active project
- **WHEN** the token calls a read tool whose effective scope resolves to the default project
- **THEN** the call SHALL be rejected with code `forbidden`; the same call on a connection at `/mcp/A` SHALL succeed against project A
- **AND** passing the cross-project argument SHALL NOT make the refused call succeed, because the widening is authorized after the resolved-scope check, not instead of it

#### Scenario: `project.list` is filtered by token scope

- **GIVEN** projects A and B exist and a token with scope `project:A`
- **WHEN** the token calls `project.list`
- **THEN** the response SHALL contain project A only

#### Scenario: `project.list` and a widened search agree

- **GIVEN** any token and any set of projects
- **WHEN** the token calls `project.list` and then `memory.search` with the cross-project argument
- **THEN** the slugs in `searchedProjects` SHALL be a subset of the non-archived slugs `project.list` returned, and SHALL equal them when none is archived

#### Scenario: Full-access tokens are unaffected

- **GIVEN** a token with scope `*`
- **WHEN** it invokes any tool on any `/mcp*` connection
- **THEN** authorization SHALL never reject the call (path-scoping errors still apply)


## ADDED Requirements

### Requirement: The MCP server MUST expose `project.create` to admin tokens

`project.create` SHALL create a project and, when asked, bind the repository identified by the request's `X-Rembric-Repo-Fingerprint` header to it. Its strict input schema SHALL declare exactly three properties: `slug` (required), `displayName` (optional) and `bindRepository` (optional boolean, default false). The fingerprint SHALL NOT be a tool argument.

`project.create` is a `project.*` tool registered on `/mcp` and `/mcp/<slug>` alongside `project.list`, `project.current` and `project.bind_repository`, and it is the single exception to "No tool SHALL activate, switch or create a project" in the project-management tools requirement: it creates a project, and like every other tool it SHALL NOT activate or switch one. `tools/list` SHALL contain it, and SHALL contain no other tool that creates a project.

The tool SHALL refuse, in this order, inserting no row:

1. a token whose scope is not `*`, with `admin_token_required`, before validating any argument;
2. a `slug` that does not match the strict slug regex, with `invalid_slug`;
3. a `slug` that names an existing project, archived or not, with `project_already_exists`, whose message SHALL name `project.bind_repository` as the way to bind a repository to an existing project.

A successful call SHALL insert the project and SHALL return `{ slug, projectId, displayName, binding: { status, fingerprint, reason }, message }`:

- without `bindRepository`, or with `bindRepository: false`, no binding SHALL be created and `binding` SHALL be `{ status: 'not_requested', fingerprint: null, reason: null }`;
- with `bindRepository: true` and a request whose header carries a fingerprint with no binding, the fingerprint SHALL be bound to the new project exactly as `project.bind_repository` binds it — copying the normalized remotes of the fingerprint's pending rows and removing its pending row of kind `unbound` — and `binding` SHALL be `{ status: 'bound', fingerprint, reason: null }`;
- with `bindRepository: true` and a request without the header, or whose header is `unavailable`, the project SHALL still be created, no binding SHALL be created, and `binding` SHALL be `{ status: 'skipped', fingerprint: null, reason: 'repository_fingerprint_unavailable' }`;
- with `bindRepository: true` and a fingerprint that already has any binding, the project SHALL still be created, the existing bindings SHALL be unchanged, and `binding` SHALL be `{ status: 'skipped', fingerprint, reason: 'repository_already_bound' }`, with `message` naming the bound projects and the dashboard as the place to move a binding.

`message` SHALL state that a binding applies from the next session whenever `binding.status` is `bound`. The connection's own project SHALL NOT change.

The tool SHALL be callable on path-scoped, path-less and unbound requests alike, including a connection whose URL slug names no project, and SHALL resolve no effective scope. Because the server resolves the URL slug on every request and keeps no per-connection state, a connection at `/mcp/<slug>` whose calls were refused with `project_not_found` SHALL resolve to the project from the first request after `project.create` creates `<slug>`; that is the URL path resolving, not the tool switching the connection's project. On such a connection, the `project_not_found` message SHALL name `project.create` for an admin token, after the dashboard, and SHALL NOT name it for any other token. Its registered description SHALL state that it requires an admin token and that binding the current repository is opt-in, within `DESCRIPTION_MAX_LENGTH`. Its behavioural annotations SHALL declare it non-read-only, non-destructive and non-idempotent.

#### Scenario: An admin creates a project and binds an unbound repository from an unbound session

- **GIVEN** an unbound fingerprint `F`, no project with slug `shop`, and an unbound path-less connection carrying `X-Rembric-Repo-Fingerprint: F` with a token of scope `*`
- **WHEN** the client calls `project.create({ slug: 'shop', bindRepository: true })`
- **THEN** a project `shop` SHALL exist, and a binding of `F` to `shop` SHALL exist
- **AND** `binding` SHALL be `{ status: 'bound', fingerprint: F, reason: null }`
- **AND** a subsequent `memory.save` on the same connection SHALL still be refused with `project_unbound`

#### Scenario: An agent connected at a slug that names no project creates it and keeps working

- **GIVEN** no project with slug `acme`, and a client without plugin connected at `/mcp/acme` with a token of scope `*`
- **WHEN** the client calls `memory.save`, then `project.create({ slug: 'acme' })`, then `memory.save` again on the same URL
- **THEN** the first `memory.save` SHALL be refused with `project_not_found`, and its message SHALL name `project.create`
- **AND** `project.create` SHALL succeed, and the second `memory.save` SHALL write its row into `acme`
- **AND** with a token whose scope is not `*`, the first refusal's message SHALL NOT name `project.create`

#### Scenario: Binding is opt-in

- **GIVEN** an unbound fingerprint `F` and a token of scope `*`
- **WHEN** a client whose requests carry `X-Rembric-Repo-Fingerprint: F` calls `project.create({ slug: 'store' })`
- **THEN** a project `store` SHALL exist, `F` SHALL have no binding, and `binding.status` SHALL be `not_requested`

#### Scenario: A repository that is not a bind candidate does not stop the creation

- **GIVEN** fingerprint `F` bound to `shop`, and a token of scope `*`
- **WHEN** a client whose requests carry `X-Rembric-Repo-Fingerprint: F` calls `project.create({ slug: 'store', bindRepository: true })`
- **THEN** a project `store` SHALL exist, `F` SHALL still be bound to `shop` only, and `binding` SHALL be `{ status: 'skipped', fingerprint: F, reason: 'repository_already_bound' }`
- **AND** the same call, with a new slug, from a client sending no header SHALL create the project and report `reason: 'repository_fingerprint_unavailable'`

#### Scenario: A non-admin token cannot create a project

- **GIVEN** a token whose scope is `project:<id of shop>`, with write access
- **WHEN** it calls `project.create({ slug: 'brand-new', bindRepository: true })` with a valid fingerprint header, and again with an invalid slug
- **THEN** both calls SHALL be refused with `admin_token_required`, and no `projects` row and no binding SHALL be created

#### Scenario: An existing slug is refused and points at binding

- **GIVEN** a project `shop`, and a token of scope `*`
- **WHEN** the client calls `project.create({ slug: 'shop' })`
- **THEN** the call SHALL be refused with `project_already_exists`, its message SHALL name `project.bind_repository`, and no row SHALL be inserted

#### Scenario: The fingerprint cannot come from the model

- **WHEN** a client calls `project.create` with a `fingerprint` property
- **THEN** the call SHALL be refused by the strict input schema as an unknown property, and no row SHALL be inserted
