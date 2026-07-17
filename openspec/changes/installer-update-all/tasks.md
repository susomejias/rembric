## 1. Installer update-all (#262)

- [x] 1.1 `apps/plugin/install.sh`: add `do_update_all` (iterates `claude codex hermes opencode`, calls `do_client "$c" update` only where `vercmp` reports `update`, prints a skip line otherwise, prints a `Done: N updated, M skipped.` summary).
- [x] 1.2 Non-interactive dispatch: `--action=update` with no `--agent` or with `--agent=all` runs `do_update_all`; an explicit non-`all` `--agent=` list is unaffected.
- [x] 1.3 Interactive menu: add `all — update outdated` as the first entry in the Plugins section's "Which agent?" prompt, wired to `do_update_all`.
- [x] 1.4 `usage()` text documents the update-all invocation and the `all` agent alias.
- [x] 1.5 `sh -n apps/plugin/install.sh` clean.

## 2. `memory.about` guidance (#262)

- [x] 2.1 `apps/server/src/mcp/about-tool.ts`: update `plugins.note` — `update_all` is safe to run directly; status-first advice now scoped to the `subset` command.
- [x] 2.2 Confirm `about-tool.test.ts` still passes unmodified.

## 3. Testing

- [x] 3.1 `install.test.ts`: selective update (1 outdated + 3 not-installed), nothing-to-update (0 updated, exit 0), `--agent=all` alias, up-to-date agent correctly skipped.
- [x] 3.2 Interactive path verified with a real pty: menu entry renders, selection runs update-all, output matches the headless path against this machine's real installed state.

## 4. Validation

- [x] 4.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 4.2 `pnpm test` full suite green; `pnpm vitest run install.test.ts` green.
- [x] 4.3 `openspec validate installer-update-all --strict` passes.
- [x] 4.4 Update issue #262 with the outcome after merge.
