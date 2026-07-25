## ADDED Requirements

### Requirement: Documented operator commands MUST be verified against the published image

The distribution documentation is required to accurately describe the current distribution model. That requirement is presently violated in a way review cannot catch by reading: the README's backup command shells into the container to run `sqlite3`, which does not exist in the distroless runtime stage, so the command fails on every invocation against the artifact users actually run.

Any command the documentation instructs an operator to run inside the container SHALL be verified against the published image, not against a development checkout. When a documented procedure depends on tooling absent from the runtime stage, the documentation SHALL present the mechanism that does work instead.

#### Scenario: A documented in-container command is verified

- **WHEN** the documentation instructs the operator to execute a command inside the running container
- **THEN** that command SHALL succeed against a container started from the published image

#### Scenario: Documentation references the working mechanism

- **WHEN** a backup or restore procedure is documented
- **THEN** it SHALL reference the dashboard snapshot flow or a host-side file copy, and SHALL NOT reference tooling absent from the runtime stage
