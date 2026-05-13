# Releasing Rembric

Releases are fully automated. You never tag, bump, or publish by hand.

## The flow

```
   feat: / fix: commit          release-please opens          merge release PR
   on main                ─▶    a "release: vX.Y.Z" PR  ─▶    + tag + GH release
                                                                       │
                                                              publish.yml fires
                                                                       │
                                                                       ▼
                                                              @scope/rembric@X.Y.Z
                                                              on GitHub Packages
```

Three workflows do the work:

| File                                   | Triggers on                   | What it does                                                                           |
| -------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`             | every PR and push to `main`   | install, lint, typecheck, test, build                                                  |
| `.github/workflows/release-please.yml` | every push to `main`          | maintains a single open "release: X.Y.Z" PR with the bumped version and `CHANGELOG.md` |
| `.github/workflows/publish.yml`        | a GitHub Release is published | re-verifies, builds, `pnpm publish` to GitHub Packages                                 |

## One-time setup

### 1. Scope the package name

In `package.json` (this is the only manual edit you ever make for releases):

```diff
- "name": "rembric",
+ "name": "@your-github-username/rembric",
+ "publishConfig": { "registry": "https://npm.pkg.github.com" },
```

`@your-github-username` matches the GitHub account or organization that
owns the repo. The CLI binary stays `rembric`.

### 2. Push to a private GitHub repo

`git push` to a private GitHub repo. The three workflows live under
`.github/workflows/` and run automatically.

### 3. Enable PR creation for Actions

In the repo settings, **Settings → Actions → General → Workflow
permissions**, check **"Allow GitHub Actions to create and approve pull
requests"**. Otherwise `release-please` cannot open its release PR.

### 4. Server-side install token

Create a classic Personal Access Token with **only `read:packages`** at
<https://github.com/settings/tokens/new>. On the server:

```bash
sudo -u rembric tee /home/rembric/.npmrc <<EOF
//npm.pkg.github.com/:_authToken=ghp_YOUR_READ_PACKAGES_TOKEN
@your-github-username:registry=https://npm.pkg.github.com
EOF
sudo chmod 600 /home/rembric/.npmrc
```

## Day-to-day

Use [Conventional Commits](https://www.conventionalcommits.org/) — the
`commit-msg` hook enforces this. Allowed types are listed in
`CONTRIBUTING.md`; the most consequential for releases are:

- `feat: …` → bumps the **minor** version (0.1.0 → 0.2.0 pre-1.0; 1.x → 1.y after)
- `fix: …` / `perf: …` → bumps the **patch** version (0.1.0 → 0.1.1)
- `feat!: …` or any `BREAKING CHANGE:` footer → bumps the **major** version
- `chore`, `docs`, `test`, `build`, `ci`, `style` → no version bump, no
  changelog entry

```bash
git commit -m "feat(consolidation): add drift heuristic for tag overlap"
git push
```

When you push to `main`, `release-please` either opens a brand-new
"release: vX.Y.Z" PR or amends the existing one with the new commit. The
PR shows the proposed version bump and the generated changelog snippet.

**To cut a release**: merge the release PR. That single merge triggers
the tag + GitHub Release + `publish.yml`. About 1–2 minutes later, the
package is available on GitHub Packages.

**To delay a release**: leave the PR open. Subsequent commits keep
amending it.

## On the server

```bash
ssh server 'sudo -u rembric pnpm add -g @your-github-username/rembric@latest && \
            sudo systemctl restart rembric'
```

Or wrap that in a shell alias. Migrations apply automatically on the
next start.

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

To push a commit to `main` without affecting the release PR (rare;
typically only for emergency reverts):

```bash
git commit -m "chore: tweak gitignore"   # `chore` never bumps the version
```

`chore`, `docs`, `test`, `build`, `ci`, `style` types are hidden from the
changelog and don't trigger version bumps.

## First release

After the one-time setup, the very first release is the same as any
other: commit a `feat:` or `fix:`, push, merge the release PR. The
manifest starts at `0.0.0` so the first `feat:` PR becomes `0.1.0` (and
the first `feat!:` PR becomes `1.0.0`).
