# Changelog

## [0.3.1](https://github.com/susomejias/rembric/compare/v0.3.0...v0.3.1) (2026-05-14)


### Bug Fixes

* **mcp:** resolve router-activated project in memory.* handlers ([7b5dd3d](https://github.com/susomejias/rembric/commit/7b5dd3d0dfc822391890074c08178a295a5f03cc))


### Documentation

* **agents:** broaden setup coverage + memory protocol snippet ([dff71d5](https://github.com/susomejias/rembric/commit/dff71d5722e2e7f1d59cc274b63b00794cc40f2f))

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
