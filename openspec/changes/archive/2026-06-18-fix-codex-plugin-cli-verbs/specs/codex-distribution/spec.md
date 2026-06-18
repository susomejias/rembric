## MODIFIED Requirements

### Requirement: Codex marketplace declaration

The repository SHALL host a Codex marketplace manifest at `.codex-plugin/marketplace.json` at the repo root, installable via `codex plugin marketplace add <repo>`. The `source.path` entry SHALL point at `./apps/plugin` so the marketplace's `git-subdir` extraction targets the relocated plugin tree.

#### Scenario: git-subdir source

- **WHEN** `.codex-plugin/marketplace.json` is loaded
- **THEN** it declares exactly one plugin entry named `rembric`
- **AND** the entry's `source` object is `{ "source": "git-subdir", "url": "https://github.com/susomejias/rembric.git", "path": "./apps/plugin", "ref": "main" }`
- **AND** the entry declares `policy.installation: "AVAILABLE"` and `policy.authentication: "ON_INSTALL"` and `category: "Memory"`

#### Scenario: Marketplace metadata

- **WHEN** the marketplace is loaded
- **THEN** the top-level object contains `name: "rembric"` and `interface.displayName: "Rembric"`

#### Scenario: Marketplace install resolves the relocated plugin tree

- **GIVEN** a clean Codex CLI installation with no `rembric` plugin cached
- **WHEN** the user runs `codex plugin marketplace add https://github.com/susomejias/rembric.git` followed by `codex plugin add rembric@rembric`
- **THEN** Codex SHALL clone the repo, extract the subtree at `./apps/plugin` per the `source.path`, and cache it under `~/.codex/plugins/cache/rembric/<version>/`
- **AND** the cached directory SHALL contain `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`, `bin/rembric-bridge.mjs`, `bin/rembric-dotenv.mjs`, `hooks/hooks.codex.json`, and the relevant `scripts/` files

### Requirement: `docs/agents.md` recommends the plugin install as primary

The Codex section of `docs/agents.md` SHALL recommend the **TUI installer** (`apps/plugin/install.sh` / the root shim) as the primary install path. It SHALL retain the Codex marketplace plugin install (`codex plugin marketplace add … && codex plugin add rembric@rembric`) and the manual `config.toml` fallback, but both SHALL appear under an explicitly-labelled "Manual / advanced" subsection, not as the lead instruction. The section SHALL document the credential flow, and the platform-required enablement steps for plugin hooks (which Codex gates behind an under-development feature flag and a per-hook trust review as of `codex-cli 0.130.0`). The "trust each of the N plugin-bundled hooks" guidance SHALL enumerate the FIVE hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`).

#### Scenario: Codex section leads with the TUI installer

- **WHEN** a reader opens the Codex section of `docs/agents.md`
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** the `codex plugin marketplace add` / `codex plugin add` commands and the manual `config.toml` SHALL appear only under a manual / advanced heading
