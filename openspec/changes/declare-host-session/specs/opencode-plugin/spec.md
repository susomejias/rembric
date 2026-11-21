## ADDED Requirements

### Requirement: The opencode plugin SHALL publish a host binding for its root session

The published bridge is spawned by opencode as a descendant of the opencode process and knows no session. Both the 1.x and the 2.x plugin SHALL therefore publish a host binding for their own process (`process.pid`) through `publishHostBinding` from `apps/plugin/mcp-bridge/rembric-host-binding.mjs`, the module the bridge reads it with; the plugin SHALL NOT re-implement the start token, the directory or the file format.

- The binding SHALL name the **root** session id, never a sub-agent's, matching which sessions the plugin registers. A session marked as a sub-agent SHALL NOT be published by any handler, the compaction hook included.
- The plugin SHALL publish whenever the active root session changes: after it ensures a root session on `session.created`, on `chat.message` (1.x) or the `prompt` hook (2.x), and on `experimental.session.compacting` (1.x).
- The plugin SHALL remove the file through `removeHostBinding` when the bound session is deleted (`session.deleted`) and at dispose (`server.instance.disposed` in 1.x, the `setup` cleanup in 2.x), and only while the file still names that session, so a binding another publisher wrote since is never removed.
- A disabled plugin (missing credentials or project) SHALL publish nothing.
- Publishing and removal are best-effort: they SHALL never throw into the host. On `win32` nothing is published.

The installer SHALL copy `rembric-host-binding.mjs` next to the other shared modules in `${HOME}/.config/rembric/bin/`, rewrite the plugin's `../mcp-bridge/rembric-host-binding.mjs` import to that absolute path, and abort, removing the plugin file, when a plugin that imports it is left without the rewritten path. The uninstaller SHALL remove that file.

#### Scenario: The root session is published for the plugin's own process

- **GIVEN** credentials and a project are configured
- **WHEN** a root session `<R>` is created
- **THEN** `<home>/.cache/rembric/host-sessions/<process.pid>.json` SHALL contain exactly `{"pid": <process.pid>, "start": <its start token>, "sessionId": "<R>"}`

#### Scenario: A sub-agent never replaces the root binding

- **GIVEN** the binding names root session `<R>`
- **WHEN** a sub-agent session of `<R>` is created, sends a message, or is compacted
- **THEN** the binding SHALL still name `<R>`

#### Scenario: Switching root sessions re-publishes

- **GIVEN** the binding names root session `<R1>`
- **WHEN** a message or a compaction arrives for another root session `<R2>`
- **THEN** the binding SHALL name `<R2>`

#### Scenario: Removal is conditional on the session

- **GIVEN** the binding names `<R>`
- **WHEN** another session is deleted
- **THEN** the binding SHALL remain
- **WHEN** `<R>` is deleted, or the plugin is disposed while the file still names `<R>`
- **THEN** the file SHALL be removed
- **AND** a dispose after another publisher rewrote the file to a different session SHALL leave it in place

#### Scenario: The installer ships and rewrites the host-binding module

- **WHEN** `install.sh` runs from a local clone
- **THEN** `${HOME}/.config/rembric/bin/rembric-host-binding.mjs` SHALL exist and the installed plugin SHALL import it by that absolute path
- **AND** a plugin whose host-binding import escapes the rewrite SHALL make the installer exit non-zero and remove the plugin file
