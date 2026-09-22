## Why

The release channel ships a different image than the one the port is moving the runtime to. `ghcr.io/<owner>/rembric:<version>` is built from the server app, while `apps/web` owns every HTTP surface once the Next.js port completes:

- `.github/workflows/docker-publish.yml:79` — `uses: ./.github/actions/build-runtime-image`, and the workflow names no Dockerfile of its own.
- `.github/actions/build-runtime-image/action.yml:40-41` and `:57-58` — `file: ./apps/server/Dockerfile` and `target: runtime`, hard-coded in both build modes.
- `apps/web/Dockerfile` is built only by `.github/workflows/ci.yml`'s `docker-build-check-web` job, and is published by nothing.

The repoint cannot be done by editing `docker-publish.yml` alone, because four contracts name the server image:

1. **The workflow's smoke test** requires the server entrypoint (`docker-publish.yml`, Signal 1), and the published smoke is the gate that decides whether any tag is minted.
2. **`openspec/specs/development-environment/spec.md:172`** pins the publish build to `docker/build-push-action@v7` with `target: runtime`, `context: .`, `file: apps/server/Dockerfile`. `:174` pins the entrypoint assertion (`Fail if Config.Entrypoint does NOT include the substring dist/server-entrypoint.js`), and `:176` pins the 1500 MB ceiling.
3. **`openspec/specs/persistence/spec.md:280`** requires the published artifact to invoke the server entrypoint: `SHALL invoke the runtime server entrypoint (node /app/dist/server-entrypoint.js) on container start`, with the scenario at `:295` asserting `Config.Entrypoint` contains it.
4. **`apps/server/src/test/invariants.test.ts:463-475`** asserts the composite action contains `target:\s*runtime\b` and that `docker-publish.yml` matches `uses:\s*\.\/\.github\/actions\/build-runtime-image\b`.

The last two are what makes this a governed change rather than a workflow edit: the invariant test pins the `uses:` reference (evaluating its exact regex against a copy of the workflow with the build inlined returns `false`), and the specs pin a runtime contract the operator can observe.

The constraint that shapes the design: an existing installation's update path must not move. It is the image name plus the tag scheme that the operator's `docker pull` and the self-update flow depend on, together with `LABEL rembric.stage=runtime`, which is the filter the updater prunes previous images by (`packages/core/src/services/self-update/orchestrator.ts:45`). None of those may change.

## What Changes

- **The composite action becomes parameterized instead of server-specific.** `.github/actions/build-runtime-image/action.yml` gains `dockerfile` and `target` inputs whose **defaults are the current values** (`./apps/server/Dockerfile`, `runtime`), and both build modes consume them. A caller that passes nothing keeps building exactly what it built before — which is why `ci.yml`'s `docker-build-check` is not touched by this change.
- **`docker-publish.yml` overrides both inputs with the web image**: `dockerfile: ./apps/web/Dockerfile`, `target: runner`. The image name (`ghcr.io/${{ github.repository_owner }}/rembric`), the label/tag scheme, the triggers, the auth, the platform policy and the merge job are unchanged.
- **The per-arch smoke asserts the web entrypoint.** Signal 1's expected substring becomes `apps/web/server.js` (via a single `EXPECT_ENTRY` variable used by both the grep and its error message), so a publish that fell back to the server image, or to any other stage, fails before a tag exists. The `seed-dev`/`tsx watch` substrings, the `rembric.stage=runtime` label check and the 1500 MB ceiling are retained verbatim.
- **The server image publication stops; the server image build does not.** `docker-publish.yml` stops producing the server artifact, so the server image is no longer published under any tag. `apps/server/Dockerfile` keeps being built and booted by `ci.yml`'s `docker-build-check` (runtime on both arches, plus the installer e2e on amd64), which is what the `install.sh --server --up` path exercises.
- **Cache scopes are realigned to what is actually build-warm.** The publish joins `docker-build-check-web`'s `web-runtime-<arch>` scope (the web image's builder layers, built on the merge-to-main that precedes a release) instead of the server image's `runtime-<arch>`, which is now CI-local.
- **The invariants become a two-sided guard.** The `target: runtime` check is replaced by a parameterization check: both build modes must consume `inputs.dockerfile`/`inputs.target` (so a re-hard-coded leg fails), the defaults must stay on the server image, and the publish must pass the web override and assert the web entrypoint. Every clause is mutation-checked with `scripts/mutate.mjs`.
- **The two spec requirements are modified** so the published artifact is the web image and its entrypoint is `/app/apps/web/server.js`, while the distroless/label/size/healthcheck requirements are kept.

## Capabilities

### New Capabilities

None. This change adds no release component, no tag, and no channel: it moves which app image fills the existing `server-v*` channel.

### Modified Capabilities

- `development-environment`: MODIFIED requirement "CI MUST verify both Dockerfile stages build cleanly on every change" — the publish half now builds `apps/web/Dockerfile`'s `runner` stage through the parameterized composite action, the smoke asserts the web entrypoint, the `apps/web/Dockerfile` structure (last stage, distroless base, label, exec-form healthcheck, numeric user) is required as the published artifact, and the parameterization/defaults are covered by scenarios.
- `persistence`: MODIFIED requirement "The distributed Docker image MUST NOT execute destructive data operations on startup" — the published artifact's entrypoint becomes `node /app/apps/web/server.js`; the prohibition on `DELETE FROM` during boot, the seed-script clause and the verification steps are unchanged in substance, with the publish-smoke step restated for the per-arch-digest flow.

## Impact

Affected build/release surface:

- `.github/actions/build-runtime-image/action.yml` — two new inputs (`dockerfile`, `target`) with server-image defaults; both build modes consume them; description updated.
- `.github/workflows/docker-publish.yml` — passes the web override, moves to the `web-runtime-<arch>` cache scope, and asserts the web entrypoint in Signal 1.
- `.github/workflows/ci.yml` — comments only: the server runtime cache scope is now CI-local, and `docker-build-check-web`'s scope is now shared with the publish. No job, step, input or threshold changes.
- `apps/server/src/test/invariants.test.ts` — the composite-action assertion is kept and parameterized; the publish override and the web entrypoint assertion are added.
- Specs merged at archive time: `openspec/specs/development-environment/spec.md`, `openspec/specs/persistence/spec.md`.

Load-bearing / governance:

- This touches the **release publish pipeline** and the **published-image contract**, so it ships as an OpenSpec change (per `CLAUDE.md`) with spec deltas rather than as a workflow edit.

Deliberately untouched (and why the operator is unaffected):

- **`release-please` configuration, manifest, `.release-please.yml` and app package versions.** There is no third component: the release still fires on the `server` component (`release-please.yml` gates `publish-docker` on `server_release_created`), and `tag: server-v<x.y.z>` is still what the publish receives and strips.
- **Image name and tag scheme** — `<version>`, `sha-<short>`, `<minor>`, `<major>`, `latest`, produced by the same merge job from the same per-arch digests.
- **Trigger set** — `release-please.yml`'s `workflow_call` (gated on a `server` release) and the manual `workflow_dispatch` recovery path.
- **Platform policy** — native `linux/amd64` on `ubuntu-latest` and `linux/arm64` on `ubuntu-24.04-arm`, no QEMU. `apps/web/Dockerfile` handles both `TARGETARCH` values and asserts the surviving onnxruntime binding.
- **Data-location contract** — `apps/web/Dockerfile` already sets `ENV REMBRIC_DATA_DIR=/data`, `VOLUME ["/data"]`, `USER 10001:10001` and `LABEL rembric.stage=runtime`, so an existing operator's volume and the updater's image-prune filter both keep working.
- **The size ceiling and label semantics** — retained as they are (see `design.md` for the one open measurement).

Out of scope:

- Retiring `apps/server/Dockerfile` or the Hono app — this change repoints the published artifact, it does not delete the server.
- The unmeasured size of the web image, which the 1500 MB ceiling now governs (risk recorded in `design.md`).
