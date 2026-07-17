## 1. Signal-handling fix (#259)

- [x] 1.1 `apps/plugin/install.sh::arrow_menu`: split the combined `EXIT INT TERM` trap into an `EXIT`-only restore trap and an `INT TERM` restore-then-`exit 130` trap.
- [x] 1.2 `apps/plugin/install.sh::_wm_anim`: add the same split-trap pattern around the cursor-hide/show pair (previously had no trap at all).
- [x] 1.3 `sh -n apps/plugin/install.sh` clean.

## 2. e2e validation (`rembric-tui-installer-e2e` playbook)

- [x] 2.1 Layer 1 — headless suite (`pnpm vitest run install.test.ts`) and `sh -n` on both entry points.
- [x] 2.2 Layer 2 — local install/uninstall round-trip (opencode) and server-prepare token generation via `REMBRIC_SRC`.
- [x] 2.3 Layer 3 — pty smoke: standard navigate-and-quit flow still works (banner, screen-clear, status table, clean exit).
- [x] 2.4 Layer 3 — dedicated Ctrl-C regression probe: reproduced the hang on the pre-fix script (via `git stash`), confirmed the fix exits cleanly with code 130 within ~1s.

## 3. Validation

- [x] 3.1 `openspec validate installer-signal-handling --strict` passes.
- [x] 3.2 Update issue #259 with the outcome after merge.
