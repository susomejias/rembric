## ADDED Requirements

### Requirement: Plugin clients MUST install from a release ref that advances only after the plugin's npm packages are published

The repository SHALL distribute the plugin from a branch named `plugin-release`, and no plugin install path SHALL follow `main` HEAD. Only the `promote-plugin-release` job in `.github/workflows/release-please.yml` SHALL move that branch. The `plugin` release track itself is unchanged: release-please still tags `plugin-vX.Y.Z` on `main`, and `publish-npm` still publishes `@rembric/pi` and `@rembric/mcp-bridge`. Only the moment a release becomes installable moves.

The job SHALL declare `needs: [release-please, publish-npm]` and SHALL run in exactly two cases:

- **Automatic promotion.** The run created a plugin release (`plugin_release_created == 'true'`) and `publish-npm` succeeded. The target is the new `plugin-v*` tag, and the update SHALL be a fast-forward only.
- **Manual promotion or rollback.** A `workflow_dispatch` run supplies the input `plugin_release_tag`. The target is that tag, which SHALL match `plugin-vX.Y.Z`. Because a rollback is a non-fast-forward update, this path SHALL force the update.

On both paths the job SHALL:

1. Resolve the tag to its commit.
2. Read the version in `apps/plugin/mcp-bridge/package.json` at that commit and refuse to move the branch unless the npm registry serves `@rembric/mcp-bridge` at exactly that version.
3. End without changing anything, and without minting a write credential, when the branch already points at the target, so that a rerun is a no-op.

The branch SHALL be protected by a ruleset that restricts updates, including force pushes, to one bypass actor: a GitHub App. The job SHALL obtain that App's installation token through `actions/create-github-app-token`, pinned by full commit SHA, scoped to this repository with `contents: write`, from the repository variable `PLUGIN_RELEASE_APP_CLIENT_ID` and the secret `PLUGIN_RELEASE_APP_PRIVATE_KEY`. The job's own `GITHUB_TOKEN` SHALL be limited to `contents: read`. Workflow inputs and outputs SHALL reach the job's shell through `env`, never by interpolation into the script. Creating the branch, the App, its credentials and the ruleset is an owner prerequisite, and the branch SHALL exist at the latest `plugin-v*` tag before any manifest points at it.

#### Scenario: A plugin release becomes installable only after its bridge is published

- **GIVEN** a merged plugin release PR tags `plugin-vX.Y.Z` on `main`
- **WHEN** `publish-npm` is still running, or has failed
- **THEN** `plugin-release` SHALL still point at the previous release, so no client is offered `X.Y.Z`
- **AND** only after `publish-npm` succeeds SHALL `promote-plugin-release` fast-forward `plugin-release` to the `plugin-vX.Y.Z` commit

#### Scenario: A rerun is a no-op

- **GIVEN** `plugin-release` already points at the target commit
- **WHEN** the job runs again
- **THEN** it SHALL succeed without updating the ref and without minting the App token

#### Scenario: Rollback moves the ref back

- **WHEN** an operator dispatches the workflow with `plugin_release_tag` set to an earlier `plugin-v*` tag
- **THEN** the job SHALL force-update `plugin-release` to that tag's commit
- **AND** clients SHALL be offered that earlier version on their next update

#### Scenario: A target whose bridge is not on npm is refused

- **WHEN** the target commit's `apps/plugin/mcp-bridge/package.json` names a version the registry does not serve
- **THEN** the job SHALL fail without moving `plugin-release`

#### Scenario: Only the App credential writes the ref

- **WHEN** `release-please.yml` is read at HEAD
- **THEN** `promote-plugin-release` SHALL declare `permissions: contents: read`
- **AND** its only write SHALL use the token minted by `actions/create-github-app-token`, referenced by full commit SHA
