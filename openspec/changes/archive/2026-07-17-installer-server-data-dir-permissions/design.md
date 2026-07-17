## Context

`docker-compose.yml`'s `./data:/data` bind mount source is auto-created by `docker compose up -d` when missing, owned by whoever invokes `docker` — root on a typical rootful Linux host. `apps/server/Dockerfile` runs the server as `USER 10001:10001` in a distroless final stage with no shell and no `useradd`/`chown` capability at runtime, so the container can never fix its own data directory's ownership. This is a pre-existing, already-documented gap (`docs/docker.md`'s UID-mismatch section, CI's own `mkdir -p data && chmod 0777 data` workaround) that the installer — the one surface meant to hide exactly this kind of operational detail — never closed.

## Goals / Non-Goals

**Goals:**

- Make `install.sh --server --up` succeed on a fresh rootful Linux Docker host with zero manual intervention, matching what CI already has to do to make its own e2e check pass.
- Never relax the permissions of an already-correctly-configured `./data` on a re-run — a `chown` failure must not be treated as proof something is broken.
- Keep the fix POSIX `/bin/sh`-safe. `stat` (needed to distinguish "not root" from "not root, and nothing to fix") isn't in the installer's existing baseline-tool list, but it's present alongside `docker`/`curl` on every practical target for this flow; both GNU (`stat -c`) and BSD/macOS (`stat -f`) invocation forms are tried.

**Non-Goals:**

- Not changing `docker-compose.yml` or the Dockerfile — the fix is entirely in the installer's own pre-flight, matching the issue's proposed fix location.
- Not touching the `dev:docker:up` path (`docker-compose.dev.yml`) — that's a separate, already-known chown requirement recorded in project memory, exercised by contributors who already know to `chown -R 10001:10001 data-dev`; this change is about the _distributed, self-hoster-facing_ installer only.

## Decisions

### D1. `chown 10001:10001` first; `chmod 0777` only as a fallback, and never silently

The initial draft of this change used `chmod 0777` unconditionally, matching CI's own e2e workaround. That's the wrong default: `chmod 0777` makes `./data` — and the SQLite DB inside it, which can hold memory content, hashed tokens, and OAuth credentials — world-readable and world-writable to **every local account on the host**, not just the container's `UID 10001`. On a single-operator personal machine that's low-risk (no other local accounts exist to exploit it), but on a shared host it's a real local information-disclosure and tampering exposure, and it's _strictly worse_ than the `chown`-to-exact-UID remedy `docs/docker.md` already documents as the sanctioned fix.

The corrected approach:

1. Attempt `chown 10001:10001 ./data` first. This only succeeds for root/`CAP_CHOWN` — exactly the precondition needed to do the _precise_ fix (only UID 10001 and root gain access). It's a harmless no-op when the directory is already correctly owned.
2. When that `chown` fails, DON'T assume that means anything is broken — `chown` to an arbitrary UID fails for _every_ non-root invocation, including one against a `./data` that's already correctly set up (a prior manual `sudo chown`, or Docker Desktop's transparent UID translation on macOS). Check the directory's current owning UID first (`stat -c '%u' ./data`, falling back to BSD `stat -f '%u'`): if it's already `10001`, leave the directory completely untouched and print nothing. Only when the owner is genuinely something else fall back to `chmod 0777`, with an explicit, non-suppressed warning naming exactly what happened and how to tighten it later (`sudo chown -R 10001:10001 ./data`).

An earlier revision of this decision fell back to `chmod 0777` on ANY `chown` failure, full stop — that regresses an already-working install: re-running the (patched) installer as a non-root user against a `./data` that a prior manual `chown` already fixed would silently widen it back to world-writable on every future `--up`/update, plus print a scary, unwarranted warning. The `stat`-based ownership check closes that gap while still healing a genuinely broken (root-owned) `./data` on a re-run.

No root-detection branching (`id -u`, sudo-availability probing) is needed for the _chown attempt itself_: attempting the operation and checking its exit code is simpler and correct in every case, including ones root-detection would get wrong (e.g. `CAP_CHOWN` without full root). The `stat` check exists only to distinguish _why_ chown failed — "not root" vs. "not root, and nothing to fix anyway."

### D1a. Fallback runs on every `bring_up` that needs it, not just first-time creation

An operator who hit the crash loop _before_ this fix shipped already has a root-owned, broken `./data` from a prior failed run. The fix must self-heal that on a re-run, not only apply to brand-new directories — so `chown`-then-maybe-`chmod` always runs before `docker compose up -d`, never gated on "was `./data` just created." Both operations are naturally idempotent (re-chowning an already-correct directory, or re-chmodding an already-`0777` one, changes nothing), so this costs nothing on the common repeat-`update` path.

### D2. Placement: immediately before the actual `docker compose up -d` call, not earlier

`bring_up` may exit early (Docker absent, user declines, `docker compose` missing) before ever reaching the point of actually starting containers — those paths never write anything to the current directory today, and this change preserves that: `mkdir -p ./data` plus the chown/chmod-fallback dance runs only in the branch that is about to invoke `docker compose up -d`, not unconditionally at the top of `bring_up`. This also naturally makes it apply identically to the `install` and `update` flows, since both funnel into the same `bring_up` function and same call site.

## Verification

- Headless tests (`install.test.ts`, extended, 3 new cases against a stubbed `docker`/`chown`): a non-interactive `--server --action=install --up` run with a stubbed-successful `chown` asserts `./data` exists and NO fallback warning is printed; a run with a stubbed-_failing_ `chown` against a FRESH `./data` (owner defaults to whoever ran the installer, never uid 10001) asserts it ends up mode `0777` (the real `chmod` runs, only `chown` is stubbed) AND the warning + `sudo chown -R 10001:10001 ./data` hint both appear; a third case pre-creates `./data` for real, `chown`s it to uid 10001 (the test runner is root, so this is a genuine syscall, not a mock), then runs with a stubbed-_failing_ `chown` and asserts the directory's mode and ownership are completely unchanged and no warning appears — the regression this decision exists to prevent.
- `sh -n apps/plugin/install.sh` — POSIX syntax check (per the e2e playbook's Layer 1).
- Docker layer (manual, where available): the exact scenario from the issue — a fresh directory on a rootful Linux Docker host, `install.sh --server --up`, asserting the server reaches a healthy `/healthz` instead of crash-looping (via the `chown` path, since a real rootful Docker invocation is typically run as root or with a root-equivalent Docker socket). CI's own `mkdir -p data && chmod 0777 data` pre-step in its e2e check is left in place as belt-and-suspenders — harmless, and CI's runner has no other local accounts to expose.

## Migration Plan

No migration — a shell-script pre-flight step only. Rollback is a plain revert; no state is left behind that a revert would need to clean up (an already-`chmod 0777`'d directory staying that way after a revert is harmless).
