## Context

Two release-please components (`server`, `plugin`) release independently through separate release PRs that share one manifest file, and one workflow both mints tags and publishes (Docker for `server`, npm for `plugin`).

## Decisions

### D1. `always-update` instead of a combined PR or per-component manifests

`always-update` is release-please's own switch for "pull requests must not be out-of-date with the base branch". With it, `createOrUpdatePullRequest` updates the existing PR on every run instead of returning early when the body is unchanged, and the update recreates the branch from `main` and rewrites only that component's manifest key. It keeps independent releases and changes one line.

- _Alternative: `separate-pull-requests: false`._ No conflict, but one merge would release every component with pending changes, which the two-track model rules out.
- _Alternative: one manifest per component (two release-please invocations)._ Removes the shared file, at the cost of two configs and a second action run; upstream support for it is still open work.

### D2. Serialize tag-minting per job, publishing per publish job

The guard exists so a second merge never cancels the first run's tag-minting, which happens in the `release-please` job. Scoping it there keeps that guarantee and stops a running publish from holding the next release. `publish-docker` gets its own serial group because `docker-publish.yml`'s internal group is keyed by tag, so without it two different server releases could publish concurrently and race the `latest` tag; `publish-npm` gets one for the same reason. The per-group pending limit (one pending run; a newer one replaces it) is unchanged from today.

### D3. Confirm availability with the existing check

The wait reuses `isPublished`, which already requires the exact version and its provenance attestation, polling every 15 seconds for up to 15 minutes. It runs inside `publish-npm`, which no longer blocks other jobs, so the wait costs nothing to the next release.

## Risks / Trade-offs

- [Risk] `always-update` cannot be exercised before a real release (the owner chose local verification over a sandbox repository) → it is release-please's documented option, verified in its source; the first release with two open PRs is the live check, and the manual path remains available.
- [Trade-off] Release PR branches are force-rebuilt on every push to `main` → they are release-please's branches; nothing in the repository commits to them.
