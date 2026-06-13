# Changelog

## [0.11.0](https://github.com/susomejias/rembric/compare/hermes-plugin-v0.10.0...hermes-plugin-v0.11.0) (2026-06-13)


### Features

* **plugin:** unified TUI installer for server + all clients ([#122](https://github.com/susomejias/rembric/issues/122)) ([3be359a](https://github.com/susomejias/rembric/commit/3be359aec1cc97a1d1623b30db76212a82fb2d59))

## [0.10.0](https://github.com/susomejias/rembric/compare/hermes-plugin-v0.9.0...hermes-plugin-v0.10.0) (2026-05-22)


### ⚠ BREAKING CHANGES

* **sessions:** cap session.summary at 2000 chars (DB CHECK + reject/truncate) ([#87](https://github.com/susomejias/rembric/issues/87))

### Features

* **plugin:** wire pre/post-compact hooks + opencode recall paridad ([#88](https://github.com/susomejias/rembric/issues/88)) ([e78b4e4](https://github.com/susomejias/rembric/commit/e78b4e43813b14138ff7c53d20d54ee9ad4d8c9b))
* **sessions:** cap session.summary at 2000 chars (DB CHECK + reject/truncate) ([#87](https://github.com/susomejias/rembric/issues/87)) ([0af3b8a](https://github.com/susomejias/rembric/commit/0af3b8a36e4125c021fb5e6df811486016b24c73))


### Bug Fixes

* **plugin:** point per-client install URLs at apps/plugin after monorepo restructure ([#75](https://github.com/susomejias/rembric/issues/75)) ([bd26271](https://github.com/susomejias/rembric/commit/bd2627178e65ac46c8488d3e7b9cd3e405b489b2))

## [0.9.0](https://github.com/susomejias/rembric/compare/hermes-plugin-v0.8.0...hermes-plugin-v0.9.0) (2026-05-20)


### ⚠ BREAKING CHANGES

* public plugin install URLs move from .../main/plugin/.<client>-plugin/install.sh to .../main/apps/plugin/.<client>-plugin/install.sh. Old URLs return 404. Marketplace pointers in .claude-plugin/marketplace.json (source) and .codex-plugin/marketplace.json (source.path) change from "./plugin" to "./apps/plugin". Release-please tags now use component-prefixed format (server-vX.Y.Z, claude-code-vX.Y.Z, etc.); legacy vX.Y.Z tags stay in history but no new ones are minted.

### Features

* restructure monorepo to apps/+packages layout ([#62](https://github.com/susomejias/rembric/issues/62)) ([368d4cc](https://github.com/susomejias/rembric/commit/368d4ccaba983a3eb1d445f20b91faab5c05e05a))
