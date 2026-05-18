## Context

The published image `ghcr.io/susomejias/rembric:latest` carries the **dev stage's `CMD`** instead of the runtime stage's `ENTRYPOINT`. Three independent root causes had to align for this to ship undetected:

1. **Dockerfile stage order is `builder → runtime → dev`.** `dev` is the last `FROM ... AS <name>` declaration in the file. `docker build` and `docker/build-push-action` without `--target` build the _last_ stage by default. The inline comment in the Dockerfile reads "the implicit final stage above (runtime)" — that assertion was wrong; runtime is not the last stage.

2. **`.github/workflows/docker-publish.yml` omits `target:` on the build-push step.** The corresponding `ci.yml` lint job _does_ pass `target: runtime` (and `target: dev`) for its build-check pair, so the runtime stage _appears_ validated on every PR. But CI only builds; it never inspects the published artifact's metadata, and the publish workflow is independent of `ci.yml`.

3. **`seed-dev.ts --reset` is unconditionally destructive.** The script's contract is "every `up` produces a fresh canvas with the same baseline counts" — designed for `docker-compose.dev.yml` only. It has no guard preventing it from executing against `./data:/data` (the prod bind-mount) if the dev `CMD` ends up running in a prod container. The destructive path has no `--yes-i-mean-it` gate.

When ANY of those three preconditions is fixed independently, the bug becomes a near-miss instead of an incident. This proposal fixes all three so the failure mode requires multiple independent regressions to recur.

## Goals / Non-Goals

**Goals:**

- The next `:latest` publish MUST be the runtime stage, with no `seed-dev`, no `tsx`, no `tsx watch` in the image's `Config.Cmd`/`Config.Entrypoint`.
- Reordering the Dockerfile stages makes `runtime` the implicit default target; any future edit that drops `target: runtime` from the publish workflow keeps producing the correct image.
- `seed-dev.ts --reset` becomes a no-op (with stderr + non-zero exit) when the env var `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1` is absent. The dev compose sets the env inline so the dev stack continues to work without operator intervention.
- CI/publish workflow runs a post-publish smoke test that fails the workflow if the just-pushed image carries `seed-dev` strings in its CMD. The retag of `:latest` only happens after the smoke test passes.
- Invariant tests assert: Dockerfile last stage is `runtime`; publish workflow contains `target: runtime`; `seed-dev.ts` has the env-var gate.

**Non-Goals:**

- Restoring the operator's data — that's an operational follow-up using the PBS backup (covered in the proposal's Impact section, executed outside the spec).
- Communicating to other users — single-user repo (the maintainer himself).
- Adding row-count health endpoints, automatic backups, or "data dir mismatch" first-boot guards. Considered for separate proposals once this fix lands and the dust settles.
- Removing the dev seed entirely. The dev stack genuinely needs the fresh-canvas baseline. Hardening the destructive gate is enough.
- Removing the dev Dockerfile stage. The dev image is still used by `pnpm run dev:docker:up` and is exercised by `ci.yml`'s build-check.

## Decisions

### Decision 1: Reorder the Dockerfile stages (`builder → dev → runtime`)

**Rationale:** Multi-stage Docker builds default to the _last_ stage when `--target` is omitted. Making `runtime` the last stage is the strongest single defense — every build invocation without an explicit target produces the correct image. The current order (`runtime` second, `dev` last) is what created the latent landmine; reversing it removes the landmine entirely.

**Alternatives considered:**

- _Keep order, rely on `target: runtime` in the workflow._ Rejected. One-line config that a future contributor can drop with no compiler/linter complaint. The publish smoke test in Decision 3 catches it post-build but only after burning CI minutes — making the default correct is cheaper.
- _Move `dev` to a separate `Dockerfile.dev`._ Rejected. The current single-file layout keeps both stages reviewable side-by-side and shares the apt/corepack install layers. Splitting trades one minor risk for the worse problem of "two files drift apart silently."
- _Use a buildx bake file with explicit targets._ Rejected. Adds a new tool/file for a problem solved by reordering five lines.

### Decision 2: Add `target: runtime` to `docker-publish.yml` even though Decision 1 makes the default correct

**Rationale:** Defense in depth. If someone reorders the Dockerfile back to `runtime → dev` (perhaps for stylistic reasons, or by accident during a merge), Decision 1 alone fails open. The explicit `target: runtime` makes the workflow's intent obvious and gives `git blame` a clear anchor when reviewing.

**Trade-off:** Slight redundancy (the value is now expressed twice — Dockerfile order _and_ workflow flag). The redundancy is the point.

### Decision 3: Post-publish smoke test inspects the pushed image's `Config.Cmd`

**Rationale:** Decisions 1 and 2 are pre-build configuration. The smoke test is a _runtime_ assertion against the actual artifact in the registry. It catches:

- Surprise reorderings of the Dockerfile by a future contributor.
- A new Dockerfile stage added after `runtime` that becomes the new "last".
- A regression in `docker/build-push-action@v5` that misinterprets `target:` (unlikely, but free to detect).
- Any other failure mode that produces a wrong-stage image while leaving the source code looking correct.

The check is implemented as a shell step that runs `docker pull` on the immutable `:sha-<short>` tag (which `docker/metadata-action@v5` produces and `build-push-action` pushes), then `docker inspect --format '{{.Config.Cmd}} {{.Config.Entrypoint}}'`, and `grep -q -v` against the forbidden substrings. The workflow fails before `:latest` and the version tags get pushed — because the smoke test runs between `docker push` and the retag step.

**Alternatives considered:**

- _Inspect the buildx output locally without pushing._ Rejected. The point of the smoke test is to verify what's _in the registry_, not what was built. A regression in `build-push-action`'s push step (compressing the wrong manifest, race in multi-arch tagging) is exactly the kind of thing local inspection wouldn't catch.
- _Run the image and curl healthz._ Rejected for V1. More moving parts (admin token, port mapping, network), more failure modes unrelated to the bug we're catching. The `docker inspect` check is sufficient because the bug is in the manifest, not in runtime behavior.

### Decision 4: Gate `seed-dev.ts --reset` on `REMBRIC_ALLOW_DESTRUCTIVE_SEED=1`

**Rationale:** Decisions 1-3 cover the publishing pipeline. Decision 4 protects against the _next_ class of bug: someone running the seed script in a context they didn't intend (manual `docker exec`, a misrouted CI job, a future feature that calls the seed programmatically). The env var is a "yes I really want to wipe data" handshake — present only in the dev compose, never in prod, never on operator workstations by default.

The dev compose (`docker-compose.dev.yml`) injects the env in its `environment:` block, so the dev stack contract (fresh-canvas-per-up) is preserved without operator intervention.

**Alternatives considered:**

- _Refuse `--reset` if `REMBRIC_DATA_DIR=/data` (the prod path) and accept it otherwise._ Rejected. Encodes the prod/dev distinction by data-dir path, but operators choose paths arbitrarily. Brittle.
- _Refuse `--reset` if any row count exceeds some threshold._ Rejected. Arbitrary heuristic; would fail open on a near-empty prod DB.
- _Require `--yes-i-mean-it` CLI flag instead of env var._ Considered. Env var chosen because the seed is invoked from a `CMD` inside the dev container's boot chain, where adding env vars is more idiomatic than threading CLI flags through `sh -c "..."` strings.

### Decision 5: Image stage `LABEL` + image size sanity check as independent smoke-test signals

**Rationale:** The post-publish smoke test in Decision 3 inspects `Config.Cmd`/`Config.Entrypoint` for forbidden substrings. That works, but it's brittle: a future change to the dev stage's CMD (e.g., switching from `tsx watch` to `node --watch`) might bypass the substring check while still shipping a destructive image. Two additional, _independent_ signals:

- **`LABEL rembric.stage=<runtime|dev>`** in the Dockerfile. The smoke test asserts the pushed image has `Config.Labels."rembric.stage" == "runtime"`. A wrong-stage publish fails the label check regardless of how the dev CMD changes over time.
- **Compressed image size** below an upper bound. The runtime stage is ~300 MB (prod node_modules only, no `tsx`/`vitest`/`drizzle-kit`/source tree). The dev stage is ~1.45 GB (full dev deps + `src/` + dev tools). A 500 MB threshold catches any wrong-stage publish without depending on labels or substrings at all.

Three independent signals (Cmd substring, image label, image size) reduce the probability that any single bypass slips through.

**Trade-off:** Three checks instead of one. Each is ~5 lines of shell in the workflow. The marginal cost is negligible; the marginal coverage is significant.

### Decision 6: Boot-time data-loss guard inside the server (refuse to start on massive row shrinkage)

**Rationale:** Decisions 1-5 cover the publishing pipeline. Decision 6 is the last line of defense: even if a buggy image somehow ships AND the seed env gate is bypassed AND the operator pulls the bad image, the server itself refuses to start when it detects a mass row deletion since the last clean shutdown.

The mechanism is intentionally simple to keep correctness obvious:

- On every successful startup AFTER migrations apply, the server reads a state-marker file `${REMBRIC_DATA_DIR}/.rembric-state.json` with shape `{ version: 1, last_seen_at: <ms>, counts: { memory: N, projects: M, sessions: S, tokens: T, prompts: P } }`.
- If the file exists, compare current counts against `last_known.counts`. For each table, if `current < last_known * 0.5`, flag a "data-loss event".
- If any table flagged AND `REMBRIC_ALLOW_DATA_SHRINKAGE !== '1'`, the server emits a multi-line stderr error (showing both count vectors and the offending tables), then `process.exit(78)` (EX_CONFIG).
- If the file does not exist (first boot, or operator manually deleted the marker), the server logs `[bootstrap] no prior state marker; treating as first boot` and proceeds.
- After successful startup, the server writes a fresh marker with current counts AND `last_seen_at: Date.now()`.
- A best-effort write happens on SIGTERM/SIGINT handler before `process.exit()`; if the process is killed without graceful shutdown, the marker is whatever the periodic-write (every 60s) last produced.

This would have caught the original incident the **first** time `seed-dev.ts --reset` ran inside the prod container: the marker said `memory: 82`, current = `memory: 0` (right after the wipe, before the seed inserts), → 100% loss → refuse to start. The operator sees a loud error in `docker compose logs` instead of a silent wipe.

**Alternatives considered:**

- _Absolute threshold instead of ratio (e.g., "if memory < 10 after having any rows previously, refuse")._ Rejected. A new project with 5 memories is legitimately small. A 50% drop ratio scales naturally with deployment size.
- _Refuse start on ANY row decrease._ Rejected. Legitimate decreases happen (dashboard maintenance purges, admin deletions). The 50% threshold targets accidental mass loss, not normal operator-initiated cleanups.
- _Store the marker in the DB itself._ Rejected. If the DB is wiped, the marker is wiped too — defeating the check. Filesystem-level marker survives DB-table wipes.
- _Refuse for ALL tables on ANY shrinkage (no threshold)._ Rejected. Too noisy. Operator legitimately archives memories via dashboard, which doesn't reduce row counts but if a follow-up `purgeDisconnectedArchived` is run, counts do drop. 50% is the sweet spot between "catches mass wipes" and "tolerates legitimate maintenance".

### Decision 7: Server emits a structured startup banner with row counts to stderr

**Rationale:** Visibility. The operator should not need to query the DB to know whether their data is intact after a restart. After migrations apply (and the data-loss guard passes), the server emits:

```
[bootstrap] rembric v0.14.1 ready
[bootstrap] data_dir=/data
[bootstrap] counts: memory=82 projects=6 sessions=59 tokens=6 prompts=1
[bootstrap] listening on 0.0.0.0:8787
```

If something goes wrong (image regression, manual data dir replacement, anything), the operator sees it in `docker compose logs rembric` immediately. This is a complement to Decision 6: the guard _refuses_ to start on mass loss; the banner _reports_ current state on every start. Together they make data-loss events impossible to miss.

**Cost:** ~10 lines added to bootstrap. No new tables, no new endpoints, no new dependencies.

### Decision 8: Bump `0.14.0 → 0.14.1` to trigger a new publish

**Rationale:** Without a version bump, `release-please` doesn't cut a new release, `docker-publish.yml` doesn't fire, and `:latest` keeps pointing at the buggy `4f8d346774b7` image. The version bump is the trigger that delivers the fix to production. Patch-level because the change is bug-fix (no behavioral changes for end users).

**Alternative considered:**

- _Manually `workflow_dispatch` the publish to retag the corrected image._ Possible, but defeats the release-please discipline and skips the CHANGELOG entry that records the incident. Bumping is the right path even if it means waiting one release cycle.

## Risks / Trade-offs

- **[Risk]** Reordering Dockerfile stages may change build cache topology — base layers shared between `builder` and `dev` may rebuild on the next push.
  **Mitigation:** Acceptable one-time cost. The publish workflow already uses `cache-from: type=gha` so subsequent builds re-warm quickly.

- **[Risk]** Adding `REMBRIC_ALLOW_DESTRUCTIVE_SEED` to the dev compose means operators who copy the dev compose for their own customizations might inadvertently bring the flag along.
  **Mitigation:** Comment in `docker-compose.dev.yml` explaining the flag's purpose explicitly. The seed script's stderr message when the gate is missing also tells the operator how to enable it. The risk is asymmetric in the right direction (default-deny).

- **[Risk]** Post-publish smoke test adds ~30s to release cycle time per arch.
  **Mitigation:** Acceptable; releases are rare. We can scope the smoke test to one arch (`linux/amd64`) since the dev/runtime stage selection is platform-independent.

- **[Risk]** Existing instances of `:latest` (the buggy `4f8d346774b7` digest) remain in operator caches. The fix doesn't propagate until each operator pulls.
  **Mitigation:** For a single-user repo, the operator manually pulls `0.14.1` once it's published. For future multi-user scenarios this would warrant a comms plan; out of scope here.

- **[Risk]** The data-loss guard's state marker is a new file in the data dir that could itself be lost (operator deletes it manually, or the data dir is replaced wholesale). If lost, the guard skips the check on the next boot.
  **Mitigation:** Acceptable failure mode. The guard is a _defense in depth_, not the primary defense. The pipeline-level guards (stage order, target, smoke test, env gate) cover the original incident class. The data-loss guard adds a runtime safety net that fails open on first boot or after marker loss — which is the right default for "I don't know what state the data dir is in" cases. The startup banner (Decision 7) makes the row counts visible regardless of whether the marker is present.

- **[Risk]** Operator manually deletes a project with 50%+ of all memories via the dashboard. Next restart, the data-loss guard refuses to start. Operator must set `REMBRIC_ALLOW_DATA_SHRINKAGE=1` once to recover.
  **Mitigation:** Friction is the point. The env var is a "yes I really did delete data on purpose" handshake. After the operator sets it, restarts, and confirms, they can unset it (the new state marker reflects the lower counts as the new baseline). The friction is one-time per legitimate deletion event.

- **[Risk]** Image size threshold (600 MB) is a heuristic that future legitimate growth could trip.
  **Mitigation:** The threshold is in the workflow file, easy to bump if needed. The runtime image growing past 600 MB is itself worth a review — likely a sign of accidentally-bundled dev deps or source tree.

- **[Trade-off]** Three pipeline defenses (stage order + workflow target + multi-signal smoke test) PLUS two runtime defenses (data-loss guard + startup banner) PLUS the seed env gate is genuinely a lot of moving parts for a single-user repo.
  **Acceptance:** This is precisely the kind of bug whose absence we want to guarantee _structurally_ rather than via discipline. Discipline failed once; structure now picks up the slack. The marginal cost is small (~150 LOC across all changes); the marginal coverage is large (any _single_ defense passing now requires multiple independent failures elsewhere to ship a wipe).

## Migration Plan

1. Implement the spec changes on a feature branch (`fix/prevent-dev-seed-in-published-image` or similar).
2. Run the new invariant tests locally; verify they pass.
3. Open PR; `ci.yml`'s build-check still runs against both stages; the smoke test only fires on actual publishes.
4. Merge; release-please bumps `0.14.0 → 0.14.1`; release-please's merged PR triggers `docker-publish.yml`.
5. `docker-publish.yml` builds with `target: runtime`, pushes immutable `:sha-<short>`, runs smoke test, then retags `:0.14.1`, `:0.14`, `:0`, `:latest`.
6. **Operator (separately, not part of this change):** restore data from PBS backup `ct/121/2026-05-17T16:10:55Z` ("rembric - before docker") into `~/docker/rembric/data/`, then `docker compose pull && docker compose up -d` to pick up the new image. The new container does NOT execute the seed, so the restored data persists across restarts.

**Rollback strategy:** If `0.14.1` introduces an unrelated regression, the operator can pin to `REMBRIC_VERSION=0.14.0` in `.env` — but that re-introduces the data-wiping bug, so the rollback is "fix forward to `0.14.2`" rather than "revert to `0.14.0`". This is documented in CHANGELOG.

## Open Questions

None blocking. Optional considerations for follow-up proposals (not part of this change):

- Should the server log row counts (memory/projects/sessions/tokens) at boot so an unexpected wipe is visible in operator logs immediately? Probably yes; separate proposal.
- Should `seed-dev.ts` accept a `--data-dir` flag instead of relying on `REMBRIC_DATA_DIR`, to make accidental cross-contamination less likely? Possibly; the env-var gate already covers the destructive risk, so this is ergonomics, not safety.
