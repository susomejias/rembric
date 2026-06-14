# Changelog

## [0.13.0](https://github.com/susomejias/rembric/compare/codex-plugin-v0.12.2...codex-plugin-v0.13.0) (2026-06-14)


### ⚠ BREAKING CHANGES

* public plugin install URLs move from .../main/plugin/.<client>-plugin/install.sh to .../main/apps/plugin/.<client>-plugin/install.sh. Old URLs return 404. Marketplace pointers in .claude-plugin/marketplace.json (source) and .codex-plugin/marketplace.json (source.path) change from "./plugin" to "./apps/plugin". Release-please tags now use component-prefixed format (server-vX.Y.Z, claude-code-vX.Y.Z, etc.); legacy vX.Y.Z tags stay in history but no new ones are minted.

### Features

* restructure monorepo to apps/+packages layout ([#62](https://github.com/susomejias/rembric/issues/62)) ([368d4cc](https://github.com/susomejias/rembric/commit/368d4ccaba983a3eb1d445f20b91faab5c05e05a))


### Bug Fixes

* **ci:** collapse plugin release components, drop linked-versions group ([#134](https://github.com/susomejias/rembric/issues/134)) ([0ae9303](https://github.com/susomejias/rembric/commit/0ae93034702fb9eb00981d1912db0d0d2d6f1cbb))
* **ci:** migrate plugin releases to node-workspace (independent claude/codex components) ([#136](https://github.com/susomejias/rembric/issues/136)) ([b53e2af](https://github.com/susomejias/rembric/commit/b53e2af325cb1e241fed70ec77d6daf4bb60ee55))

## [0.12.1](https://github.com/susomejias/rembric/compare/codex-plugin-v0.12.0...codex-plugin-v0.12.1) (2026-06-14)


### Bug Fixes

* **ci:** migrate plugin releases to node-workspace (independent claude/codex components) ([#136](https://github.com/susomejias/rembric/issues/136)) ([b53e2af](https://github.com/susomejias/rembric/commit/b53e2af325cb1e241fed70ec77d6daf4bb60ee55))
