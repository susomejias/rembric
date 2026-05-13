# Changelog

## [2.0.0](https://github.com/susomejias/rembric/compare/v1.0.0...v2.0.0) (2026-05-13)


### ⚠ BREAKING CHANGES

* existing clients that relied on a path-scoped connection emitting global writes or returning globals in search will now fail with `scope_locked` / no longer receive globals. To write globals or search across them, open a separate unscoped connection at /mcp.

### Features

* lock MCP project scope when path-scoped ([caa7ffc](https://github.com/susomejias/rembric/commit/caa7ffcbda0eb2e1433092c8354f25901faa0e0d))

## 1.0.0 (2026-05-13)


### Features

* initial release of Rembric v0 ([34bbc6e](https://github.com/susomejias/rembric/commit/34bbc6ee111f7604d8fa9331a56d62728c7c1343))
