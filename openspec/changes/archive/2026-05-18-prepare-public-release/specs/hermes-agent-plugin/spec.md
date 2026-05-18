## MODIFIED Requirements

### Requirement: Distribution via curl-installer

The plugin SHALL be installable through a single shell script hosted at `plugin/.hermes-plugin/install.sh` in the rembric monorepo. The script SHALL:

- Default to `PLUGIN_SRC="https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin"`.
- Honour an overriding `PLUGIN_SRC` environment variable that points at any local directory (for developers with a cloned monorepo) or any other reachable URL prefix.
- Honour `HERMES_HOME` (default `${HOME}/.hermes`).
- Honour `GH_PAT`, `GH_TOKEN`, or `GITHUB_TOKEN` (in that precedence; first non-empty wins) as a GitHub Personal Access Token used for HTTPS fetches. When set, the script SHALL include `Authorization: Bearer <token>` on every internal `curl` call so the same script works against any auth-protected `raw.githubusercontent.com` URL prefix (a non-public fork, a private mirror, or a fork the user owns and keeps private) without further command-line plumbing.
- Create the target directory `${HERMES_HOME}/plugins/rembric/` if it does not exist.
- Copy or fetch exactly three files into the target directory: `plugin.yaml`, `__init__.py`, `README.md`. When `PLUGIN_SRC` resolves to a local path that contains these files, the script SHALL prefer local `cp`; otherwise the script SHALL `curl -fsSL` from the prefix.
- Exit non-zero on any unrecoverable error (target directory cannot be created; all sources for a required file fail). Print a clear `[rembric] error: <reason>` line to stderr before exiting. When a fetch fails AND no auth token was set, the stderr line SHALL include the hint `(source requires auth? set GH_PAT)` so the user gets a single useful diagnostic for the most common failure mode against non-public forks or mirrors.
- Print a one-line success message identifying the install location and the next step to stdout: `✓ rembric installed at <path>\n  enable: hermes plugins enable rembric`.

The recommended public install command in `README.md` SHALL be:

```
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
```

The plugin's README and docs SHALL NOT recommend a `git clone + cp -r` two-step install as a parallel path. The curl-installer with `PLUGIN_SRC` covers both the casual-user and the developer-with-clone case.

#### Scenario: Default install fetches the three files via curl

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh` in a fresh shell with `HERMES_HOME` unset
- **THEN** the script creates `${HOME}/.hermes/plugins/rembric/` and writes `plugin.yaml`, `__init__.py`, `README.md` into it
- **AND** stdout includes `✓ rembric installed at` followed by the resolved path

#### Scenario: Developer install reads from local clone

- **WHEN** a developer with a clone of rembric runs `PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh`
- **THEN** the three files in the target directory are byte-identical to the files in the local source
- **AND** no network request is issued by the script

#### Scenario: Missing remote file fails loudly

- **WHEN** the script runs with the default `PLUGIN_SRC` and the upstream `plugin.yaml` returns HTTP 404
- **THEN** the script writes `[rembric] error:` to stderr and exits with a non-zero status
- **AND** the target directory may exist but does not contain a half-written `plugin.yaml`

#### Scenario: GH_PAT is forwarded to every internal fetch

- **WHEN** the user runs `export GH_PAT=ghp_xxx; curl -fsSL -H "Authorization: Bearer $GH_PAT" .../install.sh | sh` against an auth-protected `raw.githubusercontent.com` URL prefix
- **THEN** the piped `sh` subprocess inherits `GH_PAT` from the parent shell
- **AND** the script's three internal `curl` calls each include `Authorization: Bearer ghp_xxx`
- **AND** the install succeeds without further user intervention

#### Scenario: Anonymous fetch against an auth-protected source hints at GH_PAT

- **WHEN** the script runs with a `PLUGIN_SRC` pointing at an auth-protected source, no `GH_PAT`/`GH_TOKEN`/`GITHUB_TOKEN` is set, and the upstream `plugin.yaml` returns HTTP 404 (auth-required source masked as not-found)
- **THEN** the stderr line includes the substring `(source requires auth? set GH_PAT)`
- **AND** the script exits non-zero
