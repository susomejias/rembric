<!--
Thanks for opening a PR! Please walk through the checklist below before
requesting review. The Conventional Commit title is enforced by commitlint,
the test/lint/typecheck gates by Husky pre-commit + pre-push hooks, and the
spec-driven workflow by reviewer judgement.
-->

## Summary

<!-- 1-3 sentences. What does this change, and why? Link the issue or
     OpenSpec change name if applicable. -->

## OpenSpec change

<!-- If this PR implements an OpenSpec change, name it here and link the
     active directory: `openspec/changes/<name>/`. If not, write "N/A — small
     fix / docs only". -->

- Change name: `<name>` (or N/A)

## Test plan

<!-- Bulleted checklist of what you ran locally and what reviewers should
     run. Be specific: file paths, command flags, expected output. -->

- [ ] `pnpm run lint` clean
- [ ] `pnpm run typecheck` clean
- [ ] `pnpm test` green (full suite, no `-t` narrowing)
- [ ] `pnpm run build` clean
- [ ] `openspec validate <change> --strict` clean (if applicable)
- [ ] Manual smoke against `pnpm run dev:docker:up`: <describe the scenario>

## Checklist

- [ ] Commit messages follow Conventional Commits (`feat:` / `fix:` / `docs:` / ...).
- [ ] Changes are scoped: one conceptual change per PR.
- [ ] New tests cover new behaviour; coverage gates still pass (≥90% stmts / ≥85% rest).
- [ ] No new dependency added without consulting [`.agents/skills/npm-security-best-practices/SKILL.md`](../.agents/skills/npm-security-best-practices/SKILL.md).
- [ ] Any change touching `plugin/` bumps the version in **all three** manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml`) and `plugin/CHANGELOG.md`.
- [ ] No tokens, API keys, private hostnames, LAN IPs, or maintainer home-directory paths committed (see `openspec/config.yaml::rules.tasks`).
- [ ] If this PR closes an issue, the body includes `Closes #<n>`.

<!-- release-please picks up the commit prefix automatically; you do NOT need
     to add a CHANGELOG entry yourself. -->
