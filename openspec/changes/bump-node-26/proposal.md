## Why

Issue #363: the repository should leave Node 22. The first target, Node 25, is not viable. It
reached end of life on 2026-06-01 (last release `v25.9.0`, 2026-03-31). Distroless publishes no
`nodejs25` image (the `gcr.io/distroless/nodejs25-*` repositories have no tags), and the runtime
stage must be distroless (`/nodejs/bin/node` is pinned by the entrypoint, the HEALTHCHECK, the
Compose healthcheck, the self-update orchestrator and the publish smoke). corepack `>=0.35`
also excludes Node 25 in its `engines`. Node 26 has been Active LTS since 2026-10-28 and is
supported until 2029-04-30. `gcr.io/distroless/nodejs26-debian13` exists, and the install,
typecheck, lint and test suite run on it with the same result as on Node 22.

Node 25 and later no longer bundle corepack, which is why Dependabot's base-image bump (#295)
failed with `corepack: not found`. Every install path therefore needs an explicit, pinned
corepack install that keeps `package.json::packageManager` as the only pnpm version.

## What Changes

- **BREAKING (contributors):** `package.json::engines.node` rises from `>=22.13` to `>=26`, and
  `.nvmrc` moves to `26`. With `engine-strict=true`, `pnpm install` on Node 22 or 24 is refused.
- `apps/web/Dockerfile`: the installing stage moves to `node:26-trixie-slim`, and the runtime to
  `gcr.io/distroless/nodejs26-debian13`. Debian 13 on both keeps the builder's glibc equal to
  the runtime's. The runtime node path `/nodejs/bin/node` is unchanged.
- pnpm bootstrap on every path (Dockerfile, the `setup-workspace` CI action, devcontainer):
  `npm i -g --ignore-scripts corepack@0.36.0` followed by `corepack enable`. The Dockerfile no
  longer names a pnpm version (`corepack prepare pnpm@11.1.2` is removed).
- Devcontainer base moves to `mcr.microsoft.com/devcontainers/typescript-node:26-trixie`. Its
  preinstalled global pnpm is removed first so the corepack shim takes its place.
- Docs and `openspec/config.yaml` say Node 26.

## Capabilities

### Modified Capabilities

- `development-environment`: the Dockerfile base images, the devcontainer base and bootstrap,
  and the Node runtime coupling and pnpm bootstrap rules.
- `supply-chain-hygiene`: the engine floor and the base image named in the Dependabot scenario.

## Impact

- Operators: the published image runs Node 26 instead of 22. Data, the volume layout, the
  entrypoint and the healthcheck are unchanged.
- Contributors: Node 26 is required locally.
- CI: the workspace action installs corepack before enabling it.
- No database migration, no API change, no dependency change in the lockfile.
