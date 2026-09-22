## Context

The publish workflow does not name a Dockerfile. It delegates to a composite action that hard-codes the server image, and that action is shared with `ci.yml`'s server build. Which file to edit was therefore the first decision, and it is the one that determines whether the repo keeps a single definition of "how an app image is built".

The second constraint is the update path. An operator's `docker pull ghcr.io/<owner>/rembric:<version>`, the compose file's `${REMBRIC_VERSION:-latest}` resolution, and the self-update flow all depend on three things that must not move: the image name, the tag scheme, and `LABEL rembric.stage=runtime` (the exact-match filter `RUNTIME_IMAGE_LABEL_FILTER` prunes dangling previous images with, `packages/core/src/services/self-update/orchestrator.ts:45`).

## Decisions

### D1 — Parameterize the shared composite action; do not inline the build in the publish workflow

The action is used by two workflows: `docker-publish.yml` (mode=digest) and `ci.yml`'s `docker-build-check` (mode=load). Adding `dockerfile` and `target` inputs with the current values as defaults keeps one definition of the build for both callers, and leaves the CI caller byte-identical.

Rejected: inlining `docker/build-push-action@v7` with `file: ./apps/web/Dockerfile` directly in `docker-publish.yml`, leaving the action for CI. It is a smaller diff but it duplicates the build definition — the thing the action was extracted to prevent (its creation is recorded in the archived change `2026-06-14-speed-up-docker-publish`, task 1c) — and it reds the invariant test that asserts the publish references the action, forcing that guard to be weakened instead of sharpened.

Rejected: pointing the action at the web image outright. `ci.yml` needs the server image for the installer e2e, and a hard-coded switch would break it silently.

### D2 — Defaults stay on the server image

`default: ./apps/server/Dockerfile` and `default: runtime`. A caller that omits the inputs cannot change behaviour, which is what makes D1 safe for `ci.yml` and keeps the blast radius of this change inside the publish path. The invariant test pins both defaults inside their own input block, so a `default:` that drifts to another input, or a commented-out one, fails.

### D3 — The publish joins the web image's cache scope

`docker-build-check-web` builds `apps/web/Dockerfile` under `web-runtime-amd64`; the publish now uses `web-runtime-<arch>`. That is the same warm-cache relationship the publish previously had with the server build, re-pointed at the image it now builds. `<arch>` (not a single shared scope) is kept because the two architectures have disjoint builder layers and a shared scope evicts one with the other.

The server image's `runtime-<arch>` scope becomes CI-local. Consequence accepted: nothing else reads it, so its only consumer is the `ci.yml` `docker-build-check` leg that writes it (plus the dev-target build that imports it).

### D4 — The smoke asserts the web entrypoint; the other two signals are untouched

Signal 1's entrypoint assertion is the only signal whose expected value is image-specific (`apps/web/server.js`). The `seed-dev`/`tsx watch` substrings, the `rembric.stage=runtime` label check and the 1500 MB ceiling are kept verbatim, so the two requirements the parent change must not weaken — published-stage identity and the size ceiling — keep exactly the semantics they had.

The expected substring lives in one variable (`EXPECT_ENTRY`) used by both the grep and its error message, so the assertion and the failure text cannot drift apart.

### D5 — The 1500 MB ceiling is kept, and its open risk is recorded rather than papered over

The ceiling was calibrated against the server image (1263 MB measured, per the comment at that step). The web image is a different artifact: `apps/web/Dockerfile`'s runtime tree is the full installed closure including devDependencies (documented in that file), plus the same ~341 MB embedding model and onnxruntime payload.

This change does **not** raise the ceiling and does **not** add a size assertion to CI. Both would be changes to a gate on evidence that does not exist yet: the web image's size has not been measured on a runner, and `docker-build-check-web` asserts no size today. The publish smoke evaluates the ceiling per-arch before the merge job runs, so an over-ceiling web image fails the release loudly at publish time instead of shipping. Follow-up: measure the web image in CI, then either keep 1500 MB (if it holds) or recalibrate with the same evidence standard as the last recalibration.

### D6 — The published artifact's contract moves to the web Dockerfile's structure

`apps/server/Dockerfile` no longer publishes, but it is still built (CI, installer e2e), so its structural requirements stay in the spec. The published artifact's equivalents are added for `apps/web/Dockerfile`, which already satisfies them: `runner` is the last stage, the base is `gcr.io/distroless/nodejs22-debian12`, `LABEL rembric.stage=runtime` is declared, and the healthcheck is exec form under numeric `USER 10001:10001`.

### D7 — The server image stops being published; that is the point of the change

`docker-publish.yml` has no other use for the server artifact — it builds it, smokes it and tags it. Once the build points at the web image, the server image publication ends. The composite action does not lose its other consumer, and nothing that ships to an operator named the server image explicitly: what they pull is the repository name and the tags.

## Risks

- **Unmeasured web image size** (D5). The ceiling may be too low for the new artifact. It fails closed at publish time, before any tag exists, so the failure mode is "release blocked", not "bad image shipped".
- **No arm64 or end-to-end publish evidence in this branch.** The change is verified by the invariant tests, YAML parsing and shell-syntax checks of every `run:` block; the two native publish jobs and the merge only run on a real release. `docker-build-check-web` covers the amd64 build+boot, and `docker-build-check` covers arm64 for the server image.
- **The web image's runtime tree is the full closure including devDependencies.** Pre-existing (documented in `apps/web/Dockerfile`); this change promotes it from a CI-side concern to the published artifact, which is what makes the size risk above load-bearing.
- **Stale-cache first run.** The first publish after this change reads a `web-runtime-<arch>` scope that CI populated for the same commit family; if the scope is cold, the build is simply slower, not wrong.
