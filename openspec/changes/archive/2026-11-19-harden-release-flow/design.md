## Context

Two release-please components (`server`, `plugin`) release independently through separate release PRs that share one manifest file, and one workflow both mints tags and publishes (Docker for `server`, npm for `plugin`).

## Decisions

### D1. `always-update` instead of a combined PR or per-component manifests

`always-update` is release-please's own switch for "pull requests must not be out-of-date with the base branch". With it, `createOrUpdatePullRequest` updates the existing PR on every run instead of returning early when the body is unchanged, and the update recreates the branch from `main` and rewrites only that component's manifest key. It keeps independent releases and changes one line.

- _Alternative: `separate-pull-requests: false`._ No conflict, but one merge would release every component with pending changes, which the two-track model rules out.
- _Alternative: one manifest per component (two release-please invocations)._ Removes the shared file, at the cost of two configs and a second action run; upstream support for it is still open work.

### D2. Serialize tag-minting per job, publishing per publish job

The guard exists so a second merge never cancels the first run's tag-minting, which happens in the `release-please` job. Scoping it there keeps that guarantee and stops a running publish from holding the next release. `publish-docker` gets its own serial group because `docker-publish.yml`'s internal group is keyed by tag, so without it two different server releases could publish concurrently and race the `latest` tag; `publish-npm` gets one for the same reason. Both publish groups set `queue: max` (up to 100 pending, first-in-first-out, never replaced). Without it the default `single` mode replaces a pending job with the next one: at workflow level that cost nothing, because a replaced run had not tagged yet and the next run tags any merged release PR; at job level the replaced job would be the publish of a release that is already tagged, which nothing re-runs. The `release-please` job keeps the default, since a replaced pending tagging job loses nothing.

### D3. Confirm availability with the existing check

The wait reuses `isPublished`, which already requires the exact version and its provenance attestation, polling every 15 seconds for up to 15 minutes. It runs inside `publish-npm`, which no longer blocks other jobs, so the wait costs nothing to the next release.

### D4. Anchor `server` on the repository root, not on `apps/web`

release-please attributes a commit to a component by the paths it touches. Anchored on `apps/web`, a `feat` or `fix` that changed only `packages/core`, `packages/db` or `packages/mcp` released nothing and was left out of the changelog of the release that eventually shipped it: since August, 28 of the 81 `feat`, `fix` and `perf` commits touching the server's packages touched no file under `apps/web`. The root path `.` is release-please's documented way to release on any change, and `exclude-paths` carves out the other component and the directories the image is not built from. The channel does not move: component name, tag prefix, changelog file and the version the server reads are unchanged, and `apps/web/package.json` becomes an `extra-files` carrier, which from the root is an ordinary downward path. Alternatives: a workspace plugin with one component per package, rejected because it is the cascade model this repository retired; leaving the anchor and forcing a publish by hand, rejected because the changelog stays wrong. The action emits a root component's outputs unprefixed, so the Docker publish gate reads `release_created` instead of a per-path key.

## Risks / Trade-offs

- [Risk] A config key without a matching manifest key re-bootstraps the component at `0.0.0` → both keys move in one commit and a guard test asserts the key sets are equal; a dry run of release-please against the branch is recorded in the pull request.
- [Risk] The first release after the move lists every releasable commit since the last tag that the old anchor ignored → intended: those commits shipped without a changelog entry.
- [Trade-off] `exclude-paths` cannot name a single file, so a `feat` or `fix` touching only a root-level file releases the server → rare, and harmless.

- [Risk] `always-update` cannot be exercised before a real release (the owner chose local verification over a sandbox repository) → it is release-please's documented option, verified in its source; the first release with two open PRs is the live check, and the manual path remains available.
- [Trade-off] Release PR branches are force-rebuilt on every push to `main` → they are release-please's branches; nothing in the repository commits to them.
