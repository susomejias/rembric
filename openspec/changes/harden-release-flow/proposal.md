## Why

Releasing server 0.31.0 and plugin 0.41.0 on 2026-11-15 hit three problems in the release flow, each of which already happened before:

- **The second release PR conflicts and never recovers.** Both release PRs rewrite the shared `.release-please-manifest.json`. After the server PR merged, the run on that merge logged `PR …/pull/487 remained the same`: release-please only rebuilds an open release PR when its release notes change (`maybeUpdateExistingPullRequest`, `src/manifest.ts`), so the plugin PR stayed in conflict until it was resolved by hand — and resolving it with "Accept current change" reverts the server version, which is what produced the phantom release PR #380.
- **Publishing blocks the next release.** The `concurrency` guard sits at workflow level, so the plugin release run queued behind the server's Docker publish (about 10 minutes).
- **A publish is reported before it is available.** npm accepted `@rembric/mcp-bridge@0.41.0` and the job succeeded, but the registry served it about 8 minutes later. Clients that updated in between pinned a version `npx` could not fetch, and their MCP connection failed.

## What Changes

- `release-please-config.json` sets `"always-update": true`, release-please's documented option for keeping release PRs up to date with the base branch (`docs/manifest-releaser.md`), so each run rebuilds every open release PR from the current `main`. `separate-pull-requests` stays `true`: each component still releases on its own.
- `.github/workflows/release-please.yml` moves the `concurrency` guard from the workflow to the `release-please` job (same group, `cancel-in-progress: false`) and gives `publish-docker` and `publish-npm` their own serial groups. Tag-minting stays serialized; a publish in progress no longer queues the next release; two Docker publishes still never overlap.
- `scripts/npm-publish.mjs` waits after `npm publish` until the registry serves the exact version with its provenance attestation, for up to 15 minutes, and fails the step otherwise.

## What is lost

Nothing that works today. An open release PR's branch is now force-rebuilt by release-please on every push to `main`, so a manual commit pushed onto a release PR branch is discarded on the next run (the repository already treats release branches as release-please's own).

## Capabilities

### Modified Capabilities

- `open-source-distribution`: `always-update`, the job-scoped concurrency guard, and the registry confirmation after an npm publish.

## Impact

- `release-please-config.json`, `.github/workflows/release-please.yml`, `scripts/npm-publish.mjs`, `scripts/npm-publish.test.ts`, `scripts/release-workflow.test.ts` (new), `CLAUDE.md` (the release-track paragraph).
- No release, version or package content changes.
