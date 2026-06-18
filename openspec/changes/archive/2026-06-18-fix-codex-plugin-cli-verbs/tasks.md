## 1. Installer fix

- [x] 1.1 In `apps/plugin/install.sh` `marketplace_cmds()`, change the Codex block: `ins` → `codex plugin add rembric@rembric`; `rem` → `codex plugin remove rembric@rembric`; `upd` → `codex plugin marketplace upgrade rembric && codex plugin add rembric@rembric`. Leave the Claude block and the surrounding print/run logic untouched.
- [x] 1.2 `sh -n apps/plugin/install.sh` passes (POSIX-clean).

## 2. Docs

- [x] 2.1 `docs/agents.md` — change the Codex manual command block from `codex plugin install rembric` to `codex plugin add rembric@rembric`.
- [x] 2.2 `apps/plugin/README.md` — change the Codex CLI row in the manual-command table from `codex plugin install rembric` to `codex plugin add rembric@rembric`.

## 3. Test

- [x] 3.1 `install.test.ts` — update the Codex install scenario and the comma-separated multi-agent scenario to assert `codex plugin add rembric@rembric`; keep the update scenario's `not.toContain('codex plugin install')` guard (annotate it as "no such subcommand in the Codex CLI").

## 4. Specs (archived into authoritative on `/opsx:archive`)

- [x] 4.1 `codex-distribution` delta: the "Marketplace install resolves the relocated plugin tree" scenario and the `docs/agents.md` recommendation requirement quote `codex plugin add rembric@rembric`.
- [x] 4.2 `tui-installer` delta: the "Marketplace client prints CLI commands" scenario asserts the installer prints `codex plugin add rembric@rembric`.

## 5. Verification

- [x] 5.1 `pnpm --filter @rembric/server exec vitest run ../../install.test.ts` green (all installer tests).
- [x] 5.2 Live check against the real Codex CLI: `codex plugin marketplace add … && codex plugin add rembric@rembric` installs the plugin (cached under `~/.codex/plugins/cache/rembric/rembric/<version>/`).
