## MODIFIED Requirements

### Requirement: Unbound mode MUST permit no write

A session SHALL be in **unbound mode** when it runs inside a git work tree, no step of the cascade produced a project, and the resolve endpoint answered `unbound`. In unbound mode:

- The bridge and the Pi extension SHALL connect path-less with the `X-Rembric-Repo-Fingerprint` header, and the server SHALL refuse every tool that resolves an effective scope with structured code `project_unbound` (see the `mcp-api` capability). `project.list`, `project.current`, `project.bind_repository` and `project.create` remain callable.
- Hook scripts and in-process lifecycle handlers SHALL register no session and SHALL POST no turn report, summary, recall, file-recall or end event.
- The session-start text delivered to the model SHALL say that the repository is not bound, SHALL identify it by the first 12 characters of its fingerprint, SHALL say that before this version a repository without a `.rembric` file used the default project and that binding it to the project its earlier sessions used keeps that continuity, and SHALL say that the binding applies from the next session.

The `project_unbound` message and the session-start text SHALL name only remedies the token can perform: for a caller with administrative capability (see the `auth` capability), the dashboard and `project.bind_repository`, and in the `project_unbound` message also `project.create` with `bindRepository: true` for a project that does not exist yet; for any other caller, asking an admin to bind the repository from the dashboard, or adding a `.rembric` file with `PROJECT_SLUG=<slug>`.

A git repository without fingerprint SHALL follow the same rules, with the session-start text naming its cause (shallow clone, no commit yet, or git unavailable) and the remedy (a full clone, a first commit, or a `.rembric`), and SHALL NOT be recorded as pending.

#### Scenario: An unbound session writes nothing

- **GIVEN** a git checkout with no `.rembric`, no `REMBRIC_PROJECT_SLUG` and an unbound fingerprint
- **WHEN** a Claude Code session runs a full turn and ends
- **THEN** no `sessions` row and no `memory` row SHALL have been written for it
- **AND** a `memory.save` call through the bridge SHALL be refused with `project_unbound`

#### Scenario: The remedy matches the token

- **GIVEN** an unbound repository
- **WHEN** a session starts with a token without administrative capability, including a token of scope `*` whose owner's role is not `admin`
- **THEN** the session-start text and the `project_unbound` message SHALL NOT name `project.bind_repository` or `project.create`
- **AND** they SHALL name the dashboard and `.rembric`
- **AND** with an administering token (scope `*`, owned by an `admin` user), the `project_unbound` message SHALL name `project.bind_repository` and `project.create`
