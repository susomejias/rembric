## Releasing Rembric

Releases are fully automated. You never tag, bump, or publish by hand.

## Two release-please components

`release-please-config.json` is the source of truth. It declares exactly two components — one per deliverable — and **no** grouping plugin (`node-workspace`, `linked-versions`), so there is no cascade or anchor-tag dependency between them.

| Component | Path           | Tag format      | npm package-name  | Bumps when commits touch…                                        |
| --------- | -------------- | --------------- | ----------------- | ---------------------------------------------------------------- |
| `server`  | `apps/server/` | `server-vX.Y.Z` | `@rembric/server` | anything under `apps/server/`                                    |
| `plugin`  | `apps/plugin/` | `plugin-vX.Y.Z` | `@rembric/plugin` | anything under `apps/plugin/` — a shared asset or any client dir |

The `plugin` component covers the **whole** `apps/plugin/` tree (it declares no `exclude-paths`), and its single version is shared by all five clients: Claude Code, Codex CLI, Hermes Agent, opencode, and Pi. The component's `extra-files` rewrite every client's version carrier in lock-step:

- `.claude-plugin/{package,plugin}.json`
- `.codex-plugin/{package,plugin}.json`
- `.hermes-plugin/plugin.yaml`
- the `// @rembric-plugin-version` comment in `.opencode-plugin/plugin.ts`
- `.pi-plugin/package.json` — also the version published to npm as `@rembric/pi`

So a fix scoped to one client bumps the number every other client reports. That is deliberate: `apps/plugin/CHANGELOG.md`, scoped by conventional commit, is what records which client actually changed.

The retired per-client components (`claude-code-plugin`, `codex-plugin`, `hermes-plugin`, `opencode-plugin`, `plugin-shared`) and their tags remain in git history, inert; release-please no longer creates them. Legacy pre-restructure `vX.Y.Z` tags remain too — `ghcr.io/susomejias/rembric:v0.17.0` stays pullable. There is no rolled-up "Rembric vX.Y.Z" release line.

## The flow

```
   feat: / fix: commit          release-please opens          merge release PR
   on main                ─▶    one or more "release: <component> vX.Y.Z"  ─▶   tags + GH releases
                                PRs (one per affected component)                       │
                                                                              release-please.yml
                                                                              checks which component
                                                                              released
                                                                             ┌─────────┴─────────┐
                                                                     server │                   │ plugin
                                                                            ▼                   ▼
                                                             docker-publish.yml        publish-npm job
                                                             (workflow_call)           npm publish --provenance
                                                             ghcr.io/susomejias/       @rembric/pi
                                                             rembric:<server-tag>
```

Both gates live in `.github/workflows/release-please.yml`, one per component:

```yaml
# publish-docker — rebuilds the server image
needs.release-please.outputs.server_release_created == 'true'
# publish-npm — publishes @rembric/pi (the Pi client extension)
needs.release-please.outputs.plugin_release_created == 'true'
```

A `plugin` release does **not** rebuild the server image, and a `server` release publishes **nothing** to npm. The npm publish authenticates via trusted-publishing OIDC (`permissions: id-token: write`, scoped to the `publish-npm` job) and carries provenance; there is no stored registry token, and introducing one requires an OpenSpec change against `supply-chain-hygiene`.

If a single commit touches both server and plugin paths, release-please opens separate PRs per component; merging the server PR is what triggers Docker, and merging the plugin PR is what triggers the npm publish.

## Day-to-day

Use [Conventional Commits](https://www.conventionalcommits.org/) — the `commit-msg` hook enforces this. Allowed types live in `CONTRIBUTING.md`. Release-affecting types:

- `feat: …` → bumps the **minor** version of every component whose path the commit touches
- `fix: …` / `perf: …` → bumps the **patch** version
- `feat!: …` or `BREAKING CHANGE:` footer → bumps the **major** version
- `chore`, `docs`, `test`, `build`, `ci`, `style` → no version bump, no changelog entry

Scope the commit so the path is unambiguous. Examples:

```bash
git commit -m "feat(consolidation): add drift heuristic for tag overlap"     # → server
git commit -m "fix(bridge): handle missing PWD"                              # → plugin
git commit -m "feat(opencode): per-session summary on dispose"               # → plugin
git commit -m "fix(hermes): tighten is_available 401 handling"               # → plugin
```

Every client lives under `apps/plugin/`, so any of the last three bumps the one shared `plugin` version; the scope is what tells the CHANGELOG which client changed.

**To cut a release**: merge the relevant release PR. Merging the `server` PR triggers `docker-publish.yml`; the multi-arch image lands at `ghcr.io/susomejias/rembric:<server-version>` ~5–8 minutes later. Merging the `plugin` PR triggers `publish-npm`; `@rembric/pi` appears on the registry at the same version as the `plugin-vX.Y.Z` tag.

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
