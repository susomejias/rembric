## Context

The repo has been a single-owner private project on GitHub since 2026-05-13. Current state is `main @ 959c38a`, 188 commits, 28 tags (`v0.1.0` … `v0.14.2`), 24 GitHub Releases, 32 PRs (1 open: release-please pending 0.15.0; 29 merged; 2 closed). The committer set is the maintainer's previous personal Gmail + `github-actions[bot]` — zero corporate-identity leak. LICENSE is MIT with copyright neutralized to "Rembric contributors". `.gitignore` excludes `.env`, `*.local.*`, `data/`, `data-dev/`, `AGENTS.md`, `.claude/`.

The OWNER has explicitly chosen Ruta B (orphan-swap in the same repo) over Ruta A (rename current to `rembric-private`, create new public from scratch). The motivation: the URL `github.com/susomejias/rembric` carries SEO / backlink value and the project's documentation already hard-codes that URL across README, `docs/`, and `openspec/`. A two-repo split would either redirect (transient) or force a documentation-wide URL update; Ruta B preserves the URL.

The OWNER has also asked that the open-source-readiness work and the history rewrite ship in one motion ("todo junto"), so the very first commit of the public repo carries the corrected README, the OSS meta files, and the scrubbed archived tasks file.

Related concurrent change: `add-data-protection-defaults` (already proposed, validate green). It is sequenced AFTER this change — it lands as the first post-flip PR. The README disclaimer copy about default-on backups belongs to that change, not this one, because the squashed tree must accurately reflect what's implemented.

## Goals / Non-Goals

**Goals:**

- Single orphan commit on `main` carrying a publish-ready tree (README/docs clean, OSS meta files present, archived openspec scrubbed of personal paths).
- Recoverable backup of the pre-rewrite state so the owner can recover for at least 90 days post-flip with zero ambiguity. Two independent artifacts: an owner-attested full-directory zip (primary, out-of-band), and a protected `backup-pre-public` remote branch (secondary, cheap insurance).
- Codify the durable OSS-readiness requirements in a new `open-source-distribution` capability so future contributors don't silently regress (e.g., re-introducing stale npm copy in README, dropping SECURITY.md, etc.).
- Sequence the GitHub-side operator actions (GHCR public flip, repo visibility flip, topics, post-flip Release) as numbered tasks so the operator can execute them mechanically.

**Non-Goals:**

- Two-repo strategy (Ruta A) — explicitly rejected.
- Hot-swap "switch visibility without rewriting history" — explicitly rejected.
- Migrating the GHCR image to a new owner / registry — out of scope.
- Litigating MIT vs Apache 2.0 vs AGPL — MIT is already in place and unchallenged.
- Adding governance-as-code beyond what `open-source-distribution` codifies (e.g., MAINTAINERS.md, GOVERNANCE.md, dependency review automation) — can be follow-ups, none are blockers for the flip.
- Auto-deleting stale GitHub branches as part of this change — operator does this manually post-flip if desired.

## Decisions

### Decision 1 — Ruta B (orphan-swap in the same repo), not Ruta A

Owner decision, recorded for future reference. Trade-off accepted: 32 closed PRs will visually show "merged commits not in this repository" — cosmetic cost on the GitHub UI but no functional impact. 28 GitHub Releases and 28 git tags must be deleted manually as part of the sequence (gh CLI handles this).

**Alternatives considered:**

- Ruta A (two repos): cleaner UX but breaks `github.com/susomejias/rembric` URL continuity across documentation, README badges, marketplace manifests (`.claude-plugin/marketplace.json`, `.codex-plugin/marketplace.json`), and external references.
- Hybrid (keep history private + cherry-pick a clean PR set to a new branch): too much manual curation for too little benefit; we don't get to choose which commits "look good" — operators reading the public repo want a single source of truth.

### Decision 2 — Recoverable backup before any destructive operation

The owner CAN recover from the rewrite if and only if at least one independent copy of pre-rewrite state exists. For this specific execution the owner has produced an **out-of-band full-directory `.zip`** (entire working tree including `.git/`, all refs, all tags, all reflog state) before invoking `/opsx:apply`. That zip is the primary recovery artifact for the OWNER's own use and supersedes the mirror-clone step from earlier drafts of this design.

For belt-and-suspenders, the orphan operation still pushes a `backup-pre-public` branch to origin:

1. **Owner's full-directory zip** (out-of-band, attested in task 5.1) — primary recovery for this execution. Local file system, owner-managed.
2. **`backup-pre-public` branch on origin** (task 5.2) — recoverable from any internet-connected machine via `git fetch`. Cheap to produce (one command), survives local-disk loss. Locked under GitHub branch protection per task 5.3.

The mirror-clone step is dropped from tasks.md because the zip provides equivalent (or stronger) coverage for the owner's recovery needs without the extra ceremony.

The durable spec requirement in `open-source-distribution` ("90-day recoverable `backup-pre-public` branch on origin with protection") is unchanged — it's the project-level invariant, independent of any one-off ceremony the operator runs. The zip simplification is execution-local.

**Trade-off accepted:** the zip lives on the owner's machine only. If the owner's disk dies AND someone force-deletes `backup-pre-public` on origin in the same window, recovery is impossible. With protection rules on the remote branch this requires either GitHub admin compromise OR the owner explicitly disabling the protection, so the residual risk is acceptable for a single-maintainer project.

### Decision 3 — Keep the current version (`0.14.2`); do NOT reset the manifest

Owner decision (2026-05-18): the version doesn't matter for this flip. `.release-please-manifest.json` stays at `0.14.2`, `package.json` stays at `0.14.2`, and the four version surfaces (`package.json`, manifest, `/healthz`, GHCR tag) remain in lock-step. The next merge with a `feat:` commit bumps to `0.15.0` via release-please as usual.

**What this means in practice:**

- The orphan commit's tree carries the same version values as the pre-rewrite tree.
- The first post-flip release tag will be `v0.15.0`, NOT `v0.1.0`.
- GHCR images at `ghcr.io/susomejias/rembric:v0.14.2` continue to be the "current latest" pullable artifact until the next release publishes.
- `add-data-protection-defaults` will land as the `v0.15.0` release once merged.

**Why the version surface continues but the history doesn't:**

- The squashed commit is best understood as "the project's working state as of 2026-05-18, with prior history collapsed." Version surfaces describe the artifact's current state, not its history; collapsing history does not invalidate the version.
- Operators pinning to a specific tag aren't affected — GHCR is the source of truth for them, and those tags survive.

**Alternatives considered (and rejected):**

- Reset to `0.0.0`: signals "starting over." Owner doesn't want the narrative reframe — the project IS continuing, just behind one squashed commit.
- Jump to `1.0.0`: stability promise the project has not yet earned.

### Decision 4 — Single-commit message text is canonical, not negotiable

The orphan commit message is locked in:

```
feat: initial public release of Rembric

Self-hosted memory, sessions, and dashboard for AI coding agents.
One Docker image, one process, one SQLite file. The MCP memory surface
is the core; session lifecycle, judgments, projects, consolidation,
and an operator dashboard come along in the same process. Multi-client
by construction (Claude Code, Codex CLI, Hermes Agent), reversible by
design.

This is the first commit of the public repository. Pre-public
development happened over 188 commits between 2026-05-13 and the
date of this commit; that history is preserved on the
`backup-pre-public` branch of the same repo for reference.
```

Rationale for locking it:

- Conventional Commits parser (`commitlint`) accepts this.
- release-please ingests `feat:` as the trigger for the next minor bump on next merge — clean state machine.
- Body explains the rewrite to anyone arriving at this commit via `git log`, which is good faith disclosure.
- "Preserved on `backup-pre-public`" is a verifiable claim — the branch exists per Decision 2.

### Decision 5 — Delete tags + Releases, do NOT try to delete PRs

GitHub does not allow PR deletion without contacting Support. Trying to "clean up" closed PRs is out of scope — accepted cosmetic cost. What we CAN clean up:

- All 28 git tags (local + remote): the GHCR images they tagged are independent artifacts that survive.
- All 24 GitHub Releases: `gh release delete <tag> --cleanup-tag --yes` handles both at once.

The rationale for deleting Releases: leaving them creates 24 dangling pages on GitHub that all 404 once their tags are deleted. Cleaner to delete them outright.

### Decision 6 — Wipe `CHANGELOG.md`, do NOT keep a "Pre-public history" stub

The current CHANGELOG.md was generated by release-please from 188 commits' worth of Conventional Commits. Keeping it in the orphan commit would create a strange tableau: 886 lines of changelog with no corresponding git history to back it up. Wipe it entirely; release-please will regenerate from the next merge.

If the owner wants a public retrospective of pre-public work, the right surface is a `BLOG.md` or a GitHub Discussions post, NOT `CHANGELOG.md`.

### Decision 7 — Codify the OSS-readiness requirements in a new `open-source-distribution` capability

The work in this change is partly operational (history rewrite, GitHub UI flips) and partly durable (SECURITY.md exists, README doesn't make false claims, COC exists). The durable part deserves a spec so future agents/contributors don't silently regress. The new capability sits alongside `claude-code-plugin`, `codex-distribution`, `hermes-agent-plugin` — all of which are "how Rembric appears to the outside world" specs.

The capability spec requirements cover: license, vulnerability disclosure, code of conduct, README accuracy and presentation, contributor on-ramp documents, and the existence of issue/PR templates. It does NOT cover the one-shot operational tasks (history rewrite, GitHub flips) — those belong in `tasks.md` and archive once executed.

### Decision 8 — Archive THIS change BEFORE the orphan commit, so the squash includes its own archive

Sequence:

```
1. Implement docs/scrub edits + meta files (tasks.md section 1-3)
2. Commit the docs/scrub work to current main (normal Conventional Commits commit)
3. Archive THIS change: openspec/changes/prepare-public-release/ → openspec/changes/archive/<date>-prepare-public-release/
4. Commit the archive move
5. Pre-orphan backup (zip primary + `backup-pre-public` branch with protection, per Decision 2)
6. Orphan-swap operation (single squashed commit on main)
7. The orphan commit's tree contains:
     openspec/changes/archive/<date>-prepare-public-release/ ✅ (archived before squash)
     openspec/changes/add-data-protection-defaults/ ✅ (still active, becomes PR #1)
8. Force-push main, delete tags + releases, GitHub-side operator actions
```

The alternative (archive AFTER the orphan) was considered and rejected: it would mean the orphan commit ships with `openspec/changes/prepare-public-release/` as ACTIVE, even though the change has self-evidently been applied. Anyone reading the orphan tree would be confused.

## Risks / Trade-offs

- **[Risk] Force-push to main destroys upstream commits if a collaborator has a clone** → Mitigation: the project has no collaborators (verified via `git log --all --pretty='%ae' | sort -u`: only the maintainer's Gmail + github-actions). Operator-only project. Acceptable.
- **[Risk] Tags / Releases are deleted before the orphan commit is verified clean** → Mitigation: the task order in tasks.md does the orphan commit + force-push FIRST, then validates `pnpm test` + `pnpm run build` on the new main, ONLY THEN deletes tags and releases. Tag deletion is the last destructive step.
- **[Risk] release-please cache on GitHub Actions gets confused after the orphan rewrite** → Mitigation: the workflow runs against the new main with the manifest still at `0.14.2`; release-please reads the manifest as authoritative and continues the release chain. Verified manually in task 8.x (after the orphan commit, before declaring done). Worst case: release-please opens a PR titled `chore(main): release 0.15.0` with an empty changelog the first time around — that's cosmetic, not blocking.
- **[Risk] GHCR image continuity breaks for existing operators pinned to a tag** → Mitigation: GHCR images survive git tag deletion. Anyone pinned to `ghcr.io/susomejias/rembric:v0.14.2` keeps pulling that exact image. Documented in the release notes for the next published version that pre-public tags are still pullable but unmaintained.
- **[Risk] Stale archived openspec content in the orphan commit references things that no longer exist (e.g., PR numbers from the pre-public era)** → Accepted. The archives are historical artifacts; the README points at `openspec/changes/archive/` as the audit trail.
- **[Trade-off] 32 closed PRs become visually broken on the GitHub UI** → Accepted (Decision 5). They will show "X commits, none of which are in this repository's branches." Operators who navigate to them get a "what is this?" moment but no functional issue.
- **[Trade-off] release-please continues from 0.14.2; the `add-data-protection-defaults` PR becomes v0.15.0** → Owner decision (2026-05-18): version continuity is preferred over a narrative reset. The squashed commit collapses history, the version surface keeps its lineage.
- **[Trade-off] README copy mentions backups but does NOT claim default-on until `add-data-protection-defaults` lands** → Accepted. Honest sequencing.

## Migration Plan

```
PRE-EXECUTION CHECKLIST (operator verifies)
  [ ] GHCR registry login (gh auth status) confirms maintainer-level access
  [ ] `gh pr view 49` confirms PR #49 still open (will be closed in task 6.1)
  [ ] No collaborators on the repo (verified)
  [ ] Working tree clean: `git status` empty
  [ ] On branch main: `git symbolic-ref --short HEAD` = main
  [ ] No CI workflows are currently running

EXECUTION ORDER (matches tasks.md)
  1. Docs / scrub edits + new meta files → conventional commit on current main
  2. Archive this change before squash
  3. Pre-orphan backup (owner-attested zip primary; push backup-pre-public + protection rule secondary)
  4. Orphan-swap + force-push main
  5. Validate new main (build, typecheck, lint, test, openspec validate)
  6. Delete tags + Releases
  7. GitHub-side operator actions (GHCR public, repo public, topics, new Release)

ROLLBACK (within 90 days)
  # Path A — origin still has backup-pre-public (the expected case):
  git fetch origin backup-pre-public
  git branch -f main origin/backup-pre-public
  git push --force-with-lease origin main
  # Re-create tags from the pre-rewrite state. backup-pre-public itself doesn't
  # carry the tag refs (a branch is a single ref), so unzip the owner-attested
  # full-directory backup zip to a sibling directory and source tags from its
  # .git/ tree:
  unzip ~/path-to-pre-public-backup.zip -d /tmp/rembric-pre-public
  cd /tmp/rembric-pre-public && git tag --list 'v*' \
    | xargs -I {} sh -c 'cd '"$OLDPWD"' && git tag {} $(cd /tmp/rembric-pre-public && git rev-parse {})'
  cd - && git push origin --tags
  # Path B — origin's backup-pre-public is also gone (catastrophic):
  # Restore the owner zip locally, push --force from the unzipped working copy.
  # Re-create GitHub Releases manually if needed (operator decides which are worth restoring).
  # Revert GHCR + repo visibility flips manually in GitHub UI.
```

## Open Questions

- **Should we publish a special GitHub Release tied to the orphan commit (e.g., "Public release of Rembric"), or wait for release-please to produce `v0.15.0` automatically on the next merge?** Recommended: wait. Let release-please create `v0.15.0` when `add-data-protection-defaults` merges; that release becomes the de-facto "public-debut" tag in the operator narrative.
- **Should we set the `default-branch-protection-rule` on main BEFORE flipping visibility (require PRs, require status checks)?** Recommended: yes — configure during the operator-action phase (task 7.4) and document the choice in the new GitHub Release notes.
- **Should we keep the `backup-pre-public` branch hidden via branch protection rules (`Restrict who can push`, no force-pushes)?** Recommended: yes — set a single rule that disallows force-push and deletion on `backup-pre-public`. Documented as task 7.5.
