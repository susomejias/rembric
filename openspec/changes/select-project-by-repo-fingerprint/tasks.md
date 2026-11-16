## 0. Prerequisite

- [ ] 0.1 Archive `collapse-mcp-onto-stateless-sdk-v2` (its own tasks 3.12, 5.2 and 5.3 first), then confirm `pnpm run check:delta-freshness` and `pnpm run check:delta-sections` report no problem for this change's `projects`, `mcp-api`, `mcp-bridge` and `claude-code-plugin` deltas

## 1. Database

- [ ] 1.1 Add `project_repositories` (`fingerprint`, `project_id` → `projects.id`, `remotes` JSON, `created_at`, `created_by`; primary key `(fingerprint, project_id)`) and `repository_pending` (`id`, `fingerprint`, `kind` CHECK in `unbound`/`suggestion`/`unknown_remote`, `project_id` nullable, `remotes` JSON, `root_name` nullable, `first_seen_at`, `last_seen_at`, `discarded_at` nullable; unique on `(fingerprint, kind, coalesce(project_id, ''))`) plus `repository_pending_tokens` (`pending_id`, `token_id`) in `packages/db/src/schema/`, with migration `packages/db/src/migrations/0039_repository_bindings.sql`, so that `pnpm vitest run packages/db/src/schema/schema-drift.test.ts` passes with the three tables added to `packages/db/src/test-support/schema-inventory.ts`
- [ ] 1.2 Add repositories for both aggregates under `packages/db/src/repositories/`: scoped reads take the token's readable project ids as a required parameter, `admin*` reads serve the dashboard only, and no repository opens a transaction; `pnpm --filter @rembric/db test` passes with tests for uniqueness, dedup key, expiry filtering and the per-token live-row count
- [ ] 1.3 Confirm `apps/web/src/test/invariants.test.ts` stays green: the new tables are configuration, so their `DELETE`s need no append-only allow-list entry, and no `memory`, `sessions` or `memory_relations` statement is added

## 2. Core service

- [ ] 2.1 Add the error codes `project_unbound`, `repository_ambiguous`, `repository_already_bound`, `repository_fingerprint_unavailable` and `invalid_repository_fingerprint` to `packages/core/src/services/errors.ts`
- [ ] 2.2 Add a repository-binding service in `packages/core/src/services/` implementing resolve (visibility through the token's read reach, ambiguity, unknown-remote check and remote learning), pending recording (dedup, discard memory, `REMBRIC_REPO_PENDING_TTL_DAYS` default 14, `REMBRIC_REPO_PENDING_MAX_PER_TOKEN` default 20, no rows for read-only tokens or `null` fingerprints), bind, move, remove, discard and restore; it owns the transactions
- [ ] 2.3 Implement server-side remote normalization (scheme, user information, port, query, `.git`, trailing slash, scp-like form, lowercase) and test it with the `repository-binding` scenarios, including that `secret` from `https://user:secret@…` appears in no stored value
- [ ] 2.4 Write one RED test per `repository-binding` requirement scenario that the service can observe, then make each GREEN; `pnpm --filter @rembric/core test` passes
- [ ] 2.5 Run `node scripts/mutate.mjs` on each guard of 2.2 (token-reach filter, ambiguity, unknown-remote, read-only refusal, per-token cap, discard) and confirm the tests naming it go red; record the commands in the commit message

## 3. Server surfaces

- [ ] 3.1 Validate `X-Rembric-Repo-Fingerprint` in `apps/web/src/app/mcp/[[...path]]/route.ts` (exactly one value: 40 or 64 lowercase hex, or `unavailable`; otherwise `400 invalid_repository_fingerprint` before any tool runs) and carry it in `packages/core/src/server-context/request-context.ts`
- [ ] 3.2 Make `resolveEffectiveScope` in `packages/mcp/src/_shared.ts` refuse an unbound request (path-less with the header) with `project_unbound`, with a message that names only remedies the token can perform; extend `apps/web/src/test/mcp-http.test.ts` so `memory.save`, `memory.search`, `memory.context` and `memory.session_start` are refused on an unbound request and succeed on the same request without the header (control)
- [ ] 3.3 Extend `project.current` with `source: 'unbound'` and the `repository` field in `packages/mcp/src/project-tools.ts`, including the invisible-binding scenario
- [ ] 3.4 Add `project.bind_repository` (strict `{ slug }`, refusal order admin → header → project → already bound, annotations, description within `DESCRIPTION_MAX_LENGTH`) and update `apps/web/src/test/mcp-tool-surface.test.ts` for the third project tool
- [ ] 3.5 Add `apps/web/src/app/api/repositories/resolve/route.ts` with the strict body, the three outcomes, `409 repository_ambiguous`, and the same auth, lockout, rate limit and body bound as `/api/<slug>/*`; tests cover every `http-api` scenario of this change through the HTTP boundary, with a valid-request control
- [ ] 3.6 Run the `rembric-smoke-tests` skill against `pnpm run dev`: resolve a bound, an unbound and an ambiguous fingerprint over HTTP, and call `memory.save` on an unbound MCP connection; record the observed responses

## 4. Shared JavaScript resolver and bridge

- [ ] 4.1 Add `apps/plugin/mcp-bridge/rembric-project.mjs` (no dependency beyond `node:` builtins): `.rembric` walk to the checkout root, `git rev-parse --is-inside-work-tree`, `--is-shallow-repository` before `git rev-list --first-parent --max-parents=0 HEAD`, remote normalization, the resolve call and its outcome mapping, including "no connection" on any non-`unbound` failure
- [ ] 4.2 Test it against real scratch repositories created under `mktemp -d` (two-root merge, orphan branch, shallow clone, no commits, no git, nested `.rembric`, `.rembric` above the checkout root) and a stub server (bound, unbound, ambiguous, `404`, timeout)
- [ ] 4.3 Wire it into `apps/plugin/mcp-bridge/bridge.mjs` and `slug.mjs`: resolve once at startup, forward the header on every request inside git, exit non-zero without connecting when support is not proven; update `apps/plugin/mcp-bridge/bridge.test.ts` for every `mcp-bridge` scenario of this change
- [ ] 4.4 Extend the shared-module invariant in `apps/web/src/test/invariants.test.ts` so `rembric-project.mjs` exists once under `apps/plugin/` and is imported by the opencode plugin and the Pi extension
- [ ] 4.5 Differential check: in a `mktemp -d` copy of the base commit and in this branch, start the bridge outside git with and without `.rembric`/`REMBRIC_PROJECT_SLUG` and compare its stderr, endpoint and exit code; any difference is a regression to fix and pin with a test

## 5. Claude Code and Codex hooks

- [ ] 5.1 Update `apps/plugin/scripts/_api.sh`: `rembric_read_project_slug` walks to the checkout root; new `rembric_session_project` caches the first outcome under `${TMPDIR:-/tmp}/rembric-project/<session-id>` and resolves the fingerprint through `/api/repositories/resolve` on a miss
- [ ] 5.2 Switch every hook script that calls `rembric_read_project_slug` to `rembric_session_project`; `session-start.sh` resolves first and prints the unbound or conflict text; every other hook skips its POSTs on a non-slug outcome
- [ ] 5.3 Extend the shell tests so the same fixture repositories give the same outcome from `_api.sh` as from `rembric-project.mjs`, and an unbound session issues no `/api/<slug>/` request from any hook
- [ ] 5.4 **Operator-only**: run `.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md` for Claude Code and for Codex against a local dev server, in a bound checkout, an unbound checkout and a checkout with a conflicting root `.rembric`; measure the session-start resolve latency under Codex's hook budget (design Q2)

## 6. opencode

- [ ] 6.1 Resolve once per session in `apps/plugin/.opencode-plugin/plugin.ts` through `rembric-project.mjs`; update `apps/plugin/.opencode-plugin/plugin.test.ts` for the `opencode-plugin` scenarios of this change
- [ ] 6.2 **Operator-only**: run the e2e walkthrough for opencode in a bound and an unbound checkout

## 7. Pi

- [ ] 7.1 Resolve once per session in `apps/plugin/.pi-plugin/index.ts` through `rembric-project.mjs`, add the header to its MCP client, raise the unbound notification, and connect path-less only on `unbound`; update `apps/plugin/.pi-plugin/plugin.test.ts` (no new tracked file under `.pi-plugin/`, per the invariant that pins its four files)
- [ ] 7.2 **Operator-only**: run the e2e walkthrough for Pi in a bound and an unbound checkout

## 8. Hermes

- [ ] 8.1 Implement the cascade in `apps/plugin/.hermes-plugin/__init__.py` (walk, scoped default, fingerprint, resolve) with the same fixtures as 4.2; Python tests cover the `hermes-agent-plugin` scenarios of this change
- [ ] 8.2 **Operator-only**: run the e2e walkthrough for Hermes in a bound and an unbound checkout

## 9. Dashboard

- [ ] 9.1 Add the Repositories section to the project create and edit surfaces (`apps/web/src/components/dashboard/projects-sheets.tsx`): bound list with `<Time>` and `ConfirmSubmit tone="warn"` removal, pending list, bind-by-fingerprint field with format validation
- [ ] 9.2 Add the pending count to the projects list and a pending view with kinds, conflict move-or-add choice, unknown-remote actions, discard and a discarded view with restore, following the `rembric-dashboard-ui` skill
- [ ] 9.3 Component and action tests cover every `dashboard` scenario of this change; verify in the running app with the `next-dev-loop` skill

## 10. Documentation

- [ ] 10.1 Update `docs/agents.md`, `apps/plugin/README.md` and each client README: how a project is selected, unbound mode, how an admin binds a repository, `REMBRIC_REPO_PENDING_TTL_DAYS` and `REMBRIC_REPO_PENDING_MAX_PER_TOKEN`
- [ ] 10.2 At archive time, hand-edit what deltas cannot reach: `## Project slug selection` in `openspec/specs/claude-code-plugin/spec.md`, the hook-script requirement lines there and in `codex-distribution` that restate "read `${cwd}/.rembric`", so they point to `rembric_session_project`
- [ ] 10.3 At archive time, reconcile the MODIFIED `mcp-api` requirement "The MCP `initialize` response MUST ship a protocol-teaching `instructions` block" with `proactive-entity-recall`, which modifies the same requirement: whichever change archives second carries the other's text

## 11. Release

- [ ] 11.1 `pnpm run typecheck`, `pnpm run lint` and `pnpm test` pass on the branch
- [ ] 11.2 **Operator-only**: release the server before the plugin; confirm the published server answers `POST /api/repositories/resolve` before merging the plugin release PR
- [ ] 11.3 **Operator-only**: release the plugin with all five clients in one version
