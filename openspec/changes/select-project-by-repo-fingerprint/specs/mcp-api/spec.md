## MODIFIED Requirements

### Requirement: A path-less `/mcp` connection MUST resolve to the default project

A connection at `/mcp` with no path slug SHALL resolve its effective scope to the **default project** — the single `projects` row marked as the system default (see the `projects` capability) — unless its request carries the `X-Rembric-Repo-Fingerprint` header. Such a request is **unbound** (see the `repository-binding` capability): it is authenticated and has no project scope, and every tool that resolves an effective scope SHALL be refused with structured code `project_unbound`, reads and writes alike, without falling back to the default project and without widening. The only tools reachable on an unbound request are those that resolve no effective scope: `project.list`, `project.current` and `project.bind_repository`. Apart from unbound requests there SHALL be no state in which a connection is authenticated but has no project scope.

The `project_unbound` refusal SHALL name only remedies the calling token can perform, as the `repository-binding` capability's unbound-mode requirement specifies, and SHALL NOT name `project.bind_repository` to a token whose scope is not `*`.

Every site that previously fell back to the global scope on a path-less connection SHALL target the default project instead, and the set of such sites SHALL be exhaustive rather than sampled: the shared scope resolver, `memory.session_start`'s project binding, `project.current`'s authorization target, and the pinned-token remedy builder. A site missed here does not fail — it silently authorizes against, or reports, a scope that no longer exists.

No tool SHALL switch a path-less connection to another project, and MCP roots SHALL NOT be consulted to choose one: the server keeps no per-connection state that could hold a switch. A path-less connection reaches another project only by being reconfigured to `/mcp/<slug>`. Reconfiguring the connection's home scope is not the same operation as widening one read: a home scope decides where writes land and what every tool sees by default, while a widening affects exactly one `memory.search` call and no write. Both are bounded by the same authorization, so neither reaches a project the token may not read.

**Authorization is unchanged and still gates the default project.** A token pinned to one project, connecting path-lessly, SHALL be refused with `code: 'forbidden'` naming the default project — a project it was never granted. The denial is the same denial it receives today against the global scope; only the named target changes, and it changes to one an operator can open. The refusal SHALL carry the pinned-project remedy (see "MCP error messages MUST NOT instruct the agent to perform an action it cannot perform").

#### Scenario: A path-less save with no arguments succeeds

- **GIVEN** a path-less `/mcp` connection without an `X-Rembric-Repo-Fingerprint` header, a token authorized to write the default project, and no `.rembric` file, whether or not the client advertises the roots capability
- **WHEN** the client calls `memory.save` with only `type`, `title` and `content`
- **THEN** the call SHALL succeed and the new row SHALL carry the default project's `project_id`
- **AND** the call SHALL NOT be refused with `project_required` or `project_suggestion_pending`

#### Scenario: `project.current` names the default project on a path-less connection

- **GIVEN** a path-less `/mcp` connection with a token authorized to read the default project
- **WHEN** the client calls `project.current`
- **THEN** the response SHALL name the default project's slug and id, and `source` SHALL report that resolution came from the default rather than from a URL path

#### Scenario: A project-pinned token is refused, and told the way out

- **GIVEN** a path-less `/mcp` connection with a token whose scope is `project:<id of foo>`, where `foo` is not the default project
- **WHEN** the client calls `memory.search` or `project.current`
- **THEN** the call SHALL be refused with `code: 'forbidden'`
- **AND** the message SHALL name the slug `foo` and the `/mcp/foo` URL, and SHALL NOT name `project.use`

#### Scenario: Switching to another project does not merge two projects

- **GIVEN** a token authorized for both the default project and project `beta`, and memories in each
- **WHEN** the client switches by reconfiguring its connection from `/mcp` to `/mcp/beta`, the only way left to switch, and calls `memory.search`, `memory.search` with an `entity`, `memory.context`, `memory.stats`, `memory.get` by id, `memory.get` by ids, and `memory.timeline`, none of them passing the cross-project argument
- **THEN** every response SHALL contain only `beta`'s rows and counters, and none SHALL contain a row or counter from the default project

#### Scenario: A widened search does not change where a subsequent write lands

- **GIVEN** a path-less connection resolved to the default project and a token authorized for it and `beta`
- **WHEN** the client calls `memory.search` with the cross-project argument and then `memory.save`
- **THEN** the saved row SHALL carry the default project's `project_id`, so a widened read leaves the connection's home scope untouched

#### Scenario: The default project is listable and usable like any other

- **GIVEN** a token authorized to read the default project
- **WHEN** the client calls `project.list`
- **THEN** the default project SHALL appear as an ordinary entry with its slug, display name, archived flag and `activeMemoryCount`
- **AND** a connection at `/mcp/<its slug>` SHALL resolve to it under the same rules as any other project

#### Scenario: An unbound request is refused, and its project tools still answer

- **GIVEN** a path-less `/mcp` connection whose requests carry `X-Rembric-Repo-Fingerprint: <fingerprint>` and a token authorized to read and write the default project
- **WHEN** the client calls `memory.save`, `memory.search`, `memory.context` and `memory.session_start`
- **THEN** every call SHALL be refused with `project_unbound` and no row SHALL be written
- **AND** `project.list` and `project.current` SHALL succeed, and `project.current` SHALL report `source: 'unbound'`

### Requirement: The MCP server MUST expose three project-management tools under the `project.*` namespace

The `/mcp` and `/mcp/<slug>` endpoints SHALL register `project.list`, `project.current` and `project.bind_repository` with the following contracts; `project.bind_repository` is specified in "The MCP server MUST expose `project.bind_repository` to admin tokens". Tool names live under the top-level `project.*` namespace (not `memory.project_*`) to distinguish project management from memory CRUD.

No tool SHALL activate, switch or create a project. A connection's project is fixed by its URL path, or is the default project on a path-less connection, or is absent on an unbound request; projects are created from the dashboard. `project.bind_repository` binds a repository fingerprint to an existing project for later sessions and SHALL NOT change the project of the connection it is called on. `project.use` SHALL NOT be registered and SHALL NOT appear in `tools/list`.

`project.list`'s per-project count SHALL be named `activeMemoryCount` and SHALL count only memories whose `status` is `active`, in that project's scope. The name carries the filter because the count's previous name, `memoryCount`, stated neither dimension and was measured disagreeing with the corpus the same connection could read: after `memory.archive` on a project's only memory, `project.list` reported `1` while `memory.search` in that same scope returned `0`. The name is additionally reused elsewhere in the server for a different aggregate (memories saved in one session), so a bare `memoryCount` on this payload is ambiguous in two ways at once. Renaming rather than silently re-filtering is required: a changed value under an unchanged key gives a consumer no signal to re-read the contract.

`activeMemoryCount` SHALL be computed by a repository read that takes the scope as a required parameter (see the `data-access` requirement "`project.list`'s per-project memory count MUST be a scoped repository read"). The scope SHALL be derived from the project row being reported, and the token-authorization filter over project rows SHALL be applied BEFORE any count is taken, so the handler can only count a scope the token was already authorized to read. This ordering is the entire basis on which a handler may name its own scope, and it SHALL NOT be relaxed into a post-filter.

`project.list` SHALL NOT resolve an effective scope from the request context in order to produce the count, and SHALL continue to succeed on a connection whose URL slug resolves to no project (see "the connection is not bricked by the refusal").

`project.list` SHALL NOT report a second, unfiltered per-project total. The per-status breakdown scoped to the request context is `memory.stats`' `memoriesByStatus`, and a second total on this payload would answer the same question on a path that deliberately does not resolve the caller's scope.

`project.list`'s registered top-level description SHALL state that the count is of active memories. This SHALL be in the description string returned by `tools/list`, not only in a schema `describe()`, which some clients do not surface to the model.

#### Scenario: No project-switching or project-creating tool is offered

- **WHEN** an MCP client calls `tools/list` on `/mcp` or on `/mcp/<slug>`
- **THEN** the response SHALL contain `project.list`, `project.current` and `project.bind_repository`
- **AND** the response SHALL NOT contain `project.use`, nor any other tool that activates, switches or creates a project

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

- **GIVEN** projects `p` and `q` each holding `active` memories, plus at least one `active` memory in the default project
- **WHEN** a token authorized for both projects calls `project.list`
- **THEN** each entry's `activeMemoryCount` SHALL count only that entry's own project scope
- **AND** no entry's `activeMemoryCount` SHALL include any other project's memories

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
- **THEN** the server SHALL return `{ slug: string | null, projectId: string | null, source: 'url-path' | 'default' | 'unbound' | 'none', repository?: { fingerprint: string | null, boundSlugs: string[], conflict: boolean } }` where `source: 'default'` reports the default-project fallback — a resolution that happened, so it SHALL NOT be reported as `'none'` — and `source: 'unbound'` reports an unbound request, with `slug` and `projectId` null
- **AND** `repository` SHALL be present exactly when the request carries the `X-Rembric-Repo-Fingerprint` header: `fingerprint` SHALL be the header's value, or null for `unavailable`; `boundSlugs` SHALL list only the bound projects the token may read, sorted ascending; and `conflict` SHALL be true exactly when the connection is path-scoped, `boundSlugs` is non-empty and it does not contain the connection's slug
- **AND** the response SHALL NOT carry a `suggestedSlugs` field

#### Scenario: `project.current` reports an explicit selection that overrides a binding

- **GIVEN** fingerprint `F` bound to `shop`, and a token authorized for `shop` and `sandbox`
- **WHEN** a client at `/mcp/sandbox` whose requests carry `X-Rembric-Repo-Fingerprint: F` calls `project.current`
- **THEN** the response SHALL report `slug: 'sandbox'`, `source: 'url-path'` and `repository: { fingerprint: F, boundSlugs: ['shop'], conflict: true }`

#### Scenario: `project.current` does not reveal a binding the token cannot read

- **GIVEN** fingerprint `F` bound only to `secret`, and a token not authorized for `secret`
- **WHEN** a client at `/mcp/shop` whose requests carry `X-Rembric-Repo-Fingerprint: F` calls `project.current`
- **THEN** `repository.boundSlugs` SHALL be empty and `repository.conflict` SHALL be false

### Requirement: The MCP `initialize` response MUST ship a protocol-teaching `instructions` block

When the MCP server is constructed, its `instructions` field SHALL be populated with a scope-aware string that teaches the agent when to call each tool. The string SHALL be 1000 characters or fewer in every variant. This cap is a self-imposed token budget rather than the binding limit: the MCP specification defines `InitializeResult.instructions` as an optional free-form string with no maximum length or truncation rule, but at least one consuming client DOES impose a ceiling — Claude Code truncates `instructions` at 2048 characters with the same `LB` constant it applies to tool descriptions, appending `… [truncated]`. The 1000-character cap is therefore chosen for token cost, at less than half the known client ceiling, and it binds first. Any future change RAISING this cap SHALL keep it below the verified client ceiling (see "Tool descriptions MUST stay below the client truncation ceiling").

Neither variant SHALL name `global`, `include_global` or user-wide memory (see "No MCP tool surface MAY name a scope the server does not have"). The path-scoped variant SHALL state which project the connection is bound to; the path-less variant SHALL state that a project is always active, name the default project as the scope in effect, and name a `/mcp/<slug>` URL as the way to reach another project. An unbound connection — a path-less request carrying the `X-Rembric-Repo-Fingerprint` header — SHALL get a third variant instead of the path-less one: it SHALL state that no project is selected because the repository is not bound and that memory tools answer `project_unbound`, whose message carries the remedies the token can perform; it SHALL NOT name the default project, and SHALL NOT name `project.bind_repository`, which only an admin token can call. No variant SHALL name `project.use` or roots-based auto-detection, because neither exists.

The instructions SHALL be organized as directive, proactively-phrased guidance citing the relevant tools by name, and SHALL include all of:

1. **A proactive save flow** — directing the agent to call `memory.save` (with the required short `title` headline, `content`, and `tags`) the moment something noteworthy happens (bug fix · decision · discovery · config change · pattern · preference) rather than batching to session end, and naming the optional `topic_key` supersede path and the `candidates[]` → `memory.judge` conflict-resolution path. Tag guidance SHALL teach normally 1–5 useful reusable lowercase kebab-case labels such as `dashboard`, `sqlite`, and `bug-fix`; selecting tags SHALL NOT require another tool call. The existing explicit-batch-tool requirements continue to govern operational judgment calls. Mechanical detail (error codes, scope semantics, the hard 1–64 tag bound) MAY be deferred to the tool's own `description` and schema.
2. **A recall flow** — directing the agent that when starting or resuming work, after a `/compact` event, or when asked "what did we do", it SHALL call `memory.context` (or `memory.search` for keyword lookup) BEFORE acting, but ONLY when it lacks the prior detail it needs. The phrasing SHALL keep recall on-demand — it MUST NOT direct an unconditional `memory.context` load at session start.
3. **A session-close flow** — directing the agent to call `memory.session_summary({title, summary})`. The trigger SHALL be bound to ending a turn in which real work happened — phrased so the agent saves before ending any working turn, and SHALL NOT be evadable by avoiding the literal word "done". The flow SHALL describe the title constraint (≤100 chars, descriptive of what was actually worked on — NOT the cwd, NOT generic), the summary structure (the canonical section list defined in `sessions`, carried from its single source rather than restated), AND the summary length cap (currently ≤10000 chars, derived from `SUMMARY_MAX_CHARS`). The cap MUST be present inline so the agent budgets for it on the first attempt; this is verified by the same length test that enforces the 1000-character ceiling.
4. **The update-guidance pointer** — a short clause naming `memory.about` as the tool to call when the operator asks how to update or upgrade Rembric (server or plugins).
5. **The `sessionId` reinforcement clause** — a terse directive telling the agent to pass its current session id explicitly when it knows one, and to never guess/invent one, so writes attach correctly instead of falling through the ambiguous-session fallback (see the `sessionId` reinforcement requirement below).

#### Scenario: An MCP client connects on `/mcp/<slug>`

- **WHEN** the `initialize` handshake completes against `/mcp/my-project`
- **THEN** the `InitializeResult.instructions` SHALL contain references to `memory.save`, `memory.search`, `memory.session_summary`, AND `memory.context` plus a note indicating the connection is bound to project `'my-project'`
- **AND** the note SHALL NOT contain `global`, `include_global` or `user-wide`
- **AND** the instructions SHALL contain the substring `memory.session_summary` and the substring `title` and a reference to "before" (referring to before ending a working turn)
- **AND** the instructions SHALL contain the substring `10000` (the summary length cap)
- **AND** the instructions SHALL contain the substring `memory.context` (the recall flow)
- **AND** the instructions SHALL contain the substring `memory.about` (the update-guidance pointer)

#### Scenario: The session-summary trigger is bound to ending a working turn

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the instructions SHALL phrase the `memory.session_summary` trigger as firing before ending any turn in which real work happened
- **AND** the instructions SHALL NOT bind the trigger solely to the literal phrase `before saying "done"`

#### Scenario: Recall guidance is on-demand, not unconditional-at-start

- **WHEN** either variant of `buildInstructions(ctx)` is built
- **THEN** the `memory.context` recall flow SHALL be conditioned on the agent lacking prior detail (e.g. starting/resuming work, after `/compact`, or "what did we do")
- **AND** the instructions SHALL NOT direct an unconditional `memory.context` load on every session start

#### Scenario: An MCP client connects on `/mcp` without a project

- **WHEN** the `initialize` handshake completes against `/mcp`
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows (the proactive save flow, the on-demand recall flow, the session-close flow with the `10000`-char cap, AND the `memory.about` update-guidance pointer) and a note stating that a project is always active — naming the default project as the scope in effect and a `/mcp/<slug>` URL as the way to reach another project. It SHALL NOT name `project.use` or roots-based auto-detection. It SHALL NOT name the retired `X-Rembric-Project` header, which is asserted absent from both variants by `packages/mcp/src/instructions.test.ts`, and SHALL NOT name `global`, `include_global` or user-wide memory.

#### Scenario: An unbound MCP client connects

- **GIVEN** a path-less `/mcp` request carrying a valid `X-Rembric-Repo-Fingerprint` header
- **WHEN** the `initialize` handshake completes
- **THEN** the `InitializeResult.instructions` SHALL contain the same protocol flows as the other variants and a note stating that no project is selected and that memory tools answer `project_unbound`
- **AND** the note SHALL NOT name the default project, `project.bind_repository`, `project.use`, roots-based auto-detection, `global`, `include_global` or user-wide memory
- **AND** the same request without the header SHALL still receive the path-less variant naming the default project

#### Scenario: Instructions length is checked at build time

- **WHEN** the test suite runs against both `/mcp` and `/mcp/<slug>` variants of `buildInstructions(ctx)`
- **THEN** both outputs SHALL be 1000 characters or fewer (the raised cap — the 10000-char summary cap mention, the recall flow, AND the memory.about pointer MUST all fit within the 1000-char budget)
- **AND** both outputs SHALL contain the substring `10000`
- **AND** both outputs SHALL contain the substring `memory.context`
- **AND** both outputs SHALL contain the substring `memory.about`

#### Scenario: A client that does not consume `instructions` connects

- **WHEN** an MCP client ignores the `instructions` field
- **THEN** every tool SHALL still function normally (the field is informational only)
- **AND** `memory.about` SHALL remain discoverable through the MCP tool manifest regardless of whether the client consumed the `instructions` pointer

#### Scenario: instructions.test.ts asserts the protocol flows are present

- **WHEN** `packages/mcp/src/instructions.test.ts` runs against `buildInstructions({requestedSlug: 'demo'})` and `buildInstructions({requestedSlug: null})`
- **THEN** both outputs SHALL contain the substrings `memory.save`, `memory.context`, `memory.session_summary`, AND `memory.about`
- **AND** both outputs SHALL be ≤1000 chars
- **AND** existing assertions for `memory.search`, the scope note, the `10000` cap, and the proactive (non-"done"-bound) session-summary phrasing SHALL pass, with the scope-note assertion updated to the project-only wording

#### Scenario: The instructions cap stays below the client ceiling

- **WHEN** a change raises `INSTRUCTIONS_MAX_LENGTH` above 1000
- **THEN** the new cap SHALL remain below the verified client truncation ceiling for `instructions` (2048 characters in Claude Code 2.1.220)
- **AND** the change SHALL record the ceiling it re-verified, so the cap is never raised past a limit nobody checked

#### Scenario: SAVE guidance teaches required useful tags

- **WHEN** either instructions variant is built
- **THEN** its SAVE clause SHALL include required `tags` and normally 1–5 useful reusable lowercase kebab-case labels, with examples `dashboard`, `sqlite`, and `bug-fix`
- **AND** `topic_key` SHALL remain optional and no extra tag-selection call SHALL be introduced

## ADDED Requirements

### Requirement: The MCP server MUST expose `project.bind_repository` to admin tokens

`project.bind_repository` SHALL bind the repository identified by the request's `X-Rembric-Repo-Fingerprint` header to an existing project. Its strict input schema SHALL declare exactly one property, `slug`. The fingerprint SHALL NOT be a tool argument: it comes from the header the client computed from the working tree, so the model cannot mistype or invent it.

The tool SHALL refuse, in this order:

1. a token whose scope is not `*`, with `admin_token_required`;
2. a request without the header, or whose header is `unavailable`, with `repository_fingerprint_unavailable`;
3. a `slug` that names no project, with `project_not_found`, or an archived project, with `project_archived`;
4. a fingerprint that already has any binding, with `repository_already_bound`, naming every bound project's slug and stating that moving or removing a binding is done from the dashboard.

The tool SHALL bind only a fingerprint with no binding at all. It SHALL NOT move, replace or remove a binding; those operations exist only in the dashboard. A successful call SHALL create the binding, SHALL copy the normalized remotes of the fingerprint's pending rows into it, SHALL remove the fingerprint's pending row of kind `unbound`, and SHALL return `{ slug, fingerprint }` with text stating that the binding applies from the next session. The connection's own project SHALL NOT change.

The tool SHALL be callable on path-scoped, path-less and unbound requests alike, and SHALL resolve no effective scope. Its registered description SHALL state that it requires an admin token and binds only an unbound repository, within `DESCRIPTION_MAX_LENGTH`. Its behavioural annotations SHALL declare it non-read-only, non-destructive and non-idempotent.

#### Scenario: An admin binds an unbound repository from an unbound session

- **GIVEN** an unbound fingerprint `F`, an existing project `shop`, and an unbound path-less connection carrying `X-Rembric-Repo-Fingerprint: F` with a token of scope `*`
- **WHEN** the client calls `project.bind_repository({ slug: 'shop' })`
- **THEN** a binding of `F` to `shop` SHALL exist
- **AND** a subsequent `memory.save` on the same connection SHALL still be refused with `project_unbound`
- **AND** the next session started from that checkout SHALL resolve to `shop`

#### Scenario: A non-admin token cannot bind

- **GIVEN** a token whose scope is `project:<id of shop>`
- **WHEN** it calls `project.bind_repository({ slug: 'shop' })` with a valid fingerprint header
- **THEN** the call SHALL be refused with `admin_token_required` and no binding SHALL be created

#### Scenario: A bound repository is not moved by the tool

- **GIVEN** fingerprint `F` bound to `shop`
- **WHEN** an admin token calls `project.bind_repository({ slug: 'store' })` with `X-Rembric-Repo-Fingerprint: F`
- **THEN** the call SHALL be refused with `repository_already_bound`, its message SHALL name `shop` and the dashboard
- **AND** `F` SHALL still be bound to `shop` only

#### Scenario: The fingerprint cannot come from the model

- **WHEN** a client calls `project.bind_repository` with a `fingerprint` property
- **THEN** the call SHALL be refused by the strict input schema as an unknown property

## RENAMED Requirements

- FROM: `### Requirement: The MCP server MUST expose two project-management tools under the `project.*` namespace`
- TO: `### Requirement: The MCP server MUST expose three project-management tools under the `project.*` namespace`
