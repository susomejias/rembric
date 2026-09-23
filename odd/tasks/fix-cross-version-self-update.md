# Fix cross-version self-update (0.28.8 → Next.js images)

## Contract

Production incident 2026-09-23: a v0.28.8 deployment's dashboard one-click update pulled the
v0.28.10 image and its ephemeral upgrader exited 1 with
`MODULE_NOT_FOUND /app/dist/scripts/upgrade-helper.js`. The old orchestrator (historical tag
`server-v0.28.8`) hardcodes the upgrader entrypoint
`['/nodejs/bin/node', '/app/dist/scripts/upgrade-helper.js']`; the Next.js runtime image
(`apps/web/Dockerfile`) stopped shipping that path, so every one-click update from ≤0.28.8 to
≥0.28.10 fails before any container swap (the failed helper never touches the live container —
verified against `/tmp/rembric-v0288-upgrade-helper.ts:138-142` execution order and the owner's
healthy 8-day-old container).

Owner-authorized: compatibility fix + new release + documented known issue with manual steps
(`docker compose pull && docker compose up -d` — NOT `docker compose down`). RDD explicitly off
for this recovery line (owner decision); ordinary functional verification still mandatory.
Branch: `fix/cross-version-self-update` off `main`. Conventional Commits; hooks not bypassed.

## Key facts (verified)

- Old helper is ESM, imports only `../services/self-update/engine-api.js`; engine-api imports
  only `node:http` (zero-dependency contract, `openspec/specs/self-update`).
- `deriveCreatePayload` deliberately omits `Entrypoint`/`Cmd`/`Healthcheck` → the NEW image's
  entrypoint (`/nodejs/bin/node /app/apps/web/server.js`), USER 10001 and HEALTHCHECK win.
  Retained from the old container: `Env`, `Labels`, `ExposedPorts`, `User`, `WorkingDir`,
  `HostConfig`, `NetworkingConfig` aliases. Compose labels ride along.
- Next standalone tracing does NOT ship `packages/core/dist` wholesale; relying on it is
  forbidden. The compat files must be COPYed explicitly into `/runtime/dist/` with an explicit
  `package.json { "type": "module" }` scope at `/app/dist/`.
- Required layout for the old import to resolve:
  `/app/dist/scripts/upgrade-helper.js` + `/app/dist/services/self-update/engine-api.js`.
- Regression boundary (red on current `0.28.10` image, green on fixed image):
  `docker run --rm --entrypoint /nodejs/bin/node IMAGE /app/dist/scripts/upgrade-helper.js`
  with no env must exit 2 with the required-env diagnostic, never MODULE_NOT_FOUND.

## Tasks

- [x] H1 Recreate the upgrader as a compat script under `packages/core` (source
      `packages/core/src/scripts/upgrade-helper.ts` + existing core `tsc` build emitting
      `dist/scripts/upgrade-helper.js` next to `dist/services/self-update/engine-api.js`),
      transplanted from the historical helper with minimal semantic change; unit tests for
      `deriveCreatePayload`, `parseHealthTimeoutMs`, rollback paths beside it. DONE — writer
      mueiegm2-j-q0se; 15/15 core tests; mutation RED (Env retention drop) observed and reverted.
- [x] H2 `apps/web/Dockerfile`: COPY the compiled compat files into `/runtime/dist/` with the
      `type: module` scope; add a build gate asserting both files exist (same style as the
      existing release-identity gate). DONE.
- [x] H3 Publishing smoke: per-arch step that runs the helper with no env and asserts exit 2 +
      diagnostic (fails loudly on MODULE_NOT_FOUND). Wire into `.github/workflows/docker-publish.yml`
      and keep the invariants test guarding the contract. DONE — invariants 107/107 (guard
      mutation RED observed and reverted).
- [x] H4 Local rehearsal BEFORE release — OBSERVED 2026-09-23, all synthetic data, cleaned up:
  - Candidate built locally (`rembric-candidate:compat` from working tree).
  - Probe: `docker run --entrypoint /nodejs/bin/node IMAGE /app/dist/scripts/upgrade-helper.js`
    no env → `exit=2` + required-env diagnostic; `/app/dist/package.json` = `{"type":"module"}`;
    engine-api.js present. RED boundary already established by the owner's production log
    (MODULE_NOT_FOUND against published 0.28.10) — not re-pulled locally.
  - Swap R1 (default port): 0.28.8 container (synthetic token, temp data, compose labels) →
    helper run exactly as the old orchestrator launches it (root, socket bind) → `upgrade
complete`; same container name on candidate image, healthy, `/healthz` reports the new
    version, port map + labels + user 10001 preserved, data dir untouched (marker + db intact).
    Helper exit 137 on success = pre-existing self-removal force-kill, same as the historical
    helper; orchestrator is fire-and-forget, unaffected.
  - Swap R2 (`REMBRIC_PORT=8799` inherited from old Env): replacement listened on 8799, passed
    the new image's env-aware healthcheck, data intact.
  - Rollback R3 (broken target image, `REMBRIC_UPGRADE_HEALTH_TIMEOUT_MS=20000`): `upgrade
failed → rolling back → rollback complete`; old 0.28.8 restored healthy on same name/port,
    broken replacement removed, data intact, helper exit 1.
  - UI END-TO-END R4 (real 0.28.8 dashboard): Compose project from the repo compose file pinned
    to a local registry serving 0.28.8 as `latest` (tag non-semver → capability `available`,
    socket mounted, `group_add`), stub release feed offering `server-v0.28.11`, candidate
    pushed to the registry. Playwright drove the REAL UI: token login → per-version modal →
    `UPDATE TO v0.28.11 →` → destructive-action confirm → progress view (backup/pull steps
    observed) → orchestrator created `pre-update-v0.28.11-*.sqlite`, pulled the candidate,
    launched the helper → swap completed → server healthy on the candidate image, version
    0.28.10, marker + migrated DB intact, old container and upgrader removed → dashboard login
    again renders the NEW overview on the same session. Screenshots archived at
    /tmp/rb-ui-shots/ (offer, confirm, progress, reloaded-new); environment cleaned up.
  - FINDING (documented in docs/updates.md): one-click from ≤0.28.9 with a custom
    `REMBRIC_PORT` always rolls back — the replacement inherits the OLD image's healthcheck
    (hardcoded 8787) instead of the env-aware compose healthcheck, never reaching healthy in
    150s. Fails safe; manual command is the path. Observed live in the first UI attempt.
  - FINDING: swapping onto the SAME version also rolled back when the image healthcheck could
    not pass (port artifact above) — the rollback path is exercised against real containers,
    not only fake engines.
- [x] H5 Docs: known-issue sections in `docs/troubleshooting.md` and `docs/updates.md`
      (symptom, safe manual steps `docker compose pull && docker compose up -d`, pinned-version
      note, fixed-in version), stating down is unnecessary. DONE.

## Acceptance

- Current `:0.28.10` fails the H3 probe; the candidate image passes it on both architectures.
- H4 swap and rollback observed locally with synthetic data; data dir untouched by failures.
- Docs reviewed; no `docker compose down` in any runbook.
- Hooks pass; no commit/push beyond owner-authorized work units on the feature branch.

## Forward-compatibility guard (owner requirement)

- The compat helper is a FLOOR, not a ceiling: it only serves updates INITIATED by ≤0.28.9
  installs. The current Next runtime has no operational import of the orchestrator (verified:
  no `selfUpdate`/`upgrade-helper`/`update/start` references in `apps/web/src` outside tests),
  so it cannot break updates between future versions.
- The probe asserts the FROZEN external contract of the old orchestrator (env names, exit 2,
  diagnostic text) — never helper internals — so helper evolution stays free while the probe
  stays valid.
- If a future image ships its own newer helper at the same path, the old orchestrator runs that
  newer file from the target image; shipping both is harmless (separate `/runtime/dist` tree,
  not traced into the Next server).
- Removing the compat files later (once the ≤0.28.9 fleet is gone) is a deliberate act that
  must update the invariants guard and the smoke step in the same change — test-enforced
  coupling, never silent breakage.
