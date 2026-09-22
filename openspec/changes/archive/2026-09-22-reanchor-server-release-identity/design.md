## Context

release-please runs in manifest mode with two packages (`apps/server` → component `server`, `apps/plugin` → component `plugin`). For the `server` component the company keeps the release **channel**: the tag is `server-v<version>`, `release-please.yml` gates `publish-docker` on that component's release, and the published image tags and updater label derive from it. The Next.js port has already moved the published artifact to `apps/web` (`publish-web-runtime-image`), and P8 will delete `apps/server` entirely. So the version anchor has to move off the app being deleted without moving the channel.

## Decisions

### D1 — Re-anchor the `server` component on `apps/web`, not a new neutral package

The component's `path` also decides **which commits trigger a release**: release-please attributes a release to the component whose path holds the changed files. Once `apps/web` is the shipped app, a fix under `apps/web/` must trigger the server release — a constraint a path-independent anchor cannot satisfy.

- **Chosen: move the `server` package key to `apps/web`.** One config key and one manifest key move; the channel is untouched.
- **Rejected: keep `apps/server` and add `apps/web/package.json` as `extra-files`.** `extra-files` are component-relative and release-please rejects a `..` segment, and the spec forbids the leading-slash escape hatch; worse, the component's `path` is still `apps/server`, so an `apps/web`-only commit would not trigger the release at all — the version would move only when something unrelated did.
- **Rejected: a dedicated neutral package (e.g. `packages/release-identity`).** Adds a workspace member to hold a one-line manifest, still leaves `apps/web` commits unable to trigger the release, and introduces a second source of truth for the same number.

### D2 — Keep `component: server`; move only the path and `package-name`

The component name is the channel: it sets the tag prefix `server-v*`, and the Docker image, the updater's `rembric.stage=runtime` prune filter and the operator's `docker pull <version>` all key off that line. Renaming the component to `web` would change the tag prefix and split the release line. `package-name` only labels the manifest release-please reads, so it follows the path to `@rembric/web`. `include-component-in-tag`, `include-v-in-tag`, `release-type`, `changelog-path`, the pre-major flags and `changelog-sections` stay byte-identical.

### D3 — The manifest key rename is the anti-bootstrap guard

Manifest mode matches each configured package to its version by **directory path**. If the config key becomes `apps/web` while the manifest still keys `apps/server`, release-please sees `apps/web` with no recorded version and treats it as a first release: it opens a PR bumping from an implied `0.0.0` rather than `0.28.8 → 0.28.9`, and the tag it would mint is `server-v0.x.0`, not the next patch. Both keys therefore change in the same commit, and the guard test asserts the two key sets are equal. The probe recorded in `tasks.md` reproduces this failure with the old path plus a new-keyed manifest as its control.

### D4 — Deterministic Dockerfile copy plus a build gate, replacing the tracing include

The old mechanism was a Next `outputFileTracingIncludes` glob reaching `../../apps/server/package.json`. It worked, but it coupled the shipped release identity to the tracer's resolution of a foreign app's manifest — and its referenced app is being deleted. The replacement is explicit: the runner stage copies `apps/web/package.json` into the standalone tree at the path `lib/version.ts` walks up to, and the build gates assert the file exists and its version is a non-`0.0.0` semver. A bootstrap version reaching the image now fails the build loudly instead of making the brand report a version that is not running.

### D5 — Correct the `publish-web-runtime-image` persistence delta in place

That change is unarchived and its persistence delta asserts the runtime image carries `apps/server/package.json` and nothing else from the server app. This change removes exactly that behavior, so the sentence is corrected in the owning change rather than duplicated as a second persistence delta here (which would collide at archive time).

## Risks / Trade-offs

- [Risk] A config/manifest key mismatch silently re-bootstraps the component at `0.0.0` → Mitigation: `scripts/release-please-reanchor.test.ts` asserts config keys ≡ manifest keys, and the probe's failing control demonstrates the mismatch is detectable.
- [Risk] The published image reports `0.0.0` because the manifest never reaches the standalone tree → Mitigation: the Dockerfile's deterministic COPY plus a build gate that exits non-zero on a missing file or a `0.0.0`/non-semver version, and `lib/version.ts` keeps the compose-pin fallback for a pinned deployment.
- [Risk] The tag prefix or the publish trigger drifts with the path → Mitigation: `component: server` and `include-component-in-tag`/`include-v-in-tag` are asserted unchanged by the guard test's scope and confirmed by the probe (tag `server-v0.28.9`).
- [Risk] The workflow forwards an output key for a path no longer in the manifest → Mitigation: the guard test asserts every `<path>--<output>` reference in `release-please.yml` names a declared component path.
- [Trade-off] `apps/server/package.json` stays a workspace member and is still copied by the web Dockerfile's builder stage → Accepted: pnpm's filtered install resolves the whole lockfile graph and fails on a missing member manifest; dropping the copy is P8.3, once the app is gone.
- [Trade-off] The version number is `0.28.8` in `apps/web/package.json` before any release runs → Accepted: it mirrors the value the manifest already holds, so the next release computes `0.28.9`; leaving it at `0.0.0` would be the bootstrap the guard exists to prevent.
