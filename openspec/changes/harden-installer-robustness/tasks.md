# Tasks — harden-installer-robustness

## 1. Hook transport diagnostics

- [x] 1.1 `apps/plugin/scripts/_api.sh::rembric_post`: on curl failure print `[rembric] POST <path> failed (curl rc=<rc>)` to stderr (no body, no token), keep unconditional `return 0`; `sh -n` clean.
- [x] 1.2 `apps/plugin/scripts/session-stop.sh`: fix the stale header comment (Codex DOES wire PreCompact/PostCompact in `hooks.codex.json`) — comment-only, verify against the manifest.

## 2. Installer bring-up health

- [x] 2.1 `apps/plugin/install.sh::bring_up`: authenticated `/healthz` poll per design D2 (bounded attempts, `--max-time 2`, ≈30 s ceiling, POSIX + `set -e`-safe endings); success banner only on `{ok:true}`, include server version; timeout → `docker compose logs` hint, no success claim.
- [x] 2.2 Headless test in root `install.test.ts` covering: banner withheld on unreachable healthz; banner + version on mocked healthy response (reuse the suite's existing stubbing approach).

## 3. Bounded fetches & arg validation

- [x] 3.1 `apps/plugin/install.sh::fetch()`: add `--max-time 30 --retry 2 --retry-connrefused`; root `install.sh` curl gets the same bounds.
- [x] 3.2 Validate `--port` numeric 1-65535 at parse time; error before any `.env` write; headless test for `--port=abc`.

## 4. Bridge pin

- [x] 4.1 Resolve the current `mcp-remote` version (`npm view mcp-remote version`), replace `@latest` with the exact pin in `apps/plugin/bin/rembric-bridge.mjs`; record the version in the commit body.
- [x] 4.2 Leave the archive note: canonical `claude-code-plugin` spec prose bullet (`npx -y mcp-remote@latest`) must be updated at archive-time sync (already noted in the delta spec header).

## 5. opencode installer verifications

- [x] 5.1 Precise `mcp.rembric` detection per design D5 (scoped grep/awk, no jq dependency); keep all three branches (fresh / configured / manual-merge) reachable.
- [x] 5.2 Post-`sed` assertion that `$DOTENV_DEST` appears in the installed plugin file; abort loudly and remove the partial file on failure.
- [x] 5.3 Idempotency check: running the opencode install twice produces an empty diff (skill invariant).

## 6. Gates

- [x] 6.1 `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run e2e:installer` green; `sh -n` on every touched script.
- [x] 6.2 `openspec validate harden-installer-robustness --strict` green.
- [ ] 6.3 NOT VERIFIED HERE (operator/e2e): interactive pty smoke + full Docker `up` smoke from the `rembric-tui-installer-e2e` playbook — deferred to the consolidated e2e pass; list explicitly in the final report.
