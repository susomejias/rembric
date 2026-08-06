## ADDED Requirements

### Requirement: `memory.search` MUST accept an opt-in cross-project read and report which projects it read

`memory.search` SHALL accept one optional boolean input property, `across_projects`, defaulting to absent. When absent, the tool SHALL behave exactly as a server that does not implement it. When `true`, the tool SHALL read the projects the connection's token is authorized to read, per the `auth` capability's re-authorization requirement.

The property SHALL NOT be named `scope`, `include_global`, or `all_projects`. The first two are forbidden by "No MCP tool surface MAY name a scope the server does not have". The third is forbidden here because it is false for a set-scoped token — it promises every project and delivers a membership set — and a published input name that promises more than the tool delivers is the defect "A tool's description and its response MUST agree, and neither may promise an unreachable state" governs.

The widening SHALL apply to **both** retrieval branches of the tool — the ranked text/filter branch and the `entity` exact-address branch — because one argument on one tool whose meaning depends on which branch runs cannot be described truthfully.

The response SHALL carry:

- **`searchedProjects`**: the slugs of the projects actually read, in a stable order. Present whenever `across_projects` was requested, whatever the outcome of authorization.
- **`widened`**: `true` when and only when more than one project was read. It reports the result, not the request, so a token reaching exactly one project does not receive `widened: true` for asking.

Both SHALL appear in the tool's declared `outputSchema`, per "Every MCP tool MUST advertise an output schema and return conforming structured content". These fields are load-bearing rather than informational: an unauthorized widening is dropped and served rather than refused, so without them a caller cannot distinguish an exhaustive cross-project answer from a widening that did nothing.

The input schema SHALL remain strict, so a client sending `all_projects` or any other unknown property is refused rather than silently ignored.

#### Scenario: Absent argument is byte-identical to today

- **GIVEN** any connection and a corpus spanning several projects
- **WHEN** `memory.search` is called without `across_projects`
- **THEN** the response SHALL contain only the resolved project's rows, and SHALL carry neither `searchedProjects` nor `widened`

#### Scenario: A widened search names the projects it read

- **GIVEN** a token authorized to read projects `alpha` and `beta`, on a connection resolved to `alpha`
- **WHEN** `memory.search` is called with `across_projects: true`
- **THEN** the response SHALL carry `searchedProjects` containing exactly `alpha` and `beta`
- **AND** it SHALL carry `widened: true`
- **AND** at least one row from each project SHALL be returned for a query both match, so the assertion is not satisfied by an empty result set

#### Scenario: A widening that reached one project does not claim otherwise

- **GIVEN** a token authorized to read exactly one project
- **WHEN** `memory.search` is called with `across_projects: true`
- **THEN** `searchedProjects` SHALL contain that one slug and `widened` SHALL be absent
- **AND** the returned rows SHALL be identical to the same call without the argument

#### Scenario: The entity branch widens under the same argument

- **GIVEN** an identifier appearing in memories in two projects the token may read
- **WHEN** `memory.search` is called with that identifier as `entity` and `across_projects: true`
- **THEN** memories from both projects SHALL be returned in the branch's ordinary chronological order
- **AND** the same call without `across_projects` SHALL return only the resolved project's memories

#### Scenario: The widened entity branch keeps its response-level bound

- **GIVEN** an identifier linked to more memories across the widened set than the branch's completeness bound
- **WHEN** the widened entity lookup runs with no `limit`
- **THEN** the number of rows returned SHALL NOT exceed the same bound a narrow lookup is subject to, so widening cannot multiply the worst-case annotation payload

#### Scenario: An unknown widening spelling is refused

- **GIVEN** any connection with a valid token
- **WHEN** the client calls `memory.search` with `all_projects: true` or `include_global: true`
- **THEN** the call SHALL be refused with the transport's invalid-parameters error naming the tool and the offending property, and no memory SHALL be returned

#### Scenario: The declared output schema admits the new fields

- **WHEN** an MCP client reads `memory.search`'s `outputSchema` from a real `tools/list` response
- **THEN** it SHALL declare `searchedProjects` and `widened`, and a widened call's structured content SHALL conform to it

### Requirement: The `across_projects` description MUST steer against habitual widening

Because widening is opt-in and free to request, its tool description is load-bearing and SHALL constrain when the model uses it. The `memory.search` description SHALL instruct the model to pass `across_projects` ONLY when the user has explicitly asked about other projects, or when the model is genuinely exploring broadly and the answer is not expected in the current project. It SHALL state that the default — one project — is the right choice for ordinary recall. It SHALL name `searchedProjects` so the model can report the true reach rather than inferring it. These constraints SHALL NOT be expressed only in the per-argument zod `describe()`, which some clients do not surface to the model, but in the tool's top-level description text.

**The description is not a substitute for the authorization gate, and the gate is not a substitute for the description.** They bound different threats and both are required. The gate prevents a token from reading a project it may not read; on a single-operator instance with a full-access token that gate always passes and therefore bounds nothing about how often the model widens. The description is the only lever on frequency, and frequency is what costs tokens, dilutes precision, and raises per-turn latency — measurably, though by less than the number of projects searched, since only the dense and lexical reads scale with the widened set (see the `data-access` capability, which records the figure and names its instrument).

Satisfying this obligation SHALL stay within `DESCRIPTION_MAX_LENGTH`. Per "The four existing memory tools MUST advertise protocol-teaching descriptions", the text it needs SHALL be reclaimed from clauses no requirement mandates, the reclaimed clause SHALL be named in this change, and the resulting length SHALL be measured from a real `tools/list` response rather than from the description constant.

#### Scenario: The description carries the restraint guard

- **WHEN** an MCP client retrieves the tool description for `memory.search` via `tools/list`
- **THEN** the description SHALL convey that `across_projects` is for an explicit user request about other projects or a genuinely broad exploration
- **AND** it SHALL convey that a single project is the default and the right choice for ordinary recall
- **AND** it SHALL name the field that reports which projects were read

#### Scenario: The restraint guard is not only in the argument description

- **WHEN** the top-level description text is inspected independently of the input schema
- **THEN** it SHALL carry the restraint guard on its own, so a client that does not surface per-argument descriptions still delivers it to the model

#### Scenario: The reworded description is measured, not assumed

- **WHEN** the description is changed to carry this obligation
- **THEN** its `String.length` measured from a real `tools/list` response SHALL be at or below `DESCRIPTION_MAX_LENGTH`, the change SHALL record the measured length and remaining headroom, and it SHALL name every clause it reclaimed

## MODIFIED Requirements

### Requirement: Path-scoped connections MUST enforce strict project isolation

When the MCP connection is path-scoped (`/mcp/<slug>`) the server SHALL enforce a hard isolation contract on every tool call. The connection's project is the only scope the server chooses on the caller's behalf:

- `memory.save` SHALL be persisted with `project_id` equal to the path-bound project regardless of any other argument the agent supplies. There is no argument by which an agent can name a different destination: `memory.save` accepts no `scope` argument, so the destination is determined entirely by the connection the operator configured.
- `memory.search` SHALL return only memories whose `project_id` equals the bound project, **unless the caller explicitly passes the cross-project argument specified in "`memory.search` MUST accept an opt-in cross-project read and report which projects it read", in which case it SHALL return only memories from projects the token is authorized to read.** No other argument SHALL widen the result set past the bound project, and `include_global` remains absent from the tool's input schema. **Widening is a property of the caller's request and the token's reach, not of the connection: a path-scoped connection may widen exactly as a path-less one may, because the path fixes which project is the caller's home, not which projects the token may read.**
- `memory.get` and `memory.confirm` SHALL respond with structured code `not_found` when the requested memory belongs to a different project, regardless of whether the memory exists, to avoid leaking existence across scopes. **Neither accepts a widening argument**, so this clause is unchanged by the cross-project search.

Because there is exactly one kind of scope, the isolation this requirement describes is no longer a property of path-scoped connections specifically — it holds on every connection. What remains specific to a path-scoped connection is that its home project is fixed by the URL and cannot be changed by `project.use` for the life of the connection.

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

- **GIVEN** a connection at `/mcp/no-such-project` and a token authorized to create a project
- **WHEN** the client calls `project.current`, `project.list`, `memory.about`, or `project.use({slug: 'no-such-project', autocreate: true})`
- **THEN** each call SHALL succeed
- **AND** after the `project.use` call, subsequent scope-resolving tools SHALL operate in that project's scope rather than being refused

### Requirement: Every MCP tool call MUST be authorized against the token's scope

Every registered MCP tool except `memory.about` SHALL be classified as `read` or `write` and SHALL, before touching any data, resolve the connection's effective scope through the single async resolver (path slug → roots discovery → `SessionRouter`) and check `isAuthorized(tokenScope, action, resolvedScope)`. A failed check SHALL be rejected with code `forbidden`. **A tool that accepts an input widening the result set past the resolved scope — `memory.search`'s cross-project argument is the only one — SHALL additionally authorize each project the widening would admit, after the resolved-scope check, and SHALL drop the projects that fail rather than reject the call** (see the `auth` capability). The path-scoping error contract (`scope_locked`, `project_required`, `project_not_found`, `project_suggestion_pending`) SHALL be preserved unchanged and SHALL be evaluated before the authorization check where it applies today.

Write classification: `memory.save`, `memory.save_prompt`, `memory.capture_passive`, `memory.confirm`, `memory.judge`, `memory.compare`, `memory.session_start`, `memory.session_summary`, `memory.session_end`. `memory.compare` is a write because it always persists a `memory_relations` row (`status='judged'`) and, for `relation='supersedes'`, flips the target memory's `status` to `superseded` and appends to the source's `replaces[]` — a lifecycle mutation, not a read. Read classification: `memory.search`, `memory.get`, `memory.context`, `memory.timeline`, `memory.stats`, `memory.doctor`, `memory.search_prompts`, `memory.suggest_topic_key`, `memory.session_get`, `project.use` (against the requested project), `project.current`. `project.list` SHALL filter its result to the projects the token is authorized to read, using the same per-project predicate: `*` and `read:*` tokens see all projects; `project:<id>` and `read:project:<id>` tokens see only that project; a set-scoped token sees exactly its members. **That predicate and the one that builds the widened search set SHALL be the same expression, so `project.list` and a widened `memory.search` can never disagree about a token's reach.**

`project.use({autocreate: true})` on a slug that does not yet exist is a WRITE (it mints a new project row), even though `project.use` is otherwise read-classified: the server SHALL check `isAuthorized(tokenScope, 'write', {scope: 'project', projectId: null})` before creating the row. `autocreate: true` against an ALREADY-existing slug is unaffected (no row is created, so the normal read check against the resolved project applies).

#### Scenario: Read-restricted token attempts a formerly-ungated write

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.capture_passive`, `memory.save_prompt`, `memory.session_start`, or `memory.judge`
- **THEN** the call SHALL be rejected with code `forbidden` and no row SHALL be written

#### Scenario: Read-restricted token attempts memory.compare

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token invokes `memory.compare` with any two in-scope memories
- **THEN** the call SHALL be rejected with code `forbidden`, no `memory_relations` row SHALL be written, and no target memory's `status` SHALL change

#### Scenario: A read-only token cannot autocreate a project

- **GIVEN** a token with scope `read:*` or `read:project:<id>`
- **WHEN** the token calls `project.use({slug: 'brand-new-slug', autocreate: true})` for a slug that does not yet exist
- **THEN** the call SHALL be rejected with code `forbidden` and no project row SHALL be created

#### Scenario: A full-access token can still autocreate a project

- **GIVEN** a token with scope `*`
- **WHEN** the token calls `project.use({slug: 'brand-new-slug', autocreate: true})` for a slug that does not yet exist
- **THEN** the project SHALL be created and the call SHALL succeed

#### Scenario: Project-restricted token reads another project's context

- **GIVEN** a token with scope `read:project:A` or `project:A`
- **WHEN** the token opens `/mcp/B` (or resolves project B via `project.use`/roots discovery) and calls `memory.context`, `memory.timeline`, `memory.stats`, `memory.search_prompts`, or `memory.session_get`
- **THEN** the call SHALL be rejected with code `forbidden` and no project-B data SHALL be returned

#### Scenario: Project-restricted token on an unscoped connection resolving global scope

The title predates this change: the scope a path-less connection resolves is the default project.

- **GIVEN** a token with scope `read:project:A` connected to `/mcp` with no active project
- **WHEN** the token calls a read tool whose effective scope resolves to the default project
- **THEN** the call SHALL be rejected with code `forbidden`; after `project.use A` (authorized) the same call SHALL succeed against project A
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

### Requirement: A path-less `/mcp` connection MUST resolve to the default project

A connection at `/mcp` with no path slug SHALL resolve its effective scope to the **default project** — the single `projects` row marked as the system default (see the `projects` capability). There SHALL be no state in which a connection is authenticated but has no project scope, and no tool SHALL be reachable in such a state.

Every site that previously fell back to the global scope on a path-less connection SHALL target the default project instead, and the set of such sites SHALL be exhaustive rather than sampled: the shared scope resolver, `memory.session_start`'s project binding, `project.current`'s authorization target, and the pinned-token remedy builder. A site missed here does not fail — it silently authorizes against, or reports, a scope that no longer exists.

`project.use` SHALL still switch the connection to another project the token is authorized to read, and the default project SHALL be an ordinary target of that switch. Switching the connection's home scope is not the same operation as widening one read: a switch changes where writes land and what every subsequent tool sees by default, while a widening affects exactly one `memory.search` call and no write. Both are bounded by the same authorization, so neither reaches a project the token may not read.

**Authorization is unchanged and still gates the default project.** A token pinned to one project, connecting path-lessly, SHALL be refused with `code: 'forbidden'` naming the default project — a project it was never granted. The denial is the same denial it receives today against the global scope; only the named target changes, and it changes to one an operator can open. The refusal SHALL carry the pinned-project remedy (see "MCP error messages MUST NOT instruct the agent to perform an action it cannot perform").

#### Scenario: A path-less save with no arguments succeeds

- **GIVEN** a path-less `/mcp` connection, a token authorized to write the default project, and no `.rembric` file, no roots capability and no prior `project.use`
- **WHEN** the client calls `memory.save` with only `type`, `title` and `content`
- **THEN** the call SHALL succeed and the new row SHALL carry the default project's `project_id`
- **AND** the call SHALL NOT be refused with `project_required` or `project_suggestion_pending`

#### Scenario: `project.current` names the default project on a path-less connection

- **GIVEN** a path-less `/mcp` connection with a token authorized to read the default project and no prior `project.use`
- **WHEN** the client calls `project.current`
- **THEN** the response SHALL name the default project's slug and id, and `source` SHALL report that resolution came from the default rather than from a URL path, roots discovery or an explicit tool call

#### Scenario: A project-pinned token is refused, and told the way out

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, where `foo` is not the default project
- **WHEN** the client calls `memory.search` or `project.current`
- **THEN** the call SHALL be refused with `code: 'forbidden'`
- **AND** the message SHALL name `project.use` and SHALL name the slug `foo`

#### Scenario: Switching to another project does not merge two projects

- **GIVEN** a path-less `/mcp` connection resolved to the default project, a token authorized for both it and project `beta`, and memories in each
- **WHEN** the client calls `project.use({slug: 'beta'})` and then `memory.search`, `memory.search` with an `entity`, `memory.context`, `memory.stats`, `memory.get` by id, `memory.get` by ids, and `memory.timeline`, none of them passing the cross-project argument
- **THEN** every response SHALL contain only `beta`'s rows and counters, and none SHALL contain a row or counter from the default project

#### Scenario: A widened search does not change where a subsequent write lands

- **GIVEN** a path-less connection resolved to the default project and a token authorized for it and `beta`
- **WHEN** the client calls `memory.search` with the cross-project argument and then `memory.save`
- **THEN** the saved row SHALL carry the default project's `project_id`, so a widened read leaves the connection's home scope untouched

#### Scenario: The default project is listable and usable like any other

- **GIVEN** a token authorized to read the default project
- **WHEN** the client calls `project.list`
- **THEN** the default project SHALL appear as an ordinary entry with its slug, display name, archived flag and `activeMemoryCount`
- **AND** `project.use` with its slug SHALL activate it under the same rules as any other project

### Requirement: `memory.search` MUST accept an `entity` filter, and no new tool SHALL be added

Exact-address retrieval SHALL be reachable as an `entity` argument on `memory.search` rather than as a new tool. The MCP tool surface is already at the practical ceiling for reliable tool selection — 23 tools with four clusters the model cannot easily distinguish — so a capability expressible as an argument SHALL be an argument.

When `entity` is supplied, the response SHALL be the scoped set of memories linked to that entity, chronologically ordered, and the response SHALL indicate that the entity path was taken rather than the ranked text-query path, so the agent does not read the absence of relevance scores as a defect.

Completeness is bounded, and the bound SHALL be the same generous over-fetch ceiling the ranked branches use rather than the ranked default page size: an omitted `limit` on the entity path means "every linked memory in scope" up to that ceiling, NOT the small default that is calibrated for a ranked page. Returning eight rows out of twelve under a description promising completeness is a correctness problem, because the agent has no signal that anything was withheld. An explicit `limit` SHALL still bound the page.

`entity` SHALL compose with every other selection filter `memory.search` accepts — `status`, `type`, `tag` and `topic_key` — applying the same predicates with the same meaning as on the ranked path. A filter that is documented as combinable but silently dropped is worse than an unsupported one: an agent that narrows to `type: 'user'` and receives unfiltered rows reads project notes as user preferences. An OMITTED `status`, however, SHALL mean "any but archived" here rather than the ranked branches' `active` default — the same reason an omitted `limit` means the generous bound: this path is specified as complete within scope, and inheriting the ranked default would withhold the `superseded` history exactly as the ranked default page withheld the twelfth row. An explicit `status` SHALL filter exactly, `superseded` and `archived` included. Combining `entity` with a text `query` SHALL narrow within the entity's memories rather than fusing two result sets.

An empty entity result SHALL say whether the index has caught up. The tool's own guidance is "empty means it is not there, so retry with `query`" — which is wrong for as long as the extraction drain is still running, and after a recipe change that is the state of the whole corpus. When an `entity` lookup returns nothing AND the scope still holds memories awaiting their first scan, the response SHALL carry a draining flag, and the argument's description SHALL name it so the agent retries the same lookup rather than degrading to text. A non-empty result and a miss over a fully-scanned scope SHALL NOT carry it, so its presence always means something.

#### Scenario: Retrieving everything known about a file

- **WHEN** `memory.search` is called with an `entity` naming a file path present in scope
- **THEN** every in-scope memory linked to that path SHALL be returned in chronological order

#### Scenario: An omitted limit returns the whole linked set, not a ranked page

- **GIVEN** twelve in-scope memories linked to one entity
- **WHEN** `memory.search` is called with that `entity` and no `limit`
- **THEN** all twelve SHALL be returned

#### Scenario: An omitted status returns the entity's non-archived history

- **GIVEN** three in-scope memories linked to one entity, one `active`, one `superseded` and one `archived`
- **WHEN** `memory.search` is called with that `entity` and no `status`
- **THEN** the `active` and the `superseded` row SHALL be returned and the `archived` row SHALL NOT
- **AND** each of `status: 'active'`, `'superseded'` and `'archived'` SHALL return exactly its own row

#### Scenario: The response distinguishes the entity path

- **WHEN** `memory.search` returns results for an `entity` lookup
- **THEN** the response SHALL indicate that exact-address retrieval was used

#### Scenario: An unknown entity returns empty rather than falling back to text search

- **WHEN** `memory.search` is called with an `entity` that exists nowhere in scope
- **THEN** the response SHALL be empty and SHALL NOT silently degrade into a text query over that string
- **AND** when the scope is fully scanned the response SHALL NOT carry the draining flag

#### Scenario: An empty lookup during a drain is marked as such

- **GIVEN** an in-scope memory referencing an identifier, saved but not yet scanned for entities
- **WHEN** `memory.search` is called with that `entity`
- **THEN** the response SHALL be empty AND SHALL carry the draining flag
- **AND** after the drain completes, the same call SHALL return the memory and SHALL NOT carry the flag

#### Scenario: Entity plus text query narrows rather than fuses

- **WHEN** `memory.search` is called with both an `entity` and a text `query`
- **THEN** the result SHALL be the entity's memories ranked by the text query, not a fusion of two independent result sets

#### Scenario: Entity combines with type and status

- **GIVEN** one entity linked to a `user` memory, a `project` memory and an `archived` memory
- **WHEN** `memory.search` is called with that `entity` and `type: 'user'`
- **THEN** only the `user` memory SHALL be returned
- **WHEN** the same call passes `status: 'archived'` instead
- **THEN** only the archived memory SHALL be returned

#### Scenario: Entity combines with include_global

The title predates this change twice over: the argument it names is retired, and the entity branch DOES now widen — under the explicit cross-project argument specified in "`memory.search` MUST accept an opt-in cross-project read and report which projects it read", and under nothing else. What this scenario pins is the unwidened case. Its closing clause previously read "no argument SHALL widen the branch past the resolved project", which this change contradicts head-on; the clause is narrowed rather than deleted, because everything it excluded except the one authorized argument is still excluded.

- **GIVEN** two memories in the connection's project linked to the same path, and another project's memory linked to it too
- **WHEN** `memory.search` is called with that `entity` and without the cross-project argument
- **THEN** both in-scope memories SHALL be returned, the other project's memory SHALL NOT, and no OTHER argument SHALL widen the branch past the resolved project
