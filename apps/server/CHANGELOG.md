# Changelog

## [0.21.12](https://github.com/susomejias/rembric/compare/server-v0.21.11...server-v0.21.12) (2026-06-14)


### Features

* **dashboard:** surface review state on /dashboard/memories ([#149](https://github.com/susomejias/rembric/issues/149)) ([7b3ea4e](https://github.com/susomejias/rembric/commit/7b3ea4eb2bd192dcf2466d436b2e153c22e18b57))
* **mcp:** trim memory.context default list sizes ([#142](https://github.com/susomejias/rembric/issues/142)) ([7a8edfd](https://github.com/susomejias/rembric/commit/7a8edfd51b9f62dbda8390fe03e44e3ee5d13c79))
* **memory:** derived review state (needs_review) axis ([#141](https://github.com/susomejias/rembric/issues/141)) ([f0f4347](https://github.com/susomejias/rembric/commit/f0f4347dc408366f8798ab08be5e24fa3de42df3))

## [0.21.11](https://github.com/susomejias/rembric/compare/server-v0.21.10...server-v0.21.11) (2026-06-13)


### Features

* **mcp:** add memory.about update-guidance tool ([#129](https://github.com/susomejias/rembric/issues/129)) ([0a57244](https://github.com/susomejias/rembric/commit/0a572448fa45dee149de7d1a05d85515ff6f8cd5))

## [0.21.10](https://github.com/susomejias/rembric/compare/server-v0.21.9...server-v0.21.10) (2026-06-13)


### Features

* **plugin:** unified TUI installer for server + all clients ([#122](https://github.com/susomejias/rembric/issues/122)) ([3be359a](https://github.com/susomejias/rembric/commit/3be359aec1cc97a1d1623b30db76212a82fb2d59))

## [0.21.9](https://github.com/susomejias/rembric/compare/server-v0.21.8...server-v0.21.9) (2026-06-08)


### Features

* **server:** expose session title in memory.context ([#120](https://github.com/susomejias/rembric/issues/120)) ([8becbbd](https://github.com/susomejias/rembric/commit/8becbbd18c053836126510eb8198f205955a99cf))

## [0.21.8](https://github.com/susomejias/rembric/compare/server-v0.21.7...server-v0.21.8) (2026-06-07)


### Features

* **server:** rename memory.get_session → memory.session_get (+ docs) ([#118](https://github.com/susomejias/rembric/issues/118)) ([2a9958d](https://github.com/susomejias/rembric/commit/2a9958df9885b9da9c6717eefeda2a38b9514b04))

## [0.21.7](https://github.com/susomejias/rembric/compare/server-v0.21.6...server-v0.21.7) (2026-06-07)


### Features

* **server:** bound memory.context snippets + server-side summary cap & memory.get_session ([#116](https://github.com/susomejias/rembric/issues/116)) ([2572a81](https://github.com/susomejias/rembric/commit/2572a81c84ea6cf54c9a968118e8b7d9102966ea))

## [0.21.6](https://github.com/susomejias/rembric/compare/server-v0.21.5...server-v0.21.6) (2026-06-07)


### Refactor

* **server:** extract repository layer (confine all SQL to src/db/) ([#114](https://github.com/susomejias/rembric/issues/114)) ([b8f68c2](https://github.com/susomejias/rembric/commit/b8f68c24d0408573aee0b35d2264e31011be8ba2))

## [0.21.5](https://github.com/susomejias/rembric/compare/server-v0.21.4...server-v0.21.5) (2026-06-07)


### Features

* **server:** align consolidation dashboard with the deterministic sweep ([#111](https://github.com/susomejias/rembric/issues/111)) ([dcc8299](https://github.com/susomejias/rembric/commit/dcc829937821ff8a812d4349364ddd14c98d69f7))

## [0.21.4](https://github.com/susomejias/rembric/compare/server-v0.21.3...server-v0.21.4) (2026-06-07)


### Features

* **server:** manual update check from the dashboard ([#109](https://github.com/susomejias/rembric/issues/109)) ([88321fe](https://github.com/susomejias/rembric/commit/88321fe065ead06eb549c3c8b1d56fc89f8b80e8))

## [0.21.3](https://github.com/susomejias/rembric/compare/server-v0.21.2...server-v0.21.3) (2026-06-06)


### Features

* **server:** drop dashboard table id columns and sort active sessions first ([#107](https://github.com/susomejias/rembric/issues/107)) ([cc84a2b](https://github.com/susomejias/rembric/commit/cc84a2bd233cf7e147c3bbaad84799de95a0a084))

## [0.21.2](https://github.com/susomejias/rembric/compare/server-v0.21.1...server-v0.21.2) (2026-06-06)


### Features

* **server:** one-click self-update from the dashboard ([#106](https://github.com/susomejias/rembric/issues/106)) ([ad152db](https://github.com/susomejias/rembric/commit/ad152db139cc28f4660506b74ed432635381238c))
* **server:** show server version in dashboard brand ([#104](https://github.com/susomejias/rembric/issues/104)) ([168220c](https://github.com/susomejias/rembric/commit/168220c99e5fe0ac0a96afe540bbc566ae9a2937))

## [0.21.1](https://github.com/susomejias/rembric/compare/server-v0.21.0...server-v0.21.1) (2026-06-05)


### Bug Fixes

* **server:** retry model bake on HF 429 + optional hf_token build secret ([#101](https://github.com/susomejias/rembric/issues/101)) ([36b3b5c](https://github.com/susomejias/rembric/commit/36b3b5c09c599699388e973f3527f3fb3514bd01))

## [0.21.0](https://github.com/susomejias/rembric/compare/server-v0.20.1...server-v0.21.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* **server:** env vars OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL, EMBEDDING_PROVIDER, EMBEDDING_ENABLED, CANDIDATE_VEC_THRESHOLD and CANDIDATE_FTS_THRESHOLD are removed (ignored with the boot warning). memory.doctor embeddings block is now { model, backlog }. Embeddings are always on: lazy in-process model (ONNX q8, 768 dims), model-identity marker wipes stale vectors and the drain re-embeds resumably; similarity thresholds become engine constants (vec 0.70 sandbox-calibrated, distribution telemetry on drain).
* **server:** env vars LLM_PROVIDER, OPENAI_MODEL, CONSOLIDATION_ENABLED, CONSOLIDATION_CRON and CONSOLIDATION_BATCH_SIZE are removed (ignored with a boot warning). memory.doctor drops the llm block. Decay + pending-relation orphaning now run as a throttled deterministic sweep on session start; aged pendings surface in memory.context.pendingJudgments[] for agent-side memory.judge, and are orphaned after JUDGMENT_ORPHAN_DEADLINE_MS (14d).

### Features

* **server:** deterministic consolidation — remove chat LLM and cron ([#97](https://github.com/susomejias/rembric/issues/97)) ([b43fbdb](https://github.com/susomejias/rembric/commit/b43fbdb1783cca3486013576d8acd30461f621dd))
* **server:** in-process embeddings — gte-multilingual-base baked into the image ([#99](https://github.com/susomejias/rembric/issues/99)) ([70a0915](https://github.com/susomejias/rembric/commit/70a0915b00adfc0aa2f3c33c8b378b360262b17a))

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
