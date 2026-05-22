# Changelog

## [0.20.1](https://github.com/susomejias/rembric/compare/server-v0.20.0...server-v0.20.1) (2026-05-22)


### Bug Fixes

* **server:** disable foreign_keys around migrations to unblock parent-table rebuilds ([#93](https://github.com/susomejias/rembric/issues/93)) ([28f93cf](https://github.com/susomejias/rembric/commit/28f93cf91378dad4b963ca03e5c57802c790abab))

## [0.20.0](https://github.com/susomejias/rembric/compare/server-v0.19.0...server-v0.20.0) (2026-05-22)

### ⚠ BREAKING CHANGES

- **sessions:** cap session.summary at 2000 chars (DB CHECK + reject/truncate) ([#87](https://github.com/susomejias/rembric/issues/87))

### Features

- **plugin:** wire pre/post-compact hooks + opencode recall paridad ([#88](https://github.com/susomejias/rembric/issues/88)) ([e78b4e4](https://github.com/susomejias/rembric/commit/e78b4e43813b14138ff7c53d20d54ee9ad4d8c9b))
- **sessions:** cap session.summary at 2000 chars (DB CHECK + reject/truncate) ([#87](https://github.com/susomejias/rembric/issues/87)) ([0af3b8a](https://github.com/susomejias/rembric/commit/0af3b8a36e4125c021fb5e6df811486016b24c73))

### Bug Fixes

- **plugin:** point per-client install URLs at apps/plugin after monorepo restructure ([#75](https://github.com/susomejias/rembric/issues/75)) ([bd26271](https://github.com/susomejias/rembric/commit/bd2627178e65ac46c8488d3e7b9cd3e405b489b2))

## [0.19.0](https://github.com/susomejias/rembric/compare/server-v0.18.1...server-v0.19.0) (2026-05-21)

### Features

- **dashboard:** replace pending tile with recent judgments + detail view ([#74](https://github.com/susomejias/rembric/issues/74)) ([be80ab8](https://github.com/susomejias/rembric/commit/be80ab8f2213515e7942339461fdbce8dc352b1e))
- **server:** add operator surface for curated user prompts ([#73](https://github.com/susomejias/rembric/issues/73)) ([5950667](https://github.com/susomejias/rembric/commit/5950667dd81ece2d549782266d69f26bf71887b2))
- **sessions:** filter empty sessions from memory.context recentSessions ([#71](https://github.com/susomejias/rembric/issues/71)) ([5ed921a](https://github.com/susomejias/rembric/commit/5ed921a193e203adef44dfb9f1518a0ed60a2d4e))

## [0.18.1](https://github.com/susomejias/rembric/compare/server-v0.18.0...server-v0.18.1) (2026-05-21)

### Bug Fixes

- **docker:** use pnpm deploy for runtime image to resolve workspace deps ([#69](https://github.com/susomejias/rembric/issues/69)) ([80f710c](https://github.com/susomejias/rembric/commit/80f710cb1d3bec88d948391d4ac4a7e8c8d75dfd))

## [0.18.0](https://github.com/susomejias/rembric/compare/server-v0.17.0...server-v0.18.0) (2026-05-20)

### ⚠ BREAKING CHANGES

- public plugin install URLs move from .../main/plugin/.<client>-plugin/install.sh to .../main/apps/plugin/.<client>-plugin/install.sh. Old URLs return 404. Marketplace pointers in .claude-plugin/marketplace.json (source) and .codex-plugin/marketplace.json (source.path) change from "./plugin" to "./apps/plugin". Release-please tags now use component-prefixed format (server-vX.Y.Z, claude-code-vX.Y.Z, etc.); legacy vX.Y.Z tags stay in history but no new ones are minted.

### Features

- restructure monorepo to apps/+packages layout ([#62](https://github.com/susomejias/rembric/issues/62)) ([368d4cc](https://github.com/susomejias/rembric/commit/368d4ccaba983a3eb1d445f20b91faab5c05e05a))

## [0.17.0](https://github.com/susomejias/rembric/compare/v0.16.0...v0.17.0) (2026-05-19)

### Features

- **plugin:** opencode session summary on dispose + auto-config opencode.json ([#60](https://github.com/susomejias/rembric/issues/60)) ([9f7fbe4](https://github.com/susomejias/rembric/commit/9f7fbe4401b57d934f10aa51c2b62c88ede13d7f))

## [0.16.0](https://github.com/susomejias/rembric/compare/v0.15.1...v0.16.0) (2026-05-19)

### Features

- **plugin:** add opencode plugin ([#56](https://github.com/susomejias/rembric/issues/56)) ([081dc23](https://github.com/susomejias/rembric/commit/081dc23749a1031ed5e6371744eb9e07ed1764b9))
- **plugin:** curl-pipe-sh install for opencode + README supported-agents grid ([#58](https://github.com/susomejias/rembric/issues/58)) ([52eddf2](https://github.com/susomejias/rembric/commit/52eddf20f52bfa83e22424c0343f2f80619624a6))

## [0.15.1](https://github.com/susomejias/rembric/compare/v0.15.0...v0.15.1) (2026-05-18)

### Documentation

- add admin dashboard screenshots section to README ([#53](https://github.com/susomejias/rembric/issues/53)) ([b6869f4](https://github.com/susomejias/rembric/commit/b6869f45f114967c45a9358fe13c1e8ab2fc8686))
- replace git clone with curl in Docker Quickstart ([#51](https://github.com/susomejias/rembric/issues/51)) ([12d4193](https://github.com/susomejias/rembric/commit/12d4193c5ce3877ee18efcb8783750211f348850))

## [0.15.0](https://github.com/susomejias/rembric/compare/v0.14.2...v0.15.0) (2026-05-18)

### Features

- initial public release of Rembric ([b161006](https://github.com/susomejias/rembric/commit/b161006fce6ada0f3c3d04f92cc7b29300a0dcff))
