## Context

The runtime image is distroless, and the native modules (`better-sqlite3`, `sqlite-vec`,
`onnxruntime-node`) are fetched or built in the builder and copied into the runtime unchanged.
The builder and the runtime must therefore share one Node ABI and a compatible glibc. Node 25
and later dropped corepack from the distribution, while the repository's pnpm pin relies on
corepack reading `packageManager`.

## Goals

- Move every Node carrier to the Node 26 LTS line in one step.
- Keep `packageManager` as the only place the pnpm version is written.
- Keep the distroless runtime and its `/nodejs/bin/node` path.

## Non-Goals

- No Node 25: it is end of life and has no distroless image.
- No change to the supply-chain knobs (`ignore-scripts`, `allowBuilds`, cooldown, exotic block).

## Decisions

### D1 — Node 26 on Debian 13 for both builder and runtime

Distroless publishes Node 26 only as `nodejs26-debian13`. The builder uses `node:26-trixie-slim`
so the bindings it fetches or compiles link against the same glibc the runtime ships. A
bookworm builder would also run (glibc is forward compatible), but matching releases removes
the question.

### D2 — Install corepack with npm at an exact version, not pnpm directly

`npm i -g --ignore-scripts corepack@0.36.0` and then `corepack enable`. corepack resolves pnpm
from `packageManager` and checks its signature against the registry keys, so the pnpm version
lives in one file. `npm i -g pnpm@11.1.2` would write the version a second time on every path,
and those copies drift; the spec already forbids hard-coded pnpm literals in CI. corepack
`0.36.0` declares `engines` `^22.22.2 || ^24.15.0 || >=26.0.0`, which covers Node 26.

### D3 — Remove the devcontainer image's global pnpm before installing corepack

`typescript-node:26-trixie` ships `pnpm@12.21.0` globally, which occupies the `pnpm` shim
(`npm i -g corepack` fails with `EEXIST`) and is not the pinned version. The
`postCreateCommand` uninstalls it first.

## Risks / Trade-offs

- Contributors on Node 22 or 24 must upgrade before `pnpm install` works again.
- The corepack version is written in three install paths. A future bump must touch all three.
