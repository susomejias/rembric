# Changelog

## [0.9.0](https://github.com/susomejias/rembric/compare/opencode-plugin-v0.8.0...opencode-plugin-v0.9.0) (2026-05-20)


### ⚠ BREAKING CHANGES

* public plugin install URLs move from .../main/plugin/.<client>-plugin/install.sh to .../main/apps/plugin/.<client>-plugin/install.sh. Old URLs return 404. Marketplace pointers in .claude-plugin/marketplace.json (source) and .codex-plugin/marketplace.json (source.path) change from "./plugin" to "./apps/plugin". Release-please tags now use component-prefixed format (server-vX.Y.Z, claude-code-vX.Y.Z, etc.); legacy vX.Y.Z tags stay in history but no new ones are minted.

### Features

* restructure monorepo to apps/+packages layout ([#62](https://github.com/susomejias/rembric/issues/62)) ([368d4cc](https://github.com/susomejias/rembric/commit/368d4ccaba983a3eb1d445f20b91faab5c05e05a))
