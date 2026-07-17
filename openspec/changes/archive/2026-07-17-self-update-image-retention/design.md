# Design: self-update-image-retention

## Context

The self-update flow (`orchestrator.ts` → ephemeral `upgrade-helper.ts` container) pulls the target image via `POST /images/create`, swaps containers, and removes the old container on success — but never removes the old image. Docker offers no cleanup option at pull time (neither on the Engine endpoint nor in the CLI), and never garbage-collects images. Each update therefore leaks the previous image (~1.4GB). A production host reached 96% disk with ~40 dangling `<none>` images (~56GB) plus two `rembric-upgrader-*` containers stuck in `Created` state, each pinning its image (issue #282).

Constraints fixed with the operator:

- **Rollback must keep working** — both the in-flight rollback in `upgrade-helper.ts` (unhealthy replacement → restart parked old container) and a manual rollback to the previous version without registry access.
- **Docker-native** — lean on Engine API primitives (prune + filters + container-pinning semantics), not bespoke retention bookkeeping. The self-update feature is contractually zero-dependency (`openspec/specs/self-update`), implemented as `node:http` over the unix socket.
- **No compose changes** — must work with the already-mounted docker socket, out of the box.

## Goals / Non-Goals

**Goals:**

- Stop the per-update image leak: dangling Rembric images older than the previous version are reclaimed automatically.
- Sweep finished (`created`/`exited`) upgrader containers so they stop pinning images indefinitely.
- Always keep the immediately-previous image locally for manual rollback, with zero stored state.
- Never abort, delay, or destabilize an update because cleanup failed.
- Never touch images or containers belonging to other services on the host.

**Non-Goals:**

- Retro-cleanup of hosts that accumulated images before this change (documented manual fallback: `docker image prune -a`).
- Pruning tagged images (an operator-pinned `0.21.1` is deliberate; it is never dangling, hence never pruned).
- Log rotation or any compose-file hardening (separate concern; logs were ruled out as a cause in the incident).
- A configurable keep-N policy. Keep-1 falls out of pinning semantics for free; N>1 would require bookkeeping for marginal benefit.
- Changes to `upgrade-helper.ts` or any rollback path.

## Decisions

### D1 — Cleanup lives in the orchestrator, post-backup / pre-pull

The cleanup runs in the long-lived server process after the backup gate passes and before `pullImage`, still before the upgrader container is created.

- _Why in the orchestrator_: while the server is running, the current image is pinned by its own container, so the label-scoped dangling prune structurally cannot remove it — the keep-1 guarantee needs no code. Running it in `upgrade-helper.ts` after the swap would instead see the previous image unpinned and delete it, killing manual rollback (the Watchtower `--cleanup` behavior we explicitly rejected).
- _Why before the pull_ (moved from post-pull during code review): the pull is the step that fails with ENOSPC on a disk-full host — the very incident that motivated this change. Sequenced after the pull, the reclaim is unreachable exactly when it is most needed and every retry fails the same way. Pre-pull placement frees the space first at ~zero cost (the pinned running image keeps shared base layers; only layers unique to superseded versions re-download, which the new image doesn't reference anyway).
- _Alternatives considered_: (a) in the upgrader after successful swap — breaks keep-1, and a helper crash would skip cleanup forever; (b) a periodic sweep in the server — more machinery (scheduling, throttling) for the same effect, and cleanup naturally belongs to the update that is about to create new garbage; (c) delete the specific old image by ID at the next update — requires persisting "previous image ID" state; pinning gives the same result stateless; (d) post-pull placement — leaves disk-full hosts stuck (see above).

### D2 — Prune via `POST /images/prune` with `dangling=true` + `label=rembric.stage=runtime`

- _Why_: the runtime image already carries `LABEL rembric.stage=runtime` (`apps/server/Dockerfile:130`), and dangling images retain their build labels — so one native prune call is exactly scoped to Rembric runtime images and nothing else on the host. Tagged images are excluded by `dangling=true` by definition.
- _Alternatives considered_: (a) unfiltered dangling prune — would delete other services' dangling images (host overreach); (b) `DELETE /images/{id}` of the specific superseded image — precise but requires tracking which ID is "old enough" to delete (state) and does nothing for pre-existing leaks; (c) Watchtower or an external cleanup container — new dependency, and its all-or-nothing cleanup deletes the rollback image.

### D3 — Sweep upgrader containers with the native containers-prune endpoint

`POST /containers/prune` filtered by `label=rembric.upgrader=1`. Container prune removes stopped containers (`created` and `exited`) and by definition never touches a running one — the "never kill a running upgrader" guard is Docker semantics, not our code, exactly like the keep-1 image guarantee. Runs before the image prune so the images those zombies pin become reclaimable in the same pass.

- _Why prune over list-and-remove_: an earlier draft listed containers by label+status and removed them in a loop with a hand-rolled running-state guard. The prune endpoint collapses that to one call with the guard built in — less code, less test surface, more docker-native.
- The existing "failed upgraders are left for `docker logs` inspection" affordance survives — a failed upgrader persists until the _next_ update attempt, which is when the operator has moved on.
- _Alternatives considered_: (a) list + iterate + `removeContainer` — same effect, more code and a manual guard; (b) `AutoRemove: true` on the upgrader — doesn't apply to `Created`-state containers (the observed zombies) and deletes the logs of a failed update, its only diagnostic artifact; (c) age-based sweep — needs a clock policy and buys nothing over sweep-at-next-update; (d) skipping the sweep entirely (image prune only) — zombies pin their image (~1.4GB each observed in production), so the leak persists exactly where it hurts.

### D4 — Two thin Engine API prune wrappers, same zero-dependency pattern

`engine-api.ts` gains `pruneContainers(filters)` and `pruneImages(filters)` — two symmetric `POST /<kind>/prune` wrappers, `node:http`-over-socket like every existing method, both passing `filters` as the URL-encoded JSON the Engine API expects. No new dependencies; the self-update dependency-audit requirement holds.

- _Alternative considered_: dockerode or similar client — rejected; violates the zero-dependency contract for two trivial endpoints.

### D5 — Best-effort semantics, independent failure per prune step

Any failure (socket hiccup, permission edge, a 409 from a concurrent prune elsewhere on the host) logs one line and the update proceeds. The container sweep and the image prune each carry their own try/catch — a concurrent-prune 409 on the sweep must not skip the image prune, which is the leak this change exists to fix. Cleanup is an optimization; the update is the job.

## Risks / Trade-offs

- [Risk] Prune removes the previous image on a host where the rembric container was recreated (not running) mid-update → Mitigation: cleanup only runs inside `start()` after capability detection confirmed a running container and a successful pull; the running container is the caller's own process, so the pin is guaranteed at that point.
- [Risk] Another Rembric-derived image on the same host (e.g. a dev-stage container using `rembric.stage=dev`) gets pruned → Mitigation: the filter matches `rembric.stage=runtime` exactly; dev images carry `rembric.stage=dev`. Images pinned by any container (running or stopped) are never pruned regardless.
- [Trade-off] Hosts that leaked images before this change are not fully retro-cleaned: the first cleanup pass reclaims all label-carrying dangling images except the pinned current one, but images built before the `rembric.stage=runtime` label existed (pre-public-release builds) carry no label and are never matched → Accepted because label-less strays are a bounded legacy set and `docker image prune -a` remains documented for manual recovery.
- [Trade-off] A failed upgrader's logs survive only until the next update attempt → Accepted because the operator triggered that next attempt; by then the previous failure has either been inspected or superseded.
- [Risk] `filters` query encoding differences across Engine API versions → Mitigation: pinned `ENGINE_API_VERSION = v1.41` already in `engine-api.ts`; both endpoints and their `label`/`dangling` filters exist since well before v1.41; covered by wrapper unit tests.
- [Risk] An empty or malformed `filters` payload turns `POST /containers/prune` into "remove every stopped container on the host" (and the image prune into an unscoped dangling prune) — catastrophic on a shared host running other services → Mitigation: defense in depth: (a) both wrappers throw synchronously if `filters` lacks a non-empty `label` entry, before any socket I/O; (b) unit tests assert the exact URL-encoded filter string sent to the socket; (c) the orchestrator passes literal constants, never interpolated input.
- [Trade-off] Two Rembric deployments on one host updating simultaneously: instance B's cleanup could sweep instance A's upgrader in the milliseconds it sits in `created` state before `startContainer` (the `already_running` guard is in-process only). The failure is benign — it happens pre-swap, A's server keeps running, the update reports `failed` and a retry succeeds → Accepted because the alternative (a per-instance owner label in the prune filter) would permanently orphan legacy zombies that lack the label, adding complexity to protect an exotic topology whose failure mode is already safe.
- [Trade-off] The first cleanup after deploying this version may prune a large backlog (seconds, tens on slow disks) while the dashboard still shows the `backup` phase → Accepted; a log line before cleanup starts (in addition to the completion summary) makes the pause self-explanatory without adding a status phase.

## Migration Plan

Ships as a normal server release; no schema, compose, or operator action. First update after deploying this version performs the first cleanup pass (reclaiming all pre-existing dangling Rembric images except the pinned current one). Rollback of the feature itself = deploying a previous image; cleanup simply stops happening.

## Open Questions

None — design constraints were settled with the operator in issue #282.
