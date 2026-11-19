## 1. Release PRs

- [x] 1.1 `always-update: true` in `release-please-config.json`, pinned by `scripts/release-workflow.test.ts`

## 2. Concurrency

- [x] 2.1 Job-scoped guard on `release-please`; own serial groups for `publish-docker` and `publish-npm`; workflow otherwise identical to `main` (YAML comparison)

## 3. npm availability

- [x] 3.1 `scripts/npm-publish.mjs` waits until the registry serves the version with provenance, bounded, with tests for the late, the provenance-late and the never-served cases

## 5. Server release anchor

- [x] 5.1 Anchor the `server` component on the repository root with `exclude-paths` for `apps/plugin` and the directories the image is not built from; keep `apps/web/CHANGELOG.md` and carry the version in `apps/web/package.json` through `extra-files`; rename the manifest key in the same commit
- [x] 5.2 Read the root component's unprefixed outputs in `release-please.yml` for the Docker publish gate
- [x] 5.3 Guard tests in `scripts/release-please-reanchor.test.ts`: the anchor, the carrier, the manifest keys, no excluded directory the Dockerfile copies, the gate's output source; mutation-checked
- [ ] 5.4 OPERATOR: after the merge, confirm the release PR release-please opens bumps `server` from the current version (not from `0.0.0`) and lists the package-only commits

## 4. Verification

- [x] 4.1 Mutation checks for every new guard
- [x] 4.2 Full local CI replica and independent verification
