## MODIFIED Requirements

### Requirement: The MCP server MUST expose three project-management tools under the `project.*` namespace

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `project.use`, `project.list`, and `project.current` with the following contracts. Tool names live under the top-level `project.*` namespace (not `memory.project_*`) to distinguish project management from memory CRUD.

`project.list`'s per-project count SHALL be named `activeMemoryCount` and SHALL count only memories whose `status` is `active`, in that project's scope. The name carries the filter because the count's previous name, `memoryCount`, stated neither dimension and was measured disagreeing with the corpus the same connection could read: after `memory.archive` on a project's only memory, `project.list` reported `1` while `memory.search` in that same scope returned `0`. The name is additionally reused elsewhere in the server for a different aggregate (memories saved in one session), so a bare `memoryCount` on this payload is ambiguous in two ways at once. Renaming rather than silently re-filtering is required: a changed value under an unchanged key gives a consumer no signal to re-read the contract.

`activeMemoryCount` SHALL be computed by a repository read that takes the scope as a required parameter (see the `data-access` requirement "`project.list`'s per-project memory count MUST be a scoped repository read"). The scope SHALL be derived from the project row being reported, and the token-authorization filter over project rows SHALL be applied BEFORE any count is taken, so the handler can only count a scope the token was already authorized to read. This ordering is the entire basis on which a handler may name its own scope, and it SHALL NOT be relaxed into a post-filter.

`project.list` SHALL NOT resolve an effective scope from the request context in order to produce the count, and SHALL continue to succeed on a connection whose URL slug resolves to no project (see "the connection is not bricked by the refusal").

`project.list` SHALL NOT report a second, unfiltered per-project total. The per-status breakdown scoped to the request context is `memory.stats`' `memoriesByStatus`, and a second total on this payload would answer the same question on a path that deliberately does not resolve the caller's scope.

`project.list`'s registered top-level description SHALL state that the count is of active memories. This SHALL be in the description string returned by `tools/list`, not only in a schema `describe()`, which some clients do not surface to the model.

#### Scenario: `project.use` activates an existing slug

- **WHEN** an MCP client calls `project.use({slug: 'rembric'})` and no project is currently active for the session
- **AND** a project row exists with `slug = 'rembric'`
- **THEN** the server SHALL activate that project for the session and SHALL return `{ slug: 'rembric', projectId, created: false, switched: false, source: 'tool-explicit' }`

#### Scenario: `project.use` with the same slug as currently active is idempotent

- **WHEN** `project.use({slug})` is called where `slug` matches the project already active for the session
- **THEN** the server SHALL return `{ slug, projectId, created: false, switched: false }` and SHALL NOT mutate any state

#### Scenario: `project.use` against a different active project requires `confirmSwitch`

- **WHEN** `project.use({slug: 'api'})` is called where the session is already active in project `'rembric'` and `confirmSwitch` is omitted or `false`
- **THEN** the call SHALL be rejected with code `project_switch_requires_confirm` and a payload `{ currentSlug: 'rembric', targetSlug: 'api' }`

#### Scenario: `project.use` against a different active project with active session

- **WHEN** `project.use({slug: 'api', confirmSwitch: true})` is called where the session is active in project `'rembric'` AND a Rembric session is currently `status = 'active'` for this MCP transport session
- **THEN** the call SHALL be rejected with code `session_active_must_end` and a payload `{ activeSessionId }`, instructing the agent to call `memory.session_summary` (or `memory.session_end`) first

#### Scenario: `project.use` against an unknown slug without `autocreate`

- **WHEN** `project.use({slug: 'does-not-exist'})` is called and no project with that slug exists
- **THEN** the call SHALL be rejected with code `project_not_found` and a payload `{ suggestedSlugs: string[] }` of up to 3 deterministic Levenshtein-≤3 suggestions

#### Scenario: `project.use` with `autocreate` creates a valid slug

- **WHEN** `project.use({slug: 'new-thing', autocreate: true})` is called where no project has that slug and no other project is active for the session
- **AND** the slug matches the strict regex
- **THEN** the server SHALL insert a new `projects` row and activate it, returning `{ slug, projectId, created: true, switched: false }`

#### Scenario: `project.use` with `autocreate` and an invalid slug

- **WHEN** `project.use({slug: 'Bad_Slug', autocreate: true})` is called
- **THEN** the call SHALL be rejected with code `invalid_slug` and SHALL NOT insert a row

#### Scenario: `project.list` returns available slugs

- **WHEN** an MCP client calls `project.list({includeArchived?: false})`
- **THEN** the server SHALL return `{ projects: Array<{ slug, displayName, archived, activeMemoryCount }> }` ordered by slug ascending, filtering archived rows by default
- **AND** the payload SHALL NOT contain a `memoryCount` key on any project entry

#### Scenario: `activeMemoryCount` drops when a memory is archived

- **GIVEN** projects `p` and `q`, where `p` holds exactly one memory with `status = 'active'` and `q` holds two
- **WHEN** an MCP client calls `project.list`, then calls `memory.archive` on `p`'s only memory, then calls `project.list` again
- **THEN** the first response SHALL report `activeMemoryCount` of 1 for `p`
- **AND** the second response SHALL report `activeMemoryCount` of 0 for `p`
- **AND** `q`'s `activeMemoryCount` SHALL be 2 in both responses

#### Scenario: `activeMemoryCount` agrees with what the same connection can retrieve

- **GIVEN** a project holding one `active` memory and one `archived` memory
- **WHEN** an MCP client on a connection resolving to that project calls `project.list` and `memory.stats`
- **THEN** `activeMemoryCount` for that project SHALL equal `memory.stats`' `memoriesByStatus.active` for the same scope
- **AND** `activeMemoryCount` SHALL be strictly less than the project's total row count, so the filter is observable rather than vacuous

#### Scenario: `activeMemoryCount` excludes memories outside the reported project

- **GIVEN** projects `p` and `q` each holding `active` memories, plus at least one `active` memory in the global scope
- **WHEN** a token authorized for both projects calls `project.list`
- **THEN** each entry's `activeMemoryCount` SHALL count only that entry's own project scope
- **AND** no entry's `activeMemoryCount` SHALL include the global-scope memories

#### Scenario: A project-scoped token sees only its own project and its own count

- **GIVEN** projects `p` and `q` both holding `active` memories, and a token with scope `project:<p.id>`
- **WHEN** the token calls `project.list`
- **THEN** the response SHALL contain `p` only, with `p`'s own `activeMemoryCount`
- **AND** no count for `q` SHALL be computed or returned

#### Scenario: `project.list` still succeeds on a connection whose slug resolves to no project

- **GIVEN** a connection at `/mcp/no-such-project` and a token authorized to read the existing projects
- **WHEN** the client calls `project.list`
- **THEN** the call SHALL succeed and SHALL report `activeMemoryCount` for every project the token may read
- **AND** the call SHALL NOT be rejected with `project_not_found`

#### Scenario: `project.list`'s description states that the count is of active memories

- **WHEN** an MCP client retrieves the tool description for `project.list` via `tools/list`
- **THEN** the description SHALL convey that the per-project count covers active memories
- **AND** the description SHALL satisfy `DESCRIPTION_MAX_LENGTH` (see "Tool descriptions MUST stay below the client truncation ceiling")

#### Scenario: `project.current` reports resolution provenance

- **WHEN** an MCP client calls `project.current`
- **THEN** the server SHALL return `{ slug: string | null, projectId: string | null, source: 'url-path' | 'roots' | 'tool-explicit' | 'none', suggestedSlugs: string[] }` where `suggestedSlugs` is populated by the most recent `roots/list` derivation that did NOT auto-activate (existing-but-already-active, or non-existing)
