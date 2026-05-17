# Changelog

## [0.14.1](https://github.com/susomejias/rembric/compare/v0.14.0...v0.14.1) (2026-05-17)


### Bug Fixes

* **dashboard:** respect spacing between Abandon and Delete buttons ([6ca936e](https://github.com/susomejias/rembric/commit/6ca936e54b55fc9ce03cd36e04af9de28b48c5fc))

## [0.14.0](https://github.com/susomejias/rembric/compare/v0.13.0...v0.14.0) (2026-05-17)


### ⚠ BREAKING CHANGES

* the `rembric` CLI no longer exists. Any scripts invoking `docker compose exec rembric rembric <subcommand>` will fail. Migration: use the dashboard for interactive ops, MCP tools (project.*, memory.*) for programmatic agent ops, or the HTTP /admin/* and /api/<slug>/* endpoints for shell scripts. The @susomejias/rembric npm package will not receive further releases; pull

### Features

* **dashboard:** allow operators to abandon active sessions ([d06fe03](https://github.com/susomejias/rembric/commit/d06fe03162edf7141a4f42e17a44f6ced3c46163))
* **docker:** add one-command dev stack with hot-reload + auto-seed ([206330c](https://github.com/susomejias/rembric/commit/206330c9a02666334a8f5b2dfe50500bf2c700ce))
* remove operator CLI and npm distribution; consolidate on Docker ([1ed39ce](https://github.com/susomejias/rembric/commit/1ed39ceb75bc558e9ed3a18bd7f0dc1d2029f1d6))


### Bug Fixes

* **dashboard:** fall back to src/dashboard/public when dist/ is absent ([c18603a](https://github.com/susomejias/rembric/commit/c18603a9ee6f4cb6661f936684e34111fa05c956))
* **docker:** publish port on all interfaces by default ([075becc](https://github.com/susomejias/rembric/commit/075becc29fb3d3522a85f815cdf4fc7df45817e0))

## [0.13.0](https://github.com/susomejias/rembric/compare/v0.12.1...v0.13.0) (2026-05-17)

### ⚠ BREAKING CHANGES

- **docker:** GET /healthz now requires Authorization: Bearer <token>. Hermes plugin must be on 0.6.0+ to keep is_available() returning true against Rembric 0.13.0+. Claude Code / Codex hooks unaffected (they never called /healthz directly).

### Features

- **docker:** make Docker the canonical distribution + harden /healthz ([7f9da83](https://github.com/susomejias/rembric/commit/7f9da838ec197d5ed37de2e69da821c5751bac7a))

## [0.12.1](https://github.com/susomejias/rembric/compare/v0.12.0...v0.12.1) (2026-05-17)

### Bug Fixes

- **dashboard:** exclude soft-deleted sessions from active-session counter ([ba693ce](https://github.com/susomejias/rembric/commit/ba693ce5c0f33b70f89b4bc9636572358ae730d0))

## [0.12.0](https://github.com/susomejias/rembric/compare/v0.11.0...v0.12.0) (2026-05-17)

### ⚠ BREAKING CHANGES

- **dashboard:** refresh presentation layer

### Features

- **dashboard:** refresh presentation layer ([388f7d6](https://github.com/susomejias/rembric/commit/388f7d6a8f61e119934ff4354013410f9fc54319))

### Documentation

- **claude:** explain judgments-vs-relations naming boundary ([a867d11](https://github.com/susomejias/rembric/commit/a867d1108314b3f7fab38e2284f0688d2d7497ab))
- **openspec:** archive refresh-dashboard-presentation ([b91348c](https://github.com/susomejias/rembric/commit/b91348c5c8362788555273f72caa12d10f453f14))

## [0.11.0](https://github.com/susomejias/rembric/compare/v0.10.1...v0.11.0) (2026-05-16)

### Features

- **dashboard:** add /maintenance with operator-triggered physical purges ([8475844](https://github.com/susomejias/rembric/commit/84758444e1432673935090c974128ecc6899bd0c))

### Bug Fixes

- **dashboard:** resolve DB file path so DB SIZE is shown in production ([522ff32](https://github.com/susomejias/rembric/commit/522ff3237b7b3c81342f2e2dfe1189ec34d6b717))
- **hermes:** on_session_switch closes the cached session on /reset too ([dd547b6](https://github.com/susomejias/rembric/commit/dd547b6c0564095441c1097ae07c539d8212d62e))

## [0.10.1](https://github.com/susomejias/rembric/compare/v0.10.0...v0.10.1) (2026-05-16)

### Bug Fixes

- **plugin:** split transcript parser per agent (claude_code vs codex_cli) ([86fa83f](https://github.com/susomejias/rembric/commit/86fa83fa65850504469cb45cd40d1763dc139eb7))

## [0.10.0](https://github.com/susomejias/rembric/compare/v0.9.0...v0.10.0) (2026-05-16)

### ⚠ BREAKING CHANGES

- **sessions:** persist summary+title across all plugin clients

### Bug Fixes

- **sessions:** persist summary+title across all plugin clients ([274fe1c](https://github.com/susomejias/rembric/commit/274fe1c7efc49493244459a46b038457f9a5c977))

### Refactor

- **hermes:** use requires_env so ~/.hermes/.env is single source of truth ([bc64d7e](https://github.com/susomejias/rembric/commit/bc64d7e150865beb725efc13d4cbb5ee2324d24d))

### Documentation

- **hermes:** lead with ~/.rembric/.env to avoid silent session loss ([88bd3f1](https://github.com/susomejias/rembric/commit/88bd3f17dd763ad2c16a522ea54dd1df668c89ea))

## [0.9.0](https://github.com/susomejias/rembric/compare/v0.8.2...v0.9.0) (2026-05-16)

### Features

- **dashboard:** swap sidebar brand bullet for transparent logo ([4529316](https://github.com/susomejias/rembric/commit/4529316e154329cbadf520f9ceb1c0a716306346))
- **plugin:** add Hermes Agent memory provider ([93aae7f](https://github.com/susomejias/rembric/commit/93aae7f38ee58198e9977dec4001a09c6dcd1d1c))

### Bug Fixes

- **codex:** drop leading [ from hook stdout so looks_like_json passes ([0cc9f73](https://github.com/susomejias/rembric/commit/0cc9f73bcc8a70d5fe01f50ee06431e3f8916a27))
- **codex:** restore bridge path-scoping via PWD fallback ([f1313bd](https://github.com/susomejias/rembric/commit/f1313bd9a834ba62336211a936ec4ca5a3c96dbd))

### Documentation

- **codex:** add hook enablement note to root README too ([e2c59a1](https://github.com/susomejias/rembric/commit/e2c59a1107587f85330f4bda1bb1122b07598d87))
- **codex:** document plugin_hooks feature flag + /hooks trust review ([f077d2b](https://github.com/susomejias/rembric/commit/f077d2bd4798d92b9f8dcdbf87637f5346492a21))

## [0.8.2](https://github.com/susomejias/rembric/compare/v0.8.1...v0.8.2) (2026-05-15)

### Bug Fixes

- **codex:** split MCP config per client; use cwd + env_vars ([2d8c54f](https://github.com/susomejias/rembric/commit/2d8c54f3aa05ec1eb1f182babf99c3291f5b3f6d))

## [0.8.1](https://github.com/susomejias/rembric/compare/v0.8.0...v0.8.1) (2026-05-15)

### Bug Fixes

- **codex:** use HTTPS for marketplace plugin source ([46c3efe](https://github.com/susomejias/rembric/commit/46c3efe54d7039928a42cfca3397d4ea9261ea8c))

### Documentation

- recommend HTTPS marketplace URL for both clients ([391a77f](https://github.com/susomejias/rembric/commit/391a77f6abe442441b707c26b4263b85a720d499))

## [0.8.0](https://github.com/susomejias/rembric/compare/v0.7.0...v0.8.0) (2026-05-15)

### Features

- **dashboard:** brutalist redesign with layered design system ([c159dd0](https://github.com/susomejias/rembric/commit/c159dd0d36e9d0ab0dc227774f7d50fd36f5acee))
- **dashboard:** render timestamps in viewer-local timezone ([f3e2ab3](https://github.com/susomejias/rembric/commit/f3e2ab3f026ed6b95be66d6b9a3eabce84504834))

### Documentation

- add Rembric banner image referenced by README ([ca1dbf5](https://github.com/susomejias/rembric/commit/ca1dbf50c81b335f71f020a3e79d5a824d27dd0e))
- **design:** add Google-spec DESIGN.md + dashboard-ui skill ([ad0d0e1](https://github.com/susomejias/rembric/commit/ad0d0e193046885af6ee0ed908ea0d25023c7241))
- document official plugin update flow + bump-version rule ([d507f65](https://github.com/susomejias/rembric/commit/d507f65371cf7bc9a6881c02b5fc7c4068e3fa78))

## [0.7.0](https://github.com/susomejias/rembric/compare/v0.6.0...v0.7.0) (2026-05-15)

### Features

- **plugin:** hooks read credentials via user_config substitution ([c18c912](https://github.com/susomejias/rembric/commit/c18c912696e7c9f294c1646ae31cd8158fbe6330))

### Bug Fixes

- **plugin:** hook scripts now reach the API and stamp the agent ([2b32096](https://github.com/susomejias/rembric/commit/2b3209691e4baf2ce3240869fd0b5940cea3d5ce))
- **plugin:** revert user_config substitution in hooks.codex.json ([4c6fe2f](https://github.com/susomejias/rembric/commit/4c6fe2ff210a8e7f389a2903da7c13f3bea4c43c))

### Documentation

- document required shell envs for plugin hooks ([a43fa3c](https://github.com/susomejias/rembric/commit/a43fa3cdbfe3d6dd2bcb1ad2b739259fe598c0b8))
- spell out the dual-client credential setup explicitly ([25f579f](https://github.com/susomejias/rembric/commit/25f579f9aad045f3fceb89081537f8bc8170bc32))

## [0.6.0](https://github.com/susomejias/rembric/compare/v0.5.0...v0.6.0) (2026-05-15)

### Features

- **mcp:** attach memories to most-recent active session ([9e2f89f](https://github.com/susomejias/rembric/commit/9e2f89f6c538b555d15669831fad7fd9423a1c3b))
- **plugin:** drive session lifecycle via HTTP hooks ([a78971a](https://github.com/susomejias/rembric/commit/a78971a1e1a6f03ec0bdcd54ee4932c205ce6b44))
- **server:** expose /api/&lt;slug&gt;/sessions HTTP endpoints ([37a0c43](https://github.com/susomejias/rembric/commit/37a0c43e513d5734b3ddb2a93b41f18dfba4e055))

### Documentation

- document HTTP-driven session lifecycle ([b92a04e](https://github.com/susomejias/rembric/commit/b92a04e5be5f8b16d4528042499ecf685c84edfb))

## [0.5.0](https://github.com/susomejias/rembric/compare/v0.4.0...v0.5.0) (2026-05-15)

### Features

- **plugin:** add Codex marketplace, manifest, and hooks ([08aac16](https://github.com/susomejias/rembric/commit/08aac16e4fe3a046b0605082f79033a40c8701f0))
- **plugin:** switch slug source to .rembric dotenv (PROJECT_SLUG=) ([cda7fd9](https://github.com/susomejias/rembric/commit/cda7fd9589a5f003a862f9aa6993ba08aa021023))

### Documentation

- pivot Codex install to plugin marketplace; codify plugin dev rules ([8d67ddb](https://github.com/susomejias/rembric/commit/8d67ddb6dad73f71ec00c879a31360af5577708e))
- slim README and docs, recommend plugin, drop examples/ ([802f39e](https://github.com/susomejias/rembric/commit/802f39e02935e7953199e5ddda77993c5fce4b66))

## [0.4.0](https://github.com/susomejias/rembric/compare/v0.3.3...v0.4.0) (2026-05-15)

### Features

- **plugin:** add Claude Code plugin with stdio bridge ([25c31c8](https://github.com/susomejias/rembric/commit/25c31c83e6ec6046e90ea384dd0b0f3b146c53bb))

### Bug Fixes

- **mcp:** scopeFromContext consults router for path-less /mcp connections ([70fcb74](https://github.com/susomejias/rembric/commit/70fcb7449594a6b8728d727f86f1034c39111e31))

## [0.3.3](https://github.com/susomejias/rembric/compare/v0.3.2...v0.3.3) (2026-05-14)

### Bug Fixes

- **mcp:** drop eager oninitialized roots discovery, shorten timeout ([36e136e](https://github.com/susomejias/rembric/commit/36e136e202e971b0e272be11cdddde17802264f4))

## [0.3.2](https://github.com/susomejias/rembric/compare/v0.3.1...v0.3.2) (2026-05-14)

### Bug Fixes

- **mcp:** eager roots discovery so first memory.save resolves project ([1379c93](https://github.com/susomejias/rembric/commit/1379c937b090649f2b0161047ed65193064486c5))

### Documentation

- add CLAUDE.md for Claude Code guidance ([bae431e](https://github.com/susomejias/rembric/commit/bae431ee38ab6090a1150dfbecf186a7d580e9e6))

## [0.3.1](https://github.com/susomejias/rembric/compare/v0.3.0...v0.3.1) (2026-05-14)

### Bug Fixes

- **mcp:** resolve router-activated project in memory.\* handlers ([7b5dd3d](https://github.com/susomejias/rembric/commit/7b5dd3d0dfc822391890074c08178a295a5f03cc))

### Documentation

- **agents:** broaden setup coverage + memory protocol snippet ([dff71d5](https://github.com/susomejias/rembric/commit/dff71d5722e2e7f1d59cc274b63b00794cc40f2f))

## [0.3.0](https://github.com/susomejias/rembric/compare/v0.2.1...v0.3.0) (2026-05-14)

### Features

- **cli:** rembric project create/list + session delete + --include-deleted ([dce9898](https://github.com/susomejias/rembric/commit/dce9898a46e096c20c04bb9d8696995c2e41172b))
- **dashboard:** project create form + session Delete/Undelete UI ([864fe20](https://github.com/susomejias/rembric/commit/864fe202715d838ffdfa3346384253d1dae57da0))
- **mcp:** project_suggestion_pending gate + session_deleted rejection ([36e29d5](https://github.com/susomejias/rembric/commit/36e29d5b9e37b2c9338baa8f7fab1c3b6ba651ba))
- **persistence:** sessions.deleted_at + soft-delete service API ([2f08b7d](https://github.com/susomejias/rembric/commit/2f08b7dd1b8e4cce530f97c36cc558122c1f8102))

### Documentation

- agents.md guidance + README CLI table + sessions.deleted_at on diagram ([92acbf7](https://github.com/susomejias/rembric/commit/92acbf76ca80bb009b588c21d802368f42c055bb))

## [0.2.1](https://github.com/susomejias/rembric/compare/v0.2.0...v0.2.1) (2026-05-14)

### Bug Fixes

- **test:** handle whitespace-only fast-check inputs in save-time property ([26de8b3](https://github.com/susomejias/rembric/commit/26de8b35a65c1c20a085330081677c20bd14b645))

## [0.2.0](https://github.com/susomejias/rembric/compare/v0.1.0...v0.2.0) (2026-05-14)

### Features

- **cli:** rembric session list + status sessions count + slug refactor ([8a5d7a1](https://github.com/susomejias/rembric/commit/8a5d7a193b886ca2488ed1d5e343bee2e468cd36))
- **consolidation:** two-pass runner + orphan-promotion + journal ([601e682](https://github.com/susomejias/rembric/commit/601e6820ec71c06228e22876e8b5d1487dd1ec60))
- **dashboard:** /dashboard/relations list + CSRF-protected orphan controls ([4d02a9f](https://github.com/susomejias/rembric/commit/4d02a9f23769aafbc43b4072fcfd8fa3b0574e9a))
- **dashboard:** /dashboard/sessions list+detail, slug rename, stat card ([a4739ad](https://github.com/susomejias/rembric/commit/a4739adf621c5c381abb59b4d74eb685a4bef925))
- **dashboard:** serve static assets under /dashboard/assets/ ([6fb0f4e](https://github.com/susomejias/rembric/commit/6fb0f4e7b6eb17875d664b1d53930b2c0b966e0e))
- **mcp:** relations tools + topic_key suggest + save annotations ([2173376](https://github.com/susomejias/rembric/commit/217337673bb845813e4465e2f8d1be9bba0a040a))
- **mcp:** session lifecycle + research + project tools + instructions + roots ([e38212d](https://github.com/susomejias/rembric/commit/e38212ddfd93cc92975e0e5cdbb5b2948932cc92))
- **persistence:** memory_relations table + topic_key column ([d61c3a4](https://github.com/susomejias/rembric/commit/d61c3a457e676c776a34b068e0d09694615bc6e8))
- **persistence:** slug-only project identity + sessions/prompts tables ([6bcb9ba](https://github.com/susomejias/rembric/commit/6bcb9ba729be2015bab9a795191969feed0af05f))
- **server:** add per-token rate limiter, admin consolidation endpoint, and CLI run-now ([b076733](https://github.com/susomejias/rembric/commit/b0767338cb0e59cd735d9cd8964a650e285a90af))
- **services:** relations + save-time candidates + topic_key upsert ([9803f11](https://github.com/susomejias/rembric/commit/9803f11491090cf560be0bc52ee756d6582dda34))

### Bug Fixes

- **test:** packaging test no longer requires pre-built dist/ ([41aa14c](https://github.com/susomejias/rembric/commit/41aa14cc18f8c17c76919ed96f9c560c0fd3146e))

### Documentation

- add agent integration, backup, and troubleshooting guides ([e34b1b7](https://github.com/susomejias/rembric/commit/e34b1b7aa989c79949429f44fed83500e0ccd687))
- full tool surface in agents.md, troubleshooting for session_summary ([945f7c6](https://github.com/susomejias/rembric/commit/945f7c6c1989b77b5c6409fc0bcbeb75930bf72a))
- relations taxonomy + README save→judge flow + agents/troubleshooting ([fdf4070](https://github.com/susomejias/rembric/commit/fdf40708cb38591add3a36d559a8692c7ca3d3a3))

## 0.1.0 (2026-05-13)

### ⚠ BREAKING CHANGES

- MemoryService method signatures now require a Scope argument. Any external consumer importing the service directly must pass it. The MCP and CLI surfaces are unaffected behaviourally beyond the bug fix (cross-scope reads are now properly walled off).
- existing clients that relied on a path-scoped connection emitting global writes or returning globals in search will now fail with `scope_locked` / no longer receive globals. To write globals or search across them, open a separate unscoped connection at /mcp.

### Features

- initial release of Rembric v0 ([34bbc6e](https://github.com/susomejias/rembric/commit/34bbc6ee111f7604d8fa9331a56d62728c7c1343))
- lock MCP project scope when path-scoped ([caa7ffc](https://github.com/susomejias/rembric/commit/caa7ffcbda0eb2e1433092c8354f25901faa0e0d))
- scope-required services + slug-friendly auth + dashboard pages ([9d5aaa3](https://github.com/susomejias/rembric/commit/9d5aaa3f6912e5529a5b0eb7a5f42f5c45ffd8c8))

### Bug Fixes

- **install:** declare native build deps in package.json ([24df878](https://github.com/susomejias/rembric/commit/24df8784fe5c46f7e9c97a935529f1ba0c3e4e2f))

### Chore

- relaunch as 0.x pre-stable baseline ([a8cc373](https://github.com/susomejias/rembric/commit/a8cc373416d1d28c8e8f409c8b037a3cde8257d7))

## [3.0.1](https://github.com/susomejias/rembric/compare/v3.0.0...v3.0.1) (2026-05-13)

### Bug Fixes

- **install:** declare native build deps in package.json ([24df878](https://github.com/susomejias/rembric/commit/24df8784fe5c46f7e9c97a935529f1ba0c3e4e2f))

## [3.0.0](https://github.com/susomejias/rembric/compare/v2.0.0...v3.0.0) (2026-05-13)

### ⚠ BREAKING CHANGES

- MemoryService method signatures now require a Scope argument. Any external consumer importing the service directly must pass it. The MCP and CLI surfaces are unaffected behaviourally beyond the bug fix (cross-scope reads are now properly walled off).

### Features

- scope-required services + slug-friendly auth + dashboard pages ([9d5aaa3](https://github.com/susomejias/rembric/commit/9d5aaa3f6912e5529a5b0eb7a5f42f5c45ffd8c8))

## [2.0.0](https://github.com/susomejias/rembric/compare/v1.0.0...v2.0.0) (2026-05-13)

### ⚠ BREAKING CHANGES

- existing clients that relied on a path-scoped connection emitting global writes or returning globals in search will now fail with `scope_locked` / no longer receive globals. To write globals or search across them, open a separate unscoped connection at /mcp.

### Features

- lock MCP project scope when path-scoped ([caa7ffc](https://github.com/susomejias/rembric/commit/caa7ffcbda0eb2e1433092c8354f25901faa0e0d))

## 1.0.0 (2026-05-13)

### Features

- initial release of Rembric v0 ([34bbc6e](https://github.com/susomejias/rembric/commit/34bbc6ee111f7604d8fa9331a56d62728c7c1343))
