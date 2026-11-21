## ADDED Requirements

### Requirement: The marketplace entry MUST install the plugin from the plugin release ref

The plugin entry in `.claude-plugin/marketplace.json` SHALL be a `git-subdir` source pinned to the plugin release ref:

```json
{
  "source": "git-subdir",
  "url": "https://github.com/susomejias/rembric.git",
  "path": "apps/plugin",
  "ref": "plugin-release"
}
```

It SHALL NOT be a relative path. A relative path resolves inside the marketplace clone, which tracks the default branch, so it would offer a release before its pinned `@rembric/mcp-bridge` is on npm. This requirement supersedes the relative-path bullet in the "Marketplace declaration" section. Codex CLI reads this same file (measured on 0.163.0), so this entry also decides what Codex installs.

#### Scenario: The entry is pinned to the release ref

- **WHEN** `.claude-plugin/marketplace.json` is read at HEAD
- **THEN** its single plugin entry `rembric` SHALL carry the `git-subdir` source above, with `ref` set to `plugin-release`

#### Scenario: An existing install migrates in place

- **GIVEN** a user who installed the plugin while the entry was the relative path `./apps/plugin`
- **WHEN** they run `claude plugin marketplace update` and then `claude plugin update rembric@rembric`
- **THEN** the plugin SHALL be re-fetched from `plugin-release` without an uninstall
- **AND** it SHALL stay enabled and keep its configured options

#### Scenario: A moved ref is picked up on update

- **WHEN** `plugin-release` moves forward, or back on a rollback
- **THEN** `claude plugin update rembric@rembric` SHALL install the plugin at the new commit
