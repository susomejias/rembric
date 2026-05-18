## Why

Rembric has been developed in a private GitHub repo since 2026-05-13 with disciplined practices: spec-driven changes, append-only invariants, Conventional Commits, release-please, GHCR distribution. The owner wants to open it as MIT open-source. The current state is materially close — LICENSE is neutralized to "Rembric contributors", `.gitignore` excludes `.env`, no corporate identity in commit history, supply-chain hygiene already enforced (pnpm 11 `minimumReleaseAge`, `blockExoticSubdeps`, lifecycle-script default-deny). What's missing is (a) public-facing OSS meta files, (b) the README and a single archived OpenSpec task still carry stale or private-context strings, and (c) the owner has decided to **rewrite history to a single clean commit** as the first commit of the public repo (Ruta B from explore mode: orphan-swap in the same repo, not a two-repo split).

## What Changes

- **NEW** `SECURITY.md` at repo root — vulnerability disclosure policy, supported versions, contact path (GitHub Security Advisories preferred; email fallback to the maintainer).
- **NEW** `CODE_OF_CONDUCT.md` at repo root — Contributor Covenant 2.1 verbatim, with the maintainer's contact email substituted.
- **NEW** `.github/ISSUE_TEMPLATE/bug.md`, `.github/ISSUE_TEMPLATE/feature.md`, `.github/ISSUE_TEMPLATE/config.yml` — Github form-based templates with required `Reproduction steps`, `Rembric version`, `Client (Claude Code / Codex CLI / Hermes)` fields.
- **NEW** `.github/PULL_REQUEST_TEMPLATE.md` — checklist mirroring `CONTRIBUTING.md::Pull request checklist` (lint, typecheck, tests, conventional commit, openspec validate if applicable).
- **MODIFIED** `README.md` — fix `<i>One npm package, …</i>` → `<i>One Docker image, …</i>` (npm distribution sunset in commit `1ed39ce`); remove broken `#cli-operations` anchor from the nav (operator CLI removed in same commit); link prominently to `docs/backup.md` and `SECURITY.md` from a new "Project status" section.
- **MODIFIED** `docs/docker.md:3` — drop the "**private** today; flips to public when the project opens" parenthetical; the line stays accurate once the package is flipped.
- **MODIFIED** `openspec/changes/archive/2026-05-16-fix-codex-hook-stdout-prefix/tasks.md:48` — replace literal `/Users/jesus.mejias/Desktop/rembric` with `<repo>` placeholder.
- **HISTORY REWRITE (operational, one-shot)** — orphan-branch swap on `main` per design.md Decision 4. Before the swap: (i) confirm the owner-attested full-directory `.zip` of the repo is in place (primary recovery), (ii) close PR #49 (release-please pending 0.15.0), (iii) push branch `backup-pre-public` to origin with branch-protection rule (secondary recovery). After the swap: delete all 28 git tags + 24 GitHub Releases, wipe `CHANGELOG.md` (release-please regenerates on next merge), and the single squashed commit message follows the canonical text in tasks.md. Versions in `package.json` and `.release-please-manifest.json` are NOT reset — they stay at `0.14.2` per design.md Decision 3.
- **OPERATOR-ONLY (not done by code in this change)** — flip GHCR package `ghcr.io/susomejias/rembric` to Public; flip GitHub repo visibility to Public; add topics `mcp`, `claude-code`, `agent-memory`, `sqlite`, `self-hosted`, `codex-cli`, `hermes-agent`; create GitHub Release for the next release (likely v0.15.0) with narrative changelog after the first post-flip release-please run.

Not in scope:

- The README disclaimer copy about "default auto-snapshot every 6h × 7" — that copy lives in `add-data-protection-defaults`, which lands as the FIRST post-flip PR. Until that ships, the README points operators at `docs/backup.md` and says "you are responsible for backups" without making any default-on promise.
- Litigating LICENSE choice (MIT is already in place and acceptable).
- Migrating GHCR ownership (the package stays at `ghcr.io/susomejias/rembric`).
- Two-repo strategy (Ruta A from explore mode) — explicitly rejected.

## Capabilities

### New Capabilities

- `open-source-distribution`: codifies the durable requirements for the project as a public open-source project — license, vulnerability disclosure, code of conduct, README presentation invariants, contributor entry points, public release identity. New `openspec/specs/open-source-distribution/spec.md`.

### Modified Capabilities

- `hermes-agent-plugin`: REWORD the GH*PAT-related text in the `Distribution via curl-installer` requirement so it no longer frames the upstream as "private" — once the public repo is open, the GH_PAT support exists to handle \_any* auth-protected source (private fork, private mirror, gated `raw.githubusercontent.com` URL), not because this specific repo is private. Behavior of the install script is unchanged; only the wording of the spec and the user-facing diagnostic hint shift.

A separate one-line prose edit (NOT a spec delta — it sits inside an `## Out-of-scope behaviors` section, not a `### Requirement:` block) in `openspec/specs/claude-code-plugin/spec.md:255` SHALL be applied directly to remove the legacy "remains private to the monorepo's audience" framing. Tracked in tasks.md under section 1 (docs / scrub) for audit visibility.

## Impact

**New files**

- `SECURITY.md`, `CODE_OF_CONDUCT.md`
- `.github/ISSUE_TEMPLATE/{bug.md,feature.md,config.yml}`, `.github/PULL_REQUEST_TEMPLATE.md`

**Modified files**

- `README.md` (stale-claims scrub + new Project status section)
- `docs/docker.md` (private-today line)
- `openspec/changes/archive/2026-05-16-fix-codex-hook-stdout-prefix/tasks.md` (user-path scrub)
- `CHANGELOG.md` (wiped — release-please regenerates from the next merge; the manifest at `0.14.2` continues the version chain)

**Git history**

- 188 commits → 1 commit. The 1 commit is the orphan with subject `feat: initial public release of Rembric`. Body lists the major surfaces (MCP memory tools, session lifecycle endpoints, operator dashboard, append-only audit trail, three plugins for Claude Code / Codex CLI / Hermes Agent, Docker distribution) and links to README.
- 28 tags → 0 tags (deleted local + remote).
- 24 GitHub Releases → 0 (deleted via `gh release delete --cleanup-tag`).
- 32 PRs → 32 PRs (GitHub does not allow PR deletion without Support). Closed PRs will visually show "merged into a commit that's not in this repository" — accepted cosmetic cost.
- `backup-pre-public` branch retained on origin as the recovery branch for 90 days minimum.

**Versioning**

- Version chain is preserved. `.release-please-manifest.json` and `package.json` stay at `0.14.2`. The next merge with a `feat:` commit (which will be `add-data-protection-defaults`) bumps to `0.15.0` via release-please as usual. A `1.0.0` declaration is a separate later decision tied to operational maturity, not to the open-source flip.

**Sequencing constraint with `add-data-protection-defaults`**

- This change archives BEFORE the orphan commit is produced, so the squashed tree includes its own archive at `openspec/changes/archive/<date>-prepare-public-release/`.
- `add-data-protection-defaults` remains active in `openspec/changes/` and carries over into the orphan commit. It is the natural PR #1 of the public repo, lands the default-on backup + the README disclaimer copy that mentions defaults, and produces release `v0.15.0` via release-please.

**GitHub artifacts that survive the rewrite**

- GHCR images at `ghcr.io/susomejias/rembric:v0.X.Y` — these are independent of git refs and stay published until the operator deletes them. Recommended action documented in tasks.md: prune GHCR tags older than the orphan commit.
- Issues — none currently open. No action needed.
- Branches other than main — `backup-pre-public` retained; everything else is dead-weight to be cleaned up post-flip.
