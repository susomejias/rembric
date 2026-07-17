## 1. Implementation

- [x] 1.1 `bring_up` in `apps/plugin/install.sh`: `mkdir -p ./data && chmod 0777 ./data` immediately before the `docker compose up -d` call.
- [x] 1.2 Add a data-permission hint line to the health-check-timeout failure message.
- [x] 1.3 `sh -n apps/plugin/install.sh`.

## 2. Tests

- [x] 2.1 `install.test.ts`: non-interactive `--server --up` run asserts `./data` exists and is world-writable afterward.
- [x] 2.2 Run the `rembric-tui-installer-e2e` headless + local layers.

## 3. Spec + validation

- [x] 3.1 `tui-installer` spec delta: MODIFY "Server flow prepares files, generates the token, and optionally brings the stack up" — add the data-dir preparation step + a new scenario.
- [x] 3.2 `openspec validate installer-server-data-dir-permissions --strict`.
- [x] 3.3 `pnpm typecheck`, `pnpm lint`, full `pnpm test`.
- [x] 3.4 Commit, `openspec archive --yes`, `openspec validate --specs`, push, open PR closing #253.
