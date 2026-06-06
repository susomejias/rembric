# Tasks: dashboard-self-update

## 1. Update check

- [x] 1.1 Implement `apps/server/src/services/update-check.ts`: lazy GitHub Releases `latest` fetch with ETag, semver compare against `REMBRIC_VERSION`, 24h in-memory cache, prerelease filtering, `REMBRIC_UPDATE_CHECK=off` gate, silent failure. Co-located unit tests (mocked fetch) cover: newer/equal/older versions, off-gate, network failure, ETag 304, prerelease skip.
- [x] 1.2 Expose update info (current, latest, publishedAt, changelog body, release URL) to the dashboard layer via a single accessor used by `dashboard-router.ts`.

## 2. Capability detection

- [x] 2.1 Implement `apps/server/src/services/self-update/engine-api.ts`: zero-dependency Engine API client over `node:http` `socketPath` (ping, container inspect, image pull with progress stream, container create/start/stop/rename/remove), versioned path prefix per design D4/open question. Unit tests against a mocked unix-socket HTTP server.
- [x] 2.2 Implement `apps/server/src/services/self-update/capability.ts`: socket existence + ping, self-container resolution (hostname → inspect, `rembric` name fallback), tag-pin detection from `Config.Image` with `process.env.REMBRIC_VERSION` fallback, resulting state `available | pinned | manual`. EACCES degrades to `manual` with one informational log line. Unit tests for all quadrants + perms degradation.
- [x] 2.3 Verify zero-action compatibility: test that constructing the server with no socket present produces no Docker calls, no warnings, and capability `manual` (regression test named after the requirement).

## 3. Update execution

- [x] 3.1 Implement pre-update backup in the orchestrator: `VACUUM INTO /data/backups/pre-update-v<target>-<ts>.sqlite`, abort-on-failure, retention of 3 most recent pre-update files. Unit tests: success, failure aborts before any container call, retention prune.
- [x] 3.2 Implement `apps/server/src/services/self-update/orchestrator.ts`: state machine (idle → backup → pull → launching-helper → restarting | failed) driven by dashboard endpoints, pull progress captured from the Engine API stream, refusal with no side effects when state is `pinned` or `manual`. Unit tests with mocked engine-api.
- [x] 3.3 Implement `apps/server/src/scripts/upgrade-helper.ts` (compiled into `dist/`): inspect old → derive identical create payload (ports, volumes, env, labels incl. compose labels, restart policy, networking) with new image → stop → rename → create+start under original name → poll `/healthz` with bounded timeout → success: remove old + self; failure: remove replacement, restore name, restart old, exit non-zero leaving its container for logs. Unit-test the payload derivation and the rollback branch against mocked engine-api.
- [x] 3.4 Wire the helper launch: create the upgrader container from the freshly pulled image with alternate entrypoint, socket bind-mount, and old-container-id/target-image parameters.

## 4. Dashboard surface

- [x] 4.1 Brand badge: extend `apps/server/src/dashboard/components.ts` brand block (sidebar, mobile bar) with the update badge fed by update-check; no badge when no info. Update `components.test.ts`.
- [x] 4.2 Update modal in new `apps/server/src/dashboard/update.ts`: version diff, `formatTs` publication time, changelog rendered from release body, GitHub link, "Later" per-version dismissal (localStorage), capability-dependent primary action (button / pinned explanation / copy-paste command + docs link). CSS in `apps/server/src/dashboard/styles/` (no inline styles, locked tokens).
- [x] 4.3 One-click trigger as a `<form>` with `data-confirm` + `data-confirm-tone="danger"`, copy stating stop/replace/restart + backup-first.
- [x] 4.4 Progress view: step list (backup, pull with progress, restart, verify) polling `GET /dashboard/update/status`; connection errors render as the restart step; then poll the session-authenticated version endpoint and auto-reload when the version changes. Failure-before-swap shows reason and leaves dashboard functional.
- [x] 4.5 Router endpoints in `apps/server/src/server/dashboard-router.ts`: trigger (POST, CSRF-protected, rejects unless `available`), status (GET), version probe (GET, dashboard-session-authenticated). Extend `dashboard-e2e.test.ts`: badge render, modal quadrants (`available`/`pinned`/`manual`), trigger rejection when not `available`, zero-action boot (no socket → healthz OK, dashboard OK, no new warnings).

## 5. Deployment + docs

- [x] 5.1 Add the commented socket-mount line to `docker-compose.yml` with a one-line pointer to `docs/updates.md` (terse, per infra-comment convention).
- [x] 5.2 Write `docs/updates.md`: zero-action notification behavior, enabling one-click (uncomment or `docker-compose.override.yml` + `group_add` GID guidance), explicit root-equivalent warning, pinned-tag behavior, backup location/retention, manual recovery for an interrupted swap (`docker rename` + `docker start`), manual rollback (old image + backup restore).
- [x] 5.3 README: add "auto-updater from the UI" to the features section linking to `docs/updates.md` (respect open-source-distribution README requirements: no deprecated install mechanisms, keep existing nav links intact).

## 6. Validation

- [x] 6.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` green; confirm no new runtime deps in `apps/server/package.json` (self-update dependency requirement).
- [x] 6.2 OPERATOR-ASSISTED: end-to-end smoke on a host with Docker — run the image with socket mounted + `latest` tag, point update-check at a stubbed release (or temporarily lower the running version), execute one-click, verify: backup file created, container swapped with config preserved, page auto-reloads on new version, old container removed. Then repeat with a pinned tag (button disabled + explanation) and without socket (copy-paste quadrant, no warnings in logs).
- [x] 6.3 OPERATOR-ASSISTED: rollback drill — make the replacement fail its healthcheck (e.g. bogus target image/entrypoint) and verify the upgrader restores the old container under its original name and the deployment keeps serving.
