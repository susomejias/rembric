<!--
Thanks for contributing! Please write the title and description in English.
The PR title must be a Conventional Commit (`feat(scope): …`, `fix(scope): …`, `docs: …`):
release-please builds the changelog and version bumps from it.
Delete any section that does not apply.
-->

## Summary

<!-- What changes and why, in 1–3 sentences. Describe the user-visible effect, not the diff. -->

Closes #

## How it was verified

<!-- What you actually ran and observed. Reviewers will re-run these. -->

- [ ] `pnpm run lint` and `pnpm run typecheck` clean
- [ ] `pnpm test` green (full suite)
- [ ] Manual check against `pnpm run dev`: <!-- the scenario you tried and what you saw -->

## Area-specific checks

<!-- Tick the ones that apply and delete the rest. -->

- [ ] **Dashboard UI** — before/after screenshots attached (desktop and mobile width).
- [ ] **Agent plugin (`apps/plugin/`)** — [e2e walkthrough](https://github.com/susomejias/rembric/blob/main/.agents/skills/rembric-plugin-development/references/e2e-walkthrough.md) done for every affected client; no hand-edited version bump (release-please owns plugin versions).
- [ ] **Installer / distribution** — `pnpm run e2e:installer` green and the [installer e2e playbook](https://github.com/susomejias/rembric/blob/main/.agents/skills/rembric-tui-installer-e2e/SKILL.md) run.
- [ ] **New MCP tool, HTTP endpoint or load-bearing invariant** — implements OpenSpec change `openspec/changes/<name>/`.
- [ ] **Database migration** — tested against an existing database, not only a fresh one.
- [ ] **New or updated dependency** — follows the [npm security practices](https://github.com/susomejias/rembric/blob/main/.agents/skills/npm-security-best-practices/SKILL.md) (lockfile, build-script allow-list).

## Upgrade notes

<!-- Anything an operator must do or know when upgrading: breaking changes, new env vars,
     migrations, config changes. Write "None" if nothing. -->

None

## Checklist

- [ ] One conceptual change per PR; tests cover the new behaviour.
- [ ] Docs / help text updated where behaviour, commands or config changed.
- [ ] No tokens, API keys, private hostnames, LAN IPs or personal paths committed.
