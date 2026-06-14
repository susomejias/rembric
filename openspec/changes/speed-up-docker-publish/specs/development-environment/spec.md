## MODIFIED Requirements

### Requirement: CI MUST verify both Dockerfile stages build cleanly on every change

The repo's CI workflows SHALL include a `docker-build-check` job that triggers on `pull_request` and `push` to `main` and **mirrors the release-publish path** so a build break is caught at PR time rather than at publish. Because the publish builds the (distroless) `runtime` stage natively on two architectures, the check SHALL too — **without QEMU**:

- It SHALL build the `runtime` stage of `apps/server/Dockerfile` natively on **both** `linux/amd64` (`ubuntu-latest`) and `linux/arm64` (`ubuntu-24.04-arm`) using `docker/build-push-action@v7` with `push: false`, `load: true`, `context: .`, `file: apps/server/Dockerfile`.
- On `amd64` it SHALL additionally build the `dev` stage and run the **installer e2e** (`install.sh --server --up` against the locally-loaded image, asserting `/healthz` → 200 and `/dashboard` → 200/302).
- On `arm64` it SHALL run a **boot smoke**: start the just-built distroless image and assert `/healthz` → 200 and that the eagerly-loaded embedding model warmed (proving the arm64 glibc native modules — `onnxruntime-node`, `better-sqlite3`, `sqlite-vec` — and the baked model work).

Failures on either architecture SHALL fail the workflow and block merge by default.

The `docker-publish.yml` workflow SHALL build the multi-arch image **without QEMU emulation**, by building each architecture on a native runner and merging the results. Specifically it SHALL:

- Build `linux/amd64` and `linux/arm64` in a **matrix of two native build jobs** — `linux/amd64` on `ubuntu-latest` and `linux/arm64` on `ubuntu-24.04-arm`. The publish flow SHALL NOT use `docker/setup-qemu-action`.
- In each build job, invoke `docker/build-push-action@v7` with `target: runtime`, `context: .`, `file: apps/server/Dockerfile`, the job's **single** platform, and `outputs: type=image,push-by-digest=true,name-canonical=true,push=true` (so the build pushes a digest-addressable single-platform image and creates **no tags**). Each job SHALL use a **per-architecture build-cache scope**.
- After its push, each build job SHALL pull **its own** just-pushed image **by digest** (natively, so the inspected image is that job's architecture) and run a smoke-test step that inspects the image config and applies **three independent assertions**, ANY of which fails that job:
  - **Cmd/Entrypoint substring check**: fail if `Config.Cmd` or `Config.Entrypoint` contains the substring `seed-dev` or `tsx watch`. Fail if `Config.Entrypoint` does NOT include the substring `dist/server-entrypoint.js`.
  - **Image label check**: fail if `Config.Labels."rembric.stage"` is missing OR not equal to the string `runtime`.
  - **Image size check**: fail if the inspected image size exceeds the configured ceiling (1500 MB), evaluated per-architecture.
- Tags SHALL be created only in a **merge job** that `needs:` both build jobs (so it runs only if **every** architecture passed its smoke test). The merge job SHALL resolve the version, run the **refuse-to-overwrite** guard (fail if the immutable `:<version>` tag already exists), then create the `:<version>` and `:sha-<short>` **manifest list** from the two per-arch digests via `docker buildx imagetools create`, and only then promote the alias tags (`:latest`, major, minor).
- If ANY architecture fails its smoke test, the merge job SHALL NOT run: no `:<version>`, `:sha-<short>`, `:latest`, or alias tag SHALL be created. The per-arch digests remain pushed (untagged) in the registry as forensic evidence of the failed build.

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

#### Scenario: PR that only modifies docs does not waste CI on a Docker build

- **GIVEN** a PR that modifies only `docs/**/*` or `*.md` files
- **WHEN** the PR's CI workflow runs
- **THEN** the `docker-build-check` job MAY skip (if path filters are configured) or run-and-pass quickly via cache hits

#### Scenario: Publish builds each architecture natively, without QEMU

- **GIVEN** the release workflow has triggered `docker-publish.yml`
- **WHEN** the build matrix runs
- **THEN** the `linux/amd64` build SHALL run on `ubuntu-latest` and the `linux/arm64` build SHALL run on `ubuntu-24.04-arm`
- **AND** neither build job SHALL invoke `docker/setup-qemu-action`
- **AND** each job SHALL invoke `docker/build-push-action@v7` with `target: runtime`, its single platform, and `push-by-digest=true`

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
- **WHEN** its runtime stage is inspected
- **THEN** it SHALL be based on a distroless glibc Node base, run as a non-root numeric user, and resolve its `HEALTHCHECK` via `node` exec form (no shell present)
- **AND** the in-process embedding pipeline (`onnxruntime-node` + the baked model) SHALL function, confirming glibc compatibility

#### Scenario: Dockerfile last stage is runtime (invariant test)

- **WHEN** `apps/server/src/test/invariants.test.ts` runs the "Dockerfile stage order" check
- **THEN** the test SHALL parse `apps/server/Dockerfile`, identify all `FROM ... AS <name>` lines in order, and assert the final entry's name is `runtime`
