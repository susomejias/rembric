## MODIFIED Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.hermes-plugin/`, sibling to `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/`, and `apps/plugin/.opencode-plugin/`. The directory SHALL contain exactly five files at the top level: `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh`, `README.md`. A nested `apps/plugin/.hermes-plugin/tests/` directory MAY exist for Python unittest sources and SHALL NOT ship to end users (the `install.sh` whitelist of three shipped files — `plugin.yaml`, `__init__.py`, `README.md` — is what guarantees this; nothing else under `apps/plugin/.hermes-plugin/` is copied). `uninstall.sh` is a local-execution maintenance script and, like `install.sh`, is NOT itself copied into the user's plugin directory.

#### Scenario: Plugin tree contains the five top-level files

- **WHEN** the repository is at HEAD
- **THEN** `ls apps/plugin/.hermes-plugin/` lists `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh`, `README.md`, and the `tests/` directory
- **AND** the only nested directory permitted under `apps/plugin/.hermes-plugin/` is `tests/`, and its contents SHALL NOT be referenced by `install.sh` or `uninstall.sh`

## ADDED Requirements

### Requirement: Uninstall via local script

The plugin SHALL be removable through a script at `apps/plugin/.hermes-plugin/uninstall.sh`, mirroring the conservative, idempotent semantics of `apps/plugin/.opencode-plugin/uninstall.sh`. The script SHALL:

- Be POSIX-compatible and run cleanly such that re-running it on an already-clean system is a no-op that still exits zero (idempotent).
- Honour `HERMES_HOME` (default `${HOME}/.hermes`).
- Remove the three installed plugin files (`plugin.yaml`, `__init__.py`, `README.md`) from `${HERMES_HOME}/plugins/rembric/` if present, then `rmdir` the `rembric` plugin directory when it is empty.
- Run `hermes plugins disable rembric` on a best-effort basis (failure SHALL NOT abort the uninstall).
- NOT remove operator-owned state: it SHALL leave `${HERMES_HOME}/.env`, any stored credentials, and any `.rembric` project markers untouched.
- Print which files were removed, which were already absent, and an explicit list of what it deliberately left in place (the `.env` credentials and `.rembric` files), so the operator can remove them manually if desired.

#### Scenario: Uninstall removes plugin files and reports

- **WHEN** the plugin is installed at `${HOME}/.hermes/plugins/rembric/` and the user runs `sh apps/plugin/.hermes-plugin/uninstall.sh`
- **THEN** the three plugin files SHALL be removed and the now-empty `rembric` directory SHALL be `rmdir`-ed
- **AND** stdout SHALL list the removed files and the deliberately-left-behind state

#### Scenario: Uninstall is idempotent

- **WHEN** `uninstall.sh` runs against a system where the plugin is already absent
- **THEN** it SHALL exit zero
- **AND** it SHALL report the files as already absent without erroring

#### Scenario: Uninstall preserves credentials and project markers

- **WHEN** `uninstall.sh` completes
- **THEN** `${HERMES_HOME}/.env` and any `.rembric` files SHALL remain on disk
- **AND** stdout SHALL name them as deliberately left in place
