## Releasing Rembric

Releases are fully automated. You never tag, bump, or publish by hand.

## Five release-please components

The monorepo restructure introduced one release-please component per deliverable. `release-please-config.json` is the source of truth.

| Component     | Path                            | Tag format           | Bumps when commits touch…                                                                                  |
| ------------- | ------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `server`      | `apps/server/`                  | `server-vX.Y.Z`      | anything under `apps/server/`                                                                              |
| `claude-code` | `apps/plugin/.claude-plugin/`   | `claude-code-vX.Y.Z` | `apps/plugin/.claude-plugin/`, or shared `apps/plugin/{bin,hooks,commands,scripts}/` (cascades from group) |
| `codex`       | `apps/plugin/.codex-plugin/`    | `codex-vX.Y.Z`       | `apps/plugin/.codex-plugin/`, or the same shared paths (cascades from group)                               |
| `hermes`      | `apps/plugin/.hermes-plugin/`   | `hermes-vX.Y.Z`      | only `apps/plugin/.hermes-plugin/`                                                                         |
| `opencode`    | `apps/plugin/.opencode-plugin/` | `opencode-vX.Y.Z`    | only `apps/plugin/.opencode-plugin/`                                                                       |

`claude-code` and `codex` are linked via the `bridge-bundlers` `linked-versions` group, so they always release together at the same version — they share the bridge entry point (`apps/plugin/bin/`), hook scripts (`apps/plugin/scripts/`), and command/hook manifests.

`hermes` and `opencode` bump **independently** of the bridge. Their `install.sh` re-fetches `apps/plugin/bin/rembric-{bridge,dotenv}.mjs` (and `apps/plugin/scripts/_api.sh` is not used by them) from `main` at install time, so shared-`bin/` updates reach those users on the next install without a coordinated release.

The first release after the restructure is **`server-v0.18.0`** — there is no rolled-up "Rembric vX.Y.Z" anymore.

## The flow

```
   feat: / fix: commit          release-please opens          merge release PR
   on main                ─▶    one or more "release: <component> vX.Y.Z"  ─▶   tags + GH releases
                                PRs (one per affected component)                       │
                                                                              release-please.yml
                                                                              checks: did `server`
                                                                              release?
                                                                                       │ yes
                                                                                       ▼
                                                                              docker-publish.yml (workflow_call)
                                                                              pushes ghcr.io/susomejias/rembric:<server-tag>
```

Plugin-only releases (`claude-code`, `codex`, `hermes`, `opencode`) do **not** trigger Docker publish. The gate lives in `.github/workflows/release-please.yml`:

```yaml
needs.release-please.outputs.server_release_created == 'true'
```

If a single commit touches both server and plugin paths, release-please opens separate PRs per component; merging the server PR is what triggers Docker.

## Day-to-day

Use [Conventional Commits](https://www.conventionalcommits.org/) — the `commit-msg` hook enforces this. Allowed types live in `CONTRIBUTING.md`. Release-affecting types:

- `feat: …` → bumps the **minor** version of every component whose path the commit touches
- `fix: …` / `perf: …` → bumps the **patch** version
- `feat!: …` or `BREAKING CHANGE:` footer → bumps the **major** version
- `chore`, `docs`, `test`, `build`, `ci`, `style` → no version bump, no changelog entry

Scope the commit so the path is unambiguous. Examples:

```bash
git commit -m "feat(consolidation): add drift heuristic for tag overlap"     # → server
git commit -m "fix(bridge): handle missing PWD"                              # → claude-code + codex (linked)
git commit -m "feat(opencode): per-session summary on dispose"               # → opencode only
git commit -m "fix(hermes): tighten is_available 401 handling"               # → hermes only
```

**To cut a release**: merge the relevant release PR. Merging the `server` PR triggers `docker-publish.yml`; the multi-arch image lands at `ghcr.io/susomejias/rembric:<server-version>` ~5–8 minutes later.

## On the server

```bash
docker compose pull && docker compose up -d
```

Migrations apply automatically on the next start (the entrypoint opens SQLite via `apps/server/src/db/client.ts`, which calls `migrate()` before serving).

## Hotfix path

```bash
git checkout -b hotfix/some-fix main
git commit -m "fix(mcp): reject empty Authorization header with 401"
git push -u origin hotfix/some-fix
# open a PR, merge it → release-please bumps server-vX.Y.(Z+1) on next push to main
```

## Manual recovery

`docker-publish.yml` exposes `workflow_dispatch` with a `tag` input for one-off rebuilds (e.g. base-image CVE patch without bumping server). `release-please.yml` also supports `workflow_dispatch` with `force_publish: true` to fire Docker publish for the current `main` even if release-please didn't cut a server release on the most recent push.
