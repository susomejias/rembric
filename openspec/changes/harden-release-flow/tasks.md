## 1. Release PRs

- [x] 1.1 `always-update: true` in `release-please-config.json`, pinned by `scripts/release-workflow.test.ts`

## 2. Concurrency

- [x] 2.1 Job-scoped guard on `release-please`; own serial groups for `publish-docker` and `publish-npm`; workflow otherwise identical to `main` (YAML comparison)

## 3. npm availability

- [x] 3.1 `scripts/npm-publish.mjs` waits until the registry serves the version with provenance, bounded, with tests for the late, the provenance-late and the never-served cases

## 4. Verification

- [x] 4.1 Mutation checks for every new guard
- [x] 4.2 Full local CI replica and independent verification
