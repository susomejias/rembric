## Why

A plugin release becomes installable as soon as its release commit lands on `main`, but its exact-pinned `@rembric/mcp-bridge` reaches npm minutes later (about 5.5 minutes for `plugin-v0.43.0`, issue #513). Every client that launches the pinned bridge (Claude Code, Codex, opencode, Hermes) can install a plugin whose MCP server cannot start yet, and the TUI installer can announce "update available" in the same window. Every install path follows `main` HEAD, so the fix is to stop following it.

## What Changes

- A `plugin-release` branch becomes the plugin distribution ref. Only CI moves it: a `promote-plugin-release` job in `release-please.yml` runs after `publish-npm` succeeds, checks that the target's bridge version is on npm, and fast-forwards the branch to the release tag. A `workflow_dispatch` input promotes, or rolls back to, any `plugin-v*` tag (rollback is a forced, non-fast-forward update). The job is a no-op when the branch already points at the target. A GitHub App token is the only credential that can move the branch past its ruleset; `GITHUB_TOKEN` stays read-only in that job.
- `.claude-plugin/marketplace.json` switches its plugin entry from the relative path `./apps/plugin` to a `git-subdir` source pinned to `ref: plugin-release`. Codex CLI reads this same manifest (measured on 0.163.0), so this one edit fixes both marketplace clients.
- `.codex-plugin/marketplace.json` moves `ref` from `main` to `plugin-release` for consistency.
- The TUI installer splits its default ref by track. Plugin artifacts and `.release-please-manifest.json` come from `plugin-release`, resolved once per run to a commit SHA with `git ls-remote` and fetched by that SHA, so the raw CDN cannot serve a stale branch. Without git it falls back to the branch URL. Server artifacts (`docker-compose.yml`, `.env.example`) stay on `main`. `--ref` / `REMBRIC_REF` still override both tracks.
- Hermes install/update pin the resolved commit: `hermes plugins install … --ref <sha> --enable`, and update moves the pin with `hermes plugins install … --force --ref <sha>`, because a SHA-pinned install refuses `hermes plugins update`. A Hermes mutation refuses to run when the commit cannot be resolved. The adapter accepts pinned native metadata.
- The opencode manual-fallback script defaults to `plugin-release` instead of `main`.
- Docs: `CLAUDE.md`, `apps/plugin/README.md`, the installer skill and an owner-prerequisites section (bootstrap branch, GitHub App, ruleset).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `open-source-distribution`: plugin clients install from a release ref that advances only after the plugin's npm packages are published, with an explicit rollback path.
- `tui-installer`: plugin artifacts and the available-version manifest come from the resolved plugin release commit; server artifacts keep the server track; Hermes mutations pin that commit.
- `claude-code-plugin`: the marketplace entry is a `git-subdir` source pinned to the plugin release ref.
- `codex-distribution`: the Codex marketplace manifest's `ref` is the plugin release ref.

## Impact

- `.github/workflows/release-please.yml`, `scripts/release-workflow.test.ts`.
- `.claude-plugin/marketplace.json`, `.codex-plugin/marketplace.json`.
- `apps/plugin/install.sh`, `apps/plugin/.hermes-plugin/install.sh`, `apps/plugin/.opencode-plugin/install.sh`, `install.test.ts`.
- `CLAUDE.md`, `apps/plugin/README.md`, `docs/agents.md`, `.agents/skills/rembric-tui-installer/SKILL.md`.
- Owner prerequisites outside the repository: the `plugin-release` branch must exist at the latest `plugin-v*` tag before this merges, plus the GitHub App, its credentials and the branch ruleset.
