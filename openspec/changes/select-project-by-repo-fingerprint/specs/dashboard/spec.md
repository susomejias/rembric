## ADDED Requirements

### Requirement: The project create and edit surfaces MUST manage the project's repository bindings

The surfaces that create and edit a project SHALL carry a **Repositories** section with three parts:

- **Bound repositories** — one row per binding of this project, showing its normalized remotes (or, when it has none, the stored root name and the fingerprint's first 12 characters), the time it was bound rendered through the `<Time>` component, and the token or dashboard session that bound it. Each row SHALL offer removal, gated by the `ConfirmSubmit` dialog with `tone="warn"`, whose text SHALL state that memories and sessions already written stay in the project and that later sessions from that repository stop resolving here.
- **Pending repositories** — the live pending rows relevant to this project (suggestions and unknown-remote rows naming it first, then unbound rows), each with an action that binds it to this project.
- **Bind by fingerprint** — a field that accepts a fingerprint typed or pasted by the admin. A value that is not 40 or 64 lowercase hexadecimal characters SHALL be refused with a message naming the expected format, and no binding SHALL be created.

On the create surface the section SHALL bind after the project is created, in the same submission.

#### Scenario: An admin binds a pending repository from the project's edit surface

- **GIVEN** project `shop` and a pending `unbound` row for fingerprint `F` with remote `github.com/acme/shop`
- **WHEN** the admin opens `shop`'s edit surface and binds that row
- **THEN** a binding of `F` to `shop` SHALL exist with remote `github.com/acme/shop`
- **AND** the pending row SHALL no longer be listed

#### Scenario: Removing a binding asks for confirmation

- **WHEN** the admin activates removal on a bound repository
- **THEN** a `ConfirmSubmit` dialog with `tone="warn"` SHALL open before any request is sent
- **AND** cancelling it SHALL leave the binding in place

#### Scenario: A malformed fingerprint is refused

- **WHEN** the admin submits `abc123` in the bind-by-fingerprint field
- **THEN** the form SHALL show a message naming the 40- or 64-character hexadecimal format
- **AND** no binding SHALL be created

### Requirement: The dashboard MUST surface pending repositories, their kinds and their count

The projects list SHALL show the number of live pending repositories, so an admin learns about them without opening each project. A pending view SHALL list every live pending row with its kind, normalized remotes or root name, fingerprint prefix, the tokens that sighted it and its first- and last-seen times through `<Time>`. Kinds SHALL be distinguishable at a glance:

- **unbound** — offers binding to a project the admin picks;
- **suggestion** — names the suggested project and offers binding to it. When the fingerprint is already bound to another project, the row SHALL be shown as a conflict naming both projects, and binding it SHALL require the admin to choose between moving the binding (removing the other one) and adding a second binding, the latter with a warning that tokens reaching both projects will get an ambiguity;
- **unknown remote** — names the bound project and the unseen remote, and offers accepting the remote into that binding, binding the fingerprint to another project, or discarding.

Every row SHALL offer **discard**. Discarded rows SHALL be listed in a separate discarded view with a **restore** action, and SHALL NOT count toward the projects-list number.

On a project's edit surface, a conflict row naming that project as the bound one SHALL be shown as a notice that a checkout of the repository selects another project through its `.rembric`.

#### Scenario: The projects list counts live pending repositories only

- **GIVEN** three live pending rows and one discarded row
- **WHEN** the admin opens the projects list
- **THEN** the pending count SHALL read 3

#### Scenario: A conflict requires choosing between moving and adding

- **GIVEN** fingerprint `F` bound to `shop` and a suggestion row for `(F, sandbox)`
- **WHEN** the admin binds the row
- **THEN** the dashboard SHALL ask whether to move the binding from `shop` to `sandbox` or to add a second binding
- **AND** choosing to move SHALL leave `F` bound to `sandbox` only

#### Scenario: A discarded row can be restored

- **GIVEN** a discarded pending row
- **WHEN** the admin restores it from the discarded view
- **THEN** it SHALL be listed again in the pending view and counted on the projects list
