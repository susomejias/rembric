## Why

The repo already enforces four pnpm-native supply-chain defenses (`.npmrc::ignore-scripts=true`, `pnpm-workspace.yaml::allowBuilds`, `blockExoticSubdeps`, `minimumReleaseAge: 4320`) and `pnpm install --frozen-lockfile` in CI + both Dockerfile stages. Two layers from the `npm-security-best-practices` skill are still missing and would close gaps the existing knobs do not cover:

1. **No automated dep-update flow** (practice #7) — without Dependabot/Renovate, the locked tree drifts; CVEs against pinned versions only surface when someone runs `pnpm audit` by hand.
2. **`engines.node>=22.13` is advisory only** — pnpm 11 needs Node ≥22.13 (it imports `node:sqlite`); without `engine-strict=true` a wrong-Node-version `pnpm install` succeeds at install time and only crashes at runtime with a confusing error.

These two additions are independent, low-friction, and high-value. They also need a single durable spec to anchor the _existing_ supply-chain knobs (currently only documented in CLAUDE.md and the skill — not in any OpenSpec capability), so future proposals can extend or revise them without re-discovering the contract.

## What Changes

- ADD `.github/dependabot.yml` with three ecosystems (`npm`, `docker`, `github-actions`), all weekly + manual approval. Manual approval is the explicit choice because `minimumReleaseAge: 4320` already protects against brand-new compromised publishes; auto-merging patch/minor would still skip human review of post-release-becomes-compromised cases.
- MODIFY `.npmrc` to add `engine-strict=true` so `pnpm install` fails fast on Node `<22.13` instead of crashing at runtime.
- ADD a new `supply-chain-hygiene` capability spec that codifies the current pnpm-native defenses (so they stop being floor-rules implicit in `.npmrc`/`pnpm-workspace.yaml`) AND the two new requirements.
- ADD documentation in `tasks.md` of the post-merge manual step: enable **Dependabot security updates** + **Dependency graph** toggles in repo Settings → Security & analysis. These toggles are not file-versioned, so they sit outside the code diff but are part of the change.

No spec areas are MODIFIED — the new capability is additive. Existing pnpm-native defenses keep working unchanged; they just become contractually enforced going forward.

## Capabilities

### New Capabilities

- `supply-chain-hygiene`: Defines the durable contract for npm-ecosystem supply-chain defense in this repo — default-deny lifecycle scripts with explicit allowlist, registry-only transitive sources, install cooldown, deterministic installs in CI + Dockerfile, install-time Node engine enforcement, and bot-driven routine dep updates under manual review.

### Modified Capabilities

(none — additive change)

## Impact

**Code / config files**:

- `.github/dependabot.yml` (NEW) — 3 ecosystems × weekly × manual approval
- `.npmrc` (MODIFY) — add `engine-strict=true` with one-line rationale comment

**Spec files**:

- `openspec/changes/add-dependabot-and-engine-strict/specs/supply-chain-hygiene/spec.md` (NEW)
- After archive: `openspec/specs/supply-chain-hygiene/spec.md` (NEW canonical)

**Out-of-tree (operator action, documented in tasks)**:

- Repo Settings → Security & analysis → Dependabot security updates: ENABLE
- Repo Settings → Security & analysis → Dependency graph: ENABLE

**Tooling untouched**:

- `pnpm-workspace.yaml` — knobs already correct, spec just codifies them
- CI workflows — `ci.yml` keeps `pnpm install --frozen-lockfile`; no new jobs
- Dockerfile stages — both keep `pnpm install --frozen-lockfile` as today

**Invariants touched**: none. This proposal adds two install-time defenses + codifies existing ones; it does not weaken or modify any append-only / scope-at-service / topic_key / judgment invariant.
