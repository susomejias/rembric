## ADDED Requirements

### Requirement: Plugin artifacts and the available-version manifest MUST come from the resolved plugin release commit

The installer SHALL keep two default refs, one per release track:

- **Plugin track.** Every artifact under `apps/plugin/` (client scripts, the opencode files and shared modules) and `.release-please-manifest.json` SHALL default to the `plugin-release` branch.
- **Server track.** `docker-compose.yml` and `.env.example` SHALL default to `main`.

The installer SHALL decide an artifact's track from its repository-relative path, in one place. An explicit `--ref=<ref>`, or a non-empty `REMBRIC_REF`, SHALL override both tracks. `REMBRIC_SRC` keeps reading every artifact from disk.

In remote mode the installer SHALL resolve the plugin ref to a full commit SHA at most once per run, and only when a plugin artifact is needed, so a server-only run SHALL NOT resolve it. Resolution SHALL use `git ls-remote` against `https://github.com/susomejias/rembric.git`, asking for the branch and the tag of that name and preferring a peeled tag. A ref that is already a 40-character hexadecimal SHA SHALL be used as-is. Plugin artifacts and the manifest SHALL then be fetched by that SHA, because a raw-content URL by commit cannot be served stale by the CDN while a branch URL can. When git is absent or resolution fails, plugin artifacts SHALL be fetched by the plugin ref name instead. That fallback can only delay an update by the CDN's cache lifetime; it can never name an unpublished bridge. The opencode client script SHALL receive the same commit base, and its own manual-fallback defaults SHALL point at `plugin-release`. On start the installer SHALL announce both refs it operates against.

"Update available" therefore compares against the version promoted to `plugin-release`, which by the release requirement in `open-source-distribution` only ever names a plugin whose `@rembric/mcp-bridge` is on npm.

#### Scenario: Plugin artifacts and the manifest are fetched by the resolved commit

- **GIVEN** remote mode with no explicit ref, and `plugin-release` resolving to commit `S`
- **WHEN** the installer reads the status table or installs opencode
- **THEN** `.release-please-manifest.json` and every `apps/plugin/` artifact SHALL be fetched from `…/rembric/S/…`
- **AND** nothing under `apps/plugin/` and no manifest SHALL be fetched from `main`

#### Scenario: Server artifacts keep the server track

- **WHEN** the installer prepares or updates the server with no explicit ref
- **THEN** `docker-compose.yml` and `.env.example` SHALL be fetched from `main`
- **AND** the plugin ref SHALL NOT be resolved

#### Scenario: Without git the plugin track falls back to the branch name

- **GIVEN** remote mode on a machine without git
- **WHEN** the installer reads the status table
- **THEN** the manifest SHALL be fetched from `…/rembric/plugin-release/…`

#### Scenario: An explicit ref overrides both tracks

- **WHEN** the installer runs with `--ref=<ref>` or `REMBRIC_REF=<ref>`
- **THEN** server artifacts SHALL be fetched from `<ref>`
- **AND** plugin artifacts SHALL be fetched from the commit `<ref>` resolves to, or from `<ref>` itself when it cannot be resolved

### Requirement: Hermes mutations MUST pin the resolved plugin release commit

Hermes cannot follow a branch: `hermes plugins install --ref` accepts only a full commit SHA, and a SHA-pinned install refuses `hermes plugins update`. A Hermes install or update SHALL therefore pin the commit the plugin ref resolves to:

- **Install** SHALL be `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --ref <sha> --enable`.
- **Update** SHALL be `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --force --ref <sha>`. This moves an existing pin, and converts an existing unpinned native install into a pinned one, while Hermes keeps the user's state.
- **Uninstall** stays `hermes plugins remove rembric` and needs no SHA.

The installer SHALL pass the SHA to the Hermes adapter as `REMBRIC_PLUGIN_REV`. The adapter SHALL refuse an install or update without a 40-character hexadecimal value. It SHALL accept native source metadata whose `pinned` is a JSON boolean, either value, with a 40-character revision, and SHALL treat an update of an install already pinned at that SHA as a successful no-op. The legacy-copy migration SHALL install with the same `--ref`.

When the commit cannot be resolved, the installer SHALL refuse a Hermes install or update before any mutation in the requested transaction, with a diagnostic naming the ref. User-supplied `--ref`, `REMBRIC_REF`, `REMBRIC_SRC` and `PLUGIN_SRC` remain rejected for Hermes. Hermes reaches a rollback through `plugin-release` moving, not through a user ref. The Hermes bridge pin the installer prints SHALL be read from the manifest at that same commit.

#### Scenario: Install pins the resolved commit

- **GIVEN** `plugin-release` resolves to commit `S`
- **WHEN** the operator installs Hermes, with or without `--yes`
- **THEN** the command printed or executed SHALL be `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --ref S --enable`

#### Scenario: Update moves the pin

- **GIVEN** a native Hermes install, pinned or unpinned, at a revision other than `S`
- **WHEN** the operator runs an explicit Hermes update with `--yes`
- **THEN** the installer SHALL execute `hermes plugins install susomejias/rembric/apps/plugin/.hermes-plugin --force --ref S`
- **AND** it SHALL NOT run `hermes plugins update rembric`

#### Scenario: Update of an install already at the commit is a no-op

- **GIVEN** a native Hermes install pinned at `S`
- **WHEN** the operator runs an explicit Hermes update with `--yes`
- **THEN** it SHALL succeed without running any Hermes mutation

#### Scenario: An unresolvable commit refuses before mutation

- **GIVEN** the plugin ref cannot be resolved to a commit
- **WHEN** a transaction includes a Hermes install or update
- **THEN** the installer SHALL exit non-zero before modifying any selected client or server
- **AND** a Hermes uninstall in the same situation SHALL still proceed
