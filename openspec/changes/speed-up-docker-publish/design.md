# Design

## Job graph (publish)

```
                         ┌──────────────────────────────────────────┐
                         │ build (matrix)                           │
        ┌────────────────┤  • amd64  → runs-on: ubuntu-latest       │
        │                │  • arm64  → runs-on: ubuntu-24.04-arm    │
        │  each job:      │  checkout · buildx · login GHCR          │
        │                │  build-push-action  target=runtime       │
        │                │    platforms: <single arch>              │
        │                │    push-by-digest=true (NO tags)          │
        │                │    cache scope: publish-<arch>            │
        │                │  → export DIGEST                          │
        │                │  SMOKE its own digest natively (3 sigs)   │
        │                │  upload digest as artifact                │
        │                └──────────────────┬───────────────────────┘
        │                                   │ needs: build (both)
        ▼                                   ▼
  (a failing arch fails        ┌──────────────────────────────────────┐
   its job → merge never        │ merge  runs-on: ubuntu-latest         │
   runs; digests linger          │  login · download both digests       │
   untagged as forensics)        │  resolve version                      │
                                  │  REFUSE-OVERWRITE immutable :version  │
                                  │  imagetools create :version, :sha-*   │
                                  │    from amd64+arm64 digests           │
                                  │  promote aliases (:latest, maj, min)  │
                                  └──────────────────────────────────────┘
```

Wall-clock: `max(amd64, arm64)` native build (~2–3 min each, in parallel) + merge (~30 s) ≈ **~3 min**, down from 8–10.

## Decision 1 — Native runners over QEMU (the lever that matters)

QEMU emulation of arm64 on an amd64 host is the entire problem: the Dockerfile compiles native modules, and emulated compilation is 5–10× slower. GitHub-hosted `ubuntu-24.04-arm` is **free for public repos** (this repo is public), so we build each arch on its own native runner and never load `setup-qemu-action` in the publish flow. This is the canonical Docker "Multi-platform images with GitHub Actions" pattern.

Trade-off accepted: dependence on the `ubuntu-24.04-arm` runner label (newer; GA Jan 2025). If GitHub ever degrades free arm runners, the fallback is a single-job QEMU build (today's flow) — recoverable by reverting this change.

## Decision 2 — Push-by-digest + per-arch smoke, merge gated on all arches

The user chose **smoke each arch's digest pre-merge**. Mechanics:

- Each build job pushes with `push-by-digest=true` → a single-platform manifest addressable by digest, **no tag**. It then `docker pull IMAGE@sha256:<digest>` (native, so it gets exactly its own arch) and runs the three smoke signals via `docker inspect`.
- The `:<version>` / `:sha-<short>` manifest-list tags and the alias tags are created **only in the merge job**, which `needs:` both build jobs — so a single arch failing smoke means **no named tag is ever created**.

Forensic-evidence model changes (deliberately, for the better): today the immutable `:version`/`:sha-*` tags are pushed _before_ smoke and "remain as forensic evidence" on failure. Under push-by-digest, the **untagged per-arch digests** remain in the registry as the forensic artifact, and no `:<version>` tag is minted for a failed build at all. The spec scenarios are updated to assert "untagged digests remain; no version/alias tag created" rather than "the immutable version tag remains."

Digest hand-off uses `actions/upload-artifact` / `download-artifact` (the documented Docker pattern), not job outputs, because the digest is produced inside the matrix and merge needs both.

## Decision 3 — `refuse-to-overwrite-immutable-tag` moves to merge (preflight not worth a 3rd job)

The guard needs a GHCR login and the resolved version. Two placements considered:

| Option                              | Pros                                                                                | Cons                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Preflight job** before the matrix | Fails fast before two native builds run                                             | A 3rd job + extra checkout/login for a check that costs seconds; the wasted-build window is small                           |
| **In the merge job** (chosen)       | No extra job; guard sits right before tag creation where overwrite actually happens | If `:version` already exists, two builds run before we notice (acceptable — releases are rare and version collisions rarer) |

Chosen: guard in merge, immediately before `imagetools create`. Version resolution (strip `server-`/`v` prefix) is duplicated trivially in merge (it already exists today).

## Decision 4 — Runtime base: distroless glibc, NOT Alpine

The user asked for Alpine "or similar." Alpine is the wrong choice **here specifically**:

- Alpine uses **musl libc**. `@huggingface/transformers` (in-process embeddings) depends on **`onnxruntime-node`**, whose prebuilt binaries are **glibc-only** — there are no musl prebuilds for the platforms we ship. On Alpine the rebuild step (`pnpm rebuild … onnxruntime-node`) would fail or require building onnxruntime from source (huge, fragile).
- `better-sqlite3` + `sqlite-vec` would also need musl rebuilds.

Safe lighter base = **`gcr.io/distroless/nodejs22-debian12`** (glibc, Debian 12). It keeps everything that already works on bookworm-slim and drops the shell + apt + most of the OS userland.

Runtime-stage changes required by distroless (no shell, no `useradd`):

- `HEALTHCHECK` → **exec form**: `HEALTHCHECK … CMD ["node","-e","fetch(…)…"]` (current shell form needs `/bin/sh`, absent in distroless).
- Replace `RUN useradd -r -u 10001 … rembric` + `USER rembric` with **numeric `USER 10001:10001`**; `COPY --from=builder --chown=10001:10001 …`. The installer e2e pre-creates `./data` `0777`, so a numeric uid opens the DB fine.
- Entrypoint already `["node", "/app/dist/server-entrypoint.js"]` — distroless `ENTRYPOINT` is `node`, so keep the exec-form entrypoint (it overrides cleanly).

**Honest size expectation:** image is ~1.26 GB today; the model (~340 MB) + onnxruntime (~280 MB) are ~50 % and architectural. Distroless trims the OS layer only — expect **~1.26 GB → ~1.10–1.15 GB (~10 %)**, plus a real security win (no shell/package manager). The size-signal ceiling (currently 1500 MB) stays comfortably above; it is now checked per-arch.

Fallback if distroless proves troublesome in the installer e2e: stay on `node:22-bookworm-slim` for runtime (no size win, no risk). The base swap is independently revertable from the speed change.

## Decision 5 — Per-arch cache scopes

Today both arches share one `type=gha,mode=max` cache; with the matrix, each arch gets its own scope (`scope=publish-amd64` / `scope=publish-arm64`) so they don't evict each other and each restores only its own layers. (Keeps within GHA's 10 GB/repo cache budget better than one combined `mode=max` blob.)

## Decision 6 — Widen `docker-build-check` to mirror the publish path

`docker-build-check` is the PR-time safety net that stops a broken build from reaching a release publish. This change gives the publish two new risk surfaces — **native arm64** and the **distroless runtime** — that an amd64-only check cannot see. So the check is matrixed to mirror the publish:

| arch  | runner           | runtime build | dev build | runtime exercise                                                      |
| ----- | ---------------- | ------------- | --------- | --------------------------------------------------------------------- |
| amd64 | ubuntu-latest    | ✓             | ✓         | full installer e2e (`install.sh --server --up`)                       |
| arm64 | ubuntu-24.04-arm | ✓             | —         | boot smoke (`docker run` → `/healthz` 200 + "embedding model loaded") |

The distroless runtime logic is identical across arches, so amd64's e2e already validates it; the arm64 leg specifically guards **arm-native compilation + boot**. The boot smoke is cheap but decisive because the embedder loads **eagerly at boot** (`embedder.ts`) — a clean boot proves `onnxruntime-node` / `better-sqlite3` / `sqlite-vec` and the baked model work on arm64 glibc. The dev target stays amd64-only (it isn't published; it only needs build coverage).

Trade-off accepted: every PR now also runs an arm64 native runtime build (~2–3 min), up from amd64-only. Justified — the free arm runner makes it cheap, and the alternative is discovering arm/distroless breakage at release time, which is exactly what this job exists to prevent.

## Decision 7 — Image size: measured, not guessed; prune only what's provably safe

Build time is the goal; size is a byproduct. We measured the real image (arm64) rather than estimating:

| Component                             | Size   | Lever?                                           |
| ------------------------------------- | ------ | ------------------------------------------------ |
| node binary (in distroless base)      | 117 MB | ❌ floor for any Node base                       |
| distroless OS (non-node)              | ~30 MB | ❌ already minimal                               |
| q8 embedding model                    | 357 MB | ❌ architectural                                 |
| `onnxruntime-node`                    | 211 MB | ✅ ships darwin + win32 + both linux arches      |
| `onnxruntime-web`                     | 129 MB | ⚠️ ~120 MB `.wasm`, but coupled to dep internals |
| rest (sharp, transformers, sqlite, …) | ~91 MB | partial                                          |

**The base is NOT the lever** — 117 of its 147 MB is the Node binary, which any Node base must carry. Alpine is rejected (musl breaks `onnxruntime-node`). So distroless is already at the floor.

**Kept — `onnxruntime-node` cross-platform prune (−185 MB, zero fragility):** its loader is `require(\`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node\`)` (`dist/binding.js`), so on a single-arch Linux image every other platform/arch is provably unreachable. The **same lib runs** — no quality change. The prune operates on the `.pnpm`store layout that`pnpm deploy --legacy` preserves (`.pnpm/onnxruntime-node@_/node_modules/onnxruntime-node/bin/_/`), and **fails the build loudly** if the target binding is missing after pruning (guards against future layout drift — never a silent break or silent no-op). Measured result: 893 → **701 MB**, boot + eager embedder load confirmed.

**Rejected — `onnxruntime-web` `.wasm` prune (−120 MB):** would save more, but relies on `@huggingface/transformers` always selecting the Node backend (`onnx.js: ONNX = ONNX_NODE`). That couples the image to a dependency's internal backend-selection logic — a future bump could turn into a hard-to-diagnose CI failure. Per the explicit "no fragility for ~200 MB" constraint, it stays.

## Decision 8 — One composite action for the runtime build (DRY across CI + publish)

The runtime image is built in two workflows — CI's `docker-build-check` (load into daemon) and the release publish (push-by-digest). To avoid two drifting copies of the build config (`target: runtime`, cache, hf secret, platform), both now call a single composite action `.github/actions/build-runtime-image` with `mode: load | digest`. The divergent steps stay inline because they genuinely differ (installer e2e / boot smoke / per-arch digest smoke + merge) — over-abstracting those would hurt readability. The `target: runtime` invariant test now asserts against the action file (one source of truth) and that the publish workflow references the action.

## Spec drift cleaned up in passing

The current `development-environment` spec text references `docker/build-push-action@v5` and a `600 MB` size ceiling, but the implementation already uses `@v7` and a recalibrated `1500 MB`. Since this change rewrites the publish requirement, the modified text aligns to the implemented reality (`@v7`, 1500 MB, per-arch). No behavior change beyond the matrix/distroless work; just removing stale drift in the requirement being edited.

## Risks

- **arm64 native module compile differences** — low; bookworm-slim builder is glibc on both arches, same as today's emulated path, just native.
- **distroless + healthcheck** — exec-form `node -e` must work without a shell; verified pattern. Mitigated by the installer e2e bringing the image up and polling `/healthz`.
- **digest artifact hand-off** between matrix and merge — standard documented pattern; failure is loud (merge can't find a digest).
