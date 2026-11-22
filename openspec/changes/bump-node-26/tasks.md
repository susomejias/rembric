## 1. Carriers

- [x] 1.1 `.nvmrc` → `26`; `package.json::engines.node` → `>=26`.
- [x] 1.2 `apps/web/Dockerfile`: `node:26-trixie-slim` base, `gcr.io/distroless/nodejs26-debian13` runner, pinned corepack install, no pnpm literal.
- [x] 1.3 `.github/actions/setup-workspace/action.yml`: install corepack before `corepack enable`.
- [x] 1.4 `.devcontainer/devcontainer.json`: `typescript-node:26-trixie` and the corepack bootstrap.
- [x] 1.5 Docs (`README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/docker.md`) and `openspec/config.yaml`.

## 2. Tests

- [x] 2.1 Fix the `Response` Proxy receiver in `apps/plugin/test/resumed-read.test.ts`, which fails on Node 25 and later (`Cannot read private member #state`).

## 3. Verification

- [x] 3.1 Under Node 26: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run lint`, `pnpm test`.
- [x] 3.2 Build the runner image for the host architecture and boot it against a throwaway data directory; `/healthz` → 200.

## 4. Follow-up outside this change

- [x] 4.1 `@rembric/mcp-bridge` exits 1 ("transport failure: This operation was aborted") when stdin closes while an id-less request is still in flight. Under Node 26 the race hits `bridge.test.ts` "exits when stdin closes during a held-open SSE response" in 3 of 30 runs; on Node 22 it hit 0 of 12. Fixed by `exit-bridge-cleanly-on-stdin-close` (#562).
