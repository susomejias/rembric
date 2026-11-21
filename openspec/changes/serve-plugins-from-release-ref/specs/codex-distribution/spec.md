## MODIFIED Requirements

### Requirement: Codex marketplace declaration

The repository SHALL host a Codex marketplace manifest at `.codex-plugin/marketplace.json` at the repo root, installable via `codex plugin marketplace add <repo>`. The `source.path` entry SHALL point at `./apps/plugin` so the marketplace's `git-subdir` extraction targets the relocated plugin tree.

The entry's `ref` SHALL be `plugin-release`, the branch CI advances only after the plugin's npm packages are published, never `main`. Codex CLI 0.163.0 reads `.claude-plugin/marketplace.json` rather than this file (measured), so what Codex installs is decided by the Claude manifest's entry, which carries the same ref. This file is kept consistent with it.

#### Scenario: git-subdir source

- **WHEN** `.codex-plugin/marketplace.json` is loaded
- **THEN** it declares exactly one plugin entry named `rembric`
- **AND** the entry's `source` object is `{ "source": "git-subdir", "url": "https://github.com/susomejias/rembric.git", "path": "./apps/plugin", "ref": "plugin-release" }`
- **AND** the entry declares `policy.installation: "AVAILABLE"` and `policy.authentication: "ON_INSTALL"` and `category: "Memory"`

#### Scenario: Marketplace metadata

- **WHEN** the marketplace is loaded
- **THEN** the top-level object contains `name: "rembric"` and `interface.displayName: "Rembric"`

#### Scenario: Marketplace install resolves the relocated plugin tree

- **GIVEN** a clean Codex CLI installation with no `rembric` plugin cached
- **WHEN** the user runs `codex plugin marketplace add https://github.com/susomejias/rembric.git` followed by `codex plugin add rembric@rembric`
- **THEN** Codex SHALL clone the repo, extract the subtree at `./apps/plugin` per the `source.path`, and cache it under `~/.codex/plugins/cache/rembric/<version>/`
- **AND** the cached directory SHALL contain `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`, `hooks/hooks.codex.json`, and the relevant `scripts/` files
- **AND** it SHALL NOT be required to contain `bin/rembric-bridge.mjs` or a dotenv module: Codex spawns the published bridge through `npx`, so no repository file is on the MCP path for this client

#### Scenario: A moved release ref is picked up without removing the marketplace

- **WHEN** `plugin-release` moves and the user runs `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric`
- **THEN** Codex SHALL install the plugin at the new commit without `codex plugin marketplace remove`
