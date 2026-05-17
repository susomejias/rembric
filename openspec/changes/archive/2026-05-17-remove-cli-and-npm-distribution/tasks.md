## 1. Spec deltas (already written; verify only)

- [x] 1.1 Verify `specs/projects/spec.md` contains REMOVED requirement "Projects MUST be creatable from a dedicated CLI subcommand" with Reason + Migration.
- [x] 1.2 Verify `specs/sessions/spec.md` contains REMOVED requirement "The CLI MUST expose `rembric session delete <id>` and `--include-deleted`" with Reason + Migration.
- [x] 1.3 Verify `specs/consolidation/spec.md` contains MODIFIED "The consolidation MUST run automatically on a schedule" with the "Manual run via HTTP" scenario replacing "Manual run via CLI".
- [x] 1.4 Run `openspec validate remove-cli-and-npm-distribution --strict` and confirm it passes.

## 2. Server entrypoint refactor

- [x] 2.1 Create `src/server-entrypoint.ts` as a ~10-line script with a top-of-file `#!/usr/bin/env node` shebang that imports `startCli` from `./server/index.js` and invokes it inside an async IIFE. On rejection, log `rembric: <message>` to stderr and `process.exit(1)`.
- [x] 2.2 Delete `src/cli.ts`.
- [x] 2.3 Confirm `src/server/index.ts::startCli` does not import anything from `src/cli/*` (it shouldn't — `startCli` is the server boot entry; the operator subcommands lived alongside it but did not call back into it).

## 3. Delete the operator CLI surface

- [x] 3.1 Delete `src/cli/token-cli.ts`.
- [x] 3.2 Delete `src/cli/project-cli.ts`.
- [x] 3.3 Delete `src/cli/session-cli.ts`.
- [x] 3.4 Delete `src/cli/consolidation-cli.ts`.
- [x] 3.5 Delete `src/cli/db-migrate.ts`.
- [x] 3.6 Delete `src/cli/server-status.ts`.
- [x] 3.7 Delete `src/cli/llm-ping.ts`.
- [x] 3.8 Delete `src/cli/cli.test.ts`.
- [x] 3.9 Confirm `src/cli/` directory is empty. If empty, `rm -rf src/cli`.
- [x] 3.10 Run `grep -RIn "src/cli\|from.*cli/" src/ --include='*.ts'` and confirm there are zero hits (any residual import must be cleaned up before continuing).

## 4. Drop the embeddable library facade

- [x] 4.1 Delete `src/index.ts` (factory `createServer` re-export).
- [x] 4.2 Run `grep -RIn "from.*['\"]\\.\\./index\|from.*['\"]\\./index" src/ --include='*.ts'` and confirm zero hits.

## 5. Drop the npm publish smoke test

- [x] 5.1 Delete `scripts/smoke-pack.mjs`.
- [x] 5.2 Run `grep -RIn "smoke-pack\|smoke_pack" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist` and confirm zero hits.

## 6. package.json cleanup

- [x] 6.1 Remove the `publishConfig` block from `package.json`.
- [x] 6.2 Remove the `bin` map (only contained `rembric`).
- [x] 6.3 Remove the `main` field.
- [x] 6.4 Remove the `exports` field.
- [x] 6.5 Remove the `files` field (only relevant for `npm pack`).
- [x] 6.6 Remove the `prepack` script.
- [x] 6.7 Update the `start` script: `"start": "node dist/server-entrypoint.js"`.
- [x] 6.8 Remove `commander` from `dependencies`.
- [x] 6.9 Run `pnpm install` to regenerate `pnpm-lock.yaml` without `commander`. **Note:** also added `"private": true` as a belt-and-suspenders marker so `pnpm publish` cannot accidentally fire even if the workflow regresses; also dropped the `types` package field (was `./dist/index.d.ts`, dead after `src/index.ts` removal).

## 7. Docker entrypoint refactor

- [x] 7.1 In `Dockerfile`, update the `runtime` stage: `ENTRYPOINT ["node", "/app/dist/server-entrypoint.js"]` and delete the `CMD ["start"]` line.
- [x] 7.2 In `Dockerfile`, update the `dev` stage `CMD` (the `sh -c` chain): replace `exec tsx watch src/cli.ts start` with `exec tsx watch src/server-entrypoint.ts`. The preceding boot chain (`build:css`, `copy-assets`, `seed-dev.ts --reset`) is unchanged.
- [x] 7.3 Confirm `docker-compose.yml` (production target) does not reference `cli.ts` or `start` subcommand. (It shouldn't — it inherits from the Dockerfile's ENTRYPOINT.)
- [x] 7.4 Confirm `docker-compose.dev.yml` does not override the dev stage's CMD with a `cli.ts` path.

## 8. CI/CD cleanup

- [x] 8.1 In `.github/workflows/release-please.yml`, delete the entire `publish` job (the npm publish to GitHub Packages). Keep the `release-please` job and the `publish-docker` job (the latter is a `workflow_call` to `docker-publish.yml`).
- [x] 8.2 In `.github/workflows/ci.yml`, delete the step labeled `Smoke test (install tarball + npx rembric llm ping)`. Keep all other steps (Install, Lint, Typecheck, Test, Build).
- [x] 8.3 Confirm `.github/workflows/docker-publish.yml` does not import or call anything related to npm.

## 9. Documentation: top-level

- [x] 9.1 In `README.md`, delete the "Operating the CLI" section (table of subcommands around lines 248-260). Replace with a single sentence pointing operators at `/dashboard` for daily work and at the MCP/HTTP API for programmatic use.
- [x] 9.2 In `README.md`, delete the "Running without Docker (power users only)" section (around lines 336-352). Drop any "npm path is secondary" copy.
- [x] 9.3 In `README.md`, replace any remaining inline references to `rembric token create`, `rembric project create`, `rembric consolidation run-now`, etc. with the dashboard URL or MCP equivalent.
- [x] 9.4 In `CLAUDE.md`, delete the line "The CLI exposes subcommands once built: `rembric project create|list`, `rembric session list|delete`, `rembric token create|revoke`. See README 'Operating the CLI'." (around line 27).
- [x] 9.5 In `CLAUDE.md`, update the consolidation manual-trigger line (around line 131): `rembric consolidation run-now` → `POST /admin/consolidation/run` (admin token required) or the dashboard button at `/dashboard/consolidation`.
- [x] 9.6 In `docs/troubleshooting.md`, replace `rembric status` recipes with `curl -H "Authorization: Bearer $REMBRIC_ADMIN_TOKEN" http://127.0.0.1:8787/healthz`.
- [x] 9.7 In `docs/troubleshooting.md`, replace the two `rembric llm ping` recipes ("reports `network` / `timeout`" and "reports `auth`") with `curl` recipes against the configured LLM endpoint (probe `/v1/models` with the configured auth header; document the typical error shapes — connection refused → network/timeout, 401/403 → auth).
- [x] 9.8 In `docs/agents.md`, repoint all ~5 references to `rembric token create` (lines around 19, 74, 223, 301) to `/dashboard/tokens`.

## 10. Documentation: plugin tree

- [x] 10.1 In `plugin/README.md`, repoint the line "issued by `rembric token create`" to `/dashboard/tokens`.
- [x] 10.2 In `plugin/.hermes-plugin/README.md`, repoint the three references to `rembric token create` / `rembric token list` to `/dashboard/tokens`.
- [x] 10.3 In `plugin/.claude-plugin/plugin.json`, update the `userConfig.api_token.description` field from "Bearer token issued by `rembric token create`. Stored in the system keychain." to "Bearer token issued from /dashboard/tokens. Stored in the system keychain."
- [x] 10.4 In `plugin/.codex-plugin/plugin.json`, update the equivalent `userConfig` description string for the `REMBRIC_API_TOKEN` env var. **Note:** Codex's manifest has no `userConfig` field (Codex doesn't support it — verified at `plugin/.codex-plugin/plugin.json:1-15`). No-op task.
- [x] 10.5 In `plugin/.hermes-plugin/plugin.yaml`, update the `description: "Bearer token issued by 'rembric token create'."` line to reference `/dashboard/tokens`.
- [x] 10.6 Add an entry to `plugin/CHANGELOG.md` under an `[unreleased]` heading documenting: "Updated userConfig descriptions to reference /dashboard/tokens instead of the removed `rembric token create` CLI subcommand. No bump of plugin manifest versions — the bridge MCP surface is unchanged."
- [x] 10.7 **Do NOT bump** the `version` field in any of the three plugin manifests. Verify all three remain at their current version (per Decision 4 in `design.md`). All three confirmed at `0.6.0`.

## 11. Verification

- [x] 11.1 `pnpm run typecheck` — must pass with zero errors.
- [x] 11.2 `pnpm run lint` — must pass with zero errors.
- [x] 11.3 `pnpm test` — full vitest suite + Hermes Python tests; must pass. **Result:** 37 files / 418 vitest tests passing + 28 Hermes Python tests passing. Pre-change baseline was 424 vitest tests; the 6-test drop comes from deleting `src/cli/cli.test.ts` (small) **and** `src/test/packaging.test.ts` (6 tests — the npm-pack tarball shape guardrail, which became permanently red and obsolete after `package.json` lost `bin`/`main`/`exports`/`files`). Deletion of `packaging.test.ts` was not in the original task list; logging it here for the PR description.
- [x] 11.4 `pnpm run build` — must produce `dist/server-entrypoint.js` (replacing `dist/cli.js`) and complete cleanly. Confirmed: `dist/server-entrypoint.js` (276 bytes) exists, `dist/cli.js` and `dist/index.*` are gone.
- [x] 11.5 `openspec validate remove-cli-and-npm-distribution --strict` — must pass.
- [x] 11.6 `pnpm run format:check` — must pass. (Required one `pnpm run format` pass to normalize `RELEASING.md` table alignment + `design.md` line wrapping after the in-flight Decision 3 correction; both auto-fixed.)
- [x] 11.7 Run `grep -RIn "rembric token\|rembric project\|rembric session\|rembric consolidation\|rembric llm\|rembric status\|rembric db migrate" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=openspec/changes/archive` — expect zero hits outside the active change's own files and CHANGELOG.md history. **Result:** zero hits outside change/archive/CHANGELOG. Also caught and fixed 4 in-code residual mentions (src/server/http.ts, src/dashboard/consolidation.ts, src/db/schema/agent-sessions.ts, src/consolidation/scheduler.ts) plus the dev-stack CMD snippet in CLAUDE.md line 38.
- [x] 11.8 Run `grep -RIn "src/cli\|dist/cli\.js\|publishConfig\|npm publish\|smoke-pack\|createServer" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=openspec/changes/archive` — expect zero hits outside the active change's own files. **Result:** zero hits outside change/archive/CHANGELOG. Also caught and rewrote `RELEASING.md` (was end-to-end npm-publish flow) into a Docker-only release flow; updated `vitest.config.ts` coverage `exclude` list to drop `src/cli.ts` / `src/cli/**` / `src/index.ts` (no longer exist) and add `src/server-entrypoint.ts`; updated the `pkill` recipe in `.agents/skills/rembric-dashboard-ui/SKILL.md` to target the new entrypoint; updated a stale comment in `src/test/smoke.test.ts` referencing `dist/cli.js`. **Note on `createServer` audit:** 7 hits remain — all inside `src/test/{smoke,dashboard-e2e,mcp-integration}.test.ts` (using the internal factory), 1 in `src/server/index.ts` (the factory's definition), and 1 in `src/server/http.ts` (importing `createServer` from `node:net`, unrelated). All expected per Decision 3.

## 12. Operator smoke (manual)

- [x] 12.1 `pnpm run dev:docker:up` — confirm the dev stack boots, dashboard at `http://127.0.0.1:8788` renders, and the boot chain log includes the seed output. Ctrl-C to stop. **Operator-confirmed by author: dev stack arranca correcto con el nuevo entrypoint.**
- [x] 12.2 `docker compose build` against the production `runtime` target locally — confirm the build succeeds and `docker run --rm rembric:dev` starts the server with the new entrypoint. Tail logs for ~5s to confirm `[bootstrap] server listening` (or equivalent) appears. **Done in CI: `docker build --target runtime` succeeded; ephemeral `docker run` on port 18799 showed the boot banner ending with `✓ MCP endpoint`, `✓ Dashboard`, `✓ Healthcheck` lines — the new `ENTRYPOINT ["node", "/app/dist/server-entrypoint.js"]` boots identically to the prior CLI entrypoint.**
- [x] 12.3 Hit `curl -H "Authorization: Bearer $REMBRIC_ADMIN_TOKEN" http://127.0.0.1:8787/healthz` — must return 200 with the version field reading `0.14.0` (or whatever the release-please bump lands at). **Done: `200 {"ok":true,"version":"0.13.0"}` with bearer; `401` without bearer; `/dashboard` returns 302 to login (cookie missing); `/mcp` POST without bearer returns 401. All auth surfaces unchanged. Version field shows 0.13.0 because release-please has not yet proposed the next bump; release-please will land `0.14.0` from the `feat!` commit in this PR.**

## 13. Commit + PR

- [x] 13.1 Commit with a single conventional-commits message: `feat!: remove CLI operator subcommands and npm distribution (BREAKING CHANGE: ...)`. **Happening immediately after this archive operation; the archive + all implementation diffs land in the same commit per author direction.**
- [x] 13.2 Open the PR. Body must reference `openspec/changes/remove-cli-and-npm-distribution/` and call out: BREAKING CHANGE on the CLI surface, no impact on HTTP/MCP/dashboard surfaces, no plugin manifest bumps required. **Deferred to author — the commit is being created now; the author will decide whether to push to a new branch + PR or to merge directly. The PR description shape is captured in `proposal.md` + the commit message.**
- [x] 13.3 After PR merges and the release-please bump PR lands and merges: `/opsx:archive remove-cli-and-npm-distribution`. **Archive happening NOW (pre-PR, per author direction) — the archive move + spec sync goes into the same atomic commit as the implementation. Deviates from the strict "archive post-merge" workflow but is coherent because the change is already validated end-to-end (typecheck/lint/test/build/docker-smoke) and the author is the sole reviewer.**
