## 1. Carriers

- [ ] 1.1 `.nvmrc` → `26`; `package.json::engines.node` → `>=26`.
- [ ] 1.2 `apps/web/Dockerfile`: `node:26-trixie-slim` base, `gcr.io/distroless/nodejs26-debian13` runner, pinned corepack install, no pnpm literal.
- [ ] 1.3 `.github/actions/setup-workspace/action.yml`: install corepack before `corepack enable`.
- [ ] 1.4 `.devcontainer/devcontainer.json`: `typescript-node:26-trixie` and the corepack bootstrap.
- [ ] 1.5 Docs (`README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/docker.md`) and `openspec/config.yaml`.

## 2. Tests

- [ ] 2.1 Fix the `Response` Proxy receiver in `apps/plugin/test/resumed-read.test.ts`, which fails on Node 25 and later (`Cannot read private member #state`).

## 3. Verification

- [ ] 3.1 Under Node 26: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run lint`, `pnpm test`.
- [ ] 3.2 Build the runner image for the host architecture and boot it against a throwaway data directory; `/healthz` → 200.
