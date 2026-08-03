## ADDED Requirements

### Requirement: A persisted project-scoped token MUST be bound to the project row, enforced by the database

The scope grammar fixed by "Tokens MUST support scope and expiration" names the project by **id**. Nothing has bound the producer to that reading, and the only production writer of a persisted project-scoped token wrote a slug for the whole life of the feature — a token denied on its own project, on every endpoint. Convention is therefore not sufficient enforcement.

Every persisted token whose `scope` is `project:<id>` or `read:project:<id>` SHALL carry `tokens.project_id` equal to that same `<id>`, and `<id>` SHALL be the `projects.id` of an existing project. The database SHALL enforce both halves: the pre-existing foreign key from `tokens.project_id` to `projects(id)` rejects a value that is not a project id, and a `CHECK` constraint rejects a row whose scope string names a different project than `project_id` does.

The `TokenScope` string SHALL NOT be accepted from a caller for the project arm. The service that creates tokens SHALL compose it from a resolved project row together with a read/write access selection, so that a call site cannot supply `project:<slug>` — or any other project string — at all. Callers minting a non-project token (`*`, `read:*`) SHALL continue to supply the scope literal directly.

`tokens.project_id` SHALL be `NULL` for `*` and `read:*` tokens.

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
