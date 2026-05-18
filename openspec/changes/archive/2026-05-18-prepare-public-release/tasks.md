## 1. Docs and content scrubs

- [x] 1.1 Fix `README.md:10`: change `<i>One npm package, one process, one SQLite file. Multi-client by construction, reversible by design.</i>` to `<i>One Docker image, one process, one SQLite file. Multi-client by construction, reversible by design.</i>`.
- [x] 1.2 Remove the broken `<a href="#cli-operations">CLI</a> ·` entry from the README anchor nav at `README.md:20`. Re-balance the trailing separators so the nav line stays well-formed.
- [x] 1.3 Add a new README section near the install/quickstart anchor titled "Project status" — short paragraph saying the project is open-source under MIT, points at `SECURITY.md` for vulnerability disclosure, and at `docs/backup.md` for operator backup responsibility. Do NOT yet claim default-on backups (that belongs to `add-data-protection-defaults`).
- [x] 1.4 Update `docs/docker.md:3`: replace the parenthetical "The image is **private** today; flips to public when the project opens." with a single accurate sentence that states the image is hosted at `ghcr.io/susomejias/rembric` and is public.
- [x] 1.5 Scrub `openspec/changes/archive/2026-05-16-fix-codex-hook-stdout-prefix/tasks.md:48`: replace `/Users/jesus.mejias/Desktop/rembric` with `<repo>`.
- [x] 1.6 Repo-wide grep for any other personal home-directory leaks: `grep -rE '/Users/jesus|/home/jesus|/Users/<personal' --include='*.md' --include='*.ts' --include='*.json' --include='*.yml' --include='*.yaml' .`. If any matches outside `node_modules/` and `data-dev/`, scrub them.
- [x] 1.7 Direct edit (NOT a spec delta — prose outside any Requirement) of `openspec/specs/claude-code-plugin/spec.md:255`: replace `A public plugin marketplace. The plugin remains private to the monorepo's audience; a future change may extract it via \`git subtree split\` for public distribution.` with the public-friendly framing already drafted in the proposal (no longer asserts the plugin is "private to the monorepo's audience").
- [x] 1.8 Spec-delta sweep of `openspec/specs/` for residual "private repo / single-maintainer / pre-public" framing not already covered by the `hermes-agent-plugin` delta. Run `grep -rniE "(private|single.maintainer|single.owner|pre.public|the author|personal use|for v0|monorepo.s audience)" openspec/specs/`. Any remaining hit SHALL either be (a) rephrased in a delta spec under this change, or (b) accepted as a true historical reference and left intact with a one-sentence note explaining why it remains.

## 2. New OSS meta files

- [x] 2.1 Create `SECURITY.md` at repo root. Required content: (a) supported version policy (latest minor on `main` is the only supported version pre-1.0), (b) preferred reporting channel = GitHub Security Advisories, (c) email fallback to maintainer, (d) acknowledgement SLA = 5 business days, (e) explicit statement that pre-1.0 versions are not eligible for coordinated disclosure beyond best-effort.
- [x] 2.2 Create `CODE_OF_CONDUCT.md` at repo root. Content: Contributor Covenant 2.1 verbatim from `https://www.contributor-covenant.org/version/2/1/code_of_conduct.txt`, with the enforcement contact replaced by the maintainer's email (matches `SECURITY.md`).
- [x] 2.3 Create `.github/ISSUE_TEMPLATE/bug.yml` with required form fields: `Reproduction steps` (textarea, required), `Rembric version` (input, required), `Client` (dropdown: Claude Code / Codex CLI / Hermes Agent / Other / N-A), `Environment` (textarea: OS, Docker version, Node version if running outside Docker), `Logs` (textarea, optional).
- [x] 2.4 Create `.github/ISSUE_TEMPLATE/feature.yml` with form fields: `Problem statement` (textarea, required), `Proposed solution` (textarea, required), `Alternatives considered` (textarea, optional), `Why now?` (textarea, optional).
- [x] 2.5 Create `.github/ISSUE_TEMPLATE/config.yml` with `blank_issues_enabled: false` and a `contact_links` entry pointing "I have a question" at GitHub Discussions if Discussions are enabled later, otherwise omit.
- [x] 2.6 Create `.github/PULL_REQUEST_TEMPLATE.md` with the checklist from `CONTRIBUTING.md::Pull request checklist`: lint, typecheck, tests, conventional commit message, openspec validate (if applicable), changelog entry not needed (release-please handles it).

## 3. Pre-rewrite validation gate

- [x] 3.1 Stage the docs + scrub edits + new meta files. Run `pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run build` — ALL must pass before committing.
- [x] 3.2 Run `openspec validate prepare-public-release --strict` and `openspec validate add-data-protection-defaults --strict`. Both must pass.
- [x] 3.3 Commit the docs + scrub edits + meta files with a single Conventional Commit on current main: `docs: prepare repository for public open-source release`. This commit lands BEFORE the orphan swap.
- [x] 3.4 Verify the commit's tree includes the new files: `git show --stat HEAD` should list `SECURITY.md`, `CODE_OF_CONDUCT.md`, the `.github/ISSUE_TEMPLATE/` entries, `.github/PULL_REQUEST_TEMPLATE.md`, the README diff, the `docs/docker.md` diff, and the archived openspec tasks scrub.

## 4. Archive this change BEFORE the orphan commit

- [x] 4.1 Run `/opsx:archive prepare-public-release` to move `openspec/changes/prepare-public-release/` to `openspec/changes/archive/<YYYY-MM-DD>-prepare-public-release/`. Sync any spec deltas to `openspec/specs/open-source-distribution/spec.md`.
- [x] 4.2 Verify the archive landed under `openspec/changes/archive/`. Verify `openspec/changes/add-data-protection-defaults/` is still ACTIVE (it is the next PR after the flip).
- [x] 4.3 Commit the archive move with Conventional Commit: `chore(openspec): archive prepare-public-release ahead of orphan swap`.

## 5. Pre-orphan backup (zip-primary, remote-branch secondary)

- [x] 5.1 Owner-attested: a full-directory `.zip` of the repo (working tree + `.git/`) has been produced and stored outside the repo before proceeding. This is the primary recovery artifact for this execution per design.md Decision 2. No automated check — owner confirms in the apply transcript.
- [x] 5.2 Push `main` as a backup branch on origin: `git branch backup-pre-public main && git push origin backup-pre-public`. Cheap insurance — survives local-disk loss. Verify on GitHub UI that `backup-pre-public` is visible in the branch list.
- [x] 5.3 Apply GitHub branch protection to `backup-pre-public`: Settings → Branches → Add rule → match `backup-pre-public` → enable `Restrict deletions` and `Do not allow force-pushes`. Verify the rule is active on the GitHub UI. Required by the `open-source-distribution` spec (90-day recoverable backup branch).

## 6. Pre-orphan housekeeping

- [x] 6.1 Close PR #49 (release-please pending 0.15.0): `gh pr close 49 --comment "Closing ahead of repository history rewrite for public open-source release. release-please will re-open a fresh 0.15.0 PR once the orphan commit lands; the version chain continues from 0.14.2."`.
- [x] 6.2 Confirm no other open PRs: `gh pr list --state open --json number,title` returns empty.
- [x] 6.3 Confirm no in-flight CI workflows: `gh run list --workflow ci.yml --status in_progress` returns empty. If anything is running, wait for it to complete.

## 7. Orphan-branch swap and force-push

- [x] 7.1 From repo root: `git checkout --orphan public-release`. The working tree is preserved; only `HEAD` becomes the orphan ref.
- [x] 7.2 Wipe `CHANGELOG.md` (`rm CHANGELOG.md`). release-please regenerates from the next merge. Leave `.release-please-manifest.json` and `package.json` at `0.14.2` — the version chain continues per design.md Decision 3.
- [x] 7.3 Stage everything: `git add -A`. Verify `git diff --cached --stat` shows the full project tree as staged.
- [x] 7.4 Run the validation suite ONE MORE TIME against the orphan-tree state: `pnpm install --frozen-lockfile && pnpm run lint && pnpm run typecheck && pnpm test && pnpm run build`. ALL must pass before committing.
- [x] 7.5 Commit with the canonical text from design.md Decision 4: `git commit -m "$(cat <<'EOF'`...`EOF`...`)"`. Verify the commit hash via `git log --oneline -1` — it MUST be a root commit (no parent): `git rev-parse HEAD^` MUST fail with "unknown revision".
- [x] 7.6 Rename branches: `git branch -M main main-old-local && git branch -M public-release main`. The orphan is now `main` locally.
- [x] 7.7 Force-push: `git push --force-with-lease origin main`. The flag avoids overwriting a remote that's somehow ahead of expectations. Verify on GitHub UI that `main` now shows ONE commit at the top, with subject `feat: initial public release of Rembric`.

## 8. Post-orphan validation

- [x] 8.1 Clone a fresh copy of the repo to a sibling directory: `cd /tmp && git clone https://github.com/susomejias/rembric.git rembric-fresh`. Run `cd rembric-fresh && pnpm install --frozen-lockfile && pnpm test && pnpm run build`. ALL must pass. This proves the orphan tree is genuinely self-contained.
- [x] 8.2 Verify `openspec validate --strict` for the active change: `cd rembric-fresh && openspec validate add-data-protection-defaults --strict`. Must pass.
- [x] 8.3 Verify `openspec list` shows `add-data-protection-defaults` as the only active change.

## 9. Tag and Release cleanup

- [x] 9.1 List all tags on origin to confirm what's about to be deleted: `git ls-remote --tags origin | awk '{print $2}' | sed 's|refs/tags/||' | grep '^v0\.'` — expected output: 28 tags `v0.1.0`..`v0.14.2`.
- [x] 9.2 Delete all GitHub Releases AND their underlying tags in one pass: `for t in $(gh release list --limit 30 --json tagName --jq '.[].tagName'); do gh release delete "$t" --yes --cleanup-tag; done`. The `--cleanup-tag` flag deletes both the Release and its tag from origin.
- [x] 9.3 Delete any remaining tags locally and on origin (in case some tags had no Release): `git tag --list 'v*' | xargs -I {} git tag -d {} && git ls-remote --tags origin | awk '{print $2}' | sed 's|refs/tags/||' | xargs -I {} git push origin :refs/tags/{}`.
- [x] 9.4 Verify cleanup: `git tag --list` is empty; `gh release list` is empty; `git ls-remote --tags origin` is empty.

## 10. GitHub-side operator actions

- [x] 10.1 Operator: Settings → Packages → `ghcr.io/susomejias/rembric` → Change visibility → Public. Confirm anonymous `docker pull ghcr.io/susomejias/rembric:v0.14.2` succeeds from a clean machine if the image still exists, OR confirm anonymous pull of the new `:latest` once it publishes.
- [x] 10.2 Operator: Settings → General → Danger Zone → Change repository visibility → Public. Acknowledge the GitHub warnings. Confirm the repo is browsable anonymously at `https://github.com/susomejias/rembric`.
- [x] 10.3 Operator: About sidebar → Edit topics → add `mcp`, `claude-code`, `agent-memory`, `sqlite`, `self-hosted`, `codex-cli`, `hermes-agent`, `typescript`, `nodejs`. Confirm topics render under the description on the public repo page.
- [x] 10.4 Operator: Settings → Branches → Add branch protection rule on `main`: require PRs before merge, require status checks (ci / docker-build-check from `ci.yml`), require linear history, do NOT require signed commits (matches current practice), do NOT require approvals (single-maintainer project).
- [x] 10.5 Operator: trigger the next release-please run by merging `add-data-protection-defaults` once apply is complete. Verify release-please opens a PR for `v0.15.0` and `/healthz` reports the matching version after merge + GHCR publish.

## 11. Final sweep

- [x] 11.1 Operator: read the public README on `github.com/susomejias/rembric` from a clean browser session (incognito) and walk through `Quickstart`. Confirm zero broken anchors, zero stale claims, zero references to private-only resources.
- [x] 11.2 Operator: open a fresh GitHub Security Advisory dry-run to confirm `SECURITY.md` is wired up: Security tab → Advisories → "Report a vulnerability" — the form opens, can be cancelled out.
- [x] 11.3 Operator: read `CODE_OF_CONDUCT.md` link from the About sidebar — it MUST resolve.
- [x] 11.4 Operator: confirm `backup-pre-public` branch is still visible and protected: Settings → Branches → the rule on `backup-pre-public` shows as active. Try `git push --force origin backup-pre-public` from a test branch — it MUST be rejected.
