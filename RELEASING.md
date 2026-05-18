## Releasing Rembric

Releases are fully automated. You never tag, bump, or publish by hand.

## The flow

```
   feat: / fix: commit          release-please opens          merge release PR
   on main                ─▶    a "release: vX.Y.Z" PR  ─▶    + tag + GH release
                                                                       │
                                                              docker-publish.yml fires
                                                                       │
                                                                       ▼
                                                              ghcr.io/susomejias/rembric:X.Y.Z
                                                              (multi-arch, signed)
```

Two workflows do the work:

| File                                   | Triggers on                    | What it does                                                                                                                                               |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`             | every PR and push to `main`    | install, lint, typecheck, test, build, Docker build sanity (`runtime` + `dev` targets)                                                                     |
| `.github/workflows/release-please.yml` | every push to `main` + release | maintains a single open "release: vX.Y.Z" PR; on merge, calls `docker-publish.yml` via `workflow_call` to push the multi-arch image tagged for the release |

`docker-publish.yml` itself is a reusable workflow invoked by `release-please.yml` (and exposed via `workflow_dispatch` for ad-hoc rebuilds).

## Day-to-day

Use [Conventional Commits](https://www.conventionalcommits.org/) — the `commit-msg` hook enforces this. Allowed types are listed in `CONTRIBUTING.md`; the most consequential for releases are:

- `feat: …` → bumps the **minor** version (0.1.0 → 0.2.0 pre-1.0; 1.x → 1.y after)
- `fix: …` / `perf: …` → bumps the **patch** version (0.1.0 → 0.1.1)
- `feat!: …` or any `BREAKING CHANGE:` footer → bumps the **major** version
- `chore`, `docs`, `test`, `build`, `ci`, `style` → no version bump, no changelog entry

```bash
git commit -m "feat(consolidation): add drift heuristic for tag overlap"
git push
```

When you push to `main`, `release-please` either opens a brand-new "release: vX.Y.Z" PR or amends the existing one with the new commit. The PR shows the proposed version bump and the generated changelog snippet.

**To cut a release**: merge the release PR. That single merge triggers the tag + GitHub Release + `docker-publish.yml`. About 5–8 minutes later, the multi-arch image is available at `ghcr.io/susomejias/rembric:<version>`.

**To delay a release**: leave the PR open. Subsequent commits keep amending it.

## On the server

```bash
docker compose pull && docker compose up -d
```

Migrations apply automatically on the next start (the entrypoint opens the SQLite file via `src/db/client.ts`, which calls `migrate()` before serving).

## Hotfix path

For a one-off urgent fix without unreleased feature commits piling up:

```bash
git checkout -b hotfix/some-fix main
git commit -m "fix(mcp): reject empty Authorization header with 401"
git push -u origin hotfix/some-fix
# open a PR, merge it
# release-please will bump the patch version on the next push to main
```

## Skipping a release

To push a commit to `main` without affecting the release PR (rare; typically only for emergency reverts):

```bash
git commit -m "chore: tweak gitignore"   # `chore` never bumps the version
```

`chore`, `docs`, `test`, `build`, `ci`, `style` types are hidden from the changelog and don't trigger version bumps.
