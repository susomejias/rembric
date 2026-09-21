## Why

The release version identity is anchored on `apps/server` — the app the Next.js port is retiring (`odd/tasks/restore-main-dashboard-parity.md` P8) — while the published artifact is already `apps/web` (change `publish-web-runtime-image`). Two consumers read that anchor by path: release-please takes the `server` component's version from `apps/server/package.json` and bump-writes it there, and `apps/web/src/lib/version.ts` walks up to the same manifest so the dashboard brand prints the running release. The two agree today only because both name the doomed app. The moment `apps/server` is removed (P8.3) the chain breaks in a silent way: release-please finds no manifest at its configured path and treats the component as a first release at `0.0.0`, and the brand falls to its `0.0.0` sentinel. This change re-anchors the `server` component on `apps/web/package.json` while keeping the release **channel** byte-compatible, so an operator's `docker pull`, tag scheme and updater change nothing.

## What Changes

- **The `server` component's path moves from `apps/server` to `apps/web`** in both `release-please-config.json` and `.release-please-manifest.json`, with `package-name: @rembric/web` (the manifest it now reads). The component name stays `server`, `include-component-in-tag`/`include-v-in-tag` stay `true`, and every other config field is byte-identical — the tag prefix is still `server-vX.Y.Z`.
- **The channel is unchanged**: `publish-docker` still fires on the `server` component's release (the workflow's `server_release_created`/`server_tag_name` job outputs keep their names and only their per-path source moves to `apps/web--*`), the image tag scheme and the `rembric.stage=runtime` label are untouched, and the next release is `0.28.8 → 0.28.9`.
- **The manifest key rename is the anti-bootstrap guard.** Manifest-mode release-please matches a package to its manifest entry by directory path. Renaming the config key without renaming the manifest key would make `apps/web` look like a never-released component and open a release PR that bumps from zero. Config keys and manifest keys SHALL stay identical.
- **`apps/web/package.json` becomes the version `apps/server/package.json` held** (`0.0.0` → `0.28.8`), staying `private: true`, and `apps/server/CHANGELOG.md` moves to `apps/web/CHANGELOG.md` with no content edit so the component's release history continues under the same `changelog-path`.
- **`apps/web/src/lib/version.ts` reads `apps/web/package.json`** (`SERVER_MANIFEST` → `RELEASE_MANIFEST`); the docblock that described the cross-app read is rewritten.
- **The image carries that manifest deterministically.** `next.config.mjs` drops the runtime-tracing include that reached into `apps/server/package.json`; `apps/web/Dockerfile` copies `apps/web/package.json` into the standalone tree and gains a build gate that fails loudly on a missing file or a `0.0.0`/non-semver version, so an image can never silently report the sentinel.
- **The `publish-web-runtime-image` persistence delta is corrected**: its traced-tree sentence claimed the runtime image carries `apps/server/package.json`, which stops being true here.
- **BREAKING** (internal release contract): the manifest entry and the package path that carry the `server` version change. No operator-facing surface changes — the tag, the image name, the publish trigger and the runtime entrypoint are all preserved.

## Capabilities

### New Capabilities

None. This change moves where the `server` version lives; it adds no component, no tag, and no channel.

### Modified Capabilities

- `open-source-distribution`: the "release identity MUST be consistent across surfaces" requirement re-anchors its four-surface chain and drift scenario on `apps/web/package.json`; "docker-publish MUST run only when the server component releases" re-anchors the gated path and its example condition on `apps/web`; and "Release-please MUST run as two independent tracks" restates the `server` package as `apps/web` / `@rembric/web` and names the two manifest entries.
- `dashboard`: the brand-block version requirement and the login brand requirement name `apps/web/src/lib/version.ts` as the `REMBRIC_VERSION` source.

## Impact

Release and runtime-identity surface:

- `release-please-config.json`, `.release-please-manifest.json` — the `server` package key and its `package-name`.
- `.github/workflows/release-please.yml` — the per-path sources of the `server_release_created`/`server_tag_name` outputs and one stale comment; job-output names, the `publish-docker` gate, and every other job are unchanged.
- `apps/web/package.json` — `version` `0.0.0` → `0.28.8` (`private: true` retained).
- `apps/server/CHANGELOG.md` → `apps/web/CHANGELOG.md` — a move with no content edit.
- `apps/web/src/lib/version.ts` — the manifest constant and its docblock.
- `apps/web/next.config.mjs` — the dropped `apps/server/package.json` tracing include.
- `apps/web/Dockerfile` — the deterministic runner COPY and the release-identity build gate; the `apps/server/package.json` **builder** copy is retained because the filtered install still resolves `apps/server` as a workspace member (its removal is P8.3).
- `RELEASING.md`, `CLAUDE.md` (and its `AGENTS.md` symlink), `.agents/skills/rembric-plugin-development/SKILL.md` — path references only; channel semantics unchanged.
- `scripts/release-please-reanchor.test.ts` — a new static guard.
- Specs merged at archive time: `openspec/specs/open-source-distribution/spec.md`, `openspec/specs/dashboard/spec.md`.

Deliberately untouched (and why the operator is unaffected):

- **Tag scheme and release trigger** — `component: server` and `include-component-in-tag: true` are unchanged, so the tag is still `server-vX.Y.Z` and `publish-docker` still gates on the `server` release.
- **Docker image name, publish workflow, cache scope and entrypoint** — owned by `publish-web-runtime-image` and not revisited here.
- **`apps/server`** — untouched except the `CHANGELOG.md` move; P8.2 does not demolish it.

Out of scope:

- Retiring `apps/server`, its Dockerfile, or its remaining workspace membership — P8.3.
