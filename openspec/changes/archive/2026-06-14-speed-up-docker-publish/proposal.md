## Why

The release Docker publish (`.github/workflows/docker-publish.yml`) takes **8–10 minutes**. The dominant cost is **arm64 built under QEMU emulation** on a single amd64 runner: the `apps/server/Dockerfile` does real native compilation (`apt build-essential`, `pnpm install`, `pnpm run build`, and `pnpm rebuild better-sqlite3 sqlite-vec onnxruntime-node`), and emulated C/C++ compilation runs ~5–10× slower than native. The amd64 half of the build is ~2 min; the emulated arm64 half is the other ~6–8 min. QEMU emulation is ~80 % of the wall clock.

The repo is **public** (`susomejias/rembric`), which makes GitHub-hosted **native `ubuntu-24.04-arm` runners free** (GA since Jan 2025). That unlocks the canonical Docker multi-platform pattern — build each arch natively in parallel, push by digest, then stitch a manifest list — eliminating QEMU entirely.

Secondarily, the published image is ~1.26 GB. The runtime stage currently ships `node:22-bookworm-slim` (a full Debian userland with a shell and apt). Swapping it for a distroless glibc Node base trims the OS layer and removes the shell/package-manager attack surface.

## What Changes

**Speed — kill QEMU via native-runner matrix-by-digest (the big win):**

- Split the single build-and-push step into a **matrix of two native build jobs**: `linux/amd64` on `ubuntu-latest`, `linux/arm64` on `ubuntu-24.04-arm`. Drop `setup-qemu-action` from the publish flow.
- Each build job uses `docker/build-push-action` with `outputs: type=image,push-by-digest=true,name-canonical=true,push=true` (no tags during build) and a **per-arch GHA cache scope**.
- **Smoke each arch's digest pre-merge** (per the user's choice): each build job pulls **its own** just-pushed digest natively (`docker pull IMAGE@sha256:…`) and runs the existing **three independent smoke signals** (`seed-dev`/`tsx watch` substring + `dist/server-entrypoint.js` entrypoint check, `rembric.stage=runtime` label, image-size ceiling) against that arch's image. A failing arch fails its job and the merge never runs.
- A **merge job** (`needs:` both builds) resolves the version, runs the **refuse-to-overwrite-immutable-tag** guard, then `docker buildx imagetools create`s the `:<version>` + `:sha-<short>` manifest list from the two digests, and finally promotes alias tags (`:latest`, major, minor) — unchanged promotion logic, just relocated.
- **Forensic model refinement:** because tags are created only after every arch passes smoke, a failed build never produces a named `:<version>` tag. The per-arch digests remain pushed (untagged) in the registry as forensic evidence. This is strictly stronger than today's "version tag pushed, then smoke-gated alias promotion."

**Size — secondary, and ONLY where it adds no fragility / no quality loss** (build time is the goal; size is a byproduct):

- Switch the **`runtime` stage only** from `node:22-bookworm-slim` to a **distroless glibc Node base** (`gcr.io/distroless/nodejs22-debian12`) — **−137 MB** (measured). Builder and dev stages keep `node:22-bookworm-slim` (they need a compiler / shell / pnpm). Distroless keeps **glibc**, so `onnxruntime-node` + the other native modules work unchanged. Convert the runtime `HEALTHCHECK` to **exec form** and replace `useradd` + `USER rembric` with numeric `USER 10001:10001` (distroless has no shell/`useradd`); `COPY --chown=10001:10001`.
- **Prune `onnxruntime-node`'s non-target prebuilt libs** at build time — **−185 MB**, **zero fragility, zero quality change**. The package ships binaries for darwin + win32 + both linux arches, but its loader only ever `require()`s the running `${process.platform}/${process.arch}` (`onnxruntime-node/dist/binding.js`), so every other platform/arch is provably unreachable in a single-arch Linux image. The exact same lib runs. A post-prune assertion + the eager-boot smoke fail the build loudly if the layout ever changes.
- **Measured base image** is dominated by data that is NOT base-related: the node binary (117 MB, the floor for any Node base), the q8 embedding model (357 MB, architectural), and onnxruntime. So **a lighter base is not the lever** — Alpine is rejected (musl breaks `onnxruntime-node`), and distroless is already at the floor. Net: **~1.03 GB → ~0.7 GB** for the runtime image, with no fragility added.
- **Explicitly NOT done:** pruning `onnxruntime-web`'s ~120 MB of `.wasm`. It would save more, but relies on `@huggingface/transformers` internals always selecting the Node backend — coupling to a dependency's internals. Per the no-fragility constraint, it is out of scope.

## Capabilities

### Modified Capabilities

- `development-environment`: the requirement _"CI MUST verify both Dockerfile stages build cleanly on every change"_ is modified so the **publish** flow (a) builds each arch natively (no QEMU), (b) pushes by digest and runs the three smoke signals **per-arch before** any tag exists, (c) creates the `:<version>`/`:sha-<short>` manifest list and alias tags only in a merge job gated on all arches passing, and (d) builds the `runtime` stage from a distroless glibc Node base. **The PR-time `docker-build-check` safety net is also widened to mirror the publish path**: it builds the (distroless) `runtime` stage natively on **both** amd64 and arm64 — amd64 keeps the full installer e2e, arm64 adds a boot smoke (asserting `/healthz` 200 + the eager embedder load) — so an arm64-native or distroless regression is caught at PR time, not at release.

### New Capabilities

_None._

## Impact

Affected CI / build:

- `.github/workflows/docker-publish.yml` — single job → **preflight-free matrix (2 native build jobs) + merge job**; per-arch smoke; per-arch cache scopes; QEMU removed.
- `.github/workflows/ci.yml` — `docker-build-check` → **matrix (amd64 + arm64 native)**; runtime built on both arches; dev + installer e2e on amd64; boot smoke on arm64; per-arch runtime cache scopes.
- `.github/actions/build-runtime-image/action.yml` — **new composite action** that builds the `runtime` stage (`mode: load | digest`); called by both `ci.yml` and `docker-publish.yml` so the build config lives in one place.
- `apps/server/Dockerfile` — `runtime` stage base → distroless; exec-form `HEALTHCHECK`; numeric `USER`; **build-time prune of `onnxruntime-node` non-target platform libs** (−185 MB, loud-fail-guarded).
- `apps/server/src/test/invariants.test.ts` — `target: runtime` guard now asserts against the composite action (single source of truth) + that publish references it.
- The size-signal threshold in the smoke step is now evaluated **per-arch** (each native runner inspects its own image).

Affected specs: `development-environment`.

Load-bearing / governance:

- This touches the **release publish pipeline** and the **multi-arch-at-publish** invariant — an OpenSpec change is required (per CLAUDE.md) before implementation.
- Implementation MUST consult the **`rembric-tui-installer`** and **`rembric-plugin-development`** skills and re-run the **installer e2e** (`ci.yml`'s `docker-build-check` brings the built image up via `install.sh --server --up`): the runtime base swap must not break server bring-up, the healthcheck, or the `/data` volume ownership (the installer pre-creates `./data` `0777`, so a numeric uid is fine).

## Out of scope / verified-unaffected

- **Embedding-model / onnxruntime weight** — the ~620 MB model+runtime that dominates image size is architectural (in-process embeddings) and out of scope; this change does not alter the embedding pipeline.
- **release-please two-track model** and the "Docker publishes only on a `server` release" gate — untouched.
- **Smoke-test signal semantics** (the three assertions) — unchanged; only _where/when_ they run (per-arch, pre-merge) changes.
