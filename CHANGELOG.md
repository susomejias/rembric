# Changelog

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
