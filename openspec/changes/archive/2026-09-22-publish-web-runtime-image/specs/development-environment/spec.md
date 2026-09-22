## MODIFIED Requirements

### Requirement: CI MUST verify both Dockerfile stages build cleanly on every change

The repo's CI workflows SHALL include a `docker-build-check` job that triggers on `pull_request` and `push` to `main` and **mirrors the release-publish path** so a build break is caught at PR time rather than at publish. Because the publish builds the (distroless) `runtime` stage natively on two architectures, the check SHALL too — **without QEMU**:

- It SHALL build the `runtime` stage of `apps/server/Dockerfile` natively on **both** `linux/amd64` (`ubuntu-latest`) and `linux/arm64` (`ubuntu-24.04-arm`) using `docker/build-push-action@v7` with `push: false`, `load: true`, `context: .`, `file: apps/server/Dockerfile`.
- On `amd64` it SHALL additionally build the `dev` stage and run the **installer e2e** (`install.sh --server --up` against the locally-loaded image, asserting `/healthz` → 200 and `/dashboard` → 200/302).
- On `arm64` it SHALL run a **boot smoke**: start the just-built distroless image and assert `/healthz` → 200 and that the eagerly-loaded embedding model warmed (proving the arm64 glibc native modules — `onnxruntime-node`, `better-sqlite3`, `sqlite-vec` — and the baked model work).

Failures on either architecture SHALL fail the workflow and block merge by default.

The CI workflows SHALL additionally include a `docker-build-check-web` job that builds the **published artifact** — the `runner` stage of `apps/web/Dockerfile`, `linux/amd64`, `load: true` — and boots it on the host against a mounted `/data`, asserting `/healthz` → 200, that the boot opened the mounted data file rather than a fresh one inside the container layer, and that the boot applied the full migration set. This is the only PR-time gate that boots the artifact the release channel publishes.

The `docker-publish.yml` workflow SHALL build the multi-arch image **without QEMU emulation**, by building each architecture on a native runner and merging the results. Specifically it SHALL:

- Build `linux/amd64` and `linux/arm64` in a **matrix of two native build jobs** — `linux/amd64` on `ubuntu-latest` and `linux/arm64` on `ubuntu-24.04-arm`. The publish flow SHALL NOT use `docker/setup-qemu-action`.
- In each build job, invoke the shared composite action `.github/actions/build-runtime-image` (mode `digest`), which SHALL forward its own `dockerfile` and `target` inputs to `docker/build-push-action@v7`. The publish SHALL pass `dockerfile: ./apps/web/Dockerfile` and `target: runner`, the job's **single** platform, and `outputs: type=image,push-by-digest=true,name-canonical=true,push=true` (so the build pushes a digest-addressable single-platform image and creates **no tags**). Each job SHALL use a **per-architecture build-cache scope**, and that scope SHALL be the one `docker-build-check-web` writes for the same image (`web-runtime-<arch>`), so the merge-to-main that precedes a release leaves the publish importing those builder layers warm instead of cold.
- After its push, each build job SHALL pull **its own** just-pushed image **by digest** (natively, so the inspected image is that job's architecture) and run a smoke-test step that inspects the image config and applies **three independent assertions**, ANY of which fails that job:
  - **Cmd/Entrypoint substring check**: fail if `Config.Cmd` or `Config.Entrypoint` contains the substring `seed-dev` or `tsx watch`. Fail if `Config.Entrypoint` does NOT include the substring `apps/web/server.js` — the entrypoint the `runner` stage of `apps/web/Dockerfile` starts. This is what makes a publish that fell back to the server image, or to any other stage, fail before any tag exists.
  - **Image label check**: fail if `Config.Labels."rembric.stage"` is missing OR not equal to the string `runtime`.
  - **Image size check**: fail if the inspected image size exceeds the configured ceiling (1500 MB), evaluated per-architecture.
- Tags SHALL be created only in a **merge job** that `needs:` both build jobs (so it runs only if **every** architecture passed its smoke test). The merge job SHALL resolve the version, run the **refuse-to-overwrite** guard (fail if the immutable `:<version>` tag already exists), then create the `:<version>` and `:sha-<short>` **manifest list** from the two per-arch digests via `docker buildx imagetools create`, and only then promote the alias tags (`:latest`, major, minor).
- If ANY architecture fails its smoke test, the merge job SHALL NOT run: no `:<version>`, `:sha-<short>`, `:latest`, or alias tag SHALL be created. The per-arch digests remain pushed (untagged) in the registry as forensic evidence of the failed build.

The composite action `.github/actions/build-runtime-image/action.yml` SHALL declare `dockerfile` and `target` inputs, and BOTH of its build modes (`load` and `digest`) SHALL read them. Their defaults SHALL be the server image's `./apps/server/Dockerfile` and `runtime`, so a caller that omits them keeps building exactly what it built before. A build mode that re-hard-codes a Dockerfile path or a stage name SHALL NOT be accepted: it would silently ignore the caller's override, which is the failure mode the inputs exist to remove.

The published artifact SHALL be the `runner` stage of `apps/web/Dockerfile`, and that stage SHALL be the **last** `FROM ... AS <name>` declaration in the file. It SHALL be built from a distroless glibc Node base, SHALL run as a numeric non-root user with an exec-form `HEALTHCHECK`, and SHALL declare `LABEL rembric.stage=runtime`. The last of those is load-bearing beyond this workflow: the updater prunes previous images by an exact-match filter on that label, so a published image without it leaks an image per update.

The `apps/server/Dockerfile` SHALL be structured so that:

- The `runtime` stage is the **last** `FROM ... AS <name>` declaration. This makes `docker build .` (without `--target`) produce the runtime image by default.
- The `runtime` stage SHALL be built from a **distroless glibc Node base** (`gcr.io/distroless/nodejs22-debian12`) — keeping glibc so the prebuilt `onnxruntime-node`, `better-sqlite3`, and `sqlite-vec` native modules work unchanged. The runtime `HEALTHCHECK` SHALL use **exec form** and the stage SHALL run as a **numeric non-root user** (`USER 10001:10001`), since the distroless base has no shell or `useradd`.
- The `runtime` stage SHALL declare `LABEL rembric.stage=runtime`.
- The `dev` stage SHALL declare `LABEL rembric.stage=dev` (purely diagnostic). The `builder` and `dev` stages MAY remain on a full `node:22-bookworm-slim` base (they require a compiler / shell / pnpm).

This catches Dockerfile-level regressions before they reach a release publish, prevents the dev stage from being shipped as the canonical image, and keeps the publish off emulated builds so it completes in roughly native single-arch time.

#### Scenario: PR with a broken Dockerfile is caught before merge

- **GIVEN** a PR that introduces a change to `apps/server/Dockerfile` causing the `runtime` stage to fail to build
- **WHEN** the PR's CI workflow runs
- **THEN** the `docker-build-check` job SHALL fail
- **AND** the PR's overall status check SHALL be red

#### Scenario: docker-build-check catches an arm64-native or distroless regression before publish

- **GIVEN** a PR that changes `apps/server/Dockerfile` such that the `runtime` image builds on amd64 but fails to build or boot on arm64 (e.g. an arm64-native module break, or a distroless change that prevents the embedder from loading)
- **WHEN** the PR's CI workflow runs the `docker-build-check` matrix
- **THEN** the `arm64` leg (`ubuntu-24.04-arm`) SHALL fail at the runtime build or the boot smoke (`/healthz` never reaching 200, or the embedding model never loading)
- **AND** the PR's overall status check SHALL be red — the break is caught at PR time, not at release publish

#### Scenario: The published artifact is booted before merge

- **GIVEN** a PR that changes `apps/web/Dockerfile` such that the image builds but cannot serve
- **WHEN** the PR's CI workflow runs `docker-build-check-web`
- **THEN** the job SHALL fail on the host boot smoke (`/healthz` never reaching 200, the mounted data file never being opened, or fewer than the full migration set being applied)
- **AND** the PR's overall status check SHALL be red

#### Scenario: PR that only modifies docs does not waste CI on a Docker build

- **GIVEN** a PR that modifies only `docs/**/*` or `*.md` files
- **WHEN** the PR's CI workflow runs
- **THEN** the `docker-build-check` job MAY skip (if path filters are configured) or run-and-pass quickly via cache hits

#### Scenario: Publish builds each architecture natively, without QEMU

- **GIVEN** the release workflow has triggered `docker-publish.yml`
- **WHEN** the build matrix runs
- **THEN** the `linux/amd64` build SHALL run on `ubuntu-latest` and the `linux/arm64` build SHALL run on `ubuntu-24.04-arm`
- **AND** neither build job SHALL invoke `docker/setup-qemu-action`
- **AND** each job SHALL invoke the shared composite action in `digest` mode with the web image's `./apps/web/Dockerfile` and its `runner` stage, its single platform, and `push-by-digest=true`

#### Scenario: Publish builds the web image through the shared action

- **GIVEN** the release workflow has triggered `docker-publish.yml`
- **WHEN** the per-arch build job runs
- **THEN** the job SHALL build through `.github/actions/build-runtime-image` (not an inlined `docker/build-push-action`), passing `dockerfile: ./apps/web/Dockerfile` and `target: runner`
- **AND** the action SHALL forward those inputs to its `file:` and `target:` fields rather than using the server defaults
- **AND** the resulting image SHALL be published under the unchanged image name and tag scheme

#### Scenario: A publish that falls back to the server image fails smoke before any tag exists

- **GIVEN** a regression that makes `docker-publish.yml` build `apps/server/Dockerfile`'s `runtime` stage instead of the web image (e.g. the override inputs are dropped)
- **WHEN** a build job runs its per-arch smoke test
- **THEN** the Cmd/Entrypoint check SHALL fail because `Config.Entrypoint` does not include `apps/web/server.js`
- **AND** that build job SHALL fail
- **AND** the merge job SHALL NOT run, so no `:<version>`, `:sha-<short>`, `:latest` or alias tag SHALL be created

#### Scenario: A build mode that ignores its inputs is caught (invariant test)

- **GIVEN** a change to `.github/actions/build-runtime-image/action.yml` that re-hard-codes `file:` or `target:` in either build mode, or that moves the `default:` of `dockerfile`/`target` to another input
- **WHEN** `apps/server/src/test/invariants.test.ts` runs the composite-action check
- **THEN** the test SHALL fail: it asserts that both build modes consume `inputs.dockerfile` and `inputs.target`, and that each default sits inside its own input block

#### Scenario: A publish override that reverts to the server image is caught (invariant test)

- **GIVEN** a change to `docker-publish.yml` that removes the web override, or that restores the server entrypoint as the smoke's expected substring
- **WHEN** `apps/server/src/test/invariants.test.ts` runs the publish check
- **THEN** the test SHALL fail: it asserts exactly one uncommented `dockerfile: ./apps/web/Dockerfile`, exactly one uncommented `target: runner`, and that the smoke's expected entrypoint is `apps/web/server.js` and no longer `dist/server-entrypoint.js`

#### Scenario: CI keeps building the server image from the action's defaults

- **GIVEN** `ci.yml`'s `docker-build-check` calls the shared composite action without the `dockerfile`/`target` inputs
- **WHEN** that job builds the image
- **THEN** it SHALL build `apps/server/Dockerfile`'s `runtime` stage — the defaults — and the installer e2e SHALL keep exercising it

#### Scenario: A single arch failing smoke blocks all tags

- **GIVEN** the `linux/arm64` build job's smoke test detects `seed-dev` in `Config.Cmd` (a dev-stage publish)
- **WHEN** that build job runs its per-arch smoke test
- **THEN** the arm64 build job SHALL fail
- **AND** the merge job SHALL NOT run (it `needs:` both build jobs)
- **AND** no `:<version>`, `:sha-<short>`, `:latest`, or alias tag SHALL be created
- **AND** the per-arch digests SHALL remain pushed (untagged) in the registry as forensic evidence

#### Scenario: Image label check catches a wrong-stage publish independently

- **GIVEN** a faulty build where the published image's `Cmd` was rewritten such that the substring check no longer matches, but the image is still built from a stage that lacks `rembric.stage=runtime`
- **WHEN** a build job's per-arch smoke test inspects `Config.Labels."rembric.stage"`
- **THEN** the smoke test SHALL fail because the label is missing or has a value other than `runtime`
- **AND** the merge job SHALL NOT create any tag

#### Scenario: Image size check catches a bloated publish independently

- **GIVEN** a faulty publish that produces an image exceeding the configured ceiling regardless of what `Config.Cmd`/`Labels` say
- **WHEN** a build job's per-arch smoke test queries the inspected image size
- **THEN** the size SHALL exceed the ceiling (1500 MB)
- **AND** the smoke test SHALL fail with a clear "image too large" message naming the actual size

#### Scenario: Merge job refuses to overwrite an existing immutable version tag

- **GIVEN** both build jobs passed smoke but the immutable `:<version>` tag already exists in the registry
- **WHEN** the merge job runs its refuse-to-overwrite guard before `imagetools create`
- **THEN** the merge job SHALL fail and SHALL NOT create or move any tag

#### Scenario: Published manifest list advertises both platforms

- **GIVEN** both build jobs passed smoke and the merge job created the `:<version>` manifest list
- **WHEN** `docker buildx imagetools inspect ghcr.io/<owner>/rembric:<version>` is run
- **THEN** the manifest list SHALL advertise both `linux/amd64` and `linux/arm64`

#### Scenario: Runtime stage is built from a distroless glibc base

- **GIVEN** the published `:<version>` image (either architecture)
- **WHEN** its `runner` stage is inspected
- **THEN** it SHALL be based on a distroless glibc Node base, run as a non-root numeric user, and resolve its `HEALTHCHECK` via `node` exec form (no shell present)
- **AND** the in-process embedding pipeline (`onnxruntime-node` + the baked model) SHALL function, confirming glibc compatibility

#### Scenario: Dockerfile last stage is runtime (invariant test)

- **WHEN** `apps/server/src/test/invariants.test.ts` runs the "Dockerfile stage order" check
- **THEN** the test SHALL parse `apps/server/Dockerfile`, identify all `FROM ... AS <name>` lines in order, and assert the final entry's name is `runtime`

#### Scenario: Dockerfile declares stage labels (invariant test)

- **WHEN** `apps/server/src/test/invariants.test.ts` runs the "image labels" check
- **THEN** the test SHALL verify the `runtime` stage block contains a line matching `LABEL rembric.stage=runtime`
- **AND** the test SHALL verify the `dev` stage block contains a line matching `LABEL rembric.stage=dev`
