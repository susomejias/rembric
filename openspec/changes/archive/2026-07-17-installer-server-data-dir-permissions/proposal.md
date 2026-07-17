## Why

`install.sh --server --up` — the canonical, documented install path — crashes the server on a standard rootful Linux Docker host. `docker-compose.yml` bind-mounts `./data:/data`; when that directory doesn't exist yet, `docker compose up -d` auto-creates it `root:root 0755`. The image runs as `UID 10001:10001` (a distroless, non-root image that cannot `chown` itself at runtime), so the server can't open its SQLite DB and crash-loops. `bring_up` then reports the generic "started but /healthz did not report ok" message, giving the operator no clue what actually went wrong.

This is a known, already-worked-around gap: CI's own installer e2e check (`.github/workflows/ci.yml`) pre-creates `./data` with `chmod 0777` specifically to dodge this, with a comment admitting the real server would otherwise fail to open its DB; `docs/docker.md` separately documents the manual `chown 10001:10001 ./data` remedy for anyone who hits it. The one path meant to make this invisible — the installer — never applies either fix itself, so a first-time self-hoster following the README's own quickstart hits a crash loop on the very first run.

## What Changes

- `bring_up` (`apps/plugin/install.sh`) creates `./data` (if missing) immediately before `docker compose up -d`, then makes it accessible to the container's non-root `UID 10001`: first tries `chown 10001:10001 ./data` (the precise, `docs/docker.md`-sanctioned fix — only root/`CAP_CHOWN` can do this), and only when that fails falls back to `chmod 0777` with an explicit, non-suppressed warning explaining what happened and how to tighten it later. This runs unconditionally right before an actual bring-up (not merely offered), self-healing an already-broken `./data` from a pre-fix crash loop, not just a brand-new directory.
- The health-check-timeout message gets one added line pointing at the data-directory permission issue as a likely cause, as a defense-in-depth fallback for the rare case neither the chown nor the chmod fallback fixes it (e.g. a restrictive parent filesystem).

No flag/env/protocol changes. A blanket `chmod 0777` (matching CI's own e2e workaround, which was this change's initial approach) was rejected as the _default_ behavior — it grants every local account on the host read/write access to the SQLite DB, not just the container's UID, which is a real information-disclosure/tampering exposure on a shared host. It remains as an explicit, warned fallback only when the precise `chown` fix isn't possible. See design.md D1.

## Capabilities

### Modified Capabilities

- `tui-installer`: MODIFY "Server flow prepares files, generates the token, and optionally brings the stack up" — the bring-up step additionally ensures `./data` exists and is writable before invoking `docker compose up -d`.

## Impact

- `apps/plugin/install.sh::bring_up`.
- New headless test in `install.test.ts` asserting `./data` is created and world-writable after a bring-up run.
- Validated per the `rembric-tui-installer-e2e` playbook (headless + local layers at minimum; Docker layer run manually where available, mirroring the exact CI e2e check this change makes redundant going forward).
- Issue: #253.
