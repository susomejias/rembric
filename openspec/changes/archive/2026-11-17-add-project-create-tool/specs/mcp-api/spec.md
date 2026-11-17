## MODIFIED Requirements

### Requirement: Path-scoped connections MUST enforce strict project isolation

When the MCP connection is path-scoped (`/mcp/<slug>`) the server SHALL enforce a hard isolation contract on every tool call. The connection's project is the only scope the server chooses on the caller's behalf:

- `memory.save` SHALL be persisted with `project_id` equal to the path-bound project regardless of any other argument the agent supplies. There is no argument by which an agent can name a different destination: `memory.save` accepts no `scope` argument, so the destination is determined entirely by the connection the operator configured.
- `memory.search` SHALL return only memories whose `project_id` equals the bound project, **unless the caller explicitly passes the cross-project argument specified in "`memory.search` MUST accept an opt-in cross-project read and report which projects it read", in which case it SHALL return only memories from projects the token is authorized to read.** No other argument SHALL widen the result set past the bound project, and `include_global` remains absent from the tool's input schema. **Widening is a property of the caller's request and the token's reach, not of the connection: a path-scoped connection may widen exactly as a path-less one may, because the path fixes which project is the caller's home, not which projects the token may read.**
- `memory.get` and `memory.confirm` SHALL respond with structured code `not_found` when the requested memory belongs to a different project, regardless of whether the memory exists, to avoid leaking existence across scopes. **Neither accepts a widening argument**, so this clause is unchanged by the cross-project search.

Because there is exactly one kind of scope, the isolation this requirement describes is no longer a property of path-scoped connections specifically — it holds on every connection. What remains specific to a path-scoped connection is that its home project is fixed by the URL. No tool can change a connection's home project, on a path-scoped connection or a path-less one.

A path slug that does not resolve to an existing project SHALL NOT establish any scope. Such a connection has no bound project, so the clauses above have nothing to bind to; instead **every** tool that resolves scope SHALL be refused with structured code `project_not_found`, reads and writes alike, and SHALL NOT fall back to any other project — in particular not to the default project, whose role is to serve path-LESS connections, and **in particular not by widening**: with no resolved home project there is nothing to widen from, and the cross-project argument SHALL NOT make such a connection usable. An operator who typed a slug asked to be confined to it, and answering a typo with someone else's project is worse than refusing.

The `not_found` clause above governs a connection whose slug DOES resolve, where the comparison is between the bound project and the requested memory. On an unresolvable slug there is no bound project to compare against, so `project_not_found` — which names the unusable connection — takes precedence over `not_found`, and the two do not conflict.

#### Scenario: save with scope='global' on a path-scoped connection

- **GIVEN** a path-scoped connection at `/mcp/foo` with a valid token
- **WHEN** the client calls `memory.save` with an argument named `scope`
- **THEN** the call SHALL be rejected by the input schema as an unrecognized argument, and no refusal SHALL name the scope the argument used to request
- **AND** the scenario title predates this change: the argument it names has been removed, so no call can ask for a scope and be refused one. `scope_locked` survives only as a refusal of a project **switch** (see "the surviving `scope_locked` refusals lock a switch, not a scope"); it SHALL NOT be reintroduced as a refusal of a scope

#### Scenario: search on a path-scoped connection does not leak globals

The title predates this change: there are no global memories left to leak, and the only cross-project read is one the caller asked for and the token was authorized for — everything else stays closed, which is what this scenario now pins.

- **GIVEN** a path-scoped connection at `/mcp/foo` and memories in another project
- **WHEN** the client calls `memory.search` with any argument other than the cross-project one
- **THEN** the response SHALL contain only project `foo`'s memories, and no such argument SHALL admit another project's rows
- **AND** `include_global` SHALL still be refused as an unrecognized argument

#### Scenario: a path-scoped connection may widen deliberately

- **GIVEN** a path-scoped connection at `/mcp/foo`, a token authorized to read `foo` and `bar`, and memories in each
- **WHEN** the client calls `memory.search` with the cross-project argument
- **THEN** the response MAY contain `bar`'s memories and SHALL name both projects as searched
- **AND** `memory.save` on the same connection SHALL still write to `foo`, so widening a read has not widened a write

#### Scenario: get across project boundaries

- **GIVEN** a path-scoped connection at `/mcp/foo` and a memory M whose `project_id` is another project
- **WHEN** the client calls `memory.get('M')`
- **THEN** the response SHALL be an MCP error with `code: 'not_found'`, identical to the response for a non-existent id
- **AND** this SHALL hold whether or not a prior `memory.search` on the same connection widened and returned M, because `memory.get` accepts no widening argument

#### Scenario: search on an unresolvable slug refuses instead of reading global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and memories in the default project
- **WHEN** the client calls `memory.search`, with or without the cross-project argument
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'`
- **AND** the response SHALL contain no memory, in particular none from the default project and none from any other project the token may read
- **AND** the scenario title predates this change: there is no global memory to read, and the refusal it pins is unchanged

#### Scenario: get on a global id from an unresolvable slug refuses

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project, a token whose scope is `*`, and a memory M in the default project
- **WHEN** the client calls `memory.get({id: M})`
- **THEN** the response SHALL be an MCP error with `code: 'project_not_found'` and SHALL NOT return M's `content`
- **AND** the scenario title predates this change: M is a memory in the default project, not a global one, which is what its body already says

#### Scenario: writes on an unresolvable slug do not land in global memory

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.capture_passive` with text containing a well-formed Key Learnings section, or calls `memory.save_prompt`
- **THEN** each call SHALL be refused with `code: 'project_not_found'`
- **AND** no row SHALL be inserted into `memory` or `prompts`, in the default project or any other
- **AND** the scenario title predates this change: there is no global memory to land in, and the refusal it pins is unchanged

#### Scenario: a session is not opened in the global scope from an unresolvable slug

- **GIVEN** a connection at `/mcp/no-such-project` whose slug names no project and a token whose scope is `*`
- **WHEN** the client calls `memory.session_start`
- **THEN** the call SHALL be refused with `code: 'project_not_found'`
- **AND** no `agent_sessions` row SHALL be inserted, in the default project or any other
- **AND** the scenario title predates this change: there is no global scope to open a session in, and the refusal it pins is unchanged

#### Scenario: the refusal names candidate slugs

- **GIVEN** a project with slug `rembric` exists and a connection at `/mcp/rembic`
- **WHEN** the client calls any tool that resolves scope
- **THEN** the error payload SHALL include `suggestedSlugs` containing `rembric`

#### Scenario: the connection is not bricked by the refusal

- **GIVEN** a connection at `/mcp/no-such-project` and a token authorized to read the existing projects
- **WHEN** the client calls `project.current`, `project.list` or `memory.about`
- **THEN** each call SHALL succeed
- **AND** the `project_not_found` refusal that every scope-resolving tool returns on that connection SHALL name the dashboard as the place to create the project; for a token whose scope is `*` it SHALL also name `project.create`, the one tool call that creates a project, and for any other token it SHALL NOT name a tool call as a way to create it. It SHALL NOT name a tool call as a way to activate it, for any token

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

1. a token whose scope is not `*`, with `admin_token_required`, after the strict input schema and before any other check — the slug rule, the existing slugs and the fingerprint;
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
