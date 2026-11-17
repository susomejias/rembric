## ADDED Requirements

### Requirement: A repository fingerprint MUST be the first-parent root commit of the checked-out history

A client SHALL identify a git repository by its **fingerprint**: the full object name of the root commit reached from `HEAD` by following first parents only, as printed by `git rev-list --first-parent --max-parents=0 HEAD`. The fingerprint is a lowercase hexadecimal string of 40 characters (SHA-1 repositories) or 64 characters (SHA-256 repositories).

The fingerprint SHALL be the only repository identity the server binds to a project. Directory names, repository names, remote URLs and `package.json::name` SHALL NOT select a project, on the client or on the server: two unrelated repositories routinely share a name, and memory has no reassignment verb, so a project guessed from a name misfiles every row it attracts permanently.

A client SHALL compute no fingerprint, and SHALL treat the repository as a **git repository without fingerprint**, when any of the following holds:

- `git rev-parse --is-shallow-repository` reports `true`. A shallow clone's history ends at its boundary commit, and the command above returns that boundary commit rather than the true root, so a shallow clone would otherwise send a wrong identity.
- The repository has no commit yet (`HEAD` does not resolve).
- The `git` executable is unavailable or the command fails for any other reason.

A client SHALL determine that a directory is inside a git work tree with `git rev-parse --is-inside-work-tree`. A directory that is not inside a git work tree is **outside git**, and this capability changes nothing for it.

#### Scenario: A repository with two roots fingerprints by its own history

- **GIVEN** a repository whose own history starts at commit `A`, into which an unrelated library history starting at commit `L` was merged with `--allow-unrelated-histories`
- **WHEN** the client computes the fingerprint from the default branch and from a feature branch created after the merge
- **THEN** both computations SHALL return `A`
- **AND** neither SHALL return `L`

#### Scenario: A shallow clone sends no fingerprint

- **GIVEN** a clone made with `git clone --depth 1`
- **WHEN** the client resolves the project
- **THEN** `git rev-parse --is-shallow-repository` SHALL be consulted before the root lookup
- **AND** the client SHALL treat the repository as a git repository without fingerprint and SHALL NOT send the boundary commit as a fingerprint

#### Scenario: A repository with no commits has no fingerprint

- **GIVEN** a directory where `git init` ran and no commit exists
- **WHEN** the client resolves the project
- **THEN** the client SHALL treat it as a git repository without fingerprint
- **AND** no pending repository row SHALL be recorded for it

#### Scenario: An orphan branch is a different repository identity

- **GIVEN** a repository checked out on a branch created with `git checkout --orphan`
- **WHEN** the client computes the fingerprint
- **THEN** the fingerprint SHALL be that branch's own root commit, which differs from the main history's fingerprint

### Requirement: Every client MUST resolve the session's project with one cascade, once per session

Every Rembric client — the bridge (Claude Code, Codex, opencode, Hermes MCP), the Claude Code and Codex hook scripts, the opencode plugin's in-process handlers, the Pi extension and the Hermes provider — SHALL resolve the project with this cascade, stopping at the first step that yields a result:

1. The validated `PROJECT_SLUG` of the **nearest `.rembric`**: the client SHALL look in the starting directory and then in each parent directory, and SHALL stop after the checkout root (`git rev-parse --show-toplevel`) when the starting directory is inside a git work tree. Outside git only the starting directory SHALL be checked, so a `.rembric` in a home directory never scopes unrelated work beneath it.
2. A validated `REMBRIC_PROJECT_SLUG` default, from the source each client already reads it from.
3. Inside a git work tree only: the fingerprint resolution performed by `POST /api/repositories/resolve` (see the `http-api` capability).
4. No project.

A candidate slug that fails validation against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` SHALL be discarded and the cascade SHALL continue, as today. Steps 1 and 2 are an **explicit selection**.

**Outside git**, step 4 keeps today's behaviour: the bridge connects path-less and the connection resolves to the default project; clients that POST lifecycle events skip them. No fingerprint is computed, no header is sent and the resolve endpoint is not called.

**Inside a git work tree**, step 4 SHALL NOT reach the default project. The client SHALL connect path-scoped (`/mcp/<slug>`) only when steps 1–3 produced a slug. Otherwise it SHALL enter **unbound mode** (see "Unbound mode MUST permit no write") — and only when the resolve endpoint positively answered `unbound`; see "A client MUST NOT fall back to the default project inside a git work tree".

Resolution SHALL happen **once per host session**. Its outcome — a slug, unbound, or no connection — SHALL be fixed for the rest of that session: a binding created, moved or removed while the session runs SHALL take effect from the next session, and no client SHALL re-resolve mid-session. Every client that has a fingerprint SHALL send it in the `X-Rembric-Repo-Fingerprint` header on every MCP request of the session, path-scoped or not; a git repository without fingerprint SHALL send the literal value `unavailable`.

When an explicit selection is available inside a git work tree and the client has a fingerprint, the client SHALL still call the resolve endpoint once, passing the explicit slug and its source, so the server can report a conflict and record a suggestion (see "An explicit selection MUST win over a binding and MUST be reported"). The endpoint's answer SHALL NOT change the explicitly selected project, and a failed or unsupported call SHALL NOT prevent the client from using it.

#### Scenario: A `.rembric` in a parent directory scopes a subdirectory

- **GIVEN** a git checkout at `/work/shop` with `/work/shop/.rembric` containing `PROJECT_SLUG=shop`
- **WHEN** a client starts in `/work/shop/packages/api`
- **THEN** the resolved slug SHALL be `shop`

#### Scenario: The walk stops at the checkout root

- **GIVEN** `/work/.rembric` containing `PROJECT_SLUG=other` and a git checkout at `/work/shop` with no `.rembric` inside it
- **WHEN** a client starts in `/work/shop/src`
- **THEN** `/work/.rembric` SHALL NOT be read
- **AND** the cascade SHALL continue to `REMBRIC_PROJECT_SLUG` and then to the fingerprint

#### Scenario: Outside git nothing changes

- **GIVEN** a directory that is not inside a git work tree, with no `.rembric` and no `REMBRIC_PROJECT_SLUG`
- **WHEN** the bridge starts
- **THEN** it SHALL connect to the path-less `/mcp` endpoint without an `X-Rembric-Repo-Fingerprint` header
- **AND** the session's writes SHALL land in the default project, as before this change
- **AND** no request to `/api/repositories/resolve` SHALL be made

#### Scenario: A bound repository resolves without a `.rembric`

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG`, and a fingerprint bound to project `shop`, which the token may write
- **WHEN** a client starts a session
- **THEN** the client SHALL connect to `/mcp/shop`
- **AND** every MCP request SHALL carry `X-Rembric-Repo-Fingerprint: <fingerprint>`

#### Scenario: A binding changed mid-session applies from the next session

- **GIVEN** a running session resolved to project `shop` by fingerprint
- **WHEN** an admin moves the fingerprint's binding to project `store` from the dashboard
- **THEN** the running session SHALL keep writing to `shop` until it ends
- **AND** the next session started in that checkout SHALL resolve to `store`

### Requirement: Remote URLs MUST be normalized and stripped of credentials on the client and again on the server

A client SHALL send the repository's remote URLs, as printed by `git remote get-url` for every configured remote, in a **normalized form**: lowercase; scheme, user information, port and query string removed; scp-like `user@host:path` rewritten to `host/path`; a trailing `.git` and trailing slashes removed; nested path segments (for example GitLab subgroups) kept. `git@github.com:Acme/Shop.git`, `https://github.com/acme/shop` and `ssh://git@github.com:22/acme/shop.git` SHALL all normalize to `github.com/acme/shop`.

Credentials SHALL never leave the client: a remote such as `https://user:secret@host/acme/shop` SHALL be sent as `host/acme/shop`. The server SHALL apply the same normalization to every remote it receives before storing or comparing it, so a client that fails to strip credentials still never causes one to be persisted.

Remote URLs SHALL be used only to display a repository to an admin and to detect an unknown remote on a bound fingerprint. They SHALL NOT select a project.

#### Scenario: Equivalent remotes normalize to one form

- **WHEN** a client normalizes `git@github.com:Acme/Shop.git`, `https://github.com/acme/shop/` and `ssh://git@github.com:22/acme/shop.git`
- **THEN** each SHALL produce `github.com/acme/shop`

#### Scenario: Credentials are stripped on both sides

- **GIVEN** a remote `https://user:secret@git.example.com/acme/shop.git`
- **WHEN** the client sends it, and separately when a client sends it unnormalized
- **THEN** the stored value SHALL be `git.example.com/acme/shop`
- **AND** the string `secret` SHALL appear in no table, log line or response

### Requirement: A repository binding MUST be unique per fingerprint and project, and visible only within the token's reach

A **binding** associates one fingerprint with one existing project. Uniqueness SHALL be per `(fingerprint, project)`: the same fingerprint MAY be bound to several projects, and a fingerprint SHALL NOT be bound twice to the same project.

Resolution SHALL consider only the bindings whose project the requesting token is authorized to read. Consequently:

- exactly one visible binding resolves to its project;
- no visible binding answers `unbound`;
- two or more visible bindings SHALL be refused with structured code `repository_ambiguous`, naming only the visible projects' slugs, and the client SHALL treat the repository as having no project until an explicit selection resolves it.

A fingerprint bound only to projects the token may not read SHALL produce exactly the answer an unbound fingerprint produces, in the response body, the status code and the error code. No response SHALL reveal that such a binding exists.

A binding SHALL record its creation time, the token or dashboard session that created it, and the normalized remotes known for it. Bindings are configuration, not memory: removing one deletes its row and leaves every memory and session written under it untouched.

#### Scenario: One fingerprint, two projects, two teams

- **GIVEN** fingerprint `F` bound to project `shop` and to project `sandbox`, a token `T1` authorized only for `shop`, and a token `T2` authorized only for `sandbox`
- **WHEN** each token resolves `F`
- **THEN** `T1` SHALL resolve to `shop` and `T2` SHALL resolve to `sandbox`

#### Scenario: A token that sees both bindings gets an ambiguity, not a guess

- **GIVEN** fingerprint `F` bound to `shop` and to `sandbox`, and a token authorized for both
- **WHEN** the token resolves `F` with no explicit selection
- **THEN** the answer SHALL be `repository_ambiguous` naming `sandbox` and `shop`
- **AND** the client SHALL write nothing until a `.rembric` or `REMBRIC_PROJECT_SLUG` selects one

#### Scenario: A binding the token cannot see is indistinguishable from none

- **GIVEN** fingerprint `F` bound only to project `secret`, a token authorized only for `shop`, and fingerprint `G` with no binding
- **WHEN** the token resolves `F` and then `G`
- **THEN** both responses SHALL be identical apart from the fingerprint value they echo

### Requirement: An unknown remote on a bound fingerprint MUST NOT resolve

When the fingerprint has exactly one visible binding, the binding knows at least one remote, the client sent at least one remote, and none of the sent remotes is known to the binding, the server SHALL NOT resolve. It SHALL answer `unbound` with reason `unknown_remote` and SHALL record a pending repository row flagged as an unknown remote for that binding (see "Pending repositories MUST be deduplicated, bounded and private"). Two different projects started from the same boilerplate history share a root commit; this is the check that keeps the second one out of the first one's memory.

When at least one sent remote is known, the server SHALL resolve and SHALL add the remaining sent remotes to the binding. When the binding knows no remote yet, the server SHALL resolve and SHALL record the sent remotes. When the client sent no remote, the server SHALL resolve without the check.

#### Scenario: A project cloned from a shared boilerplate is held back

- **GIVEN** fingerprint `F` bound to `shop` with known remote `github.com/acme/shop`
- **WHEN** a client resolves `F` sending only `github.com/other/store`
- **THEN** the answer SHALL be `unbound` with reason `unknown_remote`
- **AND** a pending row flagged as an unknown remote for `shop` SHALL list `github.com/other/store`

#### Scenario: A fork with the original as upstream resolves and is learned

- **GIVEN** fingerprint `F` bound to `shop` with known remote `github.com/acme/shop`
- **WHEN** a client resolves `F` sending `github.com/dev/shop` and `github.com/acme/shop`
- **THEN** the answer SHALL resolve to `shop`
- **AND** the binding's known remotes SHALL afterwards include `github.com/dev/shop`

### Requirement: An explicit selection MUST win over a binding and MUST be reported

A slug selected by a `.rembric` or by `REMBRIC_PROJECT_SLUG` SHALL be used for the session even when the fingerprint is bound to a different project. The binding SHALL NOT be changed by that use.

When the explicitly selected project differs from every visible binding of the fingerprint, the conflict SHALL be reported in three places:

- the session-start text the client delivers to the model, naming the bound project, the selected project and the source of the selection;
- `project.current`, through its `repository.conflict` field (see the `mcp-api` capability);
- the dashboard, on the bound project, when the selection came from a `.rembric` at the checkout root (see the `dashboard` capability).

A conflict with a binding the token cannot see SHALL NOT be reported, so a report never reveals an invisible binding.

#### Scenario: A `.rembric` overrides a binding with a warning

- **GIVEN** fingerprint `F` bound to `shop` and a checkout of that repository whose root `.rembric` contains `PROJECT_SLUG=sandbox`, with a token authorized for both projects
- **WHEN** a client starts a session there
- **THEN** the session SHALL connect to `/mcp/sandbox`
- **AND** the session-start text SHALL name `shop`, `sandbox` and `.rembric`
- **AND** `project.current` SHALL report `repository.conflict: true`
- **AND** the binding of `F` to `shop` SHALL be unchanged

### Requirement: Unbound mode MUST permit no write

A session SHALL be in **unbound mode** when it runs inside a git work tree, no step of the cascade produced a project, and the resolve endpoint answered `unbound`. In unbound mode:

- The bridge and the Pi extension SHALL connect path-less with the `X-Rembric-Repo-Fingerprint` header, and the server SHALL refuse every tool that resolves an effective scope with structured code `project_unbound` (see the `mcp-api` capability). `project.list`, `project.current` and `project.bind_repository` remain callable.
- Hook scripts and in-process lifecycle handlers SHALL register no session and SHALL POST no turn report, summary, recall, file-recall or end event.
- The session-start text delivered to the model SHALL say that the repository is not bound, SHALL identify it by the first 12 characters of its fingerprint, SHALL say that before this version a repository without a `.rembric` file used the default project and that binding it to the project its earlier sessions used keeps that continuity, and SHALL say that the binding applies from the next session.

The `project_unbound` message and the session-start text SHALL name only remedies the token can perform: for an admin token, the dashboard and `project.bind_repository`; for any other token, asking an admin to bind the repository from the dashboard, or adding a `.rembric` file with `PROJECT_SLUG=<slug>`.

A git repository without fingerprint SHALL follow the same rules, with the session-start text naming its cause (shallow clone, no commit yet, or git unavailable) and the remedy (a full clone, a first commit, or a `.rembric`), and SHALL NOT be recorded as pending.

#### Scenario: An unbound session writes nothing

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG` and an unbound fingerprint
- **WHEN** a Claude Code session runs a full turn and ends
- **THEN** no `sessions` row and no `memory` row SHALL have been written for it
- **AND** a `memory.save` call through the bridge SHALL be refused with `project_unbound`

#### Scenario: The remedy matches the token

- **GIVEN** an unbound repository
- **WHEN** a session starts with a token whose scope is not `*`
- **THEN** the session-start text and the `project_unbound` message SHALL NOT name `project.bind_repository`
- **AND** they SHALL name the dashboard and `.rembric`

### Requirement: A client MUST NOT fall back to the default project inside a git work tree

Inside a git work tree with no explicit selection, a client SHALL connect path-less only after the resolve endpoint returned a successful answer whose outcome is `unbound`. That answer is the server's declaration that it understands the `X-Rembric-Repo-Fingerprint` header; a server that does not understand it would resolve a path-less connection to the default project.

When the resolve endpoint answers anything else — `404`, another non-2xx status, a body that does not parse, a timeout or a network error — the client SHALL NOT connect: the bridge SHALL exit non-zero after one stderr diagnostic naming the cause and the remedy (update the server, or add a `.rembric`), the Pi extension SHALL register no tools and SHALL raise one harness notification, and hooks and in-process handlers SHALL POST nothing. Explicit selections are unaffected and work against any server version.

#### Scenario: A new plugin against an old server stays out of the default project

- **GIVEN** a server that answers `POST /api/repositories/resolve` with `404`, and a git checkout with no `.rembric` and no `REMBRIC_PROJECT_SLUG`
- **WHEN** the bridge starts
- **THEN** it SHALL NOT open a path-less connection
- **AND** it SHALL exit non-zero with one stderr diagnostic naming the server update and `.rembric` as remedies

#### Scenario: A timeout is not treated as unbound

- **GIVEN** a resolve endpoint that does not answer within the client's budget
- **WHEN** the bridge starts in a git checkout with no explicit selection
- **THEN** it SHALL NOT connect path-less and SHALL NOT connect to any project

### Requirement: Pending repositories MUST be deduplicated, bounded and private

The server SHALL record a **pending repository** row, for an admin to act on from the dashboard, in these cases:

- **unbound** — a fingerprint resolved to `unbound` with reason `not_bound` for the reporting token;
- **suggestion** — a client reported an explicit selection whose source is a `.rembric` at the checkout root, naming an existing project the token may write;
- **unknown remote** — the case defined in "An unknown remote on a bound fingerprint MUST NOT resolve".

Rows SHALL be deduplicated per `(fingerprint, kind, project)`, where `project` is the suggested or bound project and is absent for `unbound`. A sighting that matches an existing row SHALL update its last-seen time, add the reporting token to the row's tokens, and add any new normalized remotes; it SHALL NOT create a second row. A row an admin **discarded** SHALL stay hidden from the pending list when sighted again until an admin restores it, and discarded rows SHALL NOT expire.

A row SHALL store only: the fingerprint, the normalized remotes, the suggested or bound project, the first-seen and last-seen times, the tokens that sighted it, the discarded time, and — only when no remote was ever reported for it — the basename of the checkout root. It SHALL NOT store a local path or any other part of it.

Limits, each configurable by an environment variable of the server:

- `REMBRIC_REPO_PENDING_TTL_DAYS`, default `14`: a non-discarded row not sighted for that many days SHALL NOT be listed, SHALL NOT count toward any limit and MAY be deleted. Expiry SHALL be evaluated when rows are read or written; no scheduled job is introduced.
- `REMBRIC_REPO_PENDING_MAX_PER_TOKEN`, default `20`: a sighting that would create a new row SHALL be ignored when the reporting token already appears in that many live rows. Sightings that refresh an existing row SHALL still be applied.

A token whose scope does not authorize writing SHALL NOT create or refresh pending rows of any kind. A git repository without fingerprint SHALL NOT create rows.

#### Scenario: Five teammates, one request

- **GIVEN** five tokens, each authorized to write project `shop`, whose checkouts of one repository carry the same root `.rembric` with `PROJECT_SLUG=shop`, and an unbound fingerprint
- **WHEN** each token starts a session
- **THEN** exactly one suggestion row SHALL exist for `(fingerprint, suggestion, shop)`
- **AND** it SHALL list all five tokens

#### Scenario: A discarded repository stays discarded

- **GIVEN** a pending row an admin discarded
- **WHEN** a token sights the same fingerprint again
- **THEN** the row SHALL not reappear in the pending list
- **AND** it SHALL remain listed under discarded repositories, with an updated last-seen time

#### Scenario: The per-token limit stops new rows only

- **GIVEN** `REMBRIC_REPO_PENDING_MAX_PER_TOKEN=2` and a token already sighted in two live rows
- **WHEN** the token reports a third, new fingerprint and then re-sights one of the first two
- **THEN** no row SHALL be created for the third fingerprint
- **AND** the re-sighted row's last-seen time SHALL be updated

#### Scenario: No local path is stored

- **GIVEN** a repository without remotes checked out at `/home/<user>/code/shop`
- **WHEN** it is recorded as pending
- **THEN** the row SHALL store `shop` as the root name
- **AND** no stored value SHALL contain `/home/<user>`

### Requirement: The `X-Rembric-Repo-Fingerprint` header MUST be strictly validated

The server SHALL accept the `X-Rembric-Repo-Fingerprint` header only when it carries exactly one value that is either 40 or 64 lowercase hexadecimal characters, or the literal `unavailable`. A request carrying the header with any other value — including several comma-separated values, uppercase hexadecimal, surrounding data or an empty value — SHALL be refused with HTTP `400` and structured code `invalid_repository_fingerprint` before any tool runs.

The header SHALL NOT select a project on any request (see the `projects` capability). On a path-scoped request it SHALL only inform `project.current`'s `repository` field and `project.bind_repository`.

#### Scenario: A malformed header is refused

- **WHEN** an MCP request arrives with `X-Rembric-Repo-Fingerprint: ABC,def`
- **THEN** the server SHALL answer `400` with code `invalid_repository_fingerprint`
- **AND** no tool SHALL run

#### Scenario: A valid header on a path-scoped request does not change the project

- **GIVEN** fingerprint `F` bound to `shop`
- **WHEN** an MCP request at `/mcp/sandbox` carries `X-Rembric-Repo-Fingerprint: F` and calls `memory.save`
- **THEN** the row SHALL carry `sandbox`'s `project_id`

### Requirement: All five clients MUST adopt fingerprint resolution in the same plugin release

Fingerprint resolution SHALL ship in one `plugin` release for Claude Code, Codex, opencode, Pi and Hermes together. A release in which some clients resolve by fingerprint and others do not would send the same checkout to a bound project from one client and to the default project from another.

The upgrade SHALL be a clean cut: inside a git work tree, a checkout that resolved to the default project because it had no `.rembric` and no `REMBRIC_PROJECT_SLUG` SHALL become unbound and SHALL be recorded as pending on its first session after the upgrade. Memories and sessions already written to the default project SHALL stay there; nothing is moved.

#### Scenario: Every client resolves the same checkout to the same project

- **GIVEN** a checkout with no `.rembric` whose fingerprint is bound to `shop`
- **WHEN** a session is started from it with each of the five clients of one plugin release
- **THEN** every client SHALL resolve to `shop`

#### Scenario: A checkout that used the default project becomes pending

- **GIVEN** a git checkout with no `.rembric` and no `REMBRIC_PROJECT_SLUG`, whose earlier sessions were stored in the default project
- **WHEN** its first session after the upgrade starts
- **THEN** the session SHALL be unbound
- **AND** a pending row of kind `unbound` SHALL exist for its fingerprint
- **AND** the earlier sessions SHALL still belong to the default project
