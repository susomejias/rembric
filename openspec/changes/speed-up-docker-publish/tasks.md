# Tasks

## 1. Publish workflow — native matrix + per-arch smoke + merge

- [x] 1.1 Replace the single `build-and-push` job in `docker-publish.yml` with a **matrix build job**: `{ arch: amd64 → ubuntu-latest, arch: arm64 → ubuntu-24.04-arm }`. Remove `docker/setup-qemu-action` from the publish flow.
- [x] 1.2 In each build job: checkout the tag, set up buildx, log in to GHCR, then `docker/build-push-action@v7` with `target: runtime`, single platform, `outputs: type=image,push-by-digest=true,name-canonical=true,push=true`, `cache-from/to: type=gha,scope=publish-${{ matrix.arch }}` (mode=max on `cache-to`), and the `hf_token` build secret.
- [x] 1.3 Export the pushed digest from the build step and `upload-artifact` it (one artifact per arch, e.g. `digest-${{ matrix.arch }}`).
- [x] 1.4 Per-arch smoke step: `docker pull IMAGE@sha256:<digest>` then run the existing three signals (Cmd/Entrypoint substring + `dist/server-entrypoint.js`, `rembric.stage=runtime` label, size ≤ 1500 MB) against the pulled digest. Fail the job on any signal.
- [x] 1.5 Add a **merge job** (`needs: build`): log in, `download-artifact` both digests, resolve version (strip `server-`/`v`), run the **refuse-to-overwrite immutable `:version`** guard, `docker buildx imagetools create -t :<version> -t :sha-<short>` from both digests, then promote alias tags (`:latest`, major, minor) via `imagetools create` (relocate existing promotion logic).
- [x] 1.6 Verify the existing `concurrency` / `timeout-minutes` / `permissions` blocks still make sense for the new job set (apply `permissions: packages: write` to build + merge jobs).

## 1b. CI safety net — widen `docker-build-check` to mirror the publish path

- [x] 1b.1 `ci.yml`: convert `docker-build-check` to a matrix (`amd64 → ubuntu-latest`, `arm64 → ubuntu-24.04-arm`), `fail-fast: false`. Build the (distroless) `runtime` stage natively on both arches with per-arch cache scope (`docker-build-check-runtime-${{ matrix.arch }}`). No QEMU.
- [x] 1b.2 amd64 leg keeps the `dev`-target build + full installer e2e (`install.sh --server --up`). Both gated `if: matrix.arch == 'amd64'`.
- [x] 1b.3 arm64 leg adds a boot smoke: `docker run` the loaded image with a writable `/data`, poll `/healthz` → 200, and assert `embedding model loaded` in logs (proves arm64 glibc native modules + eager embedder).

## 1c. DRY — shared composite action for the runtime build

- [x] 1c.1 New `.github/actions/build-runtime-image/action.yml`: composite action building the `runtime` stage for one platform, `mode: load | digest`, per-arch cache scope, optional `hf-token`; exposes `digest` output.
- [x] 1c.2 `docker-publish.yml` build job + `ci.yml` `docker-build-check` both call the action (digest vs load). Removed the duplicated buildx/build-push blocks.
- [x] 1c.3 Update `invariants.test.ts`: the `target: runtime` guard reads the action file (single source of truth) and asserts `docker-publish.yml` references the action.

## 1d. Image slimming — safe prune only (build time is the goal; no fragility)

- [x] 1d.1 Dockerfile builder: prune `onnxruntime-node` non-target platform/arch libs (darwin/win32/other-linux-arch) from the `.pnpm` store in `/prod-out`, keyed on `ARG TARGETARCH` (amd64→x64, arm64→arm64). Loud-fail guard (`[ -n "$found" ]`) if the target binding is missing post-prune.
- [x] 1d.2 Validated: real arm64 build → 701 MB (from 893 distroless / 1030 bookworm), boots healthy, embedder loads in ~843ms.
- [x] 1d.3 Decision recorded: `onnxruntime-web` `.wasm` prune (−120 MB) REJECTED — couples to transformers.js backend-selection internals (fragility). Out of scope.

## 1e. Build-time — stop the dev stage re-baking the model

- [x] 1e.1 Dockerfile dev stage: replace the `fetch-model.mjs` re-bake with `COPY --from=builder /models /app/models` (builder already fetched + validated it). One model bake per build instead of two.
- [x] 1e.2 `ci.yml` dev build step: `cache-from` the runtime leg's builder scope (`docker-build-check-runtime-amd64`) so the dev build reuses the baked model layer rather than re-fetching. Trims the amd64 `docker-build-check` leg.
- [x] 1e.3 Measured on GitHub (first run): arm64 native `docker-build` = 3m56s (was 6–8m emulated); amd64 leg = 8m20s cold (runtime 5m25s + dev + e2e). Publish builds runtime only → ~5.5m cold / fast warm. Warm-cache + dev-reuse timing confirmed on the follow-up run.

## 1f. Cache — share the runtime build cache between CI and publish

- [x] 1f.1 Unify the runtime cache scope to `runtime-${arch}` in BOTH `ci.yml` docker-build-check and `docker-publish.yml` (were siloed `docker-build-check-runtime-*` / `publish-*`). A release is preceded by a merge-to-main that builds the same runtime image in CI, so the publish imports those builder layers warm instead of cold.
- [x] 1f.2 CI dev build `cache-from` updated to the unified `runtime-amd64` scope (keeps its own `docker-build-check-dev` for export).

## 2. Dockerfile — distroless runtime stage

- [x] 2.1 Change the `runtime` `FROM` to `gcr.io/distroless/nodejs22-debian12` (keep it the **last** stage).
- [x] 2.2 Replace `RUN useradd … rembric` + `USER rembric` with numeric `USER 10001:10001`; change the `COPY --from=builder --chown=rembric:rembric …` lines to `--chown=10001:10001`.
- [x] 2.3 Convert the runtime `HEALTHCHECK` to **exec form** (`CMD ["node","-e","…"]`); confirm the entrypoint stays exec-form `["node","/app/dist/server-entrypoint.js"]`.
- [x] 2.4 Leave `builder` and `dev` stages on `node:22-bookworm-slim`. Confirm the `LABEL rembric.stage=runtime` survives.

## 3. Validation

- [x] 3.1 Local: `docker build --target runtime -t rembric:distroless .` (or via buildx single-arch); confirm it builds and `docker inspect` shows the `runtime` label, exec-form entrypoint, and a smaller size than baseline (~1.26 GB → ~1.10–1.15 GB).
- [x] 3.2 Run the `rembric-tui-installer-e2e` playbook / `ci.yml` `docker-build-check` path locally: `install.sh --server --up` against the distroless image, poll `/healthz` 200 and `/dashboard`, confirm `/data` volume opens (numeric uid). The in-process embedding pipeline must work (glibc) — exercise a `memory.save` + `memory.search`.
- [x] 3.3 Confirm `apps/server/src/test/invariants.test.ts` "Dockerfile stage order" still passes (runtime is last).
- [ ] 3.4 Dry-run the publish via `workflow_dispatch` against a throwaway tag; confirm: two native build jobs, no QEMU, per-arch smoke, merge creates a manifest list advertising both `linux/amd64` and `linux/arm64`, and wall-clock ≈ ~3 min.

## 4. Skills / docs

- [x] 4.1 Consult `rembric-tui-installer` and `rembric-plugin-development` skills before landing (install/distribution governance).
- [x] 4.2 If any doc references the publish flow as single-job/QEMU or the bookworm-slim runtime base, update it (grep `docs/`, `apps/server/Dockerfile` comments, README quickstart).

## 5. Spec

- [ ] 5.1 Land the `development-environment` spec delta (modified publish requirement + scenarios) into `openspec/specs/development-environment/spec.md` on archive.
