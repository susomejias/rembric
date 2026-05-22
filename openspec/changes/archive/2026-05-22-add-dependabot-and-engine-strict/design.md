## Context

Rembric's npm-ecosystem supply-chain posture today is enforced by four orthogonal pnpm-native knobs:

```
.npmrc::ignore-scripts=true            # default-deny lifecycle scripts
pnpm-workspace.yaml
  ::allowBuilds: { husky, better-sqlite3, sqlite-vec : true, esbuild : false }
  ::blockExoticSubdeps: true           # registry-only transitive sources
  ::minimumReleaseAge: 4320            # 3-day install cooldown
CI + Dockerfile: pnpm install --frozen-lockfile  # deterministic install
```

These are documented informally in `CLAUDE.md` and in the `.agents/skills/npm-security-best-practices/SKILL.md` reference, but no OpenSpec capability codifies them. The `npm-security-best-practices` skill enumerates 17 practices from `lirantal/npm-security-best-practices`; this repo applies 1, 2, 3, 6 (and N/A's 11/12/13 because of the [[project-npm-publishing-sunset]] decision to keep `private: true` locked-in). Two further practices are missing in measurable form:

- **#7 — avoid blind dependency upgrades**: no Dependabot/Renovate config exists, so the locked tree drifts and CVEs against pinned versions only surface when someone runs `pnpm audit` manually.
- **Node version enforcement at install time**: `package.json::engines.node = ">=22.13"` is set, but pnpm treats `engines` as advisory unless `engine-strict=true` is opted into. A wrong-Node install succeeds and breaks later at first `node:sqlite` import.

Both are install-time defenses. Neither touches the run-time data path. Neither modifies any append-only / scope-at-service / topic_key / judgment invariant.

## Goals / Non-Goals

**Goals:**

- Close the practice #7 gap with a Dependabot config that opens PRs weekly under manual approval, covering npm + docker + github-actions ecosystems.
- Close the Node-version-drift gap with `.npmrc::engine-strict=true` so install fails fast on Node `<22.13`.
- Codify the existing supply-chain defenses in a new `supply-chain-hygiene` capability spec so future proposals can extend or revise them without re-discovering the contract.
- Document the post-merge operator step of enabling Dependabot security updates and the Dependency graph via repo Settings (these toggles are not file-versioned but are part of the layered defense).

**Non-Goals:**

- Renovate adoption (alternative considered and rejected — see Decision 1).
- `pnpm audit` scheduled workflow (considered and rejected — see Decision 2).
- Auto-merging Dependabot PRs even for patch/minor bumps (considered and rejected — see Decision 3).
- CodeQL, gitleaks, secret-scanning, or any other security workflow outside the npm-supply-chain framing — those are different threat models and merit their own proposals.
- Reintroducing `lockfile-lint` for `pnpm-lock.yaml` — `lockfile-lint@4.x` does not parse pnpm lockfiles; the pnpm-native invariants of `--frozen-lockfile` (consistency vs `package.json`, integrity hashes, exotic-source rejection) cover the same threat class.
- Publishing-related practices (#11 2FA, #12 provenance, #13 OIDC) — N/A while [[project-npm-publishing-sunset]] holds.
- Modifying or formalizing the existing `pnpm-workspace.yaml` knobs (`allowBuilds`, `blockExoticSubdeps`, `minimumReleaseAge`) values themselves — the new spec describes the existing values as the contract; it does not change them.

## Decisions

### Decision 1 — Dependabot, not Renovate, and not both

**Chosen:** Dependabot alone.

**Why:** Dependabot is GitHub-native (zero external infra), already integrated with GitHub Security Advisories (the Settings → Security & analysis toggle gives us per-CVE PRs alongside the routine version-update PRs from the config file), and sufficient for a repo of this size. Renovate is more expressive (regex managers, fine-grained grouping, broader ecosystem support) but introduces a hosted bot dependency and a second panel to monitor.

**Why not both:** Running Dependabot and Renovate in parallel is documented anti-pattern in both vendors' docs. Both consume the same GitHub Advisory Database, so they open duplicate PRs for the same CVEs; both rewrite the same `pnpm-lock.yaml`, causing rebase loops on every bump. Coverage is not additive — the second tool adds noise, not signal.

**Alternatives considered:**

- _Renovate alone_: rejected for the GitHub-native + hosted-bot trade-off above. Could revisit if grouping needs outgrow Dependabot's expressiveness.
- _No bot, manual updates only_: rejected. Practice #7 explicitly warns that "bump everything" commands mask supply-chain attacks; structured PR review with cooldown is the named middle ground.

### Decision 2 — No weekly `pnpm audit` workflow

**Chosen:** Skip the `pnpm audit` cron entirely. Rely on Dependabot's security updates (enabled via Settings → Security & analysis toggle) for CVE coverage.

**Why:** GitHub's "Dependabot security updates" toggle consumes the same GitHub Advisory Database that `pnpm audit` queries, and opens _actionable_ PRs (with the proposed remediation bump) instead of just logging findings. A `pnpm audit` cron would be redundant in steady state; its only marginal value is in the race window where a CVE is in the DB but Dependabot has not yet opened the PR (typically <24 h) or as a tripwire if someone accidentally disables the toggle. That marginal value does not justify the workflow file, the `issues: write` permission, and the cron-noise maintenance cost.

**Alternatives considered:**

- _Weekly `pnpm audit` with `gh issue create` on failure_: rejected per above; revisit if Dependabot security updates prove unreliable in practice.
- _Workflow with `::warning::` only_: rejected — a workflow that warns without failing is effectively invisible.

### Decision 3 — Weekly schedule + manual approval, no auto-merge

**Chosen:** `schedule.interval: weekly`, no `automerge: true`, `open-pull-requests-limit: 5` per ecosystem.

**Why:** `minimumReleaseAge: 4320` (3 days) already filters out brand-new compromised publishes — the prime window where blind auto-merge would be most dangerous. But the cooldown does NOT protect against the "asentado y luego comprometido" class (a long-stable package whose maintainer account is compromised and pushes a malicious version that ages past the cooldown). Manual review of every bump PR is the gate that catches that. Weekly cadence keeps noise low; if a critical CVE needs faster turnaround, the operator can trigger Dependabot manually or override.

**Alternatives considered:**

- _Daily schedule_: rejected. Marginal value over weekly given the cooldown; significantly higher notification noise.
- _Auto-merge on patch/minor with CI green_: rejected. CI green ≠ "no maintainer-account compromise"; the human-review step is the gate against the post-stabilization-compromise class.
- _Group by ecosystem with bigger batches_: deferred. The default Dependabot output (one PR per dep update) is fine while the repo is small; consider `groups:` config if PR volume becomes painful.

### Decision 4 — Three ecosystems, not just `npm`

**Chosen:** Enable Dependabot for `npm`, `docker`, and `github-actions`. All weekly, all manual approval.

**Why:** The repo has supply-chain surface beyond `pnpm-lock.yaml`:

- _Docker_: `apps/server/Dockerfile` pins `FROM node:22-bookworm-slim`. A new minor of `node:22-bookworm-slim` ships security patches in the base image; without Dependabot, those drift.
- _GitHub Actions_: Workflows pin actions to major (`actions/checkout@v6`, `docker/build-push-action@v7`). Action-level supply-chain compromises (the `tj-actions/changed-files` incident, etc.) hit consumers who don't track minor/patch updates. Dependabot opens PRs to bump to the latest patch within the pinned major.

**Why all weekly + manual approval:** consistent rule across ecosystems — no per-ecosystem cognitive load when reviewing PRs.

**Alternatives considered:**

- _`npm` only_: rejected. Leaves Dockerfile + workflow supply-chain unmanaged.
- _Pin actions to SHA + ignore minor/patch_: considered. SHA-pinning is stronger but operationally heavy for this repo size; revisit if action-level supply-chain incidents accumulate.

### Decision 5 — `engine-strict=true` over package.json hooks

**Chosen:** Set `engine-strict=true` in `.npmrc` (pnpm honors it).

**Why:** `.npmrc` is the canonical, ecosystem-standard location for install-time policy; this lives next to `ignore-scripts=true` which is conceptually the same kind of guard. Alternatives like a `preinstall` script that checks `process.version` are non-portable, easy to bypass with `--ignore-scripts`, and split policy across two files.

**Why this matters:** pnpm 11 imports `node:sqlite` at startup. On Node `<22.13` the import fails with a confusing module-not-found error after install succeeds. With `engine-strict=true`, `pnpm install` fails immediately with a clear `engines.node` violation, naming the version mismatch.

**Alternatives considered:**

- _`preinstall` script comparing `process.version`_: rejected as non-portable / bypassable.
- _Leave it advisory_: rejected. Today's invariant only holds because CI and the Dockerfile both pin Node 22; a local dev with the wrong `nvm use` gets a runtime crash instead of a fast-failed install.

### Decision 6 — Codify existing knobs in the new spec, do not change their values

**Chosen:** The new `supply-chain-hygiene` capability spec describes the existing pnpm-native defenses (default-deny lifecycle scripts, exotic-source block, install cooldown, deterministic install) as load-bearing requirements **at their current values**. Only the two new bits (`engine-strict=true`, Dependabot config) are deltas.

**Why:** The existing knobs are load-bearing — the `npm-security-best-practices` skill enforces them and `reference_npm_security_skill.md` memory tracks them — but no OpenSpec capability anchors them today. Without that anchor, a future proposal can silently weaken them (lowering `minimumReleaseAge`, dropping `blockExoticSubdeps`, adding packages to `allowBuilds` without justification) and no spec test catches it. Codifying them in the new spec turns those silent regressions into proposal-required changes.

**Alternatives considered:**

- _Bare-minimum spec covering only the two new bits_: rejected. Leaves the foundation un-anchored; future drift is easier to introduce.
- _Codify in `development-environment` or `open-source-distribution`_: rejected. Both specs have unrelated purposes; the supply-chain story deserves its own capability for discoverability.

## Risks / Trade-offs

- **[Risk]** First Dependabot PR may surface a bump that violates `minimumReleaseAge: 4320` and fail to install in Dependabot's own runner → Mitigation: Dependabot waits for `pnpm install --frozen-lockfile` to succeed before opening the PR; if pnpm refuses, the PR will be marked failed in Dependabot's status page (Actions tab still green because no workflow ran). Document in tasks.md how to identify and unblock (lower cooldown temporarily, or add the package to `minimumReleaseAgeExclude`).
- **[Risk]** `engine-strict=true` blocks `pnpm install` on the (currently allowed) range Node `>=22.13`. A developer on Node 22.12 or 20.x will see install failure → Mitigation: error message names the constraint explicitly; document the requirement in tasks.md and ensure README / CONTRIBUTING reflect Node 22.13+ as the floor. CI already runs Node 22 and the Dockerfile already pins `node:22-bookworm-slim`, so no system-side breakage.
- **[Trade-off]** Manual approval on all Dependabot PRs means routine patch bumps require human attention → Accepted because the cost (a few PR reviews per week) is bounded and the win (catching maintainer-account-compromise bumps that aged past the cooldown) is real. Revisit if PR volume becomes painful.
- **[Trade-off]** Three ecosystems = more total PRs than `npm`-only → Accepted because Dockerfile + workflows are part of the supply-chain surface; ignoring them is false economy. Revisit grouping if noise dominates signal.
- **[Risk]** Dependabot security updates toggle is enabled via UI, not file-versioned → Mitigation: tasks.md documents the toggle as a required post-merge step; a brief screenshot or `gh api` invocation in the task makes the state auditable. The codified spec requirement names the toggle as part of the contract, so future contributors notice if it gets disabled.
- **[Risk]** Codifying existing knob _values_ (cooldown=4320, allowBuilds entries) in a spec freezes them — bumping later requires a spec change → Accepted because that is the whole point of the codification; silent value drift is the failure mode we want to prevent. Genuine bumps remain easy (one-paragraph spec modification).
