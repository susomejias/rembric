# auth Specification

## Purpose

Defines authentication and authorization requirements for Rembric, including bearer token issuance, hashing, scoping, expiration, revocation, and dashboard session management.

## Requirements

### Requirement: Bearer tokens MUST be hashed at rest

The `tokens` table SHALL store only a hash of the token (using argon2id or bcrypt with appropriate parameters). The plaintext token SHALL be returned to the operator exactly once at creation time and SHALL never be persisted or logged.

#### Scenario: Creating a token

- **WHEN** the operator creates a new token via the dashboard or CLI
- **THEN** the server SHALL generate a high-entropy random secret, store its hash, and return the plaintext value exactly once

#### Scenario: Token in logs

- **WHEN** a request log line is emitted for a `/mcp` call
- **THEN** the log SHALL NOT contain the plaintext token; if any token-related field is logged it SHALL be the token name, never the secret

### Requirement: The admin token MUST bootstrap from `REMBRIC_ADMIN_TOKEN`

On first startup, if no token row exists, the server SHALL require `REMBRIC_ADMIN_TOKEN` to be set, SHALL refuse to start otherwise, and SHALL create an `admin` token row with the hash of that value and scope `*`. Subsequent restarts SHALL NOT re-read `REMBRIC_ADMIN_TOKEN`.

#### Scenario: First start without admin token

- **GIVEN** the database has no token rows and `REMBRIC_ADMIN_TOKEN` is not set
- **WHEN** the server is started
- **THEN** the server SHALL exit with a non-zero code and a clear error message instructing the operator to set the env var

#### Scenario: Subsequent start with `REMBRIC_ADMIN_TOKEN` changed

- **GIVEN** the database already contains an admin token row
- **WHEN** the server is started with a different value of `REMBRIC_ADMIN_TOKEN`
- **THEN** the existing admin token row SHALL be preserved unchanged; the env var SHALL be ignored on this start

### Requirement: Tokens MUST support scope and expiration

Every token SHALL carry a `scope` (one of `*` for full access, `project:<id>` for project-restricted, `read:*` for read-only, `read:project:<id>` for read-only project-restricted, `projects` for a token whose reach is an explicit set of projects, or `read:projects` for a read-only token over an explicit set of projects) and SHALL optionally carry an `expires_at` timestamp. The MCP middleware SHALL enforce these on every request: every tool call (except the data-free `memory.about`) SHALL pass an `isAuthorized(tokenScope, action, resolvedScope)` check, where `action` is the tool's read/write classification and `resolvedScope` is the connection's effective scope.

Because every connection now resolves to exactly one project, `resolvedScope` is always a project scope. A `*` or `read:*` token is **unbound** rather than global-scoped: it authorizes against every project, and it carries no project binding of its own.

The two set arms SHALL NOT be spelled as a variant of `*` or `read:*`. A set token's reach comes from its membership set alone (see "A set-scoped token's scope string MUST authorize nothing on its own"), so a base scope that already reaches every project would make the set inert and silently grant more than the operator selected.

#### Scenario: Project-scoped token used for another project

- **GIVEN** a token with `scope = 'project:A'`
- **WHEN** the token is used to make an MCP call on a connection scoped to project B (`/mcp/B`)
- **THEN** the request SHALL be rejected with `403 Forbidden`

#### Scenario: Read-only token attempts to save

- **GIVEN** a token with `scope = 'read:*'`
- **WHEN** the token is used to invoke `memory.save`
- **THEN** the request SHALL be rejected with `403 Forbidden`

#### Scenario: Read-only token attempts any write-classified tool

- **GIVEN** a token with `scope = 'read:*'` or `read:project:<id>`
- **WHEN** the token invokes any write-classified tool (`memory.save_prompt`, `memory.capture_passive`, `memory.session_start`, `memory.session_summary`, `memory.session_end`, `memory.confirm`, `memory.judge`)
- **THEN** the call SHALL be rejected with code `forbidden` and nothing SHALL be persisted

#### Scenario: Project-restricted token calls a read tool outside its project

- **GIVEN** a token with `scope = 'read:project:A'` or `project:A`
- **WHEN** the token invokes a read-classified tool on a connection whose effective scope is any project other than A — including the default project on a path-less connection
- **THEN** the call SHALL be rejected with code `forbidden`
- **AND** the refusal SHALL name the pinned project and `project.use` (see the `mcp-api` requirement "MCP error messages MUST NOT instruct the agent to perform an action it cannot perform")

#### Scenario: A set-scoped token reaches every project in its set

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A, C}`
- **WHEN** the token invokes a write-classified tool on a connection scoped to project A, and then on a connection scoped to project C
- **THEN** both calls SHALL be authorized

#### Scenario: A set-scoped token is denied a project outside its set

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A, C}` and an existing project B
- **WHEN** the token invokes any tool on a connection scoped to project B
- **THEN** the call SHALL be rejected with code `forbidden`

#### Scenario: A read-only set-scoped token cannot write inside its set

- **GIVEN** a token with `scope = 'read:projects'` whose membership set is `{A}`
- **WHEN** the token invokes a write-classified tool on a connection scoped to project A
- **THEN** the call SHALL be rejected with code `forbidden` and nothing SHALL be persisted
- **AND** a read-classified tool on the same connection SHALL be authorized

### Requirement: Revocation MUST take effect immediately

When a token is revoked, the server SHALL reject any further request using that token starting with the next request. The server MAY cache the mapping from a successfully-verified plaintext credential to its token id, so a repeat request from the same caller does not repeat the password-hash derivation — but SHALL NOT cache the authorization outcome (valid / revoked / expired) for any duration. Every authenticated request, whether or not it hits that lookup cache, SHALL re-read the token's current `revoked_at` / `expires_at` state from storage before authorizing it. A credential-lookup cache entry MAY persist indefinitely (bounded by capacity, not by time) precisely because it never substitutes for that fresh authorization check.

#### Scenario: Revoke and reuse

- **WHEN** an operator revokes a token at time T, and a client uses the token at T+1s
- **THEN** the client's request SHALL be rejected with `401 Unauthorized`

#### Scenario: Revoke and reuse with a warm credential-lookup cache

- **GIVEN** a token has been used successfully at least once, so its plaintext→id mapping may be cached
- **WHEN** an operator revokes that token, and the client immediately reuses the same plaintext
- **THEN** the client's request SHALL be rejected with `401 Unauthorized` — the cached lookup MUST NOT shortcut the revocation check
- **AND** this SHALL hold identically for expiry: a token that has since expired SHALL be rejected on its next use even if its lookup was cached before expiring

### Requirement: Dashboard sessions MUST be signed and revocable

Dashboard sessions SHALL be backed by a signed httpOnly cookie referencing a `dashboard_sessions` row. Deleting the row SHALL invalidate the session. The signing key SHALL be derived from `REMBRIC_ADMIN_TOKEN` or a dedicated `REMBRIC_SESSION_SECRET` env var when set.

#### Scenario: Tampering with the cookie

- **WHEN** a client sends a request with a cookie whose signature does not verify
- **THEN** the server SHALL reject the request and redirect to `/dashboard/login`

#### Scenario: Server-side session deletion

- **GIVEN** an active dashboard session
- **WHEN** the corresponding `dashboard_sessions` row is deleted
- **THEN** the next request bearing that cookie SHALL be treated as unauthenticated

### Requirement: OAuth-minted tokens MUST be hashed at rest

Access and refresh tokens issued by the OAuth authorization server SHALL be high-entropy random secrets (at least 256 bits) persisted only as a cryptographic hash (SHA-256 of the secret, stored in an indexed column for O(1) lookup), SHALL be returned to the client exactly once at issuance, and SHALL never be persisted or logged in plaintext. They SHALL be stored in dedicated `oauth_*` tables, leaving the static `tokens` table and its rows unchanged.

#### Scenario: OAuth access token stored hashed

- **WHEN** the `/token` endpoint issues an access token
- **THEN** the persisted row SHALL contain only a hash of the secret, and the plaintext SHALL appear only in the token response body

#### Scenario: OAuth token absent from logs

- **WHEN** a request log line is emitted for an OAuth `/token` or `/mcp` call
- **THEN** the log SHALL NOT contain the plaintext access or refresh token

### Requirement: OAuth access tokens MUST authenticate `/mcp` on the same path as static tokens

The MCP authentication step SHALL accept an OAuth-minted access token presented as `Authorization: Bearer <token>` and resolve it to the same `{ scope }` shape as a static token, after first attempting the static-token lookup. An OAuth access token and a static token SHALL NOT be confusable: a value that does not verify as a static token SHALL fall through to OAuth lookup, and vice versa, with constant-time comparison preserved.

#### Scenario: OAuth access token authenticates

- **GIVEN** a valid, unexpired, unrevoked OAuth access token with scope `*`
- **WHEN** it is used as the `/mcp` bearer to call `memory.search`
- **THEN** the call SHALL be authorized exactly as the same call with a static `*` token

#### Scenario: Static token path unchanged

- **GIVEN** a valid static operator token
- **WHEN** it is used as the `/mcp` bearer after this change ships
- **THEN** the token SHALL authenticate with identical behavior to before the change

### Requirement: OAuth access tokens MUST be short-lived and OAuth tokens MUST be revocable with immediate effect

OAuth access tokens SHALL carry a short expiry (default approximately one hour, tunable via env) and SHALL be rejected once expired. Revocation of an OAuth token (including family revocation triggered by refresh reuse) SHALL take effect on the next request, with no in-memory cache holding a revoked token valid for longer than a few seconds — the same immediate-revocation contract as static tokens.

#### Scenario: Expired OAuth access token rejected

- **GIVEN** an OAuth access token past its expiry
- **WHEN** it is presented to `/mcp`
- **THEN** the request SHALL be rejected with `401 Unauthorized`

#### Scenario: Revoked OAuth token rejected immediately

- **GIVEN** an OAuth access token whose grant family was revoked at time T
- **WHEN** the token is used at T+1s
- **THEN** the request SHALL be rejected with `401 Unauthorized`

### Requirement: Authentication attempts MUST be abuse-resistant

Every bearer-authenticated entry point (`/mcp`, `/api/<slug>/sessions*`, `/healthz`, `/admin/*`, and `POST /dashboard/login`) SHALL resist unauthenticated resource exhaustion. Repeated **failed** authentication attempts from the same pre-auth identity (source socket address, or the configured trusted-proxy forwarded first hop) SHALL be throttled BEFORE the token-hash verification runs, so a caller presenting invalid bearers cannot force the per-attempt hashing work. A single authentication attempt SHALL NOT block the server's event loop: the password-hash verification SHALL run without synchronously stalling other in-flight requests. A successful authentication SHALL reset the failure counter for that identity. The existing per-token rate limiter (keyed on the resolved token id) SHALL remain in place for authenticated fair-use and SHALL NOT be relied upon to throttle failed attempts (a failed attempt yields no token id).

#### Scenario: Repeated invalid bearers are throttled before hashing

- **GIVEN** a caller that has exceeded the failed-attempt threshold within the window from one pre-auth identity
- **WHEN** the caller sends another request with an invalid bearer to any authenticated endpoint
- **THEN** the server SHALL respond `429` without performing the token-hash scan for that request

#### Scenario: A single auth attempt does not block concurrent requests

- **GIVEN** a request whose bearer triggers a full token-hash verification
- **WHEN** the verification is running
- **THEN** other in-flight requests SHALL continue to be served (the verification SHALL NOT synchronously block the event loop)

#### Scenario: Successful auth clears the failure counter

- **GIVEN** a pre-auth identity with a non-zero failed-attempt counter below the threshold
- **WHEN** a request from that identity authenticates successfully
- **THEN** the failure counter for that identity SHALL reset to zero

### Requirement: Dashboard session cookies MUST set `Secure` on HTTPS deployments

When the deployment's external origin is HTTPS (the OAuth issuer `REMBRIC_PUBLIC_URL` is `https://…`), the `rembric_session` cookie SHALL be set with the `Secure` attribute so it is never transmitted over a plaintext connection. The `HttpOnly`, `SameSite=Lax`, and `Path=/dashboard` attributes SHALL be preserved. For an http loopback deployment (localhost / 127.0.0.1 dev or first-run), the cookie MAY omit `Secure` so login still works without TLS.

#### Scenario: Secure flag on an HTTPS deployment

- **GIVEN** the server is configured with an `https://` external origin
- **WHEN** the operator logs into `/dashboard/login` successfully
- **THEN** the `Set-Cookie` for `rembric_session` SHALL include `Secure`, `HttpOnly`, and `SameSite=Lax`

#### Scenario: No Secure flag on http loopback

- **GIVEN** the server is reached over `http://localhost`
- **WHEN** the operator logs in successfully
- **THEN** the `rembric_session` cookie MAY omit `Secure` so the plaintext-loopback login works

### Requirement: The dashboard login response MUST NOT reveal token validity

`POST /dashboard/login` SHALL return an indistinguishable response for a syntactically-valid but non-admin token and for an unrecognized token, so the endpoint is not a token-validity oracle. The response body and status SHALL NOT let an attacker distinguish "this token exists but lacks admin scope" from "this token does not exist".

#### Scenario: Valid non-admin token is indistinguishable from an invalid token

- **GIVEN** two login attempts: one with a real project-scoped token and one with a random invalid token
- **WHEN** both are POSTed to `/dashboard/login`
- **THEN** the server SHALL return the same status and the same error body for both

### Requirement: A read whose result set is widened past the effective scope MUST re-authorize against the wider scope

`isAuthorized(tokenScope, action, resolvedScope)` answers one question: may this token act on the connection's effective scope? A tool argument that widens the returned result set beyond that effective scope asks a second, different question, and the server SHALL authorize it separately. A token SHALL NOT receive rows from a scope it is not authorized to read, whatever argument requested them.

This requirement is the fix for **GHSA-cc4j-ch4r-9pf5** and it is deliberately **generalised rather than retired**. The concrete widening argument that occasioned it (`memory.search`'s `include_global`, and the entity-lookup widening `memory-entities` defined as mirroring it) no longer exists: with one kind of scope there is nothing to widen into, and the argument is removed from the published tool contract. **The principle outlives the argument.** A published security requirement SHALL NOT be deleted because its single known instance was removed — a future widening argument would otherwise arrive unconstrained, and the advisory would have to be rediscovered rather than cited.

Normatively, therefore: the server SHALL admit into a result set only rows belonging to the scope the connection resolved to. Where a change proposes ANY argument, filter, flag or default that admits rows from a scope other than the resolved one, that change SHALL evaluate `isAuthorized(tokenScope, 'read', <the wider scope>)` before widening, and SHALL be bound by this requirement from the moment it is proposed. Where the check fails, the widening SHALL be dropped and the resolved-scope result served unchanged rather than the call being rejected, because the caller is authorized for everything it actually receives.

The structural reason the advisory was possible SHALL also be recorded, because it is a design constraint on any future widening: a widening flag that travels beside the resolved scope as a bare boolean cannot tell any layer that carries it whether anyone was authorized to set it. Any future widening SHALL therefore carry its authorization decision with it, or be constructed at exactly one site that has already made that decision.

This is distinct from the requirement that a project-restricted token invoking a read tool whose _effective scope_ is a project it does not hold be rejected with `forbidden`. That case concerns which scope the connection resolved to. This one concerns a result set widened past a scope the token legitimately holds.

#### Scenario: Project-restricted token requests global widening

- **GIVEN** a token with `scope = 'project:A'` or `read:project:A`, on a connection whose effective scope is project A
- **WHEN** the token calls `memory.search` with any argument, including one named `include_global`
- **THEN** the response SHALL contain only project A's memories, and an argument named `include_global` SHALL be rejected by the input schema as unrecognized rather than silently ignored
- **AND** the scenario title predates this change: the argument it names is removed, and this scenario now pins that no argument reintroduces widening

#### Scenario: Full-access token requests global widening

- **GIVEN** a token with `scope = '*'` or `read:*`, on a connection whose effective scope is a project reached via `project.use`
- **WHEN** the token calls `memory.search` with any argument
- **THEN** the response SHALL contain only that project's memories, and no argument SHALL admit rows from any other project — a full-access token gains reach by switching scope with `project.use`, never by widening one read
- **AND** the scenario title predates this change: there is no wider scope for a full-access token to be widened into

#### Scenario: The widening argument does not escalate a write

- **GIVEN** a token with `scope = 'read:project:A'`
- **WHEN** the token calls any write-classified tool
- **THEN** the call SHALL be rejected with code `forbidden`, unchanged by the presence or absence of any widening argument on any other tool

#### Scenario: A newly proposed widening is bound by this requirement

- **GIVEN** a change proposing an argument, filter or default that would admit rows from a scope other than the one the connection resolved to
- **WHEN** that change is reviewed
- **THEN** it SHALL evaluate authorization against the wider scope before widening, SHALL drop the widening rather than reject the call when that check fails, and SHALL NOT construct its widening decision outside the single site that made it

### Requirement: A persisted project-scoped token MUST be bound to the project row, enforced by the database

The scope grammar fixed by "Tokens MUST support scope and expiration" names the project by **id**. Nothing has bound the producer to that reading, and the only production writer of a persisted project-scoped token wrote a slug for the whole life of the feature — a token denied on its own project, on every endpoint. Convention is therefore not sufficient enforcement.

Every persisted token whose `scope` is `project:<id>` or `read:project:<id>` SHALL carry `tokens.project_id` equal to that same `<id>`, and `<id>` SHALL be the `projects.id` of an existing project. The database SHALL enforce both halves: the pre-existing foreign key from `tokens.project_id` to `projects(id)` rejects a value that is not a project id, and a `CHECK` constraint rejects a row whose scope string names a different project than `project_id` does.

The `TokenScope` string SHALL NOT be accepted from a caller for the project arm. The service that creates tokens SHALL compose it from a resolved project row together with a read/write access selection, so that a call site cannot supply `project:<slug>` — or any other project string — at all. Callers minting a non-project token (`*`, `read:*`) SHALL continue to supply the scope literal directly.

`tokens.project_id` SHALL be `NULL` for `*` and `read:*` tokens. That null is **not** a retired global scope and SHALL NOT be migrated: it records that the token is unbound — authorized against every project — and the `CHECK` constraint's first disjunct depends on it.

#### Scenario: A token minted for a project authorizes that project

- **GIVEN** an existing project `alpha`
- **WHEN** a token is created for `alpha` with write access
- **THEN** the persisted row SHALL have `scope = 'project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** the token SHALL be authorized for read and write against project `alpha`

#### Scenario: A token minted for a project with read access authorizes reads only

- **GIVEN** an existing project `alpha`
- **WHEN** a token is created for `alpha` with read access
- **THEN** the persisted row SHALL have `scope = 'read:project:' || <id of alpha>` and `project_id = <id of alpha>`
- **AND** a read against `alpha` SHALL be authorized and a write against `alpha` SHALL be rejected with code `forbidden`

#### Scenario: The project segment cannot be supplied as a slug

- **WHEN** a call site attempts to create a token by passing a scope string in the `project:` or `read:project:` form
- **THEN** the attempt SHALL NOT compile — the token-creation input type SHALL admit only `*` and `read:*` as a caller-supplied scope, and SHALL require a resolved project row plus an access selection for the project arm

#### Scenario: A non-project value in `project_id` is rejected by the database

- **WHEN** a row is inserted into `tokens` whose `project_id` is not the id of an existing project
- **THEN** the write SHALL be rejected by the foreign key constraint

#### Scenario: A scope string disagreeing with `project_id` is rejected by the database

- **GIVEN** two existing projects with distinct ids `X` and `Y`
- **WHEN** a row is inserted into `tokens` with `project_id = X` and `scope = 'project:' || Y`
- **THEN** the write SHALL be rejected by the `CHECK` constraint
- **AND** a row with `project_id = X` and `scope = 'project:' || X`, and a row with `project_id = X` and `scope = 'read:project:' || X`, SHALL both be accepted

#### Scenario: A global token carries no project binding

- **WHEN** a token is created with scope `*` or `read:*`
- **THEN** the persisted row SHALL have `project_id IS NULL`
- **AND** that null SHALL survive the migration that retires the global scope, because it records an unbound token rather than a scope
- **AND** the scenario title predates this change: such a token is unbound, not global

### Requirement: A token whose project binding does not resolve MUST authorize nothing and MUST NOT be repaired

Tokens created before the producer was corrected carry a scope string naming a project by slug and `project_id IS NULL`. Because the scope segment is compared against a project id, such a token is denied everywhere — it fails **closed**.

Such a token SHALL continue to authorize nothing, on every connection and every endpoint. No migration, boot-time repair, or lazy fix-up SHALL rewrite its `scope` or populate its `project_id`. Rewriting it would fail **open**: it would activate a credential the operator has never observed working, with no revocation event and no audit trail.

The server SHALL NOT resolve a project-scoped token's segment by slug as a fallback. The segment has exactly one reading — a project id — and a fallback would give the string two valid readings, which is the condition that produced the defect. Legacy project slugs are not shape-distinguishable from other values (see `projects` — "A legacy slug continues to function"), so no heuristic can safely separate them.

#### Scenario: A pre-existing malformed token is still denied after upgrade

- **GIVEN** a token row created before this change, with `scope = 'project:<slug-of-alpha>'` and `project_id IS NULL`
- **WHEN** the server is upgraded and the token is used against project `alpha`
- **THEN** the request SHALL be rejected with code `forbidden`, exactly as before the upgrade
- **AND** an admin `*` token SHALL succeed against the same endpoint

#### Scenario: The upgrade does not rewrite the row

- **GIVEN** a token row with `scope = 'project:<slug-of-alpha>'` and `project_id IS NULL`
- **WHEN** the server boots after the upgrade
- **THEN** every column of that row SHALL be byte-for-byte unchanged

### Requirement: A set-scoped token's scope string MUST authorize nothing on its own

The scope strings `projects` and `read:projects` name no project. A token carrying one of them SHALL be denied every target and every action by scope-string evaluation alone; all of its reach SHALL come from its membership set.

This is what makes the union in "Authorization for a set-scoped token MUST be the additive union of scope reach and membership" safe: the base is fail-closed, so a reader that does not know about membership under-authorizes rather than over-authorizes. A set arm spelled as `*` or `read:*` plus a set would instead reach every project regardless of the set.

`tokens.project_id` SHALL be `NULL` for `projects` and `read:projects` tokens. The set arm names no single project, so a non-NULL binding would assert a pin the token does not have.

#### Scenario: The set scope string alone denies every target

- **GIVEN** a token with `scope = 'projects'` and an empty membership set
- **WHEN** the token is used against any project connection, the path-less connection, and any `/api/<slug>/*` endpoint, for both a read-classified and a write-classified operation
- **THEN** every request SHALL be rejected with code `forbidden`
- **AND** an admin `*` token SHALL succeed against the same endpoints

#### Scenario: A set-scoped token carries no single-project binding

- **WHEN** a token is created with the set arm over projects `{A, C}`
- **THEN** the persisted row SHALL have `project_id IS NULL`
- **AND** `token_projects` SHALL contain exactly one row per selected project for that token

### Requirement: Authorization for a set-scoped token MUST be the additive union of scope reach and membership

Authorization SHALL be evaluated as `authorized(scope, action, target) OR authorizedByMembership(token, action, target)`. The union SHALL be additive only: no membership rule SHALL be able to turn an authorization that the scope string grants into a refusal.

Because every token that exists before this capability lands has an empty membership set, the union SHALL be observably identical to scope-string evaluation for every such token, on every endpoint, in both HTTP status and structured error code.

A membership grant SHALL NOT widen the action verb. A `read:projects` token SHALL be authorized for read-classified operations on its member projects and refused write-classified ones; a `projects` token SHALL be authorized for both on its member projects.

#### Scenario: Pre-existing tokens are unchanged by the union

- **GIVEN** tokens with `scope` of `*`, `read:*`, `project:<id of A>`, and `read:project:<id of A>`, each with an empty membership set
- **WHEN** each is exercised against project A, project B, the path-less `/mcp` connection, and `/api/<slug>/sessions`, for both a read and a write operation
- **THEN** every outcome SHALL match the committed pre-change baseline in both status and structured error code
- **AND** at least one probe in the set SHALL succeed, so the comparison is not over an all-refused result set

#### Scenario: Membership does not narrow a global token

- **GIVEN** a token with `scope = '*'`
- **WHEN** the token is used against a project that is not in any membership set
- **THEN** the request SHALL be authorized

### Requirement: A token's project membership set MUST be authorization state, re-read on every authenticated request

The membership set SHALL be treated exactly as `revoked_at` and `expires_at` are treated by "Revocation MUST take effect immediately": the server SHALL re-read a token's current membership from storage before authorizing any authenticated request, and SHALL NOT cache the resulting authorization outcome for any duration.

Removing a project from a token's set SHALL take effect starting with that token's next request. The credential-lookup cache (plaintext → token id) SHALL NOT be extended to hold membership, because its permission to persist indefinitely rests on never substituting for the fresh authorization read.

#### Scenario: Removing a project takes effect on the next request

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A, B}`, which has just made a successful request against project B
- **WHEN** the operator removes project B from the token's set and the same credential is used against project B again
- **THEN** the request SHALL be rejected with code `forbidden`
- **AND** a request against project A SHALL still be authorized

#### Scenario: Removal takes effect with a warm credential-lookup cache

- **GIVEN** a token with `scope = 'projects'` and membership `{A, B}` whose plaintext has already been verified once, so the credential-lookup cache is warm for it
- **WHEN** project B is removed from the set and the same plaintext is used against project B
- **THEN** the request SHALL be rejected with code `forbidden`

### Requirement: A token reaching every project MUST NOT be an admin token

Admin authority SHALL remain a property of the literal scope string `*` and SHALL NOT be derived from the breadth of a membership set. A `projects` token whose set contains every existing project SHALL be refused the dashboard login, every `/admin/*` route, and every maintenance operation gated on admin authority.

Deriving admin from breadth would make creating a project a privilege-altering operation on unrelated tokens, and would make admin authority appear and disappear as the project table changes.

#### Scenario: A set token over every project is refused the dashboard login

- **GIVEN** a token with `scope = 'projects'` whose membership set contains the id of every existing project
- **WHEN** the token is submitted to `POST /dashboard/login`
- **THEN** the login SHALL be refused
- **AND** the same token SHALL be refused on every `/admin/*` route
- **AND** an admin `*` token SHALL succeed on both

#### Scenario: Creating a project does not escalate an existing set token

- **GIVEN** a token with `scope = 'projects'` whose set contains every existing project, and which is refused the dashboard login
- **WHEN** a new project is created and then archived
- **THEN** the token SHALL remain refused on `POST /dashboard/login` at every point
- **AND** the token SHALL be refused on the newly created project

### Requirement: A set-scoped token MUST NOT be able to create a project

A set names projects that exist. A `projects` or `read:projects` token SHALL be refused `project.use` with `autocreate: true` for a slug that does not resolve, with the structured code the existing autocreate gate returns, because the project it would create is by construction not a member of its set.

#### Scenario: Autocreate is refused for a set token

- **GIVEN** a token with `scope = 'projects'` whose membership set is `{A}`
- **WHEN** the token calls `project.use({ slug: 'brand-new', autocreate: true })`
- **THEN** the call SHALL be rejected with code `forbidden` and no `projects` row SHALL be created
- **AND** an admin `*` token making the same call SHALL create the project
